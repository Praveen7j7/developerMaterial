### 40.3.3 Cost and latency engineering

#### Concept

At any real scale, an LLM feature's cost and latency must be engineered deliberately, using the same toolkit as the rest of the book: caching, routing to cheaper resources, batching, and bounding work. The levers specific to LLMs are prompt caching, model routing (small model for easy tasks, large for hard), token budgeting (shorter prompts and capped outputs), and response caching (cache the whole answer for identical requests).

#### Why does it exist?

An LLM feature's bill is driven by tokens, and tokens add up fast (40.1). An uncached, unbounded feature sending huge prompts on every request can cost tens of thousands of dollars a month for what a few levers could reduce by an order of magnitude. Latency, meanwhile, directly affects user experience and can cause timeouts. Engineering both is what makes an LLM feature viable in production rather than a demo that bankrupts you at scale.

#### Mental model

Imagine paying a translator by the word. You would not hand them the whole company archive to translate one paragraph (input-token hygiene); you would not ask the senior legal translator to do a menu (model routing); you would keep the translations you already paid for and reuse them (response caching); and for standard boilerplate you would agree a discounted rate because it is the same every time (prompt caching). None of these makes the translation worse. Only after doing all of them do you start negotiating quality for price.

#### How it works — the levers, in order of free-to-costly

```text
1. Prompt caching       cache the stable prefix; repeated calls pay ~10% for it   (free quality)
2. Response caching      identical request -> cached answer from Redis (Part 30)   (free quality)
3. Input-token hygiene   send only the data the task needs; trim history           (free quality)
4. Output cap            set max_tokens to the real need; shorter is cheaper/faster (free quality)
5. Batching              group non-interactive requests into a batch endpoint      (~50% cheaper)
6. Model routing         cheap model for easy tasks, expensive only when needed    (tradeoff)
7. Effort / depth        lower reasoning effort for simple tasks                   (tradeoff)
```

The first four cost you nothing in quality and should always be applied. Caching the stable prefix and, where the same request recurs, caching the whole response in Redis (cache-aside, Part 30) are the biggest free wins. Sending only the data the task needs — not the customer's entire history when three recent orders suffice — cuts input tokens directly. Capping output to the real need saves both money and time.

Beyond the free wins come tradeoffs. **Model routing** sends easy tasks (simple classification) to a small, cheap, fast model and reserves the large expensive model for hard tasks; a classifier that decides which does not need to be large. **Batching** processes non-interactive requests asynchronously at roughly half the cost, suitable for overnight jobs. Lower reasoning **effort** for simple tasks spends fewer tokens.

```ts
// Response caching (cache-aside, Part 30) for identical requests.
async function summarizeCached(orderHash: string, build: () => Promise<string>): Promise<string> {
  const key = `llm:summary:v3:${orderHash}`;
  const hit = await redis.get(key);
  if (hit) return hit;                 // free: no LLM call at all
  const summary = await build();        // the LLM call, only on a miss
  await redis.set(key, summary, 'EX', 3600);
  return summary;
}
```

Two cautions about response caching. First, the cache key must include everything that changes the answer: the prompt version, the model, and a hash of the exact input data (here the order snapshot), or a cached answer will describe an order as "processing" after it shipped. Second, cache only answers that do not depend on who is asking, or include the user id in the key; a cached answer containing one customer's details served to another is a data leak, not a performance bug. Section 40.6 turns the remaining levers (model routing, batching and per-user token budgets) into working code.

#### Practical example

An order-summary feature at 100,000 calls/day initially cost about $1,800/day. Applying the free levers: prompt-caching the stable system prompt and instructions, trimming the input to the three most recent orders instead of the full history, capping output at 300 tokens, and response-caching identical requests (many users re-open the same order) cut the cost by roughly 80% with no quality loss. Routing the simplest sub-task (classifying the request type) to a small cheap model removed another slice. The feature went from a cost concern to a rounding error, purely through engineering the same caching and routing habits used everywhere else in this book.

#### How a Senior Backend Engineer thinks about this

