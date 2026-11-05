## 37.3 Agents and tool use

### 37.3.1 Tool loops and giving the model safe tools

#### Concept

An **agent** is an LLM that can take actions by calling **tools** (functions you provide) in a loop: the model decides which tool to call with what arguments, your code runs the tool and returns the result, and the model continues, calling more tools until it has finished the task. Tools let the model do things beyond generating text — look up an order, check inventory, issue a refund — turning it from an answerer into an actor. The engineering challenge is doing this safely.

#### Why does it exist?

Many tasks require actions, not just answers: "cancel my order and refund me" needs the system to actually cancel and refund. Hard-coding every possible flow is inflexible; letting the model choose tools lets it handle open-ended requests. But an LLM taking actions is dangerous — it can call the wrong tool, with wrong arguments, or be manipulated into a harmful action (prompt injection, Part 36). So agents exist to enable action, and the safety machinery (read-only vs write tools, idempotency, human approval) exists to make that action safe.

#### Mental model

An agent is a capable but junior employee who can use the company's tools. You would not give a new hire unrestricted access to issue refunds and delete records on day one; you give them read access freely, require a manager's sign-off for anything that moves money or is irreversible, and make every action logged and reversible. An agent gets the same treatment: free read-only tools, approval gates and strict checks on write tools, idempotency so a retry does not double-act, and an audit trail. The model proposes; your guardrails dispose.

#### How it works — the tool loop

```mermaid
sequenceDiagram
    participant U as User
    participant A as Agent (LLM)
    participant S as Your server
    U->>A: "Cancel order 10052 and refund me"
    A->>S: tool_use: getOrder(10052)
    S-->>A: tool_result: {status: paid, total: 4299, owner: usr_7}
    A->>S: tool_use: requestRefund(10052, 4299)
    Note over S: write tool: authz check + human approval gate
    S-->>A: tool_result: {status: pending_approval}
    A-->>U: "I've requested a refund of $42.99; it needs approval."
```

1. You declare tools with typed schemas (Part 36 structured output / tool calling).
2. The model responds with a `tool_use` (which tool, what arguments) instead of a final answer.
3. Your code validates the arguments, authorizes the action, runs the tool, and returns the result.
4. You send the result back; the model continues, possibly calling more tools, until it produces a final answer.
5. You bound the loop (a maximum number of tool calls) so it cannot run forever.

```ts
// A safe tool loop sketch (using the provider's tool-calling, Part 36).
async function runAgent(userMessage: string, ctx: { userId: string; tenantId: string }) {
  const messages = [{ role: 'user', content: userMessage }];
  for (let step = 0; step < 8; step++) {        // bound the loop
    const response = await llm.messagesWithTools({ system: AGENT_SYSTEM, messages, tools });
    if (response.stop_reason !== 'tool_use') return finalText(response);

    const results = [];
    for (const call of toolCalls(response)) {
      const tool = TOOLS[call.name];
      const args = validate(tool.schema, call.input);           // validate arguments (Part 36)
      await authorize(tool, args, ctx);                          // authz: can THIS user do this?
      if (tool.isWrite && tool.needsApproval) {
        results.push(await enqueueForApproval(tool, args, ctx)); // human approval for consequential writes
      } else {
        results.push(await tool.run(args, ctx));                 // read-only or approved write
      }
    }
    messages.push(response.assistantTurn, toolResultsMessage(results));
  }
  throw new Error('agent exceeded step limit');
}
```

#### Safe tool design

The principles that keep agents safe:

