## 36.3 Structured output and prompt design

### 36.3.1 Getting JSON you can trust

#### Concept

Most backend LLM features do not want prose; they want structured data — a classification label, extracted fields, a decision with a reason. Getting the model to return well-formed JSON that matches a schema, and validating it before use, is **structured output**. Modern providers support it via a schema parameter or tool/function calling that constrains the output; whichever you use, you validate the result against your own schema with a tool like `class-validator` (Part 14) or `zod`.

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
    parsed = JSON.parse(raw);           // JSON.parse, never string-matching (59.1.2)
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

Providers also let you declare "tools" (functions) the model can call, with a typed schema for the arguments. The model returns a structured call to a named function with validated-shape arguments, which you then execute. This is the foundation of agents (Part 37) and a clean way to get structured output when the task is "decide which action to take and with what parameters". Use the provider's `strict` schema option where available so the arguments are guaranteed to match your schema, and still validate on your side.

#### Practical example

An order-support assistant extracts a structured intent from the user's message — `{ intent: 'refund' | 'track' | 'cancel' | 'question', orderId?: string }` — validates it, and routes to the right handler. The LLM turns messy natural language ("where's my stuff from last week, order 10052?") into a typed, validated object your existing code can act on. The LLM is doing the language understanding; your validated schema and your handlers do the actual, trustworthy work.

#### NestJS example

Modern provider SDKs can enforce a schema on the response for you. With the Anthropic TypeScript SDK you pass a JSON schema (here generated from a `zod` schema) in `output_config.format`, and `messages.parse()` returns the parsed object. Other providers expose the same idea under names like "structured outputs" or "JSON schema response format"; the shape of the code is the same.

```ts
// support/intent.service.ts -- schema-constrained output, then our own validation
import { Inject, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { LLM_CLIENT } from '../llm/llm.module';
import { INTENT_SYSTEM_V2 } from '../prompts/intent.v2';

export const SupportIntent = z.object({
  intent: z.enum(['refund', 'track', 'cancel', 'question']),
  orderId: z.string().regex(/^[0-9]{5,10}$/).nullable(), // null when no order is mentioned
  confidence: z.enum(['high', 'low']),
});
export type SupportIntent = z.infer<typeof SupportIntent>;

@Injectable()
export class IntentService {
  private readonly logger = new Logger(IntentService.name);
  constructor(@Inject(LLM_CLIENT) private readonly client: Anthropic) {}

  async extract(message: string): Promise<SupportIntent | null> {
    const response = await this.client.messages.parse({
      model: 'claude-opus-5-5',
      max_tokens: 256,
      system: INTENT_SYSTEM_V2,
      messages: [{ role: 'user', content: message }],
      output_config: {
        format: zodOutputFormat(SupportIntent), // the provider constrains the output shape
        effort: 'low',                          // a simple extraction needs little reasoning
      },
    });

    if (response.stop_reason !== 'end_turn') {
      // 'refusal' or 'max_tokens': no trustworthy object; caller falls back
      this.logger.warn(`intent extraction stopped: ${response.stop_reason}`);
      return null;
    }
    // Layer 2: validate again ourselves. Cheap, and it survives SDK or provider changes.
    const checked = SupportIntent.safeParse(response.parsed_output);
    return checked.success ? checked.data : null;
  }
}
```

Note the `regex` on `orderId`: the schema encodes what a *valid-looking* order id is, so a model that returns `"my last order"` fails validation instead of reaching a database query. When the job is "choose an action and its arguments", use tool calling instead and mark each tool `strict: true` with `additionalProperties: false` in its input schema, so the arguments are guaranteed to match; Part 37 builds on that.

#### TypeORM example

Schema validation proves the id *looks* right; only the database proves it is real and belongs to the caller. This check is not optional.

```ts
// support/order-lookup.service.ts -- validate the model's output against reality
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from '../orders/order.entity';

@Injectable()
export class OrderLookupService {
  constructor(@InjectRepository(Order) private readonly orders: Repository<Order>) {}

  async ownedOrderOrThrow(orderId: string, userId: string): Promise<Order> {
    // Scope by owner in the query itself: "exists" and "belongs to this user" in one step.
    const order = await this.orders.findOne({ where: { id: orderId, userId } });
    if (!order) {
      // Same error whether it does not exist or belongs to someone else (no enumeration, Part 39).
      throw new NotFoundException('Order not found');
    }
    return order;
  }
}
```

#### Production scenario