A senior applies the free levers first — prompt caching, response caching, input-token hygiene, output caps — before reaching for any tradeoff, because those cost nothing in quality. They measure cost per completed task (not per call) and latency at p50 and p99, then tune per feature. They route cheap tasks to cheap models and reserve the expensive model for work that needs it, and they push non-interactive work to batch for roughly half price. They treat an LLM feature's cost as a first-class metric on a dashboard (40.4) with alerts, because an LLM feature can quietly become the biggest line on the cloud bill, and a single bad change (an uncached huge prompt) can multiply it overnight.

#### Common mistakes

- Not caching the stable prompt prefix or identical responses, paying full price repeatedly.
- Sending more data than the task needs, inflating input tokens.
- No output cap, allowing long, slow, expensive completions.
- Using the largest model for every task, including trivial ones.
- Not monitoring cost, so a regression goes unnoticed until the bill arrives.

#### Interview questions

1. **What are the no-cost levers for reducing LLM cost?** Prompt caching the stable prefix, response caching identical requests, sending only the needed input, and capping output tokens — none sacrifice quality.
2. **When would you route a task to a smaller, cheaper model?** For easy, high-volume tasks (simple classification) where a large model's extra capability is wasted; reserve the expensive model for hard tasks.
3. **How does prompt caching reduce cost and latency?** A stable prompt prefix is cached so repeated calls pay a fraction (around a tenth) for it and start faster; structure prompts with the stable part first.
4. **Why measure cost per completed task rather than per call?** A cheaper call that needs more retries or turns to finish the job is not actually cheaper; the real metric is the cost to complete the work.

#### Practical exercise

Take an LLM feature and apply the free levers: cache the stable prompt prefix, add Redis response caching for identical requests, trim the input to only the needed data, and cap `max_tokens`. Measure the cost and p50 latency before and after. Then route the simplest sub-task to a smaller model and measure again. Acceptance criteria: you demonstrate a substantial cost reduction from the free levers alone with no loss of output quality, verified against a small evaluation set.

## 40.4 Rate limits, queueing and backpressure

### 40.4.1 Managing quotas and queueing LLM jobs

#### Concept

LLM providers impose rate limits (requests per minute, tokens per minute), and your own users should have limits too (so one user cannot run up your bill). When demand exceeds what you can process immediately, you queue the work rather than dropping it or hammering the provider. For non-interactive LLM tasks, a background job queue (BullMQ, Part 39 — Background Jobs and Schedulers) with controlled concurrency is the standard pattern.

#### Why does it exist?

If every user request triggered an immediate LLM call, a traffic spike would blow past the provider's rate limit (getting you 429s and failed requests) and your bill would be uncontrolled. Per-user limits stop abuse and runaway cost. A queue absorbs spikes, smooths load to stay within provider limits, and lets you process non-interactive work (summaries, classifications, enrichment) reliably with retries, without making a user wait synchronously for a slow LLM call.

#### Mental model

Think of the LLM provider as a popular restaurant with a fixed number of tables (the rate limit). If a crowd arrives at once, you cannot seat them all; without management, people get turned away (429s). A queue is the host maintaining a waitlist and seating parties at a steady pace the kitchen can handle, so nobody is turned away and the kitchen is never overwhelmed. Per-user limits are the rule that one party cannot book every table.

#### How it works

```ts
// Per-user rate limiting with NestJS throttler or a Redis token bucket (Part 11, Part 30).
// Queue non-interactive LLM work with BullMQ (Part 39).

// Producer: enqueue instead of calling the LLM synchronously.
@Injectable()
export class SummaryService {
  constructor(@InjectQueue('llm-summaries') private readonly queue: Queue) {}

  async requestSummary(orderId: string, userId: string): Promise<{ jobId: string }> {
    const job = await this.queue.add('summarize', { orderId, userId }, {
      attempts: 3,                                  // retry transient failures
      backoff: { type: 'exponential', delay: 2000 },
    });
    return { jobId: job.id! };                       // return immediately; result fetched later
  }
}
```

