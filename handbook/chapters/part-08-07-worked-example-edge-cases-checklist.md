## 8.18 Worked example: the Orders API end to end

This section assembles the pieces from 8.1 to 8.17 into one complete slice: the `OrdersController` with all six endpoints, the DTOs, an `OrdersService` facade over the Part 7 use cases, the exception filter, the idempotency interceptor, swagger decorators and module wiring. Everything here is real NestJS code; the domain and application layer it calls is the one built in Part 7 — Domain-Driven Design.

The endpoints:

```text
POST   /api/v2/orders                       place an order (idempotent via Idempotency-Key)
GET    /api/v2/orders/:id                   read one (ETag)
GET    /api/v2/orders?status=PAID&cursor=   list with filters and cursor pagination
PATCH  /api/v2/orders/:id                   edit a draft (merge-patch, If-Match)
DELETE /api/v2/orders/:id                   delete a draft (idempotent)
POST   /api/v2/orders/:id/cancellations     cancel a placed or paid order (action as resource)
```

#### DTOs

```ts
// src/ordering/api/dto/create-order.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { UniqueBy } from '../../../shared/api/validators/unique-by.validator';

export class OrderLineDto {
  @ApiProperty({ example: 'MUG-BLU-01' }) @IsString() @MaxLength(64) @Matches(/^[A-Z0-9-]+$/) sku: string;
  @ApiProperty({ example: 2, minimum: 1, maximum: 10000 }) @IsInt() @Min(1) @Max(10000) quantity: number;
}
export class AddressDto {
  @ApiProperty() @IsString() @Length(1, 200) line1: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) line2?: string;
  @ApiProperty() @IsString() @Length(1, 100) city: string;
  @ApiProperty({ example: '560001' }) @IsString() @Length(3, 12) @Matches(/^[A-Za-z0-9 -]+$/) postalCode: string;
  @ApiProperty({ example: 'IN' }) @IsIn(['IN', 'US', 'GB', 'DE']) countryCode: string;
}
export class CreateOrderDto {
  @ApiProperty({ enum: ['INR', 'USD', 'EUR'] }) @IsIn(['INR', 'USD', 'EUR']) currency: string;
  @ApiProperty({ type: [OrderLineDto], minItems: 1, maxItems: 100 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => OrderLineDto) @UniqueBy('sku')
  lines: OrderLineDto[];
  @ApiProperty({ type: AddressDto }) @ValidateNested() @Type(() => AddressDto) shippingAddress: AddressDto;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(500) customerNote?: string;
}
```

```ts
// src/ordering/api/dto/update-order.dto.ts
import { PartialType, PickType } from '@nestjs/swagger';
import { CreateOrderDto } from './create-order.dto';

// Only the fields a draft may change. No currency, no lines (they have their own sub-resource), no status.
export class UpdateOrderDto extends PartialType(PickType(CreateOrderDto, ['shippingAddress', 'customerNote'] as const)) {}

// src/ordering/api/dto/create-cancellation.dto.ts
export class CreateCancellationDto {
  @ApiProperty({ maxLength: 500 }) @IsString() @Length(1, 500) reason: string;
}

// src/ordering/api/dto/list-orders.query.dto.ts   (from 8.6; limit, cursor, status[], placedAfter, placedBefore, sort, q)
```

```ts
// src/ordering/api/dto/order-response.dto.ts
export class MoneyDto { @ApiProperty({ example: '1299.00' }) amount: string; @ApiProperty({ example: 'INR' }) currency: string; }
export class OrderLineResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() sku: string;
  @ApiProperty() productName: string;
  @ApiProperty() quantity: number;
  @ApiProperty({ type: MoneyDto }) unitPrice: MoneyDto;
  @ApiProperty({ type: MoneyDto }) lineTotal: MoneyDto;
}
export class OrderResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ enum: ['DRAFT', 'PLACED', 'PAID', 'FULFILLED', 'CANCELLED'], description: 'Open enum' }) status: string;
  @ApiProperty({ type: [OrderLineResponseDto] }) lines: OrderLineResponseDto[];
  @ApiProperty({ type: MoneyDto }) total: MoneyDto;
  @ApiProperty({ type: AddressDto }) shippingAddress: AddressDto;
  @ApiPropertyOptional() customerNote?: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) placedAt?: string;
  @ApiProperty({ description: 'Send back as If-Match on PATCH' }) version: number;
  @ApiProperty({ type: [String], example: ['cancel'] }) actions: string[];
}
export class CancellationResponseDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) orderId: string;
  @ApiProperty() reason: string;
  @ApiProperty() refundRequired: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt: string;
}
```