- **Read-only vs write tools.** Prefer read-only tools (look up an order, check inventory); the model can read freely because reading is safe. Write tools (refund, cancel, send email) are few, guarded, and ideally require approval.
- **Authorization on every tool call.** A tool call is a request like any other: check that *this* user (the one the agent is acting for) is allowed to perform *this* action on *this* resource (Part 39). The model asking to refund order 10052 does not mean user 7 is allowed to; your code checks.
- **Idempotency for write actions.** The loop may retry; a refund tool must be idempotent (an idempotency key, Part 29) so a retry does not refund twice. This is the same discipline as any write API.
- **Human approval for consequential actions.** Money movement, data deletion, external communication — route these to a human approval step rather than letting the model execute them directly. The model proposes; a person confirms.
- **Bound the loop and the blast radius.** Cap the number of tool calls; limit what tools can touch; log every tool call for audit.
- **Treat tool results as untrusted too.** Data a tool returns (especially from external sources) can contain injected instructions; it is data, not commands (Part 36 prompt injection).

#### NestJS example

The sketch above, with real SDK shapes. Each tool is declared with a JSON schema and `strict: true`; the model answers with `tool_use` blocks; you reply with one user message containing a `tool_result` block per call, matched by `tool_use_id`, with `is_error: true` when a tool fails (so the model can recover instead of guessing).

```ts
// agent/order-agent.service.ts -- a bounded manual tool loop
import { Inject, Injectable } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { LLM_CLIENT } from '../llm/llm.module';
import { ToolExecutor, ToolContext } from './tool-executor';

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_order',
    description: "Look up one of the current customer's orders by id. Read-only.",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { orderId: { type: 'string', description: 'Numeric order id' } },
      required: ['orderId'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_refund',
    description: 'Create a refund REQUEST for a delivered order. A human approves it; nothing is paid now.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        reason: { type: 'string', enum: ['damaged', 'wrong_item', 'not_delivered', 'other'] },
      },
      required: ['orderId', 'reason'],
      additionalProperties: false,
    },
  },
];

@Injectable()
export class OrderAgentService {
  constructor(@Inject(LLM_CLIENT) private readonly client: Anthropic, private readonly tools: ToolExecutor) {}

  async run(userMessage: string, ctx: ToolContext): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

    for (let step = 0; step < 6; step++) {                       // bound the loop
      const res = await this.client.messages.create({
        model: 'claude-opus-5-5', max_tokens: 2_048, system: AGENT_SYSTEM, tools: TOOLS, messages,
      });
      if (res.stop_reason !== 'tool_use') {
        return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
      }
      messages.push({ role: 'assistant', content: res.content }); // append the full content, not just text

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== 'tool_use') continue;
        try {
          // The executor validates input, authorizes against ctx.userId, and enforces idempotency.
          const out = await this.tools.execute(block.name, block.input, ctx);
          results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
        } catch (err) {
          results.push({ type: 'tool_result', tool_use_id: block.id, content: (err as Error).message, is_error: true });
        }
      }
      messages.push({ role: 'user', content: results });          // ALL results in ONE user message
    }
    return 'I could not finish this request. A support agent will follow up.'; // step limit reached
  }
}
```

The provider SDK also ships a "tool runner" helper that drives this loop for you, with hooks for approval and logging; the manual loop is shown here because every guardrail point is visible.

#### PostgreSQL example

Write tools do not perform actions; they create **action requests**. A unique idempotency key makes a repeated tool call (a loop retry, a duplicated request) return the existing request instead of creating a second one.

```sql
CREATE TABLE agent_actions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key  text NOT NULL UNIQUE,   -- e.g. sha256(conversation_id | action | canonical args)
  tenant_id        uuid NOT NULL,
  user_id          uuid NOT NULL,          -- the customer the agent acted for
  action           text NOT NULL,          -- 'refund'
  args             jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending_approval'
                   CHECK (status IN ('pending_approval','approved','rejected','executed','failed')),
  decided_by       uuid,                    -- the human who approved or rejected
  created_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz
);

-- Tool call: create once, or return the existing request.
INSERT INTO agent_actions (idempotency_key, tenant_id, user_id, action, args)
VALUES ($1, $2, $3, 'refund', $4)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id, status;
-- (no row returned -> SELECT id, status FROM agent_actions WHERE idempotency_key = $1)

-- Human approval: a state transition that can only happen once.
UPDATE agent_actions
   SET status = 'approved', decided_by = $2, decided_at = now()
 WHERE id = $1 AND status = 'pending_approval'
RETURNING id, args;
```

