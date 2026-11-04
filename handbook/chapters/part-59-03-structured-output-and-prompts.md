## 59.3 Structured output and prompt design

### 59.3.1 Getting JSON you can trust

#### Concept

Most backend LLM features do not want prose; they want structured data — a classification label, extracted fields, a decision with a reason. Getting the model to return well-formed JSON that matches a schema, and validating it before use, is **structured output**. Modern providers support it via a schema parameter or tool/function calling that constrains the output; whichever you use, you validate the result against your own schema with a tool like `class-validator` (Part 23) or `zod`.

#### Why does it exist?

If you ask an LLM for free text and try to parse fields out of it, you get a brittle mess: the model wraps the JSON in prose, adds a trailing comment, uses a different field name, or hallucinates a value. Structured output makes the model return machine-readable data in your shape, and validation guarantees that what reaches your business logic actually matches that shape. This turns an unreliable text generator into a dependable component you can build on.

#### Mental model

Asking an LLM for free-form text and parsing it is like asking someone to "tell me about this order" and then trying to extract the total from their rambling answer. Structured output is handing them a form with labelled boxes and saying "fill in these exact fields." Validation is checking the form before filing it — rejecting one with a missing field or a letter where a number belongs. The form and the check together are what make the output trustworthy.

#### How it works

