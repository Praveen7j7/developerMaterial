## 41.5 Hybrid search: full-text and vectors in one PostgreSQL query

### 41.5.1 Combining keyword and semantic retrieval

#### Concept

**Hybrid search** runs a keyword search and a vector search for the same query and merges the two ranked lists into one. Keyword search (PostgreSQL full-text search, Part 37 — Search) is precise about words: exact names, SKUs, rare terms. Vector search is good at meaning: paraphrases, synonyms, vague descriptions. Merged, they cover each other's blind spots. The most common merge method is **Reciprocal Rank Fusion (RRF)**, which combines lists by rank position rather than by raw score.

#### Why does it exist?

Each method fails in a way the other does not. A shopper typing "4410-B" or "Nitrile Pro XL" wants that exact product; its embedding is nearly meaningless, so vector search returns lookalikes. A shopper typing "gloves that don't rip on sharp tools" uses none of the catalog's words, so full-text search returns nothing. Real traffic mixes both kinds of queries, often in one query ("puncture resistant gloves size XL"). Choosing one method means failing a large share of searches; combining them is cheap because both run inside the same PostgreSQL database.

#### Mental model

Imagine two librarians. One has memorized the catalog index card by card and finds any title or code instantly, but has no idea what a book is *about*. The other has read every book and can find "something like this", but is hopeless with call numbers. You ask both, take each one's top picks, and give extra credit to books both of them picked. RRF is that "extra credit for agreement" rule, done with arithmetic.

#### How it works

1. **Keyword branch**: `websearch_to_tsquery` parses the query; a GIN index on a `tsvector` column finds matches; `ts_rank_cd` orders them. Take the top 50.
2. **Semantic branch**: embed the query; the HNSW index returns the 50 nearest product vectors.
3. **Exact branch** (optional but valuable in e-commerce): a direct lookup on SKU or barcode.
4. **Fuse with RRF**: each product's score is the sum over branches of `1 / (k + rank)`, with `k` around 60. A product ranked 1st by keywords and 3rd by vectors scores `1/61 + 1/63`; a product found by only one branch scores less. An exact SKU hit gets a large fixed boost.
5. **Filter in every branch**: tenant, in-stock, visibility. A filter applied in only one branch leaks rows through the other.

Why rank and not score? `ts_rank_cd` values and cosine similarities live on unrelated scales that change with the query; adding them is meaningless. Ranks are comparable by construction, and RRF needs no tuning beyond `k`.

#### PostgreSQL example

```sql
-- Keyword side: a generated tsvector with weights (name matters more than description).
ALTER TABLE products ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'B')
) STORED;
CREATE INDEX products_search_tsv_gin ON products USING gin (search_tsv);
CREATE INDEX products_tenant_sku ON products (tenant_id, sku);

-- $1 = query embedding, $2 = tenant id, $3 = raw query text
WITH semantic AS (
  SELECT e.product_id AS id, row_number() OVER (ORDER BY e.embedding <=> $1::vector) AS rnk
    FROM product_embeddings e
   WHERE e.tenant_id = $2
   ORDER BY e.embedding <=> $1::vector
   LIMIT 50
),
keyword AS (
  SELECT p.id, row_number() OVER (ORDER BY ts_rank_cd(p.search_tsv, q) DESC) AS rnk
    FROM products p, websearch_to_tsquery('english', $3) AS q
   WHERE p.tenant_id = $2 AND p.search_tsv @@ q
   ORDER BY ts_rank_cd(p.search_tsv, q) DESC
   LIMIT 50
),
exact AS (
  SELECT id, 1 AS rnk FROM products WHERE tenant_id = $2 AND sku = upper(trim($3))
)
SELECT p.id, p.name, p.price_cents,
       coalesce(1.0 / (60 + s.rnk), 0)
     + coalesce(1.0 / (60 + k.rnk), 0)
     + coalesce(0.5 / x.rnk, 0)                AS score   -- an exact SKU hit always wins
  FROM semantic s
  FULL JOIN keyword k USING (id)
  FULL JOIN exact   x USING (id)
  JOIN products p ON p.id = coalesce(s.id, k.id, x.id)
 WHERE p.in_stock AND p.tenant_id = $2                   -- final filters, applied once to the union
 ORDER BY score DESC
 LIMIT 20;
```