```ts
// Worker: bounded concurrency keeps you within the provider's rate limit.
@Processor('llm-summaries', { concurrency: 5 })     // at most 5 LLM calls at once
export class SummaryProcessor extends WorkerHost {
  constructor(private readonly llm: LlmService) { super(); }

  async process(job: Job<{ orderId: string; userId: string }>): Promise<string> {
    const summary = await this.llm.complete({ /* ... */ });
    // store the result keyed by job/order so the client can fetch it
    return summary;
  }
}
```

The pattern: for interactive requests, call synchronously and stream (40.2); for anything else, enqueue and return a job id, then let a worker with bounded concurrency process the queue at a rate within the provider's limit, with retries and a dead-letter queue for poison jobs (Part 39). Per-user rate limiting (NestJS `@nestjs/throttler` or a Redis token bucket) caps how much any one user can consume.

#### Backpressure

When the queue grows faster than the workers drain it (a sustained spike, or a provider slowdown), you have backpressure. The responses: bound the queue and reject new work with a clear "try later" when it is full, scale workers up to the provider's rate limit but no further (more workers past the limit just produce 429s), and shed low-priority work first. This is the same backpressure thinking as Part 13 and Part 34, applied to LLM work.

#### NestJS example

Three pieces work together: a per-user request limit at the edge, a bounded queue that refuses work when it is too deep, and a worker whose rate matches the provider's limit and which backs off when the provider says 429 anyway.

```ts
// llm/user-throttler.guard.ts -- limit by authenticated user, not by IP
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    // Many users share one office IP; one user can rotate IPs. Track the account.
    return req.user?.id ?? req.ip;
  }
}

// app.module.ts (excerpt): ttl is in milliseconds in current @nestjs/throttler versions
// ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
// For multiple app instances, configure shared storage (for example a Redis-backed storage) so the
// limit is global, not per pod.
```

```ts
// summaries/summary.controller.ts -- tighter limit on the expensive route + queue backpressure
import { Controller, Param, Post, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { UserThrottlerGuard } from '../llm/user-throttler.guard';

const MAX_WAITING = 5_000; // beyond this, new work would wait longer than anyone will tolerate

@Controller('orders')
@UseGuards(UserThrottlerGuard)
export class SummaryController {
  constructor(@InjectQueue('llm-summaries') private readonly queue: Queue) {}

  @Post(':id/summary')
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // 5 summaries per user per minute
  async request(@Param('id') orderId: string, @Req() req: { user: { id: string } }) {
    if ((await this.queue.getWaitingCount()) > MAX_WAITING) {
      throw new ServiceUnavailableException('Summaries are busy, try again in a minute'); // shed load
    }
    const job = await this.queue.add(
      'summarize',
      { orderId, userId: req.user.id },
      { jobId: `summary:${orderId}`, attempts: 3, backoff: { type: 'exponential', delay: 2_000 } },
    ); // jobId dedupes: ten clicks on "summarize" create one job, not ten
    return { jobId: job.id };
  }
}
```

```ts
// summaries/summary.processor.ts -- rate matched to the provider, manual backoff on 429
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Worker } from 'bullmq';
import Anthropic from '@anthropic-ai/sdk';
import { LlmService } from '../llm/llm.service';

@Processor('llm-summaries', {
  concurrency: 5,                          // at most 5 calls in flight per worker process
  limiter: { max: 50, duration: 60_000 },  // at most 50 jobs per minute across all workers on this queue
})
export class SummaryProcessor extends WorkerHost {
  constructor(private readonly llm: LlmService) { super(); }

  async process(job: Job<{ orderId: string; userId: string }>): Promise<string> {
    try {
      return await this.llm.summarizeOrder(job.data.orderId, job.data.userId);
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) {
        // The provider is saturated: pause the whole queue for 30 s and retry this job later
        // without burning one of its attempts.
        await this.worker.rateLimit(30_000);
        throw Worker.RateLimitError();
      }
      throw err; // other errors use the job's attempts and backoff, then land in the failed set
    }
  }
}
```

The `limiter` is shared through Redis by every worker on the queue, so adding pods adds concurrency but never exceeds 50 jobs a minute. That is the property you want: the provider's quota is a global resource, so the throttle must be global too. Note that the `LlmService` here should be created with SDK retries turned down (or off) for queue work, so that retries happen in one place (the queue) rather than multiplying inside each attempt.

