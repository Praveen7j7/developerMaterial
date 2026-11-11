## 40.2 Calling LLM APIs from NestJS

### 40.2.1 Client setup, timeouts and retries

#### Concept

Calling an LLM from NestJS is calling a slow external HTTP API, so it needs the same resilience you give any external call (Part 34 — Reliability Engineering): a configured client, a timeout, retries with backoff, and error handling that distinguishes retryable from permanent failures. You wrap the provider SDK in a NestJS service so the rest of the application depends on your interface, not the vendor's.

#### Why does it exist?

An LLM provider can be slow, rate-limit you, or have an outage. Without a timeout, a slow call ties up your request handler and can cascade into an outage (Part 34). Without retries, a transient error fails a request that would have succeeded on the next attempt. Wrapping the SDK in your own service means you can swap providers, add caching and logging in one place, and keep vendor specifics out of your business logic.

#### Mental model

Your LLM service is an embassy between your application and a foreign power (the provider). Your application speaks your language (your domain types); the embassy translates to and from the provider's protocol, enforces your rules (timeouts, retries, logging, redaction), and shields your code from the provider's quirks and outages. If you change allegiances (switch providers), only the embassy changes, not the whole country.

#### How it works — the client and service

```ts
// llm/llm.module.ts
import { Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { ConfigService } from '@nestjs/config';
import { LlmService } from './llm.service';

export const LLM_CLIENT = 'LLM_CLIENT';

@Module({
  providers: [
    {
      provide: LLM_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Anthropic({
          apiKey: config.getOrThrow<string>('LLM_API_KEY'),
          timeout: 30_000,   // 30s ceiling; long completions should stream instead
          maxRetries: 2,     // SDK retries transient errors (429, 5xx) with backoff
        }),
    },
    LlmService,
  ],
  exports: [LlmService],
})
export class LlmModule {}
```

```ts
// llm/llm.service.ts
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LLM_CLIENT } from './llm.module';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(@Inject(LLM_CLIENT) private readonly client: Anthropic) {}

  async complete(params: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: params.maxTokens ?? 1024,
        system: params.system,
        messages: [{ role: 'user', content: params.user }],
      });

      if (response.stop_reason === 'max_tokens') {
        // Output was truncated: detect and handle, do not use silently.
        this.logger.warn('LLM output truncated at max_tokens');
      }
      // content is a list of blocks; collect the text blocks.
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return text;
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        // Retryable; surface as 503 with Retry-After upstream.
        throw new ServiceUnavailableException('LLM rate limited');
      }
      if (err instanceof Anthropic.APIError) {
        this.logger.error(`LLM error ${err.status}: ${err.message}`);
        throw new ServiceUnavailableException('LLM unavailable');
      }
      throw err;
    }
  }
}
```

The SDK's `maxRetries` handles transient errors (429, 5xx, connection errors) with exponential backoff automatically, so you do not hand-roll a retry loop for those. You add handling on top for mapping errors to HTTP responses and for the application-specific concerns (truncation, logging). The timeout is a hard ceiling; for genuinely long outputs you stream (40.2.2) rather than raising the timeout, because a 2-minute non-streaming request risks hitting HTTP timeouts anyway.

#### Deadlines: the client timeout is per attempt

One detail catches almost everyone. The SDK's `timeout` applies to **each attempt**, and timed-out attempts are retried. With `timeout: 30_000` and `maxRetries: 2`, a single call can block for up to 90 seconds of wall-clock time before it finally fails. Your endpoint promised the user (and the load balancer, which may cut the connection at 60 seconds) something much shorter. So set a per-request deadline that bounds the *whole* operation, retries included, and pass an `AbortSignal` so the work actually stops when the deadline passes:

```ts
// Per-request override: a short interactive deadline for the whole call, retries included.
async completeWithDeadline(params: { system: string; user: string }, deadlineMs = 12_000) {
  const signal = AbortSignal.timeout(deadlineMs); // aborts the in-flight HTTP request when it fires
  return this.client.messages.create(
    {
      model: 'claude-opus-5-5',
      max_tokens: 512,
      system: params.system,
      messages: [{ role: 'user', content: params.user }],
    },
    { timeout: 8_000, maxRetries: 1, signal }, // per attempt 8 s, at most one retry, hard stop at 12 s
  );
}
```

Choose the numbers from the latency profile, not from hope: if p99 for a 300-token answer is 7 seconds, an 8-second attempt timeout with one retry inside a 12-second deadline is honest. A background worker can afford a 120-second deadline; an interactive endpoint cannot.

#### Circuit breaker around the provider

Retries handle a blip; they make an outage worse, because every request now makes three slow calls instead of one. A **circuit breaker** (Part 34) counts failures and, past a threshold, stops calling the provider for a cool-down period, failing fast to the fallback instead. The widely used `opossum` library implements it:

```ts
// llm/llm-breaker.ts -- fail fast to a fallback when the provider is clearly down
import CircuitBreaker from 'opossum';

export function createLlmBreaker(
  call: (system: string, user: string) => Promise<string>,
  fallback: (system: string, user: string) => string,
) {
  const breaker = new CircuitBreaker(call, {
    timeout: 15_000,              // treat calls slower than 15 s as failures
    errorThresholdPercentage: 50, // open when half of recent calls fail...
    volumeThreshold: 20,          // ...but only after at least 20 calls in the window
    resetTimeout: 30_000,         // after 30 s, let one trial call through (half-open)
  });
  breaker.fallback(fallback);      // what callers get while the circuit is open
  breaker.on('open', () => console.warn('LLM circuit OPEN: serving fallback'));
  breaker.on('close', () => console.log('LLM circuit closed: provider healthy'));
  return breaker;                  // callers use: await breaker.fire(system, user)
}
```

The fallback is a product decision: a plain database-built summary, a cached previous answer, or an honest "the assistant is unavailable, here are your orders". What it must never be is a hang.

#### The config and secrets

The API key is a secret: it comes from the environment (Part 4 covers environment variables), is never committed, and in production comes from a secret manager (Part 50). A leaked LLM key is both a cost risk (someone runs up your bill) and a data risk, so it is guarded like a database password.

#### Production scenario

An order-support endpoint calls the LLM service. On a normal day, p50 latency is 2.5 seconds and the SDK's retries smooth over the occasional 429. During a provider incident, calls start timing out at 30 seconds; the error handling maps them to `503` with a `Retry-After`, so the endpoint degrades gracefully (and a circuit breaker, Part 34, stops hammering the provider) rather than hanging every request for 30 seconds and exhausting the thread pool. The business impact is "the AI assistant is temporarily unavailable" rather than "the whole support page is down".

#### Failure scenario

A team put an LLM call directly in a synchronous request handler with no timeout, using the raw SDK. During a provider slowdown, calls took 90 seconds instead of 3. Because there was no timeout, every request handler waited the full 90 seconds; within minutes the Node process had all its capacity tied up waiting on the LLM, and the entire service — including pages that did not use the LLM — went unresponsive. The fix was a 30-second timeout, a circuit breaker, and moving non-interactive LLM work to a background queue (40.4). The lesson is the same one from Part 34: an external call with no timeout is how one slow dependency takes down everything.

#### Edge cases & failure modes

- **No timeout**: a slow provider hangs your handlers and cascades into an outage.
- **Rate limits (429)**: handle with backoff and surface as `503` with `Retry-After`; do not fail hard on the first 429.
- **Provider outage (5xx)**: retries then a circuit breaker; a fallback (a canned response, a cached answer, or degrading the feature) keeps the rest of the app working.
- **Truncated output (`max_tokens`)**: detect via stop reason; either raise the cap, continue the generation, or tell the user it was cut off.
- **Leaked API key**: cost and data incident; rotate immediately, keep keys in a secret manager.
- **Network blips**: the SDK retries connection errors; your timeout still bounds the total.

#### How a Senior Backend Engineer thinks about this

A senior wraps the vendor SDK in their own service so the application depends on an interface they control, and treats the LLM call with the full external-dependency discipline from Part 34: timeout always, retries with backoff for transient errors, a circuit breaker to stop hammering a failing provider, and a graceful fallback so an LLM outage degrades one feature rather than taking down the service. They never put a non-interactive LLM call on a synchronous request path; interactive ones stream, and everything else goes to a queue. They map provider errors to honest HTTP status codes so clients and monitoring behave correctly.

#### Common mistakes

- Using the raw SDK throughout the codebase instead of behind one service, making provider changes and cross-cutting concerns hard.
- No timeout, causing cascading outages.
- Failing hard on a 429 instead of backing off.
- No fallback, so an LLM outage breaks the whole feature.
- The API key in code or committed config.

#### Interview questions

1. **Why wrap the provider SDK in your own NestJS service?** To depend on an interface you control, centralize timeouts/retries/logging/redaction/caching, and make switching providers or adding fallbacks a one-place change.
2. **What resilience must every LLM call have, and why?** A timeout (or streaming) to prevent cascading outages, retries with backoff for transient errors, a circuit breaker and a fallback; an LLM is a slow, flaky external dependency.
3. **How do you handle a 429 from the provider?** Back off and retry (the SDK does this); if it persists, surface a `503` with `Retry-After` rather than failing hard, and consider a circuit breaker.
4. **How do you detect that an LLM response was cut off?** The stop reason is `max_tokens`; handle it rather than using the truncated output silently.

