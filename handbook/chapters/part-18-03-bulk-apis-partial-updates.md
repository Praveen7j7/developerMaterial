## 18.7 Bulk APIs

#### Concept

A bulk API accepts many items in one request: `POST /orders/batch` with 200 orders, `PATCH /products/batch` with 500 price changes, `POST /inventory/adjustments/batch` from a warehouse scanner. The hard part is not the loop; it is answering **what happens when item 137 of 200 fails**.

Two shapes:

- **All-or-nothing**: one transaction; any failure rolls back everything; response is 201 or an error.
- **Partial success**: each item is processed independently; the response lists a per-item result. HTTP has no perfect code for "some succeeded"; the WebDAV-derived 207 Multi-Status exists, and many APIs use 200 with a per-item status array instead.

#### Why does it exist?

Round trips are expensive. A warehouse scanner uploading 5,000 stock counts one request at a time spends 5,000 × (network ~30 ms + TLS + auth) and holds a connection for minutes. One request with 5,000 items does the same work in a few hundred milliseconds of database time. Bulk also lets the server batch inserts (`INSERT ... VALUES (...), (...), (...)`), which is 10 to 50 times faster than row-by-row.

#### Mental model

Imagine handing a stack of 200 forms to a clerk. Two possible rules: "if any form has an error, hand the whole stack back" (all-or-nothing), or "process the good ones, and staple a note to each bad one saying why" (partial success). The second is friendlier when forms are independent, but the person submitting must be ready to read 200 notes.

#### How it works

1. **Cap the batch size** (100 to 1,000 depending on item size) and reject with 413 or 400 above it.
2. **Validate the envelope first** (shape, size, duplicate item keys), then validate each item.
3. **Decide the mode**, per endpoint, and document it. Use all-or-nothing when items are related (lines of one order). Use partial success when items are independent (many orders, many stock adjustments).
4. **Per-item idempotency.** Each item carries its own client-generated key or id, so a retry of the whole batch does not duplicate the items that succeeded the first time.
5. **Per-item result** with index or key, status, and error details in the same problem shape as single-item errors (18.9).
6. **Bound the work.** Process in chunks with `Promise.all` limited to a concurrency of ~10, or in one multi-row `INSERT`. Never `await` 500 serial database calls.
7. **For large batches**, switch to async: 202, a job, and a status resource (18.16).

Response shape for partial success:

```json
{
  "summary": { "total": 3, "succeeded": 2, "failed": 1 },
  "results": [
    { "index": 0, "key": "scan-8811", "status": 201, "id": "adj_9f1c..." },
    { "index": 1, "key": "scan-8812", "status": 201, "id": "adj_9f1d..." },
    { "index": 2, "key": "scan-8813", "status": 422,
      "error": { "type": "https://errors.example.com/unknown-sku", "title": "Unknown SKU", "detail": "SKU MUG-BLU-XL does not exist" } }
  ]
}
```

#### NestJS example

Batch stock adjustments with partial success, per-item idempotency and bounded concurrency.

```ts
// src/inventory/api/dto/batch-adjustments.dto.ts
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Length, Max, Min, ValidateNested, IsUUID } from 'class-validator';

export class AdjustmentItemDto {
  @IsString() @Length(1, 64) key: string;            // client idempotency key per item (scanner event id)
  @IsString() @Length(3, 64) sku: string;
  @IsUUID() warehouseId: string;
  @IsInt() @Min(-100000) @Max(100000) delta: number;
  @IsString() @Length(1, 200) reason: string;
}

export class BatchAdjustmentsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => AdjustmentItemDto)
  items: AdjustmentItemDto[];
}
```

```ts
// src/inventory/api/adjustments.controller.ts
import { Body, Controller, HttpCode, Post, BadRequestException } from '@nestjs/common';
import { BatchAdjustmentsDto } from './dto/batch-adjustments.dto';
import { AdjustStockService } from '../application/adjust-stock.service';
import { DomainError } from '../../shared/domain/domain-error';
import { toProblem } from '../../shared/api/problem';     // maps domain errors to RFC 9457 bodies (18.9)

@Controller('inventory/adjustments')
export class AdjustmentsController {
  constructor(private readonly adjust: AdjustStockService) {}

  @Post('batch')
  @HttpCode(200)                                            // partial success: 200 with per-item statuses
  async batch(@Body() dto: BatchAdjustmentsDto) {
    const keys = new Set(dto.items.map((i) => i.key));
    if (keys.size !== dto.items.length) throw new BadRequestException('Duplicate item keys in batch');

    const results = await mapWithConcurrency(dto.items, 10, async (item, index) => {
      try {
        const { adjustmentId, created } = await this.adjust.execute(item);   // idempotent on item.key
        return { index, key: item.key, status: created ? 201 : 200, id: adjustmentId };
      } catch (err) {
        const problem = toProblem(err);                     // never leaks stack traces
        return { index, key: item.key, status: problem.status, error: problem };
      }
    });

    const succeeded = results.filter((r) => r.status < 400).length;
    return { summary: { total: results.length, succeeded, failed: results.length - succeeded }, results };
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  });
  await Promise.all(workers);
  return out;
}
```