#### Production scenario

A nightly job enriches 200,000 product descriptions; during the day, interactive order summaries need capacity too. The account's limit is 4,000 requests and 2 million tokens per minute. The team splits it deliberately: the interactive path gets priority and roughly 70% of the budget; the enrichment queue's limiter is set to 1,000 jobs per minute, so 200,000 jobs take about 3.5 hours overnight and never starve daytime users. Better still, the enrichment moved to the provider's asynchronous batch API (40.6), which costs about half and does not consume the interactive rate limit at all.

#### Failure scenario

A marketing email linked to a new "AI order recap" page. Within five minutes, 30,000 users clicked. The endpoint called the LLM synchronously with no per-user limit and no queue. The provider started returning 429s at about 1,200 requests per minute; the SDK retried each one twice, tripling the request rate into the limit; Node held 9,000 open requests waiting on retries; the pods ran out of memory and restarted, taking the rest of the order pages with them. Recovery needed a deploy that switched the recap to enqueue-and-poll with a 5,000-job cap, a per-user limit, and a worker limiter at 80% of the provider quota. The lesson: a rate limit you do not enforce yourself will be enforced on you by the provider, at the worst moment, with retries amplifying it.

#### Edge cases & failure modes

- **Per-pod limits**: an in-memory throttler with 10 pods allows ten times the intended limit; use shared storage.
- **Retry amplification**: SDK retries inside queue attempts inside client retries multiply load; retry in exactly one layer.
- **Duplicate jobs** from double-clicks or client retries: a deterministic `jobId` deduplicates.
- **Token limits, not just request limits**: one huge prompt can consume a minute's token quota; limit by tokens for features with variable input size (40.6).
- **Poison jobs**: an order whose data always makes the prompt overflow fails every attempt; after the attempts, it must sit in the failed set with an alert, not loop.
- **Results never collected**: store results with a TTL so abandoned jobs do not grow Redis forever.

#### How a Senior Backend Engineer thinks about this

A senior puts per-user rate limits on LLM features from day one, because an unmetered LLM endpoint is an open invitation to run up the bill, maliciously or accidentally. They queue all non-interactive LLM work with bounded worker concurrency tuned to the provider's rate limit, with retries and a dead-letter queue, so spikes are absorbed and transient failures recovered. They treat the provider's rate limit as a hard capacity ceiling and design the system to stay under it rather than discovering it through 429 storms. And they keep interactive work (streamed, synchronous) separate from background work (queued), because the two have completely different latency and reliability requirements.

#### Common mistakes

- No per-user limit, allowing one user to exhaust your quota and budget.
- Calling the LLM synchronously for non-interactive work, making users wait and risking timeouts.
- Unbounded worker concurrency that blows past the provider's rate limit into 429s.
- No retries or dead-letter queue, so transient failures lose work and poison jobs block the queue.
- No queue bound, so a spike grows the queue without limit instead of shedding load.

#### Interview questions

1. **Why queue non-interactive LLM work instead of calling synchronously?** To absorb spikes, stay within the provider's rate limit via bounded concurrency, get retries and reliability, and avoid making users wait on slow calls.
2. **Why impose per-user rate limits on an LLM feature?** To prevent one user from exhausting your provider quota and running up your bill, maliciously or accidentally.
3. **How do you tune worker concurrency for LLM jobs?** To the provider's rate limit — enough to use the capacity, not so much that you exceed it and get 429s.
4. **What is backpressure here and how do you handle it?** The queue growing faster than workers drain it; bound the queue and shed or defer low-priority work, scale workers only up to the rate limit, and reject new work with a clear "try later" when full.

#### Practical exercise

Convert a synchronous order-summary endpoint into an enqueue-and-poll design: the endpoint adds a BullMQ job and returns a job id, a worker with concurrency tuned to the provider limit processes it with retries and a dead-letter queue, and a second endpoint returns the result by job id. Add a per-user rate limit. Acceptance criteria: a burst of requests does not produce provider 429s, failed jobs retry then dead-letter, and one user cannot exceed their limit.