#### The service facade

`OrdersService` is the API layer's single entry point into the Ordering context. It delegates to the Part 7 use cases and the read-side query, and maps domain results to response DTOs. It contains no business rules.

```ts
// src/ordering/api/orders.service.ts
import { Injectable } from '@nestjs/common';
import { PlaceOrderService } from '../application/place-order.service';
import { UpdateDraftService } from '../application/update-draft.service';
import { DeleteDraftService } from '../application/delete-draft.service';
import { CancelOrderService } from '../application/cancel-order.service';
import { OrdersQuery, Page } from '../application/orders.query';
import { OrderNotFoundError } from '../domain/errors';
import { CreateOrderDto, UpdateOrderDto, ListOrdersQueryDto, OrderResponseDto, CancellationResponseDto } from './dto';

@Injectable()
export class OrdersService {
  constructor(
    private readonly placeOrder: PlaceOrderService,
    private readonly updateDraft: UpdateDraftService,
    private readonly deleteDraft: DeleteDraftService,
    private readonly cancelOrder: CancelOrderService,
    private readonly query: OrdersQuery,
  ) {}

  async create(customerId: string, idempotencyKey: string, dto: CreateOrderDto): Promise<{ order: OrderResponseDto; created: boolean }> {
    const result = await this.placeOrder.execute({ customerId, idempotencyKey, currency: dto.currency, lines: dto.lines,
      shippingAddress: dto.shippingAddress, customerNote: dto.customerNote });
    const order = await this.getOne(customerId, result.orderId);
    return { order, created: result.created };
  }

  async getOne(customerId: string, orderId: string): Promise<OrderResponseDto> {
    const view = await this.query.getForCustomer(customerId, orderId);   // read model; 404 hides other customers' orders
    if (!view) throw new OrderNotFoundError(orderId);
    return toResponse(view);
  }

  list(customerId: string, q: ListOrdersQueryDto): Promise<Page<OrderResponseDto>> {
    return this.query.listForCustomer(customerId, q).then((page) => ({ ...page, items: page.items.map(toResponse) }));
  }

  async update(customerId: string, orderId: string, expectedVersion: number, dto: UpdateOrderDto): Promise<OrderResponseDto> {
    await this.updateDraft.execute({ customerId, orderId, expectedVersion,
      shippingAddress: dto.shippingAddress, customerNote: dto.customerNote });   // undefined = unchanged, null = clear
    return this.getOne(customerId, orderId);
  }

  remove(customerId: string, orderId: string): Promise<void> {
    return this.deleteDraft.execute({ customerId, orderId });   // no-op if already gone
  }

  async cancel(customerId: string, orderId: string, reason: string): Promise<{ cancellation: CancellationResponseDto; created: boolean }> {
    const r = await this.cancelOrder.execute({ customerId, orderId, reason, requestedBy: customerId });
    return { created: r.created, cancellation: { id: r.cancellationId, orderId, reason: r.reason, refundRequired: r.refundRequired, createdAt: r.createdAt.toISOString() } };
  }
}

function toResponse(v: OrderView): OrderResponseDto {
  const actions: string[] = [];
  if (v.status === 'DRAFT') actions.push('edit', 'delete', 'place');
  if (v.status === 'PLACED') actions.push('pay', 'cancel');
  if (v.status === 'PAID') actions.push('cancel');
  return {
    id: v.id, status: v.status, version: v.version, placedAt: v.placedAt?.toISOString(), customerNote: v.customerNote,
    lines: v.lines.map((l) => ({ id: l.id, sku: l.sku, productName: l.productName, quantity: l.quantity,
      unitPrice: money(l.unitPriceMinor, v.currency), lineTotal: money(l.lineTotalMinor, v.currency) })),
    total: money(v.totalMinor, v.currency),
    shippingAddress: { line1: v.shipLine1, line2: v.shipLine2 ?? undefined, city: v.shipCity, postalCode: v.shipPostalCode, countryCode: v.shipCountry },
    actions,
  };
}
function money(minor: string, currency: string): MoneyDto {
  const digits = currency === 'JPY' ? 0 : 2;
  const s = BigInt(minor).toString().padStart(digits + 1, '0');
  return { amount: digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s, currency };
}
```