5. **Your client has `timeout: 30s` and `maxRetries: 2`. What is the worst-case latency of one call, and how do you bound it?** Up to about 90 seconds plus backoff, because the timeout is per attempt and timeouts are retried. Bound it with a per-request deadline (an `AbortSignal` with a total time limit) and fewer retries on interactive paths. Follow-up: why not just set `maxRetries: 0`? Because transient 429s and connection resets are common; one retry inside a deadline is usually the right compromise.
6. **Why put a circuit breaker in front of an LLM provider when the SDK already retries?** Retries help with blips but multiply load and latency during an outage; a breaker detects the outage, fails fast to a fallback, and probes for recovery, protecting both your service and the provider.

#### Practical exercise

Build an `LlmService` wrapping the provider SDK with a 30-second timeout, SDK retries, error mapping (429 and 5xx to `503`), and stop-reason checking. Add a fallback so that when the LLM is unavailable, an order-summary endpoint returns a plain non-AI summary built from the database instead of failing. Acceptance criteria: a simulated provider outage degrades the feature to the fallback without hanging or crashing the endpoint.

### 40.2.2 Streaming responses to the browser

#### Concept

Because an LLM generates output token by token over several seconds, making the user wait for the whole completion before showing anything feels broken. **Streaming** sends each piece of the output to the client as it is generated, so the user sees text appear progressively — the familiar "typing" effect. On the backend, you stream the provider's token stream through your server to the browser, commonly using Server-Sent Events (SSE).

#### Why does it exist?

A 10-second wait with a blank screen is a bad experience; the same 10 seconds with text streaming in feels fast and responsive. Streaming also avoids HTTP timeouts on long completions and lets the user read (and sometimes stop) the response before it finishes. For any interactive, user-facing LLM feature, streaming is the default.

#### Mental model

Without streaming, you order food and wait at an empty table until the entire multi-course meal is ready, then it all arrives at once. With streaming, each course comes out as it is cooked, so you start eating immediately and the wait feels shorter even though the kitchen takes the same total time. Streaming does not make the LLM faster; it makes the experience feel faster by delivering output as it is produced.

#### How it works

```ts
// llm.controller.ts -- stream an answer to the browser via SSE
import { Controller, Post, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LlmService } from './llm.service';

@Controller('assistant')
export class AssistantController {
  constructor(private readonly llm: LlmService) {}

  @Post('stream')
  async stream(@Body() body: { question: string }, @Res() res: Response) {
    // Set up Server-Sent Events headers.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      for await (const text of this.llm.streamComplete({
        system: 'You are an order-support assistant.',
        user: body.question,
      })) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`); // one SSE event per chunk
      }
      res.write('data: [DONE]\n\n');
    } catch {
      res.write(`data: ${JSON.stringify({ error: 'stream failed' })}\n\n`);
    } finally {
      res.end();
    }
  }
}
```

```ts
// in LlmService -- yield text chunks as they arrive
async *streamComplete(params: { system: string; user: string }): AsyncGenerator<string> {
  const stream = await this.client.messages.stream({
    model: 'claude-opus-5-5',
    max_tokens: 2048,
    system: params.system,
    messages: [{ role: 'user', content: params.user }],
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;   // emit each piece of text as it is generated
    }
  }
}
```

The server consumes the provider's stream and forwards each text chunk to the browser as an SSE event. The browser's JavaScript listens and appends each chunk to the page. Key operational details: you must handle the client disconnecting (stop consuming the provider stream to avoid paying for output nobody will read — Part 2 cancellation), and you still enforce limits (`max_tokens`, rate limits) on a streamed call.

#### NestJS example

The controller above shows the raw mechanics but has a costly gap: when the browser disconnects, the loop keeps reading the provider stream until the model finishes. NestJS has first-class SSE support through the `@Sse()` decorator, which expects an `Observable` of `MessageEvent` objects. The Observable's teardown function runs when the client disconnects, which is exactly where you abort the upstream call:

```ts
// assistant/assistant-sse.controller.ts -- NestJS-native SSE with upstream cancellation
import { Controller, Inject, MessageEvent, Query, Sse, UseGuards } from '@nestjs/common';
import { Observable } from 'rxjs';
import Anthropic from '@anthropic-ai/sdk';
import { LLM_CLIENT } from '../llm/llm.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('assistant')
@UseGuards(JwtAuthGuard)
export class AssistantSseController {
  constructor(@Inject(LLM_CLIENT) private readonly client: Anthropic) {}