The approval endpoint then calls the payments service with the same idempotency key (Part 29), so even an approval clicked twice refunds once. The key is derived from the conversation and the canonical arguments, not from the model's `tool_use` id, because a retried loop gets new ids for the same intended action.

#### Production scenario

An order-support agent has read-only tools (get order, get tracking, get return policy) and one write tool (request refund). Read tools run freely and let the agent answer most questions directly. The refund tool validates arguments, checks that the requesting user owns the order, enforces an idempotency key, and — because it moves money — creates a pending refund that a support agent approves rather than executing immediately. Every tool call is logged with the user and arguments. The result is an assistant that handles the common cases autonomously and safely escalates the consequential ones, with a full audit trail.

#### Failure scenario

An early agent was given a write tool to cancel orders with no authorization check and no approval gate, trusting the model to only cancel the user's own orders. A user sent a message crafted to make the model cancel a different order id (prompt injection, Part 36). The model obediently called the cancel tool with that id, and because there was no authorization check, it worked — one user cancelled another's order through the agent. The fix: authorize every tool call against the acting user's permissions (the agent cannot do anything the user could not do directly), require approval for cancellation, and treat the user message as untrusted. The lesson: an agent's tool call is an action that must pass the same authorization and safety gates as any API call; the model's say-so is never authorization.

#### Edge cases & failure modes

- **Unbounded loop**: the model calls tools forever; cap the steps.
- **No authorization**: the agent performs actions the user is not entitled to (the incident above).
- **Non-idempotent writes retried**: double refunds, double cancels; use idempotency keys.
- **Prompt injection via user input or tool results**: crafted content makes the model misbehave; treat all as untrusted, restrict tools, require approval.
- **Wrong arguments**: the model calls a tool with a hallucinated id; validate arguments and check against reality.
- **No audit trail**: you cannot explain or undo what the agent did; log every tool call.
- **Consequential action executed directly**: money or deletion without approval; gate these.

#### How a Senior Backend Engineer thinks about this

A senior designs agents on the principle that the model's output is untrusted and its tool calls are actions subject to the full security stack: every tool call is authorized against the acting user (the agent can do nothing the user could not do directly), write tools are few, idempotent and approval-gated, consequential actions route to a human, and everything is logged for audit. They prefer read-only tools and let the model read freely, because reads are safe and cover most tasks. They bound the loop and the blast radius, and they treat both user input and tool results as potential prompt-injection vectors. They apply the senior mantra to every tool the agent can call — can it be called with the wrong arguments, by the wrong user, twice, maliciously? — and build the guardrail for each.

#### Common mistakes

- Trusting the model's say-so as authorization for an action.
- Giving the agent powerful write tools with no approval gate.
- Non-idempotent write tools that double-act on retry.
- No loop bound, no audit log.
- Treating user input or tool results as trusted, enabling injection.

#### Interview questions

1. **What is an agent and how does the tool loop work?** An LLM that takes actions via tools in a loop: the model requests a tool call, your code validates/authorizes/runs it and returns the result, the model continues until done; you bound the loop.
2. **How do you make a write tool safe for an agent to call?** Validate arguments, authorize against the acting user, enforce idempotency, require human approval for consequential actions, and log the call; the model's request is never authorization.
3. **Why prefer read-only tools?** Reading is safe, so the model can use read tools freely to handle most tasks; write tools are the dangerous minority that need guarding.
4. **How does prompt injection threaten an agent, and how do you defend?** Crafted user input or tool results can make the model call a harmful tool; defend by authorizing every call against the user, restricting and approval-gating write tools, and treating all input and tool results as untrusted.
5. **Why must agent write tools be idempotent?** The tool loop may retry a call; without idempotency a retry double-acts (double refund), so use idempotency keys as with any write API (Part 29).

#### Practical exercise