Applying `in_stock` after fusion keeps the HNSW branch unfiltered except by tenant (avoiding the filtered-search trap from 41.1.2 for a common filter), at the cost of sometimes returning fewer than 20 rows; for very selective filters, push them into the branches and enable iterative scans.

```text
EXPLAIN (ANALYZE, BUFFERS), abbreviated:
Limit  (actual time=11.9..12.0 rows=20 loops=1)
  ->  Sort  (actual time=11.9..11.9 rows=20 loops=1)
        Sort Key: (((COALESCE(...) + COALESCE(...)) + COALESCE(...))) DESC
        Sort Method: top-N heapsort  Memory: 27kB
        ->  Nested Loop  (actual time=4.1..11.6 rows=88 loops=1)
              ->  Hash Full Join  (actual time=4.0..4.3 rows=91 loops=1)
                    ->  Subquery Scan on s  (actual time=0.9..3.0 rows=50 loops=1)
                          ->  Limit -> WindowAgg -> Index Scan using product_embeddings_hnsw
                    ->  Subquery Scan on k  (actual time=2.6..2.8 rows=41 loops=1)
                          ->  Limit -> WindowAgg -> Sort
                                ->  Bitmap Heap Scan on products  (rows=41)
                                      ->  Bitmap Index Scan on products_search_tsv_gin
              ->  Index Scan using products_pkey on products p  (actual time=0.07..0.07 rows=1 loops=91)
                    Filter: (in_stock AND (tenant_id = $2))
Execution Time: 12.3 ms
```

Both indexes are used (`product_embeddings_hnsw` and `products_search_tsv_gin`), 91 candidates are fused, and the whole query runs in about 12 ms on a 400,000-product catalog.

#### NestJS example

```ts
// search/hybrid-search.service.ts -- hybrid when possible, keyword-only when the embedder is down
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmbeddingService } from '../embeddings/embedding.service';
import { HYBRID_SQL, KEYWORD_ONLY_SQL } from './search.sql';

@Injectable()
export class HybridSearchService {
  private readonly logger = new Logger(HybridSearchService.name);
  constructor(private readonly ds: DataSource, private readonly embeddings: EmbeddingService) {}

  async search(tenantId: string, query: string) {
    const q = query.trim().slice(0, 200);                  // bound input (and cost)
    let vec: number[] | null = null;
    try {
      vec = await Promise.race([
        this.embeddings.embedQuery(q),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('embed timeout')), 300)),
      ]);
    } catch (err) {
      this.logger.warn(`semantic branch skipped: ${(err as Error).message}`); // degrade, do not fail
    }
    return vec
      ? this.ds.query(HYBRID_SQL, [JSON.stringify(vec), tenantId, q])
      : this.ds.query(KEYWORD_ONLY_SQL, [tenantId, q]);
  }
}
```

The 300 ms budget for the query embedding is deliberate: search must stay fast, and keyword-only results are far better than an error page. Count how often the fallback runs; if it is more than a fraction of a percent, the embedding provider (or the cache) needs attention.

#### Production scenario

A B2B dental-supplies store with 400,000 products measured "search success" (a click in the top 5 within the session) over two weeks per variant: full-text only 61%, vector only 66%, hybrid with an exact-SKU branch 74%. Zero-result searches fell from 9% (full-text) to under 1%. The query costs about 12 ms in PostgreSQL; with the embedding call (cached for 45% of queries) the endpoint's p50 is 55 ms and p99 160 ms. No new infrastructure was added: one generated column, one GIN index and one HNSW index on the existing database.

#### Failure scenario

The same store first launched **vector-only** search, because the demo looked impressive. Within a week, sales reps reported that clinics could no longer find products by part number; typing "4410-B" returned five similar-looking but wrong products. B2B buyers search by codes copied from invoices, so conversion for repeat orders dropped 12%. The rollback restored full-text search; the relaunch two weeks later used hybrid search with the exact-SKU branch. The lesson: semantic search is an addition to keyword search, not a replacement, and an evaluation set without SKU queries would never have caught this (41.6).

#### Edge cases & failure modes