The robust pattern has two layers: ask the model for structured output (via the provider's schema/structured-output feature or tool calling), and independently validate the result against your own schema. Never skip the second layer — the provider's constraint reduces errors but your validation is the guarantee.

```ts
// Define the shape you expect and validate against it.
import { IsIn, IsInt, IsString, Min, validateOrReject } from 'class-validator';
import { plainToInstance } from 'class-transformer';

class SupportTriage {
  @IsIn(['billing', 'shipping', 'technical', 'other'])
  category!: 'billing' | 'shipping' | 'technical' | 'other';

  @IsInt() @Min(1)
  urgency!: number;        // 1 (low) to 5 (urgent)

  @IsString()
  reason!: string;
}

async function triage(message: string): Promise<SupportTriage> {
  const raw = await llm.completeJson({
    system:
      'Classify the support message. Respond ONLY with JSON matching: ' +
      '{ "category": "billing"|"shipping"|"technical"|"other", "urgency": 1-5, "reason": string }',
    user: message,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);           // JSON.parse, never string-matching (Part 59.1)
  } catch {
    throw new Error('LLM did not return valid JSON');
  }
  const triage = plainToInstance(SupportTriage, parsed);
  await validateOrReject(triage);        // rejects wrong shape/values -> you handle it
  return triage;                         // now safe to use and store
}
```

Two rules. First, always `JSON.parse` and then validate — the model can return valid JSON with the wrong shape (a `category` outside your allowed set, a missing field, a string where a number belongs). Second, decide what to do on a validation failure: retry once (the model may comply on a second attempt), fall back to a default, or raise an error — but never pass unvalidated LLM output into your database or business logic.

#### Tool / function calling

Providers also let you declare "tools" (functions) the model can call, with a typed schema for the arguments. The model returns a structured call to a named function with validated-shape arguments, which you then execute. This is the foundation of agents (Part 60) and a clean way to get structured output when the task is "decide which action to take and with what parameters". Use the provider's `strict` schema option where available so the arguments are guaranteed to match your schema, and still validate on your side.

#### Practical example

An order-support assistant extracts a structured intent from the user's message — `{ intent: 'refund' | 'track' | 'cancel' | 'question', orderId?: string }` — validates it, and routes to the right handler. The LLM turns messy natural language ("where's my stuff from last week, order 10052?") into a typed, validated object your existing code can act on. The LLM is doing the language understanding; your validated schema and your handlers do the actual, trustworthy work.

#### Edge cases & failure modes

- **Valid JSON, wrong shape**: the number-one structured-output failure; catch it with validation, not hope.
- **JSON wrapped in prose** ("Here is the JSON: {...}"): structured-output features avoid this; if using plain prompting, instruct "respond with only JSON" and handle extraction defensively.
- **Hallucinated values**: the model invents an order id that does not exist; validate against reality (does that order exist and belong to this user?) before acting, not just against the schema.
- **Repeated failures**: if the model will not produce valid output after a retry, fall back gracefully rather than looping forever (and paying for each attempt).
- **Schema drift**: if you change the expected shape, update both the prompt and the validator; a mismatch silently breaks.

#### How a Senior Backend Engineer thinks about this

A senior never trusts LLM output structurally or semantically without validation. Structurally, they use the provider's structured-output or tool-calling feature and then validate against their own schema — two layers, because the provider's constraint is a strong hint, not a guarantee they own. Semantically, they validate against reality: a model-supplied order id is checked for existence and ownership before anything acts on it, because a schema-valid id can still be hallucinated. They treat an LLM that extracts an intent as a sophisticated parser whose output enters the system through the same validation gate as any other untrusted input (Part 23, Part 71).

#### Common mistakes

- Trusting the model's JSON because the prompt asked for it, without parsing and validating.
- Validating the shape but not the meaning (accepting a hallucinated id that is well-formed but does not exist).
- Retrying forever on invalid output, running up cost.
- Letting unvalidated LLM output reach the database or business logic.

#### Interview questions

1. **How do you get trustworthy structured output from an LLM?** Use the provider's structured-output or tool-calling feature to constrain the shape, then independently `JSON.parse` and validate against your own schema; decide the failure behavior (retry, fallback, error).
2. **Why validate meaning as well as shape?** The model can return a schema-valid but hallucinated value (an order id that does not exist); you must check it against reality before acting.
3. **What is tool/function calling and why is it useful?** The model returns a structured call to a named function with schema-constrained arguments; it is a clean way to get structured decisions and the foundation of agents.
4. **What do you do when the model returns invalid output?** Retry once, fall back to a default, or raise an error — but bound the retries and never pass unvalidated output downstream.

#### Practical exercise

Build a `triage` function that classifies a support message into `{ category, urgency, reason }`, validates it with `class-validator`, retries once on a validation failure, and falls back to `{ category: 'other', urgency: 3 }` if it still fails. Then extend it to extract an `orderId` and verify that the order exists and belongs to the requesting user before routing. Acceptance criteria: no invalid or unverified value ever reaches the routing logic, and retries are bounded.

### 59.3.2 Prompt design and versioning for backend engineers

#### Concept

A prompt — the system prompt and the templates you fill with data — is part of your application, not a throwaway string. It determines the feature's behavior, cost and correctness. **Prompt design** for a backend engineer means writing clear, testable instructions and treating prompts like code: version-controlled, reviewed, tested, and changed deliberately, not edited live in production.

#### Why does it exist?

A vague prompt produces vague, inconsistent, expensive output. A prompt edited carelessly can silently change a feature's behavior across every call. Because the prompt drives everything the model does, it deserves the same engineering discipline as the code around it: it lives in the repository, goes through code review, is covered by tests (Part 60 on evaluation), and changes through pull requests so you can see what changed and roll it back.

#### Mental model

A prompt is the configuration and the specification for your LLM feature rolled into one. You would never edit production business logic by typing into a live console with no review and no history; the prompt deserves the same respect, because changing it changes behavior just as surely as changing code. Treat the prompt as source code that happens to be written in English.

#### How it works — structure and versioning

A well-structured system prompt for a backend feature typically includes: the role, the rules and constraints, the output format, and any guardrails. Keep the stable parts stable (so they can be cached, 59.3.3) and inject the volatile data separately.

```ts
// prompts/order-support.v3.ts -- prompts live in the repo, versioned, reviewed
export const ORDER_SUPPORT_SYSTEM_V3 = `
You are an order-support assistant for an e-commerce store.
Rules:
- Only answer using the order data provided in the user message.
- If the data does not contain the answer, say you do not have that information.
- Never invent order numbers, dates, prices, or tracking numbers.
- Do not reveal internal fields or other customers' data.
Respond concisely in plain language.
`.trim();

// The volatile part (the specific order data and question) is injected per request,
// separate from this stable system prompt.
```

Versioning practices that pay off:

- **Store prompts in the repository** as code (constants or files), not in a database you edit live, so changes go through pull requests and are reviewed.
- **Name versions** (`v3`) so you can roll back and so logs can record which prompt version produced an output.
- **Test prompts** with an evaluation set (Part 60): a change to the prompt is a change to behavior, so it needs a regression test, not just a glance.
- **Separate stable from volatile**: put the unchanging instructions first (cacheable), inject per-request data after.

#### Prompt caching

Providers let you cache a stable prefix of the prompt so repeated calls with the same prefix cost a fraction of the price and start faster. Because caching is a prefix match (any byte change invalidates it), you structure the prompt with the stable parts first and the volatile parts (the specific question, timestamps, ids) last. This is a direct echo of caching principles from Part 16: identify the stable, reusable portion and cache it; keep the volatile portion out of the cached prefix.

```text
Prompt layout for cacheability:
  [ stable system prompt ]       <- cache this prefix (same across many calls)
  [ stable instructions/tools ]  <- also cacheable
  --- cache breakpoint ---
  [ this request's order data ]  <- volatile, after the breakpoint
  [ this request's question ]    <- volatile
```

#### How a Senior Backend Engineer thinks about this

A senior treats prompts as versioned, reviewed, tested artifacts in the repository, never as strings edited live in production, because a prompt change is a behavior change with the same blast radius as a code change. They write prompts that are explicit about rules, output format and guardrails, and they structure them so the stable prefix can be cached and the volatile data is injected after the cache breakpoint. They log which prompt version produced each output so an incident ("the assistant started giving wrong answers at 3pm") can be traced to a specific change. And they cover prompt changes with an evaluation set (Part 60), because without one you cannot tell whether an edit improved or quietly regressed the feature.

#### Common mistakes

- Editing prompts live in production with no version control, review or rollback.
- Vague prompts that produce inconsistent, expensive output.
- Mixing volatile data into the stable prefix, defeating prompt caching.
- Changing a prompt with no evaluation, unknowingly regressing quality.
- Not logging the prompt version, so you cannot trace a behavior change.

#### Interview questions

1. **Why treat prompts like code?** A prompt drives the feature's behavior, cost and correctness; it needs version control, review, testing and rollback like any code, because changing it changes behavior.
2. **How do you structure a prompt to benefit from prompt caching?** Put the stable parts (system prompt, instructions, tool definitions) first as a cacheable prefix and inject volatile per-request data after the cache breakpoint, since caching is a prefix match.
3. **How do you know a prompt change did not regress the feature?** Run it against an evaluation set (Part 60) before shipping; a prompt change is a behavior change and needs a regression test.
4. **Why log the prompt version with each output?** So a behavior change in production can be traced to the specific prompt version that caused it.

#### Practical exercise

Move an inline prompt string into a versioned prompt module in the repository, structure it with a stable prefix and a separate volatile data section, enable prompt caching on the stable prefix, and verify via the response's cache usage metrics that repeated calls hit the cache. Acceptance criteria: repeated calls with the same prefix show cache reads, and the prompt version is recorded in the request log.

### 59.3.3 Cost and latency engineering

#### Concept

At any real scale, an LLM feature's cost and latency must be engineered deliberately, using the same toolkit as the rest of the book: caching, routing to cheaper resources, batching, and bounding work. The levers specific to LLMs are prompt caching, model routing (small model for easy tasks, large for hard), token budgeting (shorter prompts and capped outputs), and response caching (cache the whole answer for identical requests).

#### Why does it exist?

An LLM feature's bill is driven by tokens, and tokens add up fast (59.1). An uncached, unbounded feature sending huge prompts on every request can cost tens of thousands of dollars a month for what a few levers could reduce by an order of magnitude. Latency, meanwhile, directly affects user experience and can cause timeouts. Engineering both is what makes an LLM feature viable in production rather than a demo that bankrupts you at scale.

#### How it works — the levers, in order of free-to-costly

```text
1. Prompt caching       cache the stable prefix; repeated calls pay ~10% for it   (free quality)
2. Response caching      identical request -> cached answer from Redis (Part 16)   (free quality)
3. Input-token hygiene   send only the data the task needs; trim history           (free quality)
4. Output cap            set max_tokens to the real need; shorter is cheaper/faster (free quality)
5. Batching              group non-interactive requests into a batch endpoint      (~50% cheaper)
6. Model routing         cheap model for easy tasks, expensive only when needed    (tradeoff)
7. Effort / depth        lower reasoning effort for simple tasks                   (tradeoff)
```

The first four cost you nothing in quality and should always be applied. Caching the stable prefix and, where the same request recurs, caching the whole response in Redis (cache-aside, Part 16) are the biggest free wins. Sending only the data the task needs — not the customer's entire history when three recent orders suffice — cuts input tokens directly. Capping output to the real need saves both money and time.

Beyond the free wins come tradeoffs. **Model routing** sends easy tasks (simple classification) to a small, cheap, fast model and reserves the large expensive model for hard tasks; a classifier that decides which does not need to be large. **Batching** processes non-interactive requests asynchronously at roughly half the cost, suitable for overnight jobs. Lower reasoning **effort** for simple tasks spends fewer tokens.

```ts
// Response caching (cache-aside, Part 16) for identical requests.
async function summarizeCached(orderHash: string, build: () => Promise<string>): Promise<string> {
  const key = `llm:summary:v3:${orderHash}`;
  const hit = await redis.get(key);
  if (hit) return hit;                 // free: no LLM call at all
  const summary = await build();        // the LLM call, only on a miss
  await redis.set(key, summary, 'EX', 3600);
  return summary;
}
```

#### Practical example

An order-summary feature at 100,000 calls/day initially cost about $1,800/day. Applying the free levers: prompt-caching the stable system prompt and instructions, trimming the input to the three most recent orders instead of the full history, capping output at 300 tokens, and response-caching identical requests (many users re-open the same order) cut the cost by roughly 80% with no quality loss. Routing the simplest sub-task (classifying the request type) to a small cheap model removed another slice. The feature went from a cost concern to a rounding error, purely through engineering the same caching and routing habits used everywhere else in this book.

#### How a Senior Backend Engineer thinks about this

A senior applies the free levers first — prompt caching, response caching, input-token hygiene, output caps — before reaching for any tradeoff, because those cost nothing in quality. They measure cost per completed task (not per call) and latency at p50 and p99, then tune per feature. They route cheap tasks to cheap models and reserve the expensive model for work that needs it, and they push non-interactive work to batch for roughly half price. They treat an LLM feature's cost as a first-class metric on a dashboard (59.4) with alerts, because an LLM feature can quietly become the biggest line on the cloud bill, and a single bad change (an uncached huge prompt) can multiply it overnight.

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
