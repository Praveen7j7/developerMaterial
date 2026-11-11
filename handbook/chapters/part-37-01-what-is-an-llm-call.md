# Part 37 — Building Backends with LLMs: Foundations

Large language models (LLMs) have become a normal part of the backend engineer's toolkit, sitting alongside PostgreSQL, Redis and Kafka as something you call over the network and have to make reliable, cheap and secure. This Part treats an LLM the way a senior engineer treats any external dependency: not as magic, but as a slow, expensive, non-deterministic HTTP API that can time out, fail, return garbage, leak data and run up a bill, and that must therefore be wrapped in timeouts, retries, validation, caching, rate limits and observability like everything else.

We do not teach prompt engineering as a creative art, and we do not hype. We teach the engineering: what an LLM API call actually is, how to call it from NestJS safely, how to get structured output you can trust, how to control cost and latency, how to handle the specific failure modes LLMs add, and how to keep the feature secure. The running example is an order-support assistant for an e-commerce backend, which we build up across the files of this Part.

The code uses real, current APIs. Where we show a vendor SDK we use the Anthropic TypeScript SDK (`@anthropic-ai/sdk`) with a real current model id, but every pattern — timeouts, retries, structured output, caching, rate limiting — is provider-neutral; the same shapes apply to any LLM provider. Part 38 continues into retrieval (RAG with pgvector), agents and evaluation.

## 37.1 What an LLM API call is

### 37.1.1 Tokens, context windows and the request-response shape

#### Concept

An LLM API call is an HTTP request. You send some text (the **prompt**) plus parameters, and you get back generated text (the **completion**). The model does not "know" anything between calls — like every HTTP request (Part 3), each call is stateless; you must send the whole conversation every time. The text, in both directions, is measured in **tokens** — chunks of roughly 3 to 4 characters of English — and you pay per token, separately for input and output.

#### Why does it exist?

A backend needs to do language tasks that rule-based code cannot: summarize a messy order history, classify a support message, extract structured fields from free text, answer a question in natural language. Traditionally these required either a human or a narrow machine-learning model trained for one task. An LLM API gives you a single general-purpose text engine you call over the network, so the backend engineer's job becomes integrating and operating it, not training a model.

#### Mental model

Imagine hiring a very fast, very well-read contractor who has no memory between conversations. Each time you want help you must hand them a fresh packet containing everything they need to know — the instructions, the relevant data, the question — because they remember nothing from last time. They charge by the word, counting both the words you give them and the words they write back. They are brilliant but occasionally confidently wrong, so you check their work. That contractor is the LLM; the packet is your prompt; the per-word charge is token pricing; checking the work is validation.

#### How it works

The key terms, which you will meet in every LLM integration:

| Term | Meaning | Why it matters to you |
|---|---|---|
| Token | A chunk of text (~3-4 chars); the unit of input and output | You pay per token and are limited by token counts, not characters |
| Context window | The maximum tokens (input + output) one call can handle | A long document plus history can exceed it; you must manage it |
| Prompt / input tokens | Everything you send: instructions, data, history, question | The bulk of cost in most backend features |
| Completion / output tokens | What the model generates | Usually priced higher per token than input |
| System prompt | Instructions that set the model's role and rules | Where you put the stable behavior; cache it (37.3) |
| Temperature | A 0-to-1-ish knob for randomness | Low for deterministic tasks, higher for creative ones |
| `max_tokens` | A cap on output length | Set it; an unbounded completion is a cost and latency risk |

A call, conceptually:

```text
Request  (you send)                      Response (you get back)
----------------------------            ----------------------------
model: which model                       generated text (completion)
system: role and rules                   stop reason (why it stopped)
messages: the conversation so far        usage: input/output token counts
max_tokens: output cap                   (sometimes) which model served it
```

The **stop reason** tells you why generation ended: finished naturally, hit the `max_tokens` cap (output was truncated — a bug to detect), the model wanted to call a tool (Part 38), or the model declined. Always check it; treating a truncated response as complete is a classic mistake.

#### Latency profile

An LLM call is slow by backend standards, and the latency depends on how much it generates, because the model produces output one token at a time:

```text
Typical LLM call latency (illustrative, varies by model and load):
  Time to first token:     ~0.3 to 2 s
  Per output token:        ~5 to 30 ms
  A 500-token answer:      ~3 to 15 s total
  A short classification:  ~0.5 to 2 s
```

Compare that to Redis (~0.3 ms) and a PostgreSQL query (~1 to 20 ms) from the rest of this book. An LLM call is 100 to 10,000 times slower. That single fact drives most of the engineering in this Part: you stream the output so the user sees progress, you cache aggressively, you never put an LLM call on a hot path that needs millisecond latency, and you often push LLM work to a background queue.

#### Pricing