#### The controller

```ts
// src/ordering/api/orders.controller.ts
import {
  Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res,
  UseGuards, UseInterceptors, PreconditionRequiredException, BadRequestException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiConflictResponse, ApiCreatedResponse, ApiHeader, ApiNoContentResponse,
  ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiPreconditionFailedResponse, ApiResponse, ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import { Response } from 'express';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { CurrentUser } from '../../auth/current-user.decorator';
import { Idempotent } from '../../shared/api/idempotent.decorator';
import { IdempotencyInterceptor } from '../../shared/api/idempotency.interceptor';
import { OrdersService } from './orders.service';
import { CreateOrderDto, UpdateOrderDto, CreateCancellationDto, ListOrdersQueryDto, OrderResponseDto, CancellationResponseDto, ProblemDetailsDto } from './dto';

type User = { id: string };

@ApiTags('orders')
@ApiBearerAuth()
@ApiBadRequestResponse({ type: ProblemDetailsDto })
@ApiResponse({ status: 401, type: ProblemDetailsDto })
@ApiResponse({ status: 429, type: ProblemDetailsDto, description: 'Rate limited; honour Retry-After' })
@UseGuards(JwtAuthGuard)
@Controller({ path: 'orders', version: '2' })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @HttpCode(201)
  @Idempotent({ ttlSeconds: 86_400 })
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ short: { limit: 5, ttl: seconds(1) } })
  @ApiOperation({ summary: 'Place an order', description: 'Prices and names are snapshotted at placement. Idempotent per Idempotency-Key for 24 h.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID v4 per logical operation; reuse only for retries' })
  @ApiCreatedResponse({ type: OrderResponseDto, headers: { Location: { schema: { type: 'string' } } } })
  @ApiOkResponse({ type: OrderResponseDto, description: 'Idempotent replay (Idempotent-Replayed: true)' })
  @ApiUnprocessableEntityResponse({ type: ProblemDetailsDto, description: 'UNKNOWN_SKU, INSUFFICIENT_STOCK, IDEMPOTENCY_KEY_REUSED' })
  @ApiResponse({ status: 403, type: ProblemDetailsDto, description: 'Customer blocked' })
  async create(
    @CurrentUser() user: User,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: CreateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponseDto> {
    const { order, created } = await this.orders.create(user.id, idempotencyKey, dto);
    res.setHeader('Location', `/api/v2/orders/${order.id}`);
    res.setHeader('ETag', `"${order.version}"`);
    if (!created) res.status(200);
    return order;
  }

  @Get()
  @ApiOperation({ summary: 'List my orders', description: 'Cursor pagination; cursors are opaque and expire with the sort spec.' })
  @ApiOkResponse({ description: 'items plus pageInfo' })
  list(@CurrentUser() user: User, @Query() q: ListOrdersQueryDto) {
    return this.orders.list(user.id, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get an order' })
  @ApiOkResponse({ type: OrderResponseDto, headers: { ETag: { schema: { type: 'string' } } } })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  async getOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string, @Res({ passthrough: true }) res: Response): Promise<OrderResponseDto> {
    const order = await this.orders.getOne(user.id, id);
    res.setHeader('ETag', `"${order.version}"`);
    res.setHeader('Cache-Control', 'private, no-cache');   // revalidate; never shared-cache a customer's order
    return order;
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edit a draft order', description: 'JSON merge-patch semantics: null clears, absent leaves unchanged. Requires If-Match.' })
  @ApiHeader({ name: 'If-Match', required: true, description: 'ETag from the last GET, e.g. "12"' })
  @ApiOkResponse({ type: OrderResponseDto })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto, description: 'Order is not a draft' })
  @ApiPreconditionFailedResponse({ type: ProblemDetailsDto, description: 'Version mismatch; reload and retry' })
  @ApiResponse({ status: 428, type: ProblemDetailsDto, description: 'If-Match missing' })
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateOrderDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OrderResponseDto> {
    if (!ifMatch) throw new PreconditionRequiredException('If-Match header is required');
    const m = /^(?:W\/)?"(\d+)"$/.exec(ifMatch.trim());
    if (!m) throw new BadRequestException('Malformed If-Match');
    const order = await this.orders.update(user.id, id, Number(m[1]), dto);
    res.setHeader('ETag', `"${order.version}"`);
    return order;
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a draft order', description: 'Idempotent: deleting an already-deleted draft returns 204. Placed orders cannot be deleted; cancel them.' })
  @ApiNoContentResponse()
  @ApiConflictResponse({ type: ProblemDetailsDto, description: 'Order is not a draft' })
  async remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.orders.remove(user.id, id);
  }

  @Post(':id/cancellations')
  @HttpCode(201)
  @ApiOperation({ summary: 'Cancel an order', description: 'Creates a cancellation. Repeating returns the existing cancellation with 200.' })
  @ApiCreatedResponse({ type: CancellationResponseDto })
  @ApiOkResponse({ type: CancellationResponseDto, description: 'Already cancelled' })
  @ApiNotFoundResponse({ type: ProblemDetailsDto })
  @ApiConflictResponse({ type: ProblemDetailsDto, description: 'ORDER_NOT_CANCELLABLE: fulfilled orders cannot be cancelled' })
  async cancel(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCancellationDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CancellationResponseDto> {
    const { cancellation, created } = await this.orders.cancel(user.id, id, dto.reason);
    res.setHeader('Location', `/api/v2/orders/${id}/cancellations/${cancellation.id}`);
    if (!created) res.status(200);
    return cancellation;
  }
}
```

