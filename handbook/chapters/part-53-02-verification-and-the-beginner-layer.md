### 53.1.3 Plausible, not verified

#### Concept

A language model produces text that is *likely* given its input. For code, "likely" usually means "looks like correct code", and very often it is correct. But nothing in the generation step runs the code, checks it against your schema, or confirms that a package or method exists. Output is **plausible by construction and verified by nobody** until a compiler, a test, a reviewer or production checks it.

#### Why does it exist?

This is not a bug that the next model version removes; it is what the generation process is. Models are getting better, and agentic tools narrow the gap by running tests and type checkers inside the loop. But a tool that runs your tests is only as good as your tests, and a passing type check says nothing about authorization or concurrency. Part 38 (38.4.1 and 38.6.1) explains how product teams evaluate model output systematically; as an individual engineer, your evaluation is your test suite and your review.

#### Mental model

Imagine a student who has read every textbook and writes beautifully, sitting an exam where nobody marks the answers. Most answers will be right because they read the books. Some will be wrong with exactly the same handwriting and confidence. Fluency is not evidence.

#### How it works

The gap between "plausible" and "correct" shows up in predictable places:

| Failure | What it looks like | What catches it |
|---|---|---|
| Hallucinated API | `repository.findOneOrFailBy(...)` with a made-up signature | Compiler, type checker |
| Hallucinated package | `npm install` of a name that does not exist, or worse, exists and is malicious | Registry check, dependency review (53.4) |
| Wrong version | Uses an option removed two major versions ago | Compiler, tests, changelog |
| Logic error in an untested branch | Refund allowed when order is `shipped` | Tests that cover the branch, review |
| Security gap | Missing ownership check, string-built SQL | Security review checklist (Part 40, 40.38) |
| Concurrency bug | Check-then-act without a lock | Senior review, concurrency tests (Part 41, 41.9) |
| Fabricated explanation | "PostgreSQL automatically indexes foreign keys" (it does not) | Documentation, an experiment |

The top rows are cheap to catch automatically. The bottom rows are expensive and are exactly where AI-generated code needs a human who understands the system.

#### Practical example

You ask why a migration locked the `orders` table. The assistant explains confidently that `CREATE INDEX` "only takes a lightweight lock". In fact a plain `CREATE INDEX` takes a lock that blocks writes for the duration of the build; `CREATE INDEX CONCURRENTLY` avoids that (Part 24, 24.3). The explanation was fluent, specific and wrong. A two-minute check of the PostgreSQL documentation, or a test on a copy of the table while running an `INSERT` in another session, settles it.

#### Failure scenario

A developer asks for "a function to validate Indian GST numbers" and gets a tidy regex with a comment claiming it follows the official format. It accepts most real numbers, so manual testing looks fine. It also accepts some invalid ones, because the checksum digit is not verified, and the comment says nothing about that. Invoices with bad tax IDs reach the accounting export, and the finance team spends a week correcting them. Fix: property-based tests against known valid and invalid examples (Part 41, 41.15), and a habit of asking "what does this *not* check?"

#### Edge cases & failure modes

- **Confident citations.** The tool may cite a documentation section or RFC that does not say what it claims. Open the link.
- **Tests that test the implementation.** Ask a tool to write code and tests together and the tests may encode the same misunderstanding as the code.
- **"Fixed" by weakening the check.** An agent told to make tests pass may change the assertion instead of the code. Read test diffs as carefully as code diffs.

#### How a Senior Backend Engineer thinks about this

A senior applies the same rule to AI output as to a Stack Overflow answer or a colleague's untested branch: it is a hypothesis until something independent confirms it. They push verification as early and as automatic as possible (types, lint, tests, a quick experiment) and reserve human attention for the things machines cannot check: whether the change is the *right* change, and whether it is safe under failure, concurrency and attack.

#### Common mistakes

- Treating a detailed explanation as more trustworthy than a short one.
- Accepting a test suite written by the same tool, in the same session, as proof that the code works.
- Skipping the experiment because the answer "sounds right".

#### Interview questions

1. **Why is AI-generated code "plausible but unverified"?** Generation predicts likely text; nothing in that step executes or checks it. Follow-up: which classes of error does a compiler catch, and which need a human?
2. **An agent says all tests pass. What else do you check?** Whether tests were changed or weakened, whether new branches are covered, security and concurrency paths, and whether the change is the right one.
3. **How would you verify an AI's claim about database locking behaviour?** Read the PostgreSQL documentation for the statement's lock level and reproduce it with two sessions, checking `pg_locks`.

#### Practical exercise

Ask an assistant five factual questions about PostgreSQL or NestJS behaviour that you can verify (for example, "does PostgreSQL create an index for a foreign key automatically?", "what lock does `ALTER TABLE ... ADD COLUMN ... DEFAULT` take?"). Acceptance criteria: for each, the assistant's answer, the documentation or experiment that confirms or refutes it, and a tally of correct, partly correct and wrong.