- **Text search configuration**: `'english'` stems words ("gloves" -> "glove") but mangles codes and brand names; consider a second `'simple'` tsvector for names and SKUs.
- **Stop-word-only queries** ("the", "and") produce an empty tsquery: the keyword branch returns nothing and only vectors answer.
- **Filters in one branch only** let excluded rows in through the other branch; apply tenant scope in every branch.
- **Deep pagination** over fused results is unstable; cap at a few pages and suggest refining the query.
- **Embedding provider slow or down**: time-box the embed call and fall back to keyword-only.
- **Score display**: RRF scores are not percentages or "relevance"; never show them to users.

#### How a Senior Backend Engineer thinks about this

A senior assumes real query traffic is a mix of exact lookups, keywords and vague descriptions, and does not let a demo of one kind decide the architecture. They keep both retrieval methods in PostgreSQL when the scale allows, fuse by rank because raw scores are not comparable, give exact identifiers a hard boost, apply security filters in every branch, and keep keyword search as the degraded mode when the embedding path fails. They justify each piece with an evaluation set that includes every query type the business sees.

#### Common mistakes

- Replacing keyword search with vector search instead of adding to it.
- Adding raw `ts_rank` and cosine scores together.
- Filtering by tenant in one branch only.
- No fallback when the query embedding cannot be computed.
- Evaluating only natural-language queries and missing codes and names.

#### Interview questions

1. **Why combine full-text and vector search?** Keyword search is precise for exact terms, codes and names; vector search handles paraphrase and vague intent. Real traffic mixes both, and hybrid search beats either alone.
2. **What is Reciprocal Rank Fusion and why use it instead of adding scores?** Score = sum over lists of `1/(k + rank)`; it combines rankings on a common scale without tuning, whereas raw scores from different methods are not comparable.
3. **How do you keep hybrid search tenant-safe?** Apply the tenant filter in every branch and again on the final join; a filter in one branch only leaks through the other.
4. **What happens to your search when the embedding provider is down?** With a time-boxed embed call, the service falls back to keyword-only results and records the degradation.

#### Practical exercise

Add a weighted `search_tsv` column and GIN index to a products table, build the RRF query with semantic, keyword and exact-SKU branches, and wrap it in a NestJS service with a 300 ms embedding budget and keyword fallback. Build a 60-query evaluation set mixing SKUs, product names and natural-language descriptions. Acceptance criteria: hybrid beats both single methods on recall@5, every SKU query returns its product first, `EXPLAIN` shows both indexes used, and blocking the embedding provider still returns keyword results.

## 41.6 Evaluation in depth: golden datasets, judges and CI gates

### 41.6.1 Building an evaluation you can trust

#### Concept

Section 41.4 introduced evaluation. This section builds one: a **golden dataset** stored like test fixtures, **retrieval metrics** (did we fetch the right chunks?), **answer grading** with rules and an **LLM-as-judge** (is the answer correct and grounded?), a **CI gate** that blocks regressions, and **online metrics** that keep the dataset honest.

#### Why does it exist?

Every change to an LLM feature (a prompt edit, a new chunk size, a different model, a re-ranker) changes behavior in ways a reviewer cannot see in a diff. Without measurements, teams ship by vibes: three examples look better, so it merges. An evaluation turns those changes into numbers that can be compared, and the CI gate makes the comparison automatic, exactly as unit tests do for code (Part 45 — Testing).

#### Mental model

Imagine a restaurant that changes its recipes weekly. A trusted panel tastes a fixed menu of 200 dishes after every change and scores each against written criteria: is it the dish that was ordered, is it cooked through, is anything on the plate that should not be there. Some checks are mechanical (temperature, weight); some need a trained taster, and the head chef checks the tasters against her own judgment now and then. The fixed menu is the golden dataset, the mechanical checks are rule-based graders, the tasters are the LLM judge, and the head chef is human review.

#### How it works

1. **Collect cases** from real traffic (with PII removed), support tickets and known failures. Each case has an input, the tenant it runs as, and expectations: the documents that should be retrieved, a reference answer or required facts, and flags such as "should say I don't know".
2. **Cover the categories that matter**: common questions, exact identifiers, questions the corpus cannot answer, multi-document questions, injection attempts, and cross-tenant probes. A dataset of 150–400 cases is a useful start.
3. **Score retrieval separately**: recall@k (share of expected documents found in the top k) and MRR (how high the first relevant document ranks).
4. **Score answers**: rule checks first (valid citations, length, "I don't know" when expected), then an LLM judge for correctness and groundedness.
5. **Compare to a baseline** on the same cases, and fail the build on meaningful drops or on any hard-gate failure (a cross-tenant leak).
6. **Feed production back**: thumbs-down answers and escalations become new cases weekly.