You pay per million tokens, with output usually costing several times more than input. For example, a model might cost a few dollars per million input tokens and several times that per million output tokens (exact numbers change; always check current pricing). The practical consequences:

```text
A feature that sends 2,000 input tokens and generates 500 output tokens per call,
at say $4/1M input and $20/1M output:
  input:  2,000 / 1,000,000 x $4  = $0.008
  output:   500 / 1,000,000 x $20 = $0.010
  per call: ~$0.018
At 100,000 calls/day: ~$1,800/day = ~$54,000/month.
```

That is why cost engineering (37.3) is not optional at scale. A careless feature that sends a huge prompt on every request, uncached, can cost more than your entire database infrastructure.

#### Practical example

An order-support feature summarizes a customer's recent orders. You send a system prompt (the assistant's role and rules), the order history as structured text, and the question. The model returns a short summary. The input might be 1,500 tokens (mostly the order data), the output 200 tokens. At scale, the order data is the same across many requests for the same customer within a session, which is exactly the kind of repeated prefix that prompt caching (37.3) makes cheap.

#### Context window management

The context window is a hard ceiling, but your real budget should sit far below it. Modern models accept hundreds of thousands of tokens, some up to a million, yet three things make big prompts a bad default. Cost scales linearly with input tokens. Time to first token grows with input size, because the model must read the whole prompt before it writes anything. And models are measurably worse at using facts buried in the middle of a very long prompt than facts near the start or end. So a senior sets an explicit **token budget** per feature (for example, 8,000 input tokens for order support) and builds the prompt to fit it: the system prompt, the most relevant data, the last few conversation turns, and a short summary of older turns instead of the full history.

#### NestJS example

Counting tokens before sending lets you refuse or trim an oversized prompt instead of discovering the problem on the invoice or as a `400` from the provider.

```ts
// llm/token-budget.service.ts -- count tokens BEFORE sending, refuse oversized prompts
import { Inject, Injectable, PayloadTooLargeException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LLM_CLIENT } from './llm.module';

const MODEL = 'claude-opus-5-5';
const MAX_INPUT_TOKENS = 8_000; // our budget, far below the model's context window

@Injectable()
export class TokenBudgetService {
  constructor(@Inject(LLM_CLIENT) private readonly client: Anthropic) {}

  async assertWithinBudget(
    system: string,
    messages: Anthropic.MessageParam[],
  ): Promise<number> {
    // A separate count endpoint: no output tokens, fast, but still a network hop.
    // Use it for large or variable prompts, not for a fixed 200-token classifier prompt.
    const { input_tokens } = await this.client.messages.countTokens({
      model: MODEL,
      system,
      messages,
    });
    if (input_tokens > MAX_INPUT_TOKENS) {
      throw new PayloadTooLargeException(
        `Prompt is ${input_tokens} tokens; the budget is ${MAX_INPUT_TOKENS}`,
      );
    }
    return input_tokens; // log it next to the actual usage the response reports
  }
}
```

Never estimate tokens with a character heuristic for anything that matters: tokenizers differ between providers and even between model generations of one provider, and a newer tokenizer can produce noticeably more tokens for the same text. Ask the provider's count endpoint, or read `usage` from real responses.

#### Production scenario

The order-support feature at peak: 40 requests per second, 1,800 input tokens and 250 output tokens per call, p50 latency 2.1 s and p99 7.8 s. Three numbers fall out of that, and each one drives a design decision.

```text
Concurrency (Little's law: in-flight = rate x latency)
  40 req/s x ~3 s average  = ~120 LLM calls in flight at once
  -> connection pool, provider concurrency limit, Node memory for 120 open streams

Tokens per minute (what provider rate limits are usually expressed in)
  40 x 60 x (1,800 + 250)   = ~4.9 M tokens/min
  -> must fit the account's TPM tier, or you need queueing (59.4)

Cost per 1,000 requests (at $4 / 1M input, $20 / 1M output)
  input:  1,000 x 1,800 x $4 / 1M  = $7.20
  output: 1,000 x   250 x $20 / 1M = $5.00
  total:  ~$12.20 per 1,000 requests, before any caching
```

Cost per 1,000 requests is the number to put next to every LLM feature on a dashboard, exactly like cost per 1,000 API requests in Part 51 — Cost-Aware Engineering. It lets a product manager compare "the AI summary" with "one more database replica" in the same currency.

#### Failure scenario

A "chat about your orders" feature appended every turn to the conversation and resent it all on each call, as the stateless API requires. Nobody set a budget. A wholesale customer with 300 orders kept one chat open for an afternoon. By turn 60 every call carried 180,000 input tokens and cost about $0.75; by turn 70 the provider started rejecting requests with `400 invalid_request_error` because the prompt exceeded the context window, and the customer saw a generic error. The cost dashboard (once someone looked) showed one user responsible for 9% of the day's LLM spend. The fix had three parts: a token budget enforced before every call, a sliding window that keeps the last 8 turns plus a model-written summary of older ones, and sending only the 10 most recent orders instead of all 300. The lesson: "stateless" means *you* own the growth of the context, and anything you own needs a limit.

