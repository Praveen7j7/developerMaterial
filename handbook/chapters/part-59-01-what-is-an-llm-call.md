# Part 59 — Building Backends with LLMs: Foundations

Large language models (LLMs) have become a normal part of the backend engineer's toolkit, sitting alongside PostgreSQL, Redis and Kafka as something you call over the network and have to make reliable, cheap and secure. This Part treats an LLM the way a senior engineer treats any external dependency: not as magic, but as a slow, expensive, non-deterministic HTTP API that can time out, fail, return garbage, leak data and run up a bill, and that must therefore be wrapped in timeouts, retries, validation, caching, rate limits and observability like everything else.

We do not teach prompt engineering as a creative art, and we do not hype. We teach the engineering: what an LLM API call actually is, how to call it from NestJS safely, how to get structured output you can trust, how to control cost and latency, how to handle the specific failure modes LLMs add, and how to keep the feature secure. The running example is an order-support assistant for an e-commerce backend, which we build up across the files of this Part.

The code uses real, current APIs. Where we show a vendor SDK we use the Anthropic TypeScript SDK (`@anthropic-ai/sdk`) with a real current model id, but every pattern — timeouts, retries, structured output, caching, rate limiting — is provider-neutral; the same shapes apply to any LLM provider. Part 60 continues into retrieval (RAG with pgvector), agents and evaluation.

## 59.1 What an LLM API call is

### 59.1.1 Tokens, context windows and the request-response shape

#### Concept

An LLM API call is an HTTP request. You send some text (the **prompt**) plus parameters, and you get back generated text (the **completion**). The model does not "know" anything between calls — like every HTTP request (Part 71), each call is stateless; you must send the whole conversation every time. The text, in both directions, is measured in **tokens** — chunks of roughly 3 to 4 characters of English — and you pay per token, separately for input and output.

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
| System prompt | Instructions that set the model's role and rules | Where you put the stable behavior; cache it (59.3) |
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

The **stop reason** tells you why generation ended: finished naturally, hit the `max_tokens` cap (output was truncated — a bug to detect), the model wanted to call a tool (Part 60), or the model declined. Always check it; treating a truncated response as complete is a classic mistake.

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

That is why cost engineering (59.3) is not optional at scale. A careless feature that sends a huge prompt on every request, uncached, can cost more than your entire database infrastructure.

#### Practical example

An order-support feature summarizes a customer's recent orders. You send a system prompt (the assistant's role and rules), the order history as structured text, and the question. The model returns a short summary. The input might be 1,500 tokens (mostly the order data), the output 200 tokens. At scale, the order data is the same across many requests for the same customer within a session, which is exactly the kind of repeated prefix that prompt caching (59.3) makes cheap.

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

#### Practical exercise

Estimate the monthly cost of an LLM feature that handles 50,000 calls per day, each sending 3,000 input tokens and generating 400 output tokens, at $4 per million input and $20 per million output tokens. Then estimate how much prompt caching would save if 2,500 of the 3,000 input tokens are an identical prefix cached at one-tenth the input price. Acceptance criteria: you compute per-call and monthly cost for both scenarios and can state the percentage saved.

### 59.1.2 Determinism, temperature and non-determinism

#### Concept

Unlike a SQL query, which returns the same result for the same input, an LLM can return different output for the same prompt. The **temperature** parameter controls how much randomness is allowed: near zero makes output nearly deterministic (the model picks the most likely next token every time), higher values make it more varied and creative. Even at temperature zero, output is not guaranteed identical across calls, because of how the models run.

#### Why does it exist?

Randomness is a feature for creative tasks (varied marketing copy, brainstorming) and a bug for deterministic ones (classification, extraction, anything you will store or compare). Temperature lets you choose per task. For a backend engineer, most tasks want the low end: when you extract an order id or classify a support message, you want the same answer every time, so you set temperature low.

#### How it works

```ts
// Low temperature for a deterministic task (classification, extraction).
// (Some current models fix sampling internally; set it where the model allows.)
const response = await client.messages.create({
  model: 'claude-opus-4-8',
  max_tokens: 256,
  system: 'Classify the support message into exactly one of: billing, shipping, technical, other. Respond with only the label.',
  messages: [{ role: 'user', content: supportMessage }],
});
```

The practical rule: deterministic backend tasks (classification, extraction, structured output) use the lowest randomness the model allows; creative tasks (drafting a reply a human will edit) can use more. But never assume byte-identical output even at the low end — design so that small variations do not break you (validate and normalize the output rather than string-matching an exact expected response).

#### How a Senior Backend Engineer thinks about this

A senior designs LLM features to tolerate non-determinism rather than fight it. They use low randomness for deterministic tasks but still validate the output against a schema and normalize it, because the same prompt can yield slightly different phrasing, field ordering or formatting. They never build logic that depends on an exact-string match of a generated response. For anything that must be reproducible (a test, an audit), they record the exact prompt and the exact output, because you cannot assume you can regenerate the identical result later.

#### Common mistakes

- Expecting byte-identical output and string-matching against an exact expected response.
- Using high temperature for tasks that should be deterministic, getting inconsistent classifications.
- Not validating output because "the prompt says to return JSON" — the model does not always comply.

#### Interview questions

1. **What does temperature control, and what setting fits a classification task?** The randomness of token selection; low (near zero) for deterministic tasks like classification, higher for creative tasks.
2. **Can you rely on an LLM returning identical output for identical input?** No — output is non-deterministic even at low temperature; design to validate and normalize rather than match exact strings.

#### Practical exercise

Write a classification function that asks the model to label a support message as one of four categories and then validates that the returned text is exactly one of the allowed labels, throwing or retrying if it is not. Acceptance criteria: the function never returns a label outside the allowed set, even when the model occasionally adds extra words or punctuation.