The exception filter (8.9) and the idempotency interceptor (8.12) are the ones already shown; the filter is registered globally in `main.ts`, the interceptor is applied per endpoint with `@Idempotent()`.

#### Module wiring and bootstrap

```ts
// src/ordering/ordering.module.ts
@Module({
  imports: [TypeOrmModule.forFeature([OrderOrmEntity, OrderLineOrmEntity]), CustomerModule, CatalogModule, SharedInfrastructureModule],
  controllers: [OrdersController],
  providers: [
    OrdersService, OrdersQuery,
    PlaceOrderService, UpdateDraftService, DeleteDraftService, CancelOrderService, PricingService,
    IdempotencyInterceptor, CursorCodec,
  ],
})
export class OrderingModule {}

// src/main.ts (all the global pieces together)
const app = await NestFactory.create(AppModule, { bodyParser: false, rawBody: true });
app.set('trust proxy', 1);
app.use(json({ limit: '1mb', strict: true }));
app.setGlobalPrefix('api');
app.enableVersioning({ type: VersioningType.URI, defaultVersion: '2' });
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, forbidUnknownValues: true, validationError: { target: false, value: false } }));
app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));
app.use(correlationIdMiddleware);
app.enableShutdownHooks();
```

#### What a request looks like

```text
POST /api/v2/orders HTTP/1.1
Authorization: Bearer eyJ...
Idempotency-Key: 6b1c1c5e-2f0e-4c7f-9d1a-0a9d3e2f1b11
Content-Type: application/json

{ "currency": "INR", "lines": [ { "sku": "MUG-BLU-01", "quantity": 2 } ],
  "shippingAddress": { "line1": "12 MG Road", "city": "Bengaluru", "postalCode": "560001", "countryCode": "IN" } }

HTTP/1.1 201 Created
Location: /api/v2/orders/8f3c2b1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f
ETag: "0"
X-Correlation-Id: req_01J7Q8Z9M3
X-RateLimit-Limit: 300
X-RateLimit-Remaining: 299
Content-Type: application/json

{ "id": "8f3c2b1e-...", "status": "PLACED", "lines": [ { "id": "...", "sku": "MUG-BLU-01", "productName": "Blue Mug", "quantity": 2,
  "unitPrice": { "amount": "199.00", "currency": "INR" }, "lineTotal": { "amount": "398.00", "currency": "INR" } } ],
  "total": { "amount": "398.00", "currency": "INR" }, "shippingAddress": { ... }, "placedAt": "2026-09-07T04:12:31.118Z",
  "version": 0, "actions": ["pay", "cancel"] }
```