#### Edge cases & failure modes

- **Non-English text** often costs two to three times more tokens per character than English; budget in tokens, never in characters.
- **JSON and code are token-dense**: braces, quotes and indentation all cost tokens. Send compact JSON or a terse line format, not pretty-printed objects.
- **Tokenizer change on model upgrade**: the same prompt can become 10–35% more tokens; re-baseline budgets and cost forecasts when you switch models.
- **`max_tokens` is a ceiling, not a charge**: you pay for tokens generated, not for the cap. A high cap costs nothing on short answers but lets a runaway generation run long and expensive.
- **Context overflow** is a `400`, not a retryable error: retrying the same oversized prompt fails forever. Trim, then retry.
- **Long prompts slow the first token**: a 100,000-token prompt can add seconds before streaming starts, even with caching for part of it.

#### How a Senior Backend Engineer thinks about this

A senior treats the LLM as a slow, metered, fallible network dependency and designs around those three properties from the start. Slow means stream, cache and push to background work, never on a millisecond-latency hot path. Metered means count tokens, cap output, cache prefixes and route cheap tasks to cheap models. Fallible means validate every output, check the stop reason, and never let a hallucinated value flow unchecked into a database or a customer-facing number. They ask, before building any LLM feature: what does it cost per call, what is the p99 latency, what happens when it is wrong, and what happens when the provider is down.

#### Common mistakes

- Treating the LLM as instant and putting it on a latency-sensitive hot path.
- Not setting `max_tokens`, risking runaway cost and latency.
- Ignoring the stop reason and treating a truncated output as complete.
- Not counting tokens, then being shocked by the bill.
- Assuming the model remembers previous calls; it does not — you resend the context.

#### Interview questions

1. **What is a token and why does it matter?** A chunk of text (~3-4 characters) that is the unit of both billing and context limits; you pay per input and output token and are bounded by the context window in tokens.
2. **Why is an LLM call fundamentally different from a database query in terms of latency?** It is 100 to 10,000 times slower and the latency scales with output length because text is generated one token at a time; this forces streaming, caching and background processing.
3. **Why must you send the full conversation on every call?** The API is stateless — the model has no memory between calls — so all needed context (instructions, data, history, question) is resent each time.
4. **What does the stop reason tell you and why check it?** Why generation ended (natural finish, `max_tokens` cap, tool call, refusal); checking it detects truncated output and refusals instead of silently using an incomplete response.