## 53.2 The beginner layer: learning with an assistant

### 53.2.1 A tutor and a pair, not an oracle

#### Concept

For someone early in their career, an AI assistant can be the most patient tutor they have ever had: it explains a stack trace at 23:00, rephrases a concept five ways and never sighs. It can also quietly stop you learning, because it hands you working code before you have built the mental model that would let you write, debug or review it. The difference is how you use it: as a **tutor** (explain, quiz, critique) and a **pair** (you drive, it suggests), not as an **oracle** (it answers, you paste).

#### Why does it exist?

Juniors become seniors by building mental models: how a request flows through NestJS, why a transaction needs isolation, what an index does. Those models come from struggling with problems, being wrong, and finding out why. An oracle removes the struggle and the model never forms. The engineer who cannot work without the tool is also the engineer who cannot tell when the tool is wrong, which is exactly when they are needed.

#### Mental model

Imagine learning to drive with an instructor who has dual controls. A good instructor lets you steer, brakes only when needed, and explains what you did wrong. A bad one drives the whole lesson while you sit in the driver's seat. After twenty lessons with the second, you have a log of hours and no ability to drive.

#### How it works

Prompts that build understanding versus prompts that replace it:

| Instead of | Ask |
|---|---|
| "Write a NestJS guard that checks roles." | "I wrote this guard. Explain what `ExecutionContext` gives me and point out anything wrong, without rewriting it." |
| "Fix this error." | "Explain what this error means and where in the request lifecycle it is thrown. Give me a hint, not the fix." |
| "Write the SQL for top customers." | "Here is my SQL. Will it be slow on 10 million rows? Explain the plan I should expect." |
| "Write tests for this service." | "List the cases I should test for this service and why. I will write them." |
| "What does this code do?" (then nothing) | "Explain this function line by line, then quiz me with three questions about it." |

#### Practical example

A junior is stuck on `QueryFailedError: duplicate key value violates unique constraint "uq_users_email"`. The oracle route: paste error, get a patch that catches the error and returns 409, paste it in, move on. The tutor route: ask what the error means, learn that PostgreSQL enforced a unique index, learn why checking "does the email exist?" before inserting is a race (two requests can both see "no" and both insert, Part 21, 21.3), and then write the handler that maps PostgreSQL error code `23505` to `409 Conflict`. Same final code; one of them now understands why the database, not the application, must be the source of truth for uniqueness.

#### How a Senior Backend Engineer thinks about this

Seniors coaching juniors encourage AI use and expect juniors to explain every line they submit. "The AI wrote it" is not an answer in code review, any more than "I found it on a forum" was. The senior also models the behaviour: asking the tool for explanations, saying out loud when it is wrong, and showing how they checked.

#### Common mistakes

- Pasting code you cannot explain into a pull request.
- Never trying for ten minutes before asking. Struggle is where learning happens.
- Asking for whole features instead of asking about the parts you do not understand.

#### Interview questions

1. **How do you use AI tools while you are still learning a stack?** As a tutor for explanations and critique, writing the code myself first, and verifying everything by running it.
2. **A reviewer asks you why a line works and you do not know. What happened and what do you do?** I accepted code without understanding it; I learn it before the change merges, or I rewrite it into something I can explain.

#### Practical exercise

For one week, use an assistant only in "tutor mode": it may explain, critique and quiz, but not write code you commit. Acceptance criteria: a log of ten questions you asked, what you learned from each, and one concept you could now explain to a teammate without notes.

### 53.2.2 What never goes into a prompt

#### Concept

Anything you type, paste or let a tool read is sent to a model provider's servers, unless your organisation runs the model itself. Depending on the product and plan, it may be logged, retained for a period, or reviewed for abuse. Treat a prompt like an email to an external company: **never** include secrets, private keys, customer personal data or anything your data classification says must not leave approved systems.

#### Why does it exist?

Because the most common AI-tool security incident is not a clever attack; it is an engineer pasting a production `.env` file to ask "why can't I connect?". Once sent, you cannot un-send it, and the secret must be treated as compromised. Part 40 — Security, 40.32, covers secrets management; this is the AI-shaped hole in it.

#### How it works

| Never paste or expose | Why | Do instead |
|---|---|---|
| `.env` files, API keys, database URLs with passwords | Credentials leave your control; must be rotated | Redact: `postgres://USER:REDACTED@HOST/db` |
| Private keys, JWT signing secrets, certificates | Total compromise of what they protect | Describe the setup, never the material |
| Customer data: names, emails, addresses, phone numbers, payment details | Privacy law and contracts; a data breach by another name | Use synthetic rows with obviously fake values |
| Production database dumps or log extracts with personal data | Same as above, at scale | Anonymise first, or reproduce with generated data |
| Proprietary code your policy says must not go to unapproved tools | Licence, IP and contractual obligations | Use only the organisation's approved tools (53.9) |