A retry of the same request returns the same body with `200` and `Idempotent-Replayed: true`. A cancel of a fulfilled order returns:

```text
HTTP/1.1 409 Conflict
Content-Type: application/problem+json
X-Correlation-Id: req_01J7Q8ZB77

{ "type": "https://errors.example.com/order-not-cancellable", "title": "Order Not Cancellable", "status": 409,
  "detail": "Cannot cancel: order is FULFILLED", "instance": "/api/v2/orders/8f3c.../cancellations",
  "code": "ORDER_NOT_CANCELLABLE", "correlationId": "req_01J7Q8ZB77" }
```

#### Production scenario

This shape ran at 1,200 RPS across six pods: 70% `GET` (list and item, p50 6 ms, served by the read query with the composite index), 25% `POST /orders` (p50 28 ms, p99 90 ms including the idempotency round trip to Redis), 5% everything else. The `Idempotent-Replayed` rate was 1.8%, the 412 rate on `PATCH` 0.4%, the 429 rate 0.3% (two integrations). Error bodies were uniform, the OpenAPI document was generated on every merge and diffed, and the mobile SDK was regenerated from it.

## 8.19 Edge cases & failure modes for APIs

Every item below has bitten a real system. For each: what happens, and the defence.

- **Duplicate request.** The client sends the same `POST` twice (double-tap, retry loop). Defence: `Idempotency-Key` with atomic reservation and replay (8.12); unique constraints in the database as the durable backstop; naturally idempotent sub-resources (`cancellations` with `UNIQUE (order_id)`).
- **Client timeout after server success.** The order committed; the response was lost; the client thinks it failed. Defence: idempotency keys so the retry returns the original; `Location` headers and `GET` so the client can reconcile; never make clients guess.
- **Retries of non-idempotent calls.** SDKs and gateways retry 5xx and timeouts by default. Defence: every retryable path is idempotent by verb (`PUT`, `DELETE`) or by key (`POST`); return 4xx (not 5xx) for client faults so gateways do not retry them; document the retry contract.
- **Partial failure in bulk.** Item 137 fails. Defence: per-item results with per-item keys (8.7); bounded concurrency; all-or-nothing only for related items.
- **Large payloads.** A 40 MB body exhausts memory or hits the gateway limit. Defence: body limit (1 MB) at gateway and app returning 413; array size caps in DTOs; streaming uploads for files (multipart to object storage with pre-signed URLs, never buffered through Node); pagination for responses; async export for big results.
- **Malicious input.** `__proto__` keys (prototype pollution) neutralised by `whitelist: true` and a strict JSON parser; ReDoS by length caps and linear regexes; SQL injection through sort/filter by allow-lists; id enumeration by UUID/prefixed ids plus authorisation on every read (`getForCustomer`, not `getById`); path traversal in file names by never using client strings as paths; header injection by validating `Location`-influencing values.
- **Clock skew in signed requests.** A client's clock is 8 minutes off; every signed request or webhook is rejected as stale. Defence: 5-minute tolerance is standard; return a problem body that says "clock skew" with the server time so the client can correct; monitor rejection reasons; use NTP everywhere you control.
- **Pagination drift when rows are inserted.** Offset pages repeat or skip items when rows are inserted before the current page. Defence: keyset pagination on an immutable `(created_at, id)`; opaque signed cursors; `hasNextPage` instead of totals.
- **Breaking changes in responses.** Adding a field is safe (clients must ignore unknown fields; say so in the docs). Removing, renaming, retyping (`number` to `string`), changing meaning (paise to rupees), tightening validation, or changing a status code are breaking. Defence: additive evolution; a diffed OpenAPI document in CI; a new version for anything breaking; deprecation and sunset headers.
- **Mobile clients stuck on old versions.** Some users never update. Defence: keep old versions alive per the sunset policy; per-version usage dashboards; tolerant readers on the client (ignore unknown fields, handle unknown enum values); a minimum-supported-version check that returns 426 Upgrade Required with a store link only for security-critical breaks.
- **Enum growth.** A new `status` value crashes a client with an exhaustive `switch`. Defence: document enums as open; add values in minor releases only when clients are known to tolerate them; otherwise version.
- **Timeouts on the server side.** A slow catalog lookup makes `POST /orders` hang. Defence: per-dependency timeouts (300 ms for in-request reads), 503/504 with `Retry-After`, circuit breakers (Part 18 — Resilience), no external I/O inside transactions.
- **Thundering retries after an outage.** All clients retry at once when you come back. Defence: `Retry-After` with jittered values; rate limits at the edge; documented exponential backoff with jitter in SDKs.
- **Authorisation by URL only.** `GET /orders/{id}` checks the token but not ownership. Defence: every read and write is scoped by the principal in the query itself.
- **Caching mistakes.** A CDN caches `GET /orders/{id}` and serves one customer's order to another. Defence: `Cache-Control: private, no-cache` on anything user-specific; `Vary: Authorization`; only cache public resources.
- **Correlation lost.** An error in a worker cannot be tied to the request that queued it. Defence: propagate the correlation id through queue messages and webhook headers.
- **Inconsistent error shapes** between the gateway (429, 503), the framework (404 for unknown routes) and the app. Defence: configure the gateway's error bodies; catch-all route in NestJS returning problem+json; contract tests on error responses.