Build an order-support agent with read-only tools (get order, get tracking) and one write tool (request refund). Make the refund tool validate its arguments, authorize against the requesting user, enforce an idempotency key, and route to a pending-approval state rather than executing. Bound the tool loop and log every call. Then attempt a prompt-injection message trying to refund another user's order and confirm the authorization check blocks it. Acceptance criteria: the agent answers read questions autonomously, refunds require approval and are idempotent, and no cross-user action succeeds.

## 37.4 Evaluation and guardrails

### 37.4.1 Knowing your LLM feature works

#### Concept

**Evaluation** is how you measure whether an LLM feature is good and whether a change improved or regressed it. Because LLM output is non-deterministic and prompt/model changes have unpredictable effects, you cannot verify an LLM feature by eyeballing a few examples. You build a **golden dataset** (representative inputs with known-good expected outputs or grading criteria), run the feature against it, and score the results — automatically where possible — so every change is measured, like a test suite for behavior.

#### Why does it exist?

Without evaluation, you are flying blind: you tweak a prompt, it looks better on the one example you tried, and you ship a change that silently made the feature worse on the cases you did not check. LLM features regress in ways unit tests do not catch, because the logic is in the prompt and the model, not the code. An evaluation set (built in depth in 37.6) turns "it seems fine" into a measured score, so you can improve the feature deliberately (hill-climbing against the eval) and catch regressions before users do. It is the single most important discipline for operating LLM features responsibly.

#### Mental model

An evaluation set is a test suite for a component whose behavior you cannot fully specify in code. For ordinary code, a unit test asserts an exact output. For an LLM feature, the "test" is a representative input plus a way to grade the output (exact match where possible, or a rubric, or a judge), run across many cases to produce a score. Just as you would not refactor code without tests, you do not change a prompt or model without an eval, because both are changes to behavior with unpredictable blast radius.

#### How it works

```text
Golden dataset: representative (input, expected/criteria) pairs
        |
        v
Run the feature on each input  ->  outputs
        |
        v
Grade each output:
  - exact / structured match   (classification, extraction: did it get the label/fields right?)
  - rule-based checks          (is it valid JSON? cites a real source? within length?)
  - LLM-as-judge               (a model scores the answer against a rubric)
  - human review               (a sample, for the subjective parts)
        |
        v
Score  ->  compare to the previous version  ->  ship only if it did not regress
```

The grading methods, from cheapest to richest:

- **Exact / structured match** for deterministic tasks: the classification label or extracted fields are right or wrong. Easy to automate, run in CI.
- **Rule-based checks**: is the output valid JSON, does it cite a real document, is it within the length limit, does it avoid forbidden content. Automatable guardrails.
- **LLM-as-judge**: a (often larger) model scores an answer against a rubric ("is this answer correct and grounded in the sources?"). Scales better than human review for subjective quality; validate the judge against human labels so you trust it.
- **Human review**: a sample, for the genuinely subjective aspects; the ground truth that validates the automated methods.

```ts
// A tiny eval harness: run the feature over the golden set and score.
async function runEval(cases: EvalCase[]): Promise<{ score: number; failures: EvalCase[] }> {
  let passed = 0;
  const failures: EvalCase[] = [];
  for (const c of cases) {
    const output = await feature(c.input);
    const ok = grade(output, c);          // exact match, rule check, or judge
    if (ok) passed++;
    else failures.push(c);
  }
  return { score: passed / cases.length, failures };
}
```

#### Regression tests in CI and online metrics

A subset of the eval runs in CI (Part 46) so a prompt or model change that regresses quality fails the build, just like a failing unit test. Beyond offline evals, **online metrics** measure the live feature: thumbs-up/down from users, task completion rates, how often answers are corrected, escalation rates. Offline evals catch regressions before shipping; online metrics catch real-world problems the eval set missed and feed new cases back into the golden dataset.

#### Guardrails