For agents, the risk is that the tool reads secrets *on its own*: it opens `.env` to understand configuration, or prints environment variables while debugging. Two habits close most of this gap:

```bash
# Keep real secrets out of the working tree entirely; load them from a manager at runtime.
# For local work, keep a redacted example file that tools may read:
cat .env.example
# DATABASE_URL=postgres://orders_app:CHANGE_ME@localhost:5432/orders_dev
# PAYMENT_API_KEY=test_key_placeholder

# And check your tool's ignore or deny settings so it will not read real secret files.
# Many tools honour .gitignore; some have their own ignore or permission files. Verify, do not assume.
git check-ignore -v .env
```

#### Failure scenario

A developer debugging a connection error asks a chat assistant for help and pastes the full output of `printenv` from a staging container. It includes the payment provider's live secret key, because staging had been wired to the live account "temporarily" months earlier. The security team, alerted by the developer's own message in the team channel, rotates the key within the hour. Nothing was abused, but the rotation broke three services that had the old key cached, and it took an afternoon to recover. Two lessons: redact before you paste, and staging should never hold production secrets in the first place.

#### Common mistakes

- Pasting a whole log file without scanning it for emails, tokens or card fragments.
- Using a personal AI account for company code because "it is faster than asking for access".
- Assuming the tool will not read `.env` because you did not mention it.

#### Interview questions

1. **You accidentally pasted a production database password into an AI chat. What do you do?** Treat it as leaked: tell the security owner, rotate the credential, check access logs, and follow the incident process; do not just delete the chat.
2. **How do you get help with a bug that involves customer data?** Reproduce it with synthetic data, or redact identifying fields before sharing anything.

#### Practical exercise

Audit your own last twenty AI prompts (most tools keep a history). Acceptance criteria: count any that contained credentials, personal data or internal hostnames; for each, write what you should have sent instead; set up a redacted `.env.example` and confirm with `git check-ignore` that the real file is ignored.

### 53.2.3 Verify every suggestion: run it, test it, read it

#### Concept

The beginner's single most important habit with AI: **nothing is done until you have run it and written a test that would fail if it were wrong.** And because you will spend your career reading code you did not write (colleagues', libraries', and now AI's), learn to read AI code the same way: line by line, asking what each line does and what happens when its inputs are bad.

#### How it works

A five-step check for any AI suggestion, small or large:

1. **Read it before you run it.** Can you say what each line does? Look up anything you cannot.
2. **Run it.** Locally, against real inputs. Does it even compile and start?
3. **Break it.** Feed it the inputs the tool did not think of: empty string, null, a huge number, a duplicate request, a user who is not the owner.
4. **Pin it with a test.** Write a test that fails without the change and passes with it (Part 41 — Testing Backend Systems with Jest and NestJS).
5. **Explain it.** Could you defend this in review? If not, you are not done.

```ts
// A tiny test that pins behaviour an assistant suggested for order cancellation.
// If someone (or some tool) later changes the rule, this fails loudly.
import { OrdersService } from './orders.service';
import { ConflictException } from '@nestjs/common';

describe('OrdersService.cancel', () => {
  it('refuses to cancel an order that has already shipped', async () => {
    const repo = { findOneBy: jest.fn().mockResolvedValue({ id: 'ord_1', status: 'shipped' }) };
    const service = new OrdersService(repo as any);

    await expect(service.cancel('ord_1')).rejects.toBeInstanceOf(ConflictException);
  });
});
```

#### When to switch the assistant off

There are times to close the chat panel and turn completion off:

- **When learning a new fundamental.** Your first week of SQL joins, your first transaction code, your first time with NestJS dependency injection. Write it by hand until it is boring.
- **When practising for interviews.** Most coding interviews still expect you to reason without an assistant (Part 70 — The Interview Playbook).
- **When you notice you are accepting suggestions without reading them.** That is autopilot; switch off for an hour and reset.
- **When debugging something subtle.** A concurrency bug or a performance cliff needs your full attention on evidence, not a stream of guesses.

#### Common mistakes

- "It compiled, so it works."
- Running the happy path once and calling it tested.
- Keeping completion on during a learning exercise and wondering why nothing sticks.

#### Interview questions

1. **How do you verify code an assistant gave you?** Read, run, try bad inputs, add a failing-then-passing test, and make sure I can explain it.
2. **When would you deliberately not use an AI tool?** While learning a fundamental, when debugging something subtle that needs focused reasoning, and when I notice I am accepting without reading.

#### Practical exercise

Take an AI-generated function from your recent work. Write three tests that try to break it (bad input, boundary, unauthorised caller). Acceptance criteria: at least one test either fails and leads to a fix, or you write a short note explaining why the function handles all three correctly, with the evidence.