## 8.20 API design review checklist

Use this table in design reviews and PR reviews. A "no" needs a written reason.

| Area | Question | Reference |
|---|---|---|
| Resources | Are endpoints modelled around business resources and capabilities, not tables? | 8.1 |
| Resources | Are state changes expressed as `PATCH` of writable fields or `POST` to a sub-resource (`/cancellations`), not `/cancel`? | 8.1 |
| URIs | Plural nouns, kebab-case, no verbs, no trailing slashes, at most two levels deep? | 8.2 |
| URIs | Are ids non-enumerable (UUID/prefixed) and validated with a pipe? | 8.2 |
| Verbs | Is every `GET` side-effect free? Every `PUT`/`DELETE` provably idempotent? Every `POST` either idempotent-keyed or documented as not retryable? | 8.3 |
| Status codes | Is 400 vs 422 vs 409 used consistently? 201 with `Location`? 202 for async? 429 with `Retry-After`? Never 200 for errors? | 8.4 |
| Pagination | Cursor-based for lists that can grow? Composite `(created_at, id)` key with a matching index? Opaque, signed cursors? Limit capped? | 8.5 |
| Filtering | Are filter and sort fields allow-listed and index-backed? Unknown params rejected? Search uses full-text/trigram, not `ILIKE`? | 8.6 |
| Bulk | Batch size capped? Partial success with per-item results and per-item keys? Bounded concurrency? | 8.7 |
| Partial updates | Merge-patch semantics documented (null vs absent)? `If-Match` required with 412 on mismatch? Writable fields whitelisted? | 8.8 |
| Errors | RFC 9457 problem+json from one global filter? Stable `code` catalogue? Correlation id in body and logs? No stack traces? | 8.9 |
| Validation | Global `ValidationPipe` with `whitelist`, `forbidNonWhitelisted`, `transform`? Length and array caps? No nested-quantifier regexes? Body size limit? | 8.10 |
| Versioning | Version strategy chosen and applied consistently? Additive changes preferred? Deprecation and `Sunset` headers on old versions? Usage per version measured? | 8.11 |
| Idempotency | `Idempotency-Key` mandatory on money-moving and creating `POST`s? Atomic reservation? Fingerprint check? Replay identical? Database unique constraint as backstop? | 8.12 |
| Rate limiting | Limits at the edge and in the app? Keyed by user/API key after auth? Stricter on login and expensive endpoints? 429 with `Retry-After`? Redis-down behaviour decided? | 8.13 |
| Contracts | OpenAPI generated and committed? Breaking-change diff in CI? Responses validated against the spec in tests? Clients generated, not hand-written? | 8.14 |
| Async | Operations over a few seconds return 202 with a status resource and `Retry-After`? Workers idempotent? Operations expire? | 8.16 |
| Webhooks | HMAC with timestamp? At-least-once with event ids? Backoff schedule? SSRF protection? Delivery log and replay? Receiver acks fast and dedupes? | 8.17 |
| Security | Every read/write scoped by principal? `Cache-Control: private` on user data? No PII in webhooks or error details? | 8.19 |
| Money | All amounts are decimal strings with currency, never floats? | Part 7, 7.5 |
| Compatibility | Clients told to ignore unknown fields and enum values? Nothing removed or renamed without a version? | 8.19 |