Each `adjust.execute(item)` runs its own short transaction on one `StockItem` aggregate (Part 17), so a failure in one item cannot poison another, and 10 in flight at once keeps the connection pool happy.

For the all-or-nothing case (creating one order with many lines is already that; another example is importing a price list where a half-applied list is worse than none), wrap the loop in one `dataSource.transaction()` and use a multi-row insert.

#### PostgreSQL example

Per-item idempotency backed by a unique constraint, and a multi-row insert for the all-or-nothing case.

```sql
CREATE TABLE inventory.stock_adjustments (
  id            uuid PRIMARY KEY,
  client_key    text NOT NULL,
  sku           text NOT NULL,
  warehouse_id  uuid NOT NULL,
  delta         integer NOT NULL,
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_adjustment_client_key UNIQUE (warehouse_id, client_key)   -- item-level idempotency
);

-- Idempotent insert: a replayed item is a no-op and we read back the original id.
INSERT INTO inventory.stock_adjustments (id, client_key, sku, warehouse_id, delta, reason)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (warehouse_id, client_key) DO NOTHING
RETURNING id;
-- If RETURNING is empty, SELECT id ... WHERE warehouse_id = $4 AND client_key = $2.

-- All-or-nothing price import: one statement, 500 rows, ~4 ms instead of 500 round trips.
INSERT INTO catalog.prices (sku, list_price_minor, currency, effective_from)
VALUES ($1, $2, $3, $4), ($5, $6, $7, $8), ($9, $10, $11, $12) /* ... */
ON CONFLICT (sku, effective_from) DO UPDATE SET list_price_minor = EXCLUDED.list_price_minor;
```

#### TypeORM example

Multi-row insert inside a transaction:

```ts
await this.dataSource.transaction(async (em) => {
  await em.createQueryBuilder().insert().into(PriceOrmEntity)
    .values(rows)                                   // array of 500 plain objects
    .orUpdate(['list_price_minor'], ['sku', 'effective_from'])   // ON CONFLICT ... DO UPDATE
    .execute();
});
```

#### Sequelize example

```ts
await this.sequelize.transaction(async (t) => {
  await PriceModel.bulkCreate(rows, {
    updateOnDuplicate: ['listPriceMinor'],          // ON CONFLICT DO UPDATE on the unique index
    transaction: t,
  });
});
```

#### Production scenario

A warehouse app uploaded 20,000 scan events per hour per site across 40 sites. Single-item calls would have been 800,000 requests per hour. Batches of 500 made it 1,600 requests per hour, each about 250 ms, with per-item results so a bad SKU on one shelf never blocked the other 499. Partial-failure rate was 0.3%, all surfaced to the scanner UI with the item key.

#### Failure scenario

An early version processed the batch in one transaction and returned 422 if any item failed. A single unknown SKU (a label misprint) caused the whole 500-item upload to be rejected, the scanner retried automatically every minute, and for six hours no stock counts from that site were recorded. Meanwhile the site's stock went out of sync and orders were promised against phantom inventory. Partial success with per-item results fixed it the same day.

#### Edge cases & failure modes