An intent extractor handles 25,000 support messages a day. With prompt-only JSON ("respond only with JSON"), about 2% of responses failed validation: prose around the JSON, a missing field, or `"intent": "Refund request"`. After switching to schema-constrained output, schema failures dropped to well under 0.1%, almost all of them `max_tokens` truncations caused by a cap that was too tight. Semantic failures did not disappear: around 1% of extracted order ids did not belong to the user (typos, a friend's order, an id copied from an old email), and the ownership check caught every one. Running this on a small, cheap model at roughly 350 input and 40 output tokens per call costs a few cents per 1,000 messages, small enough that nobody argues about it.

#### Failure scenario

An early version of the assistant skipped the ownership check because "the model only extracts what the user typed". A user typed "what's the status of order 1004417?", which was not theirs; they had guessed a number close to their own. The intent extractor did its job perfectly, the handler fetched order 1004417, and the assistant cheerfully described another customer's delivery address and items. This is an Insecure Direct Object Reference (IDOR, Part 39) with an LLM in the middle; the LLM did nothing wrong. The fix was the scoped lookup above, applied in the shared handler so no route can forget it. The lesson: structured output gives you well-formed input, not authorized input; authorization stays in your code.

#### Edge cases & failure modes

- **Valid JSON, wrong shape**: the number-one structured-output failure; catch it with validation, not hope.
- **JSON wrapped in prose** ("Here is the JSON: {...}"): structured-output features avoid this; if using plain prompting, instruct "respond with only JSON" and handle extraction defensively.
- **Hallucinated values**: the model invents an order id that does not exist; validate against reality (does that order exist and belong to this user?) before acting, not just against the schema.
- **Repeated failures**: if the model will not produce valid output after a retry, fall back gracefully rather than looping forever (and paying for each attempt).
- **Schema drift**: if you change the expected shape, update both the prompt and the validator; a mismatch silently breaks.

#### How a Senior Backend Engineer thinks about this

A senior never trusts LLM output structurally or semantically without validation. Structurally, they use the provider's structured-output or tool-calling feature and then validate against their own schema — two layers, because the provider's constraint is a strong hint, not a guarantee they own. Semantically, they validate against reality: a model-supplied order id is checked for existence and ownership before anything acts on it, because a schema-valid id can still be hallucinated. They treat an LLM that extracts an intent as a sophisticated parser whose output enters the system through the same validation gate as any other untrusted input (Part 14, Part 39).

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

### 36.3.2 Prompt design and versioning for backend engineers

#### Concept

A prompt — the system prompt and the templates you fill with data — is part of your application, not a throwaway string. It determines the feature's behavior, cost and correctness. **Prompt design** for a backend engineer means writing clear, testable instructions and treating prompts like code: version-controlled, reviewed, tested, and changed deliberately, not edited live in production.

#### Why does it exist?

A vague prompt produces vague, inconsistent, expensive output. A prompt edited carelessly can silently change a feature's behavior across every call. Because the prompt drives everything the model does, it deserves the same engineering discipline as the code around it: it lives in the repository, goes through code review, is covered by tests (Part 37 on evaluation), and changes through pull requests so you can see what changed and roll it back.

#### Mental model

A prompt is the configuration and the specification for your LLM feature rolled into one. You would never edit production business logic by typing into a live console with no review and no history; the prompt deserves the same respect, because changing it changes behavior just as surely as changing code. Treat the prompt as source code that happens to be written in English.

#### How it works — structure and versioning

A well-structured system prompt for a backend feature typically includes: the role, the rules and constraints, the output format, and any guardrails. Keep the stable parts stable (so they can be cached, 36.3.3) and inject the volatile data separately.

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
- **Test prompts** with an evaluation set (Part 37): a change to the prompt is a change to behavior, so it needs a regression test, not just a glance.
- **Separate stable from volatile**: put the unchanging instructions first (cacheable), inject per-request data after.

#### Prompt caching

Providers let you cache a stable prefix of the prompt so repeated calls with the same prefix cost a fraction of the price and start faster. Because caching is a prefix match (any byte change invalidates it), you structure the prompt with the stable parts first and the volatile parts (the specific question, timestamps, ids) last. This is a direct echo of caching principles from Part 26: identify the stable, reusable portion and cache it; keep the volatile portion out of the cached prefix.

```text
Prompt layout for cacheability:
  [ stable system prompt ]       <- cache this prefix (same across many calls)
  [ stable instructions/tools ]  <- also cacheable
  --- cache breakpoint ---
  [ this request's order data ]  <- volatile, after the breakpoint
  [ this request's question ]    <- volatile
```

#### Practical example

The order-support prompt goes from `v3` to `v4` to add a rule about return windows. The change is a pull request that edits `prompts/order-support.v4.ts` (leaving `v3` in place), updates the evaluation cases, and shows the eval score in the PR (Part 37). After merge, a config flag routes 10% of traffic to `v4`; the dashboard compares thumbs-down rate, escalation rate and tokens per answer between versions for two days; then `v4` goes to 100% and `v3` is deleted a week later. Rolling back is a config change, not an emergency edit.

#### NestJS example

A small registry gives every prompt an id, a version and a content hash, so logs can say exactly which text produced an output, and so the stable system prompt can be marked as a cache breakpoint.

```ts
// prompts/prompt-registry.ts -- prompts as versioned, hashed code
import { createHash } from 'node:crypto';
import { ORDER_SUPPORT_SYSTEM_V3 } from './order-support.v3';
import { ORDER_SUPPORT_SYSTEM_V4 } from './order-support.v4';

export interface PromptVersion { id: string; version: string; text: string; sha: string }

function define(id: string, version: string, text: string): PromptVersion {
  const sha = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return { id, version, text, sha }; // sha catches "same version name, edited text"
}

export const PROMPTS = {
  'order-support:v3': define('order-support', 'v3', ORDER_SUPPORT_SYSTEM_V3),
  'order-support:v4': define('order-support', 'v4', ORDER_SUPPORT_SYSTEM_V4),
} as const;
export type PromptKey = keyof typeof PROMPTS;
```

```ts
// in the service: stable prefix cached, volatile data after it
const prompt = PROMPTS[this.config.get<PromptKey>('ORDER_SUPPORT_PROMPT', 'order-support:v3')];

const response = await this.client.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 400,
  system: [
    // Cache breakpoint at the end of the stable part (system text plus any tools before it).
    { type: 'text', text: prompt.text, cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    { role: 'user', content: `<orders>\n${ordersCompactJson}\n</orders>\n\nQuestion: ${question}` },
  ],
});

this.logger.log({
  event: 'llm_call', prompt: prompt.id, version: prompt.version, sha: prompt.sha,
  cacheRead: response.usage.cache_read_input_tokens,      // > 0 means the prefix was reused
  cacheWrite: response.usage.cache_creation_input_tokens, // a write costs slightly more than normal input
});
```

Cache writes cost a little more than normal input (about 1.25 times on a 5-minute cache), reads cost a small fraction (around a tenth or less), so caching pays off as soon as the same prefix is used twice within the cache lifetime. Check the numbers in your logs: if `cacheRead` stays at zero across repeated calls, something in the prefix is changing.

#### Failure scenario

A team stored prompts in a database table so that product managers could "tune the tone" from an admin page. One afternoon someone rewrote the order-support prompt to sound friendlier and, in the process, deleted the line "Never invent tracking numbers". There was no review and no history. Over the next three days the assistant started producing plausible tracking numbers for orders that had not shipped; customers pasted them into the carrier's website and got "not found". Because logs did not record which prompt text was live, it took a day to connect the complaints to the edit. The fix: prompts moved into the repository with code review and an evaluation gate, the version and hash are logged with every call, and tone tweaks go through the same pull request as everything else (a product manager can open the PR).

#### Edge cases & failure modes

- **Prompt too short to cache**: providers only cache prefixes above a minimum length (from a few hundred to a few thousand tokens depending on the model). A 150-token system prompt will never cache; caching pays when the stable part includes tool definitions, policies or examples.
- **A timestamp or request id in the system prompt** changes the prefix on every call and silently disables caching; put volatile values after the breakpoint.
- **Delimiter injection**: user text containing `</orders>` can break your template's structure; strip or escape your delimiter tags from untrusted input.
- **Same version name, edited text**: the content hash in logs catches it.
- **Prompt shared by several services** drifts when each copies it; publish it from one package or one service.
- **Model upgrade**: a prompt tuned for one model can behave differently on the next; re-run the evaluation before switching.

#### How a Senior Backend Engineer thinks about this

A senior treats prompts as versioned, reviewed, tested artifacts in the repository, never as strings edited live in production, because a prompt change is a behavior change with the same blast radius as a code change. They write prompts that are explicit about rules, output format and guardrails, and they structure them so the stable prefix can be cached and the volatile data is injected after the cache breakpoint. They log which prompt version produced each output so an incident ("the assistant started giving wrong answers at 3pm") can be traced to a specific change. And they cover prompt changes with an evaluation set (Part 37), because without one you cannot tell whether an edit improved or quietly regressed the feature.

#### Common mistakes

- Editing prompts live in production with no version control, review or rollback.
- Vague prompts that produce inconsistent, expensive output.
- Mixing volatile data into the stable prefix, defeating prompt caching.
- Changing a prompt with no evaluation, unknowingly regressing quality.
- Not logging the prompt version, so you cannot trace a behavior change.

#### Interview questions

1. **Why treat prompts like code?** A prompt drives the feature's behavior, cost and correctness; it needs version control, review, testing and rollback like any code, because changing it changes behavior.
2. **How do you structure a prompt to benefit from prompt caching?** Put the stable parts (system prompt, instructions, tool definitions) first as a cacheable prefix and inject volatile per-request data after the cache breakpoint, since caching is a prefix match.
3. **How do you know a prompt change did not regress the feature?** Run it against an evaluation set (Part 37) before shipping; a prompt change is a behavior change and needs a regression test.
4. **Why log the prompt version with each output?** So a behavior change in production can be traced to the specific prompt version that caused it.

#### Practical exercise

Move an inline prompt string into a versioned prompt module in the repository, structure it with a stable prefix and a separate volatile data section, enable prompt caching on the stable prefix, and verify via the response's cache usage metrics that repeated calls hit the cache. Acceptance criteria: repeated calls with the same prefix show cache reads, and the prompt version is recorded in the request log.