  @Sse('answer') // SSE endpoints are GET: the browser uses new EventSource('/assistant/answer?q=...')
  answer(@Query('q') question: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false; // set when the client goes away
      const stream = this.client.messages.stream({
        model: 'claude-opus-5-5',
        max_tokens: 1024,
        system: 'You are an order-support assistant. Answer briefly.',
        messages: [{ role: 'user', content: question }],
      });

      stream.on('text', (delta) => subscriber.next({ data: { text: delta } }));

      stream
        .finalMessage() // resolves once the stream completes; rejects on error or abort
        .then((msg) => {
          subscriber.next({ data: { done: true, stopReason: msg.stop_reason } });
          subscriber.complete();
        })
        .catch((err) => {
          if (!subscriber.closed) subscriber.next({ data: { error: 'stream_failed' } });
          subscriber.complete();
          if (!cancelled) console.error('LLM stream error', err);
        });

      // Teardown: runs when the client disconnects or the Observable completes.
      return () => {
        cancelled = true;
        stream.abort(); // stop generating (and paying for) output nobody will read
      };
    });
  }
}
```

Two practical notes. `EventSource` in the browser only sends GET requests and cannot set custom headers, so either authenticate with a cookie, or use `fetch()` with a streaming body reader on the client if you need a POST body and a bearer token (the Express version above supports that). And keep the question length validated (a DTO with `@MaxLength`) even on GET; a query string is still untrusted input.

#### Production scenario

An assistant page serves 2,000 concurrent viewers at peak. Measured with streaming: time to first visible text is 600–900 ms; the full answer arrives in 4–6 seconds. Without streaming, users stared at a spinner for the whole 4–6 seconds and the abandon rate (closing the panel before the answer appeared) was 18%; with streaming it dropped to 4%. Instrumenting disconnects showed that about 9% of streams were abandoned midway. Before the teardown abort was added, those abandoned streams kept generating to completion, which was roughly 6% of the feature's output-token bill spent on text nobody saw.

#### Failure scenario

After a move behind a new reverse proxy, users reported that the assistant "freezes, then dumps the whole answer at once". The backend logs showed normal streaming. The proxy was buffering responses until they completed, which silently turned streaming into a slow non-streaming call; long answers also hit the proxy's 60-second read timeout and were cut off. The fix was proxy configuration (disable response buffering for the SSE route; with nginx, the backend can send the `X-Accel-Buffering: no` header), plus a comment heartbeat every 15 seconds (`: ping`) so idle-timeout rules do not close a connection while the model is thinking before its first token. The lesson: streaming is an end-to-end property, and every hop (CDN, load balancer, proxy) must allow it.

#### Edge cases & failure modes

- **Client disconnects mid-stream** (user navigates away): detect it and abort the provider stream, or you keep generating and paying for discarded output.
- **An error partway through** the stream: you have already sent some output; send an error event so the client knows it is incomplete, and do not treat a partial stream as a complete answer.
- **Buffering proxies**: some proxies buffer responses, defeating streaming; SSE headers and proxy config matter.
- **Backpressure**: if the browser reads slowly, the server must handle backpressure (Part 13, Part 34) rather than buffering unboundedly.
- **Partial output persisted**: if you store the result, store it only on successful completion, not mid-stream.
- **Long silence before the first token** (large prompt, model reasoning first): idle timeouts at a proxy or load balancer can close the connection; send periodic SSE comment lines as a heartbeat.
- **Retries and streams do not mix casually**: if a stream fails after sending half an answer, retrying from scratch shows the user duplicated text; either restart the UI message cleanly or show an error and let the user retry.
- **Too many open streams**: each open SSE connection holds a socket and some memory; 2,000 concurrent streams is fine for Node, 50,000 needs capacity planning (Part 38 — Real-Time Systems).

#### How a Senior Backend Engineer thinks about this

A senior streams every interactive LLM response and plans for the stream's failure modes: client disconnect (cancel the upstream call to stop paying), mid-stream error (signal the client, do not persist a partial answer), and backpressure. They keep the limits (token cap, rate limit, timeout-as-overall-ceiling) in force even when streaming. For non-interactive work (a batch summarization job, an async classification), they do not stream to a user at all — they push it to a background queue (40.4) and store the result. The decision is simple: a human is watching, stream; no human is watching, queue.

#### Common mistakes

- Not streaming interactive responses, making the feature feel broken.
- Continuing to consume the provider stream after the client disconnects, wasting money.
- Treating a partial (errored) stream as a complete answer.
- Streaming non-interactive batch work that should be a background job.

#### Interview questions

1. **Why stream LLM responses to the browser?** Output is generated token by token over seconds; streaming shows progress immediately, improves perceived latency, and avoids HTTP timeouts on long completions.
2. **What must you do when the client disconnects mid-stream?** Abort the upstream provider call so you stop generating and paying for output nobody will read.
3. **When should you not stream, and what do you do instead?** For non-interactive work with no human watching; push it to a background queue and store the result.

#### Practical exercise

Build a streaming assistant endpoint using SSE that forwards the provider's token stream to the browser, and add handling so that if the client disconnects, the upstream provider stream is aborted. Acceptance criteria: text appears progressively in the browser, and disconnecting the client stops the upstream generation (verify the provider call is cancelled, not left running).