## Senior Checklist — Part 08

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can model an API around resources and business capabilities and explain why table-driven APIs break
- [ ] I can turn a business action into a sub-resource (`POST /orders/{id}/cancellations`) and say why it beats `/cancel`
- [ ] I can pick the right status code for any situation, including 400 vs 422 vs 409 and 202 for async
- [ ] I can read the `EXPLAIN` for `OFFSET 200000` and implement keyset pagination with a composite index, opaque signed cursors and backward paging
- [ ] I can allow-list filter and sort fields so dynamic `ORDER BY` can never become injection or a full sort
- [ ] I can design a bulk endpoint with partial success, per-item idempotency and bounded concurrency
- [ ] I can implement merge-patch with correct null/undefined semantics and `If-Match`/412
- [ ] I can write one global RFC 9457 exception filter that maps domain errors to HTTP without leaking internals
- [ ] I can configure `ValidationPipe` to prevent mass assignment, prototype pollution and ReDoS
- [ ] I can implement an idempotency interceptor with atomic reservation, fingerprinting, replay and a database backstop
- [ ] I can rate limit at the edge and in the app with Redis, keyed by principal, with 429 and `Retry-After`
- [ ] I can version an API, evolve it additively, and sunset a version with headers and usage data
- [ ] I can design 202-based long-running operations and secure, retried, deduplicated webhooks on both sides
- [ ] I can run an API design review with the checklist above

## Part 08 — Key Takeaways

- An API is a long-lived contract; design it around business resources and the ubiquitous language, never around tables.
- Business actions become sub-resources (`/cancellations`), which gives them ids, history, idempotency and a uniform shape.
- Verbs carry semantics that retries depend on: `GET` safe, `PUT`/`DELETE` idempotent, `POST` needs an `Idempotency-Key` when it creates money or business events.
- Status codes are control signals for gateways, SDKs and monitoring; 200-with-error breaks all three.
- Offset pagination costs grow with depth; keyset pagination on `(created_at, id)` with a matching index is constant-time and drift-free; cursors are opaque and signed.
- Every filter and sort field is an allow-listed promise that an index exists; client strings never reach `ORDER BY`.
- Bulk endpoints cap size, bound concurrency, and return per-item results with per-item idempotency.
- `PATCH` is merge-patch with null-clears/absent-unchanged semantics and requires `If-Match`; lost updates are a bug, not a feature.
- One global filter emits RFC 9457 problem+json with a stable code catalogue and a correlation id; stack traces never leave the server.
- `ValidationPipe` with `whitelist`, `forbidNonWhitelisted` and `transform`, plus length caps and linear regexes, is a security control before it is a UX feature.
- Idempotency is reserve-atomically, fingerprint, execute, store, replay, with a unique constraint in PostgreSQL as the durable backstop.
- Rate limit coarse at the edge and precise in the app with Redis; stricter on login and expensive endpoints; always send `Retry-After`.
- Version at the URI, evolve additively, keep one implementation behind thin adapters, and sunset with `Deprecation`/`Sunset` headers and usage dashboards.
- Anything slower than a few seconds is 202 plus an operation resource; webhooks are signed with timestamps, delivered at-least-once with backoff, deduplicated by event id, and acknowledged fast by receivers.
- Adding fields is safe; removing, renaming, retyping or changing meaning is a new version, because some client somewhere will never update.
