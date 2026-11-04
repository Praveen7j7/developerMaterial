## 59.2 Calling LLM APIs from NestJS

### 59.2.1 Client setup, timeouts and retries

#### Concept

Calling an LLM from NestJS is calling a slow external HTTP API, so it needs the same resilience you give any external call (Part 38): a configured client, a timeout, retries with backoff, and error handling that distinguishes retryable from permanent failures. You wrap the provider SDK in a NestJS service so the rest of the application depends on your interface, not the vendor's.

#### Why does it exist?

An LLM provider can be slow, rate-limit you, or have an outage. Without a timeout, a slow call ties up your request handler and can cascade into an outage (Part 70). Without retries, a transient error fails a request that would have succeeded on the next attempt. Wrapping the SDK in your own service means you can swap providers, add caching and logging in one place, and keep vendor specifics out of your business logic.

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
        model: 'claude-opus-4-8',
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

The SDK's `maxRetries` handles transient errors (429, 5xx, connection errors) with exponential backoff automatically, so you do not hand-roll a retry loop for those. You add handling on top for mapping errors to HTTP responses and for the application-specific concerns (truncation, logging). The timeout is a hard ceiling; for genuinely long outputs you stream (59.2.2) rather than raising the timeout, because a 2-minute non-streaming request risks hitting HTTP timeouts anyway.

#### The config and secrets

The API key is a secret: it comes from the environment (Part 72), is never committed, and in production comes from a secret manager (Part 28). A leaked LLM key is both a cost risk (someone runs up your bill) and a data risk, so it is guarded like a database password.

#### Production scenario

An order-support endpoint calls the LLM service. On a normal day, p50 latency is 2.5 seconds and the SDK's retries smooth over the occasional 429. During a provider incident, calls start timing out at 30 seconds; the error handling maps them to `503` with a `Retry-After`, so the endpoint degrades gracefully (and a circuit breaker, Part 38, stops hammering the provider) rather than hanging every request for 30 seconds and exhausting the thread pool. The business impact is "the AI assistant is temporarily unavailable" rather than "the whole support page is down".

#### Failure scenario

A team put an LLM call directly in a synchronous request handler with no timeout, using the raw SDK. During a provider slowdown, calls took 90 seconds instead of 3. Because there was no timeout, every request handler waited the full 90 seconds; within minutes the Node process had all its capacity tied up waiting on the LLM, and the entire service — including pages that did not use the LLM — went unresponsive. The fix was a 30-second timeout, a circuit breaker, and moving non-interactive LLM work to a background queue (59.4). The lesson is the same one from Part 70: an external call with no timeout is how one slow dependency takes down everything.

#### Edge cases & failure modes

- **No timeout**: a slow provider hangs your handlers and cascades into an outage.
- **Rate limits (429)**: handle with backoff and surface as `503` with `Retry-After`; do not fail hard on the first 429.
- **Provider outage (5xx)**: retries then a circuit breaker; a fallback (a canned response, a cached answer, or degrading the feature) keeps the rest of the app working.
- **Truncated output (`max_tokens`)**: detect via stop reason; either raise the cap, continue the generation, or tell the user it was cut off.
- **Leaked API key**: cost and data incident; rotate immediately, keep keys in a secret manager.
- **Network blips**: the SDK retries connection errors; your timeout still bounds the total.

#### How a Senior Backend Engineer thinks about this

A senior wraps the vendor SDK in their own service so the application depends on an interface they control, and treats the LLM call with the full external-dependency discipline from Part 38: timeout always, retries with backoff for transient errors, a circuit breaker to stop hammering a failing provider, and a graceful fallback so an LLM outage degrades one feature rather than taking down the service. They never put a non-interactive LLM call on a synchronous request path; interactive ones stream, and everything else goes to a queue. They map provider errors to honest HTTP status codes so clients and monitoring behave correctly.

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

#### Practical exercise

Build an `LlmService` wrapping the provider SDK with a 30-second timeout, SDK retries, error mapping (429 and 5xx to `503`), and stop-reason checking. Add a fallback so that when the LLM is unavailable, an order-summary endpoint returns a plain non-AI summary built from the database instead of failing. Acceptance criteria: a simulated provider outage degrades the feature to the fallback without hanging or crashing the endpoint.

### 59.2.2 Streaming responses to the browser

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
    model: 'claude-opus-4-8',
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

The server consumes the provider's stream and forwards each text chunk to the browser as an SSE event. The browser's JavaScript listens and appends each chunk to the page. Key operational details: you must handle the client disconnecting (stop consuming the provider stream to avoid paying for output nobody will read — Part 70 cancellation), and you still enforce limits (`max_tokens`, rate limits) on a streamed call.

#### Edge cases & failure modes

- **Client disconnects mid-stream** (user navigates away): detect it and abort the provider stream, or you keep generating and paying for discarded output.
- **An error partway through** the stream: you have already sent some output; send an error event so the client knows it is incomplete, and do not treat a partial stream as a complete answer.
- **Buffering proxies**: some proxies buffer responses, defeating streaming; SSE headers and proxy config matter.
- **Backpressure**: if the browser reads slowly, the server must handle backpressure (Part 3) rather than buffering unboundedly.
- **Partial output persisted**: if you store the result, store it only on successful completion, not mid-stream.

#### How a Senior Backend Engineer thinks about this

A senior streams every interactive LLM response and plans for the stream's failure modes: client disconnect (cancel the upstream call to stop paying), mid-stream error (signal the client, do not persist a partial answer), and backpressure. They keep the limits (token cap, rate limit, timeout-as-overall-ceiling) in force even when streaming. For non-interactive work (a batch summarization job, an async classification), they do not stream to a user at all — they push it to a background queue (59.4) and store the result. The decision is simple: a human is watching, stream; no human is watching, queue.

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