```ts
// eval/metrics.ts -- retrieval metrics are plain code
export function recallAtK(retrieved: string[], expected: string[], k: number): number {
  if (!expected.length) return 1;
  const top = new Set(retrieved.slice(0, k));
  return expected.filter((id) => top.has(id)).length / expected.length;
}

export function reciprocalRank(retrieved: string[], expected: string[]): number {
  const i = retrieved.findIndex((id) => expected.includes(id));
  return i === -1 ? 0 : 1 / (i + 1); // averaged over cases, this is MRR
}
```

#### NestJS example

The judge is an LLM call with structured output. Ask it for **yes/no judgments on specific criteria** rather than a 1–10 score; binary questions are far more consistent between runs and easier to validate against humans.

```ts
// eval/judge.ts -- a grounded-correctness judge with a strict verdict shape
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

export const Verdict = z.object({
  correct: z.boolean(),                       // agrees with the reference facts
  grounded: z.boolean(),                      // every claim is supported by the supplied context
  unsupportedClaims: z.array(z.string()).max(5),
  saysUnknownWhenItShould: z.boolean(),
});

const JUDGE_SYSTEM = `You grade answers from a support assistant. Use ONLY the context and the
reference facts given. Judge each criterion independently. Be strict: a claim not supported by the
context is unsupported even if it is true in the real world.`;

export async function judge(client: Anthropic, c: {
  question: string; referenceFacts: string[]; context: string; answer: string; expectUnknown: boolean;
}) {
  const res = await client.messages.parse({
    model: 'claude-opus-5-5', // a capable judge; validate it against human labels before trusting it
    max_tokens: 800,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content:
      `<question>${c.question}</question>\n<reference_facts>${c.referenceFacts.join('\n')}</reference_facts>\n` +
      `<context>${c.context}</context>\n<answer>${c.answer}</answer>\n` +
      `<expect_unknown>${c.expectUnknown}</expect_unknown>` }],
    output_config: { format: zodOutputFormat(Verdict), effort: 'medium' },
  });
  return Verdict.parse(res.parsed_output);
}
```

The CI suite is an ordinary Jest test that runs the real pipeline over the cases and compares with a stored baseline:

```ts
// eval/rag.eval.spec.ts -- run with: npm run eval (a separate Jest project, not the unit tests)
import { readFileSync, writeFileSync } from 'node:fs';
import { runSuite } from './run-suite';

jest.setTimeout(15 * 60_000);

it('order-support RAG does not regress', async () => {
  const cases = readFileSync('eval/cases/ci.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const report = await runSuite(cases, { concurrency: 4 });
  writeFileSync('eval/report.json', JSON.stringify(report, null, 2));
  const base = JSON.parse(readFileSync('eval/baseline.json', 'utf8'));

  expect(report.crossTenantLeaks).toBe(0);                                  // hard gate
  expect(report.invalidCitations).toBe(0);                                  // hard gate
  expect(report.recallAt5).toBeGreaterThanOrEqual(base.recallAt5 - 0.03);
  expect(report.correctAndGrounded).toBeGreaterThanOrEqual(base.correctAndGrounded - 0.05);
});
```

```yaml
# .github/workflows/llm-eval.yml -- only when behavior-changing code changes
name: llm-eval
on:
  pull_request:
    paths: ['src/prompts/**', 'src/rag/**', 'src/search/**', 'eval/**']
jobs:
  eval:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_PASSWORD: postgres
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run eval:seed   # fixed corpus with precomputed embeddings: no embedding cost per run
      - run: npm run eval
        env:
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: eval-report
          path: eval/report.json
```

#### PostgreSQL example

Online metrics come from production tables you already have: the call ledger (40.7) and a feedback table.