- **Partial failure with no per-item result.** Client cannot tell what to retry; retries everything; duplicates without item keys.
- **Batch too large.** Memory spike, long transaction, gateway timeout at 30 s. Cap it and go async beyond the cap.
- **Duplicate keys within one batch.** Reject the envelope; otherwise the second silently wins.
- **Ordering dependencies between items** (item 2 references item 1's result). Bulk endpoints should require independent items; otherwise use a single composite resource.
- **Timeout mid-batch** with partial success: some items committed, client never saw the response. Per-item idempotency makes the retry safe.
- **Connection pool exhaustion** from unbounded `Promise.all`. Bound concurrency.
- **Error body size.** 500 failures with full problem details can be megabytes. Truncate `detail`, keep `type` and `title`.

#### How a Senior Backend Engineer thinks about this

They ask "are the items independent?" If yes, partial success with per-item keys and results. If no, a single resource, one transaction. They cap the batch, bound concurrency, and make every item idempotent so that the client's only retry strategy ("send the whole batch again") is safe.

#### Common mistakes

- 200 with `{ ok: true }` while half the items failed silently.
- One transaction around 5,000 independent items, holding locks for seconds.
- `for (const item of items) await repo.save(item)` with no batching.
- No batch cap, then a 40 MB request from a well-meaning integration.

#### Interview questions

1. *Design a bulk stock-adjustment endpoint. How do you handle item 137 failing?* Expected: partial success, per-item results, per-item idempotency, bounded concurrency.
2. *When would you choose all-or-nothing for a batch?* Expected: related items where partial state is worse than none; small batches.
3. *How do you make a retried batch safe?* Expected: client keys per item, unique constraint, `ON CONFLICT DO NOTHING`.
4. *What HTTP status do you return for partial success and why?* Expected: 200 with per-item statuses (or 207); tradeoffs; consistency.

#### Practical exercise

Implement `POST /inventory/adjustments/batch` as above, then write a test that sends 100 items where items 10, 50 and 90 have unknown SKUs, kills the request mid-way (abort the HTTP request after 50 ms), and resends the same batch. Acceptance criteria: exactly 97 adjustments exist after the retry; the response lists 3 failures with 422 and the item keys; the endpoint rejects 501 items with 400; concurrency never exceeds 10 (assert via a counter in a fake service).

## 18.8 Partial updates

#### Concept

A partial update changes some fields of a resource without sending the rest. HTTP's verb for this is `PATCH`. Two standard body formats:

- **JSON Merge Patch** (RFC 7396, `application/merge-patch+json`): send a JSON object; provided fields replace, `null` deletes, absent means unchanged. Simple; cannot express "append to array" or "set field to literal null while keeping others" ambiguity-free.
- **JSON Patch** (RFC 6902, `application/json-patch+json`): send an array of operations (`add`, `remove`, `replace`, `move`, `copy`, `test`). Precise; supports arrays and conditional `test`; more verbose and harder for clients.

Most REST APIs use merge-patch semantics with `application/json` (technically sloppy, universally understood). Use JSON Patch when clients need array operations or conditional updates.

#### Why does it exist?

`PUT` requires the whole representation, which means the client must first `GET`, then send everything back. That is two round trips, larger payloads, and a race: between the `GET` and the `PUT`, someone else's change is overwritten. `PATCH` sends only the change, and combined with a version check it can refuse to overwrite concurrent edits.

#### Mental model

Imagine editing a shared document. `PUT` is "here is the whole new document, replace it"; if a colleague edited paragraph 3 while you edited paragraph 7, their change is gone. `PATCH` with a version is "change paragraph 7, and only if the document is still at revision 12"; if it is at revision 13, you are told to look again.

#### How it works

**Null vs undefined.** This is the crux of merge-patch and the most common bug:

| Field in request | JavaScript value after parsing | Meaning |
|---|---|---|
| `"line2": "Flat 4"` | `'Flat 4'` | Set to this value |
| `"line2": null` | `null` | Clear the value (set column to NULL) |
| key absent | `undefined` | Leave unchanged |

Your DTO and your update logic must preserve this distinction. `class-validator`'s `@IsOptional()` treats both `null` and `undefined` as "skip validation", which is fine, but your mapping code must not do `if (dto.line2)` (which treats `null`, `''` and `undefined` alike). It must do `if (dto.line2 !== undefined)`.

**Optimistic concurrency.** Two mechanisms:

- `If-Match: "12"` header carrying the `ETag` the client received from the last `GET`. The server compares with the current version and returns 412 Precondition Failed on mismatch. This is the HTTP-standard way.
- `version` field in the body. Same idea, less standard, simpler for some clients.

Either way, the database update is `UPDATE ... WHERE id = $1 AND version = $2` and `affected === 0` means conflict (Part 17, section 17.15).

**Allow-listing patchable fields.** A `PATCH /orders/{id}` must not allow `status`, `total` or `customerId`. State changes go through sub-resources (`/cancellations`); computed fields are never writable. `PartialType` from `@nestjs/swagger` or `@nestjs/mapped-types` makes every field of a DTO optional; make sure the base DTO contains only the fields that are legitimately writable.

#### NestJS example

```ts
// src/ordering/api/dto/update-order.dto.ts
import { PartialType } from '@nestjs/swagger';            // also available from @nestjs/mapped-types
import { Type } from 'class-transformer';
import { IsOptional, IsString, Length, ValidateNested, ValidateIf } from 'class-validator';

class ShippingAddressWriteDto {
  @IsString() @Length(1, 200) line1: string;
  @ValidateIf((o) => o.line2 !== null) @IsOptional() @IsString() @Length(0, 200) line2?: string | null;
  @IsString() @Length(1, 100) city: string;
  @IsString() @Length(3, 12) postalCode: string;
  @IsString() @Length(2, 2) countryCode: string;
}

// Only the writable fields of a draft order. No status, no total, no customerId.
class OrderWritableDto {
  @ValidateNested() @Type(() => ShippingAddressWriteDto) shippingAddress: ShippingAddressWriteDto;
  @IsString() @Length(0, 500) customerNote: string | null;
}

export class UpdateOrderDto extends PartialType(OrderWritableDto) {}
```

```ts
// src/ordering/api/orders.controller.ts (PATCH handler)
import { Headers, Patch, Param, Body, PreconditionFailedException, BadRequestException } from '@nestjs/common';

@Patch(':id')
async update(
  @Param('id', ParseUUIDPipe) id: string,
  @Headers('if-match') ifMatch: string | undefined,
  @Body() dto: UpdateOrderDto,
  @Res({ passthrough: true }) res: Response,
) {
  if (!ifMatch) throw new PreconditionRequiredException('If-Match header is required'); // 428
  const expectedVersion = parseEtag(ifMatch);                                         // "12" -> 12, W/"12" -> 12

  const result = await this.updateDraft.execute({
    orderId: id,
    expectedVersion,
    // Preserve null vs undefined exactly as received.
    shippingAddress: dto.shippingAddress,       // undefined = unchanged; object = replace
    customerNote: dto.customerNote,             // undefined = unchanged; null = clear; string = set
  });
  res.setHeader('ETag', `"${result.version}"`);
  return result;
}

function parseEtag(raw: string): number {
  const m = /^(?:W\/)?"(\d+)"$/.exec(raw.trim());
  if (!m) throw new BadRequestException('Malformed If-Match');
  return Number(m[1]);
}
```

`PreconditionRequiredException` (428) is part of `@nestjs/common`. The `GET` handler must return the same `ETag` header so clients have something to send back.

The application service applies the three-way semantics and the version check:

```ts
// src/ordering/application/update-draft.service.ts (excerpt)
async execute(cmd: UpdateDraftCommand) {
  return this.uow.run(async ({ orders }, track) => {
    const order = await orders.findByIdForUpdate(cmd.orderId);
    if (!order) throw new OrderNotFoundError(cmd.orderId);
    if (order.version !== cmd.expectedVersion) throw new ConcurrencyError(`Order ${cmd.orderId} is at version ${order.version}`); // -> 412
    track(order);
    if (cmd.shippingAddress !== undefined) order.setShippingAddress(Address.of(cmd.shippingAddress));
    if (cmd.customerNote !== undefined) order.setCustomerNote(cmd.customerNote);   // null clears
    await orders.save(order);
    return { orderId: order.id, version: order.version + 1 };
  });
}
```

For JSON Patch, accept `Content-Type: application/json-patch+json`, apply with a library (`fast-json-patch`'s `applyPatch` with `validate: true`) to a DTO-shaped copy of the current representation, then validate the result with the same `UpdateOrderDto` before handing it to the domain. Never apply a JSON Patch directly to a database row or a domain object; the `path` values would become an attack surface.

#### PostgreSQL example

The version-checked update, with `COALESCE` for "unchanged" fields and explicit NULL for "cleared":

```sql
-- $2 = expected version; $3.. = new values or NULL; $n flags whether each field was provided.
UPDATE ordering.orders
SET ship_line2    = CASE WHEN $4 THEN $3 ELSE ship_line2 END,   -- $4 = "line2 provided?" (true even if $3 is NULL)
    customer_note = CASE WHEN $6 THEN $5 ELSE customer_note END,
    version       = version + 1,
    updated_at    = now()
WHERE id = $1 AND version = $2 AND status = 'DRAFT';
-- affected = 0  ->  either not found, not a draft, or version mismatch; the service disambiguates.
```

Most teams do this in the ORM (load, mutate, save with version) rather than in SQL, but the SQL shows the semantics clearly: "provided" is separate from "value".

#### TypeORM example

TypeORM's `save()` with `@VersionColumn` checks the version automatically and throws `OptimisticLockVersionMismatchError`. If you go through the repository from Part 17, the explicit `UPDATE ... WHERE version = :version` does the same. For merge-patch mapping onto an ORM entity in the pragmatic approach:

```ts
const row = await repo.findOneOrFail({ where: { id } });
if (row.version !== expectedVersion) throw new ConcurrencyError(...);
if (dto.customerNote !== undefined) row.customerNote = dto.customerNote;   // null clears
if (dto.shippingAddress !== undefined) Object.assign(row, toAddressColumns(dto.shippingAddress));
await repo.save(row);   // version incremented; mismatch throws OptimisticLockVersionMismatchError
```

#### Sequelize example

```ts
const row = await OrderModel.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
if (!row || row.version !== expectedVersion) throw new ConcurrencyError(...);
const changes: Partial<OrderAttributes> = {};
if (dto.customerNote !== undefined) changes.customerNote = dto.customerNote;
await row.update(changes, { transaction: t });   // with `version: true`, Sequelize bumps and checks the version
```

#### Production scenario

The mobile app and the web app both let a customer edit a draft cart's address. Before `If-Match`, support saw ~30 tickets a month of "my address changed back". After `If-Match` with 412 and a "this cart was updated elsewhere, reload?" prompt, the tickets stopped. The 412 rate in production was 0.4% of PATCH requests, which is exactly the rate at which two devices were racing.

#### Failure scenario

A PATCH handler did `if (dto.line2) order.line2 = dto.line2`. Customers who tried to clear the second address line (`"line2": null`) saw it come back every time. Worse, `"customerNote": ""` was treated as "not provided" and could never be cleared either. Tickets accumulated for months because nobody could reproduce "I deleted it and it is still there" from the API logs, where the null was plainly visible. `!== undefined` is the whole fix.

#### Edge cases & failure modes

- **Null vs undefined collapsed.** Cannot clear fields.
- **Patch on non-writable fields** accepted silently (`status`, `total`). Whitelist through the DTO and `forbidNonWhitelisted`.
- **No version check.** Last write wins; silent data loss between devices.
- **`If-Match` with a weak ETag (`W/"12"`)** when the server emitted a strong one. Decide and document; parse both.
- **JSON Patch `path` pointing at internals** (`/__proto__/polluted`, `/id`). Apply to a DTO copy, validate, never to live objects.
- **PATCH with relative operations** on retry (18.3). Keep absolute.
- **Nested partial updates.** Is `shippingAddress: { line2: "x" }` a merge into the existing address or a replacement? Decide per field; here, the address is a value object and is replaced whole. Document it.

#### How a Senior Backend Engineer thinks about this

They pick merge-patch for 95% of APIs, require `If-Match` on every PATCH of a resource that can be edited from two places, and they write the null/undefined table into the API docs. They keep the writable field set tiny; anything that is a state change gets a sub-resource, anything computed is read-only.

#### Common mistakes

- `PartialType(CreateOrderDto)` when `CreateOrderDto` includes fields that must not change after creation.
- `Object.assign(entity, dto)` with no allow-list.
- Treating `""`, `null` and `undefined` as the same.
- Returning 200 on a version conflict with the stale data.

#### Interview questions

1. *JSON Merge Patch vs JSON Patch: when do you use each?* Expected: simple field updates vs array/conditional operations; media types.
2. *How do you represent "clear this field" vs "leave it alone" in a PATCH?* Expected: `null` vs absent; `!== undefined` in code.
3. *How do you prevent lost updates when two devices edit the same resource?* Expected: `ETag`/`If-Match`, version column, 412, `UPDATE ... WHERE version = ...`.
4. *Which fields should never be patchable and where do those changes go?* Expected: status, totals, ownership; sub-resources for state changes.

#### Practical exercise

Implement `PATCH /orders/{id}` with merge-patch semantics, `If-Match` and 412, and `ETag` on `GET`. Write tests for: clearing `customerNote` with `null`, leaving it unchanged when absent, setting it to a string, rejecting `status` in the body with 400, and a concurrent-edit race where two PATCHes with the same `If-Match` result in exactly one 200 and one 412. Acceptance criteria: all five tests pass; the database column is actually NULL after the clear; no `if (dto.field)` truthiness checks in the code.