5. **Your LLM endpoint gets 40 requests per second with a 3-second average latency. How many calls are in flight, and why do you care?** About 120 (Little's law: rate times latency). That number sizes your HTTP connection pool, must fit the provider's concurrency and tokens-per-minute limits, and determines memory for open streams. Follow-up: what happens to in-flight count when the provider slows to 9 seconds? It triples to 360, which is how a provider slowdown exhausts your resources.
6. **Does setting a high `max_tokens` cost money by itself?** No; you pay only for tokens actually generated. It is a ceiling that bounds the worst case. Set it to the real need plus a margin, and treat hitting it (stop reason `max_tokens`) as a signal, not a normal outcome.
7. **Why set a token budget far below the model's context window?** Cost is linear in input tokens, time to first token grows with input, and models use facts in the middle of very long prompts less reliably. A budget forces you to send only relevant data.

#### Practical exercise

Estimate the monthly cost of an LLM feature that handles 50,000 calls per day, each sending 3,000 input tokens and generating 400 output tokens, at $4 per million input and $20 per million output tokens. Then estimate how much prompt caching would save if 2,500 of the 3,000 input tokens are an identical prefix cached at one-tenth the input price. Acceptance criteria: you compute per-call and monthly cost for both scenarios and can state the percentage saved.

### 37.1.2 Determinism, temperature and non-determinism

#### Concept

Unlike a SQL query, which returns the same result for the same input, an LLM can return different output for the same prompt. The **temperature** parameter controls how much randomness is allowed: near zero makes output nearly deterministic (the model picks the most likely next token every time), higher values make it more varied and creative. Even at temperature zero, output is not guaranteed identical across calls, because of how the models run. Not every model exposes the knob any more: the newest models from some providers (current Claude models among them) have removed the sampling parameters and reject a request that sets them, so on those you get consistency from the prompt, from structured output (37.3) and from a lower reasoning-effort setting instead.

#### Why does it exist?

Randomness is a feature for creative tasks (varied marketing copy, brainstorming) and a bug for deterministic ones (classification, extraction, anything you will store or compare). Temperature lets you choose per task. For a backend engineer, most tasks want the low end: when you extract an order id or classify a support message, you want the same answer every time, so you set temperature low.

#### Mental model

Imagine asking ten skilled baristas for "a flat white". You get ten good flat whites, but no two are identical: the foam is a little different, one is slightly hotter. A recipe card (the prompt), a fixed cup size (the output schema) and a quality check at the counter (validation) make the drinks consistent enough to sell, but they never make them byte-identical. You design the café so that small variations do not matter; you do not fire the barista because the foam pattern changed.

#### How it works

```ts
// A deterministic task (classification). No temperature here: current Claude models reject
// sampling parameters. On a provider that still accepts it, you would add temperature: 0.
const response = await client.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 256,
  system: 'Classify the support message into exactly one of: billing, shipping, technical, other. Respond with only the label.',
  messages: [{ role: 'user', content: supportMessage }],
});
```

The practical rule: deterministic backend tasks (classification, extraction, structured output) use the lowest randomness the model allows; creative tasks (drafting a reply a human will edit) can use more. But never assume byte-identical output even at the low end — design so that small variations do not break you (validate and normalize the output rather than string-matching an exact expected response).

#### Production scenario

A support-ticket classifier handles 30,000 tickets a day. The team measures consistency directly: once a week, a job re-runs 500 archived tickets through the current prompt three times and records how often all three runs agree on the category. Agreement sits around 97–98%; the 2–3% that flip are genuinely ambiguous tickets ("refund for a late delivery" is billing or shipping). The team accepted that, routed the ambiguous ones to a shared queue, and stored the exact prompt version, model id and output with every classification so that an audit months later can show what the system decided and why, without pretending the call can be replayed identically.

#### Failure scenario

A team routed support tickets with a `switch` on the raw model output: `case 'shipping':`, `case 'billing':` and so on. It worked in the demo. In production the model sometimes answered `Shipping`, sometimes `shipping.` and occasionally `Shipping issue`. Each variant fell through to the `default` branch, which dumped the ticket into a general queue that nobody watched at weekends. Over one weekend, 7% of tickets (about 2,000) sat unanswered. The fix was to stop matching strings: the model now returns a JSON object whose `category` field is constrained to an enum (37.3), the code validates it, normalizes case and whitespace defensively, and a ticket that still fails validation goes to a monitored "needs triage" queue with an alert on its depth.

#### Edge cases & failure modes

- **Same prompt, different answer across runs**: expected; measure agreement and route ambiguous cases explicitly.
- **Model upgrade changes behavior** even with an identical prompt: pin the model id, and re-run your evaluation set (Part 38) before switching.
- **Provider-side changes** to sampling or defaults: some current models no longer accept sampling parameters at all and return a `400` if you send them; keep sampling settings in one place (your LLM service) so a provider change is a one-line fix.
- **Caching on output**: never use a generated string as a cache key or an idempotency key; it is not stable.
- **Snapshot tests on generated text** are flaky by design; test your code with a mocked client and test the model's behavior with evaluations.

#### How a Senior Backend Engineer thinks about this

A senior designs LLM features to tolerate non-determinism rather than fight it. They use low randomness for deterministic tasks but still validate the output against a schema and normalize it, because the same prompt can yield slightly different phrasing, field ordering or formatting. They never build logic that depends on an exact-string match of a generated response. For anything that must be reproducible (a test, an audit), they record the exact prompt and the exact output, because you cannot assume you can regenerate the identical result later.

#### Common mistakes

- Expecting byte-identical output and string-matching against an exact expected response.
- Using high temperature for tasks that should be deterministic, getting inconsistent classifications.
- Not validating output because "the prompt says to return JSON" — the model does not always comply.

#### Interview questions

1. **What does temperature control, and what setting fits a classification task?** The randomness of token selection; low (near zero) for deterministic tasks like classification, higher for creative tasks.
2. **Can you rely on an LLM returning identical output for identical input?** No — output is non-deterministic even at low temperature; design to validate and normalize rather than match exact strings.

3. **How do you test code that calls a non-deterministic model?** Split it: unit tests mock the LLM client with fixed responses (including malformed, truncated and refused ones) so your code's handling is deterministic; evaluations (Part 38) measure the model's behavior statistically over a dataset. Follow-up: what do you assert in an eval if the wording varies? The structured fields, the presence of required facts, citations, or a rubric score, never the exact string.
4. **Why record the exact prompt and output for consequential decisions?** Because you cannot regenerate the same output later; the record is the only faithful audit trail.

#### Practical exercise

Write a classification function that asks the model to label a support message as one of four categories and then validates that the returned text is exactly one of the allowed labels, throwing or retrying if it is not. Acceptance criteria: the function never returns a label outside the allowed set, even when the model occasionally adds extra words or punctuation.