**Guardrails** are the runtime checks that keep a live LLM feature safe and on-spec, complementing evaluation (which measures quality offline). They include input filtering (reject or sanitize malicious or out-of-scope input), output filtering (block unsafe or off-policy output before it reaches the user), and — critically for RAG and agents — **permission checks on retrieved data**: in a multi-tenant system, the retrieval and the tools must be scoped to the current tenant and user, or the model can surface data it should not (37.1, 37.3).

#### Failure scenario (RAG leaking another tenant's documents)

A RAG system embedded all tenants' documents into one pgvector table and, in a refactor, a query dropped the `WHERE tenant_id = $tenant` filter. Suddenly, retrieval returned the most semantically similar chunks across *all* tenants, and the LLM confidently answered one company's question using another company's confidential documents, citing them. The leak went unnoticed until a customer recognized a competitor's product name in an answer. The fixes: make the tenant filter non-optional in the retrieval layer (not something a query can forget), add a guardrail that verifies every retrieved chunk belongs to the requesting tenant before it enters the prompt, and add an eval case that asserts no cross-tenant retrieval. The lesson: tenant isolation in RAG and agents is a guardrail that must be enforced structurally, because a single missing filter is a serious data breach (Part 85). Section 37.9 tells this incident in full, with the timeline and the structural fixes, and 37.7 builds the guardrails.

#### How a Senior Backend Engineer thinks about this

A senior will not ship or change an LLM feature without an evaluation set, because a prompt or model change is a behavior change with unpredictable effects that eyeballing cannot catch. They build a golden dataset of representative cases, grade with the cheapest method that fits (exact match, rules, then judge, then human sample), run a subset in CI as a regression gate, and track online metrics to feed new cases back. They enforce guardrails at runtime — input/output filtering and, above all, tenant and user permission checks on retrieved data and tool actions — treating a missing tenant filter in RAG as a data-breach-class bug. They measure retrieval and generation quality separately for RAG, because the two fail differently. In short, they apply the testing and observability discipline of the whole book to the parts of the system whose behavior lives in prompts and models.

#### Common mistakes

- Shipping prompt/model changes with no eval, silently regressing quality.
- Eyeballing a few examples instead of scoring a representative set.
- No regression gate in CI, so regressions reach production.
- Trusting an LLM judge without validating it against human labels.
- No runtime guardrails (input/output filtering, permission checks).
- Missing tenant/user scope on retrieval or tools, leaking data across tenants.
- Not feeding real-world failures back into the golden dataset.

#### Interview questions

1. **Why can't you verify an LLM feature by testing a few examples?** Output is non-deterministic and prompt/model changes have unpredictable, non-local effects; you need a representative scored dataset to catch regressions the examples miss.
2. **What grading methods does an eval use and when?** Exact/structured match for deterministic tasks, rule-based checks for guardrails, LLM-as-judge for subjective quality (validated against humans), and human review on a sample as ground truth.
3. **How does evaluation fit into CI and production?** A subset runs in CI as a regression gate on prompt/model changes; online metrics (feedback, completion, escalation) catch real-world issues and feed new eval cases back.
4. **What are guardrails and why are permission checks on retrieved data critical?** Runtime checks (input/output filtering, permission scoping) that keep a live feature safe; without tenant/user scoping on retrieval and tools, a RAG system or agent can surface another tenant's data — a breach.
5. **How do you validate an LLM-as-judge?** Compare its scores against human labels on a sample; only trust it where it agrees with humans.

#### Practical exercise

Build an evaluation set for the order-support RAG assistant: a golden dataset of representative questions with expected answers or grading criteria, automated grading (exact match for extractions, rule checks for citations and length, an LLM-judge for answer quality validated against a handful of human labels), and a CI gate that fails if a prompt change drops the score. Add two guardrail eval cases: one asserting no cross-tenant retrieval, one asserting the assistant says "I do not have that information" when the context lacks the answer. Acceptance criteria: a deliberately worse prompt fails the CI gate, and the cross-tenant case fails if the tenant filter is removed.