```sql
-- Weekly answer quality by prompt version, from user feedback and escalations.
SELECT c.prompt_version,
       count(*)                                                  AS answers,
       round(100.0 * avg((f.rating = 'down')::int), 2)           AS thumbs_down_pct,
       round(100.0 * avg((f.escalated)::int), 2)                 AS escalated_pct,
       round(100.0 * avg((c.outcome <> 'ok')::int), 2)           AS degraded_pct
  FROM llm_calls c
  LEFT JOIN llm_feedback f ON f.call_id = c.id
 WHERE c.feature = 'order-support' AND c.created_at >= now() - interval '7 days'
 GROUP BY c.prompt_version
 ORDER BY c.prompt_version;
```

#### Production scenario

The order-support team keeps 380 cases: 120 run in CI on every prompt or retrieval change (about 6 minutes and about $1.50 per run), the full 380 run nightly and before any model switch. They validated the judge on 150 human-labelled answers: it agreed with the humans on 92% of "grounded" judgments, and the disagreements were mostly borderline paraphrases, so they trust it for regression detection but not for absolute quality claims. Each week, 20–30 thumbs-down answers are reviewed and about 10 become new cases.

#### Failure scenario

The first CI gate compared each run's pass rate with a fixed threshold of 90% on 60 cases. It failed randomly about one run in five with no code change, so engineers learned to click "re-run" until it passed, and the gate became theater. The cause was arithmetic: with 60 cases, one case is 1.7 points, and run-to-run noise from non-deterministic outputs moved the score by 3–5 points. The fix: 120 cases in CI, tolerances based on measured noise, a comparison against the baseline on the same cases, hard gates only for zero-tolerance properties (leaks, invalid citations), and the full set nightly. The lesson: an eval gate must be less noisy than the regressions it is meant to catch, or people will route around it.

#### Edge cases & failure modes

- **Small datasets are noisy**: with 100 cases, the standard error of a 90% pass rate is about 3 points; gate on larger drops or larger sets.
- **The judge shares the generator's blind spots** if it is the same model with a similar prompt; use specific criteria, reference facts, and human validation.
- **Dataset rot**: the corpus changes and expected documents no longer exist; version the eval corpus as a fixture.
- **Overfitting to the eval**: tuning prompts until 380 cases pass can hurt real traffic; keep a held-out set you do not tune against.
- **Eval cost creep**: judge calls on every PR add up; run the full set nightly, a subset per PR.
- **PII in eval cases** copied from production; scrub before committing.

#### How a Senior Backend Engineer thinks about this

A senior treats the evaluation set as a product asset that grows every week, not a one-off script. They measure retrieval and generation separately so that a failure points at its stage; they prefer cheap deterministic checks and use an LLM judge only for what rules cannot grade, after validating it against humans; and they design the CI gate around measured noise so that it is trusted. Hard gates exist for the properties that must never happen (cross-tenant leaks, fabricated citations), and online metrics close the loop. They explain it to a product manager as "our test suite for the parts of the system written in English".

#### Common mistakes

- Only end-to-end answer grading, so retrieval regressions look like prompt problems.
- Asking a judge for a 1–10 score and treating the decimals as meaningful.
- Never checking the judge against human labels.
- A CI gate so noisy that people re-run it until green.
- Never adding production failures to the dataset.

#### Interview questions

1. **How do you evaluate a RAG system?** Separately: retrieval with recall@k and MRR against expected documents; answers with rule checks and a validated LLM judge for correctness and groundedness; plus hard-gate cases for safety properties and online metrics from feedback.
2. **How do you make an LLM judge trustworthy?** Specific binary criteria, reference facts and the context in the prompt, structured verdicts, and measured agreement with human labels on a sample before relying on it.
3. **Your eval gate is flaky. What do you do?** Measure run-to-run noise, enlarge the CI set, compare against a baseline on the same cases with tolerances above the noise, keep zero-tolerance hard gates, and run the full suite on a schedule.
4. **Where do new eval cases come from?** Production failures (thumbs-down, escalations, incidents), new product features, and adversarial cases such as injection and cross-tenant probes.

#### Practical exercise

Build the eval harness for your RAG assistant: 120 cases in JSONL with expected document ids, reference facts and an `expectUnknown` flag; recall@5 and MRR computed in code; a binary-criteria judge with structured output validated against 40 cases you label yourself; a Jest suite with hard gates for cross-tenant leaks and invalid citations; and the GitHub Actions workflow above. Acceptance criteria: removing the tenant filter fails the build; a deliberately worse prompt fails the build; three re-runs of an unchanged branch all pass.
