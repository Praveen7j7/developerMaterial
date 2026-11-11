## 41.9 Incident story: a RAG system leaking another tenant's documents

### 41.9.1 The system

A B2B SaaS company sells practice-management software to dental clinics. Each clinic is a tenant. A "Clinic Assistant" answers staff questions ("what is our cancellation policy?", "which supplier do we use for implants?") using RAG over each clinic's own uploaded documents: policies, price lists, supplier contracts. All tenants' chunks live in one `doc_chunks` table with a `tenant_id` column and an HNSW index. The table predates the company's adoption of row-level security, so isolation depends on the `WHERE tenant_id = $1` in the retrieval query. About 1,400 tenants, 3.2 million chunks, 60,000 assistant questions a day.

### 41.9.2 Timeline

| When | What happened |
|---|---|
| Tue 10:05 | Release 2.31 ships a retrieval refactor so a new "public help center" search can reuse the chunk search |
| Tue 10:05 to Thu 16:42 | The assistant answers about 115,000 questions; some answers include other clinics' content |
| Thu 16:42 | A clinic manager reports that the assistant quoted "Brightsmile Dental supplier price list" when asked about their own implant prices |
| Thu 17:10 | Support escalates to the on-call engineer and security; declared SEV-1 |
| Thu 17:25 | The assistant is disabled for all tenants with its feature flag (kill switch) |
| Thu 18:40 | Root cause found in the refactored repository method |
| Thu 20:15 | Fix deployed; assistant re-enabled for the internal test tenant only |
| Fri 11:00 | Blast-radius analysis complete from retrieval logs |
| Fri 15:00 | Assistant re-enabled for all tenants after the new CI hard gate passes |
| Mon | Affected tenants notified under their data-processing agreements, with the list of exposed documents |

### 41.9.3 Root cause

The refactor turned the tenant filter into an **optional** parameter, so that public help-center content (stored with no tenant) could be searched with the same method:

```ts
// BEFORE: tenant required by the signature
async searchChunks(tenantId: string, vec: number[], k: number) { /* WHERE tenant_id = $1 ... */ }

// AFTER (the bug): tenant optional, filter added only "if present"
async searchChunks(vec: number[], opts: { tenantId?: string; k?: number }) {
  const where: string[] = [];
  const params: unknown[] = [JSON.stringify(vec)];
  if (opts.tenantId) { params.push(opts.tenantId); where.push(`tenant_id = $${params.length}`); }
  const sql = `SELECT id, tenant_id, document_id, content FROM doc_chunks
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY embedding <=> $1::vector LIMIT ${opts.k ?? 8}`;
  return this.ds.query(sql, params);
}
```

The assistant's call site was updated to pass `{ k: 8, tenantId: ctx.tenant }`. But `ctx.tenant` was the old property name; the request context had been renamed to `tenantId` in an unrelated change a month earlier and the field was typed as `any` in that one place. `opts.tenantId` was therefore `undefined`, the `if` skipped the filter, and every assistant query searched **all 1,400 tenants**. The nearest chunks were usually still the clinic's own (similar documents are similar), which is why the bug hid for two days: only questions where another clinic had a closer document leaked.

Why nothing caught it, the "five whys" in short: no RLS on the table; the tenant was optional in the method signature; an `any` hid the wrong property name; unit tests mocked the repository; the evaluation set ran as a single tenant, so there was no other tenant's data to leak.

### 41.9.4 Blast radius

The team could answer "who saw what" only because they logged retrieved chunk ids for every call (a decision made months earlier for debugging):

```sql
-- Every answer that used at least one chunk from a different tenant, since the release.
SELECT r.call_id, c.tenant_id AS asking_tenant, d.tenant_id AS owner_tenant, d.document_id, c.created_at
  FROM llm_retrievals r
  JOIN llm_calls  c ON c.id = r.call_id
  JOIN doc_chunks d ON d.id = r.chunk_id
 WHERE c.feature = 'clinic-assistant'
   AND c.created_at >= '2026-03-10 10:05+00'
   AND d.tenant_id IS DISTINCT FROM c.tenant_id;
```

Result: 1,912 answers, asked from 37 tenants, included at least one foreign chunk; 214 documents from 61 owner tenants were involved; 403 of those answers quoted or cited foreign content directly. Without the retrieval log, the only honest statement would have been "any document of any tenant may have been exposed", which turns a serious incident into a catastrophic one.

### 41.9.5 Fixes

Immediate (Thursday night):

1. The tenant became a **required** argument again, typed as a branded `TenantId` that only the authentication layer can construct, so `undefined` or a raw string does not compile.
2. Public help-center content moved to its own table, so no code path needs "search without a tenant".
3. **Post-retrieval verification** (41.7) throws and pages on any row whose tenant differs from the request's.

Structural (the following two weeks):

4. **Row-level security** with `FORCE` and a fail-closed policy on every table that feeds prompts; tenant set with transaction-local `set_config`.
5. A **CI hard gate**: the evaluation suite now seeds two tenants with deliberately similar documents and asserts zero cross-tenant retrievals (41.6). The gate was run against the buggy commit and failed, as it should.
6. A lint rule forbidding `any` in request-context types and raw SQL on chunk tables outside the retriever module.
7. A per-feature kill switch for every LLM feature, documented in the runbook, plus 90-day retention of retrieval logs.

### 41.9.6 Lessons

- **Isolation must be structural.** A filter that every query must remember will eventually be forgotten; RLS, a required typed tenant and a single retriever make forgetting impossible or loud.
- **"Optional filter" is an anti-pattern for security filters.** If some callers need no tenant, they need a different data source, not a missing `WHERE`.
- **Similarity hides leaks.** Because most nearest neighbours are still the tenant's own, cross-tenant RAG bugs produce intermittent, plausible leaks rather than obvious failures.
- **Log retrievals.** Retrieved chunk ids per call cost little and are the difference between a bounded and an unbounded disclosure.
- **Evaluate with more than one tenant.** A single-tenant eval cannot detect a cross-tenant leak.
- **Have a kill switch** for every LLM feature; it took 15 minutes to stop the leak because one existed.

#### Interview questions

1. **Walk me through how you would investigate a report that a RAG assistant showed another customer's document.** Disable the feature (kill switch), preserve logs, find the retrieval path and the change that touched it, then compute the blast radius from retrieval logs by joining retrieved chunk owners to asking tenants; notify according to contracts; fix structurally.
2. **Why did this bug take two days to notice?** Most nearest chunks still belonged to the asking tenant, so leaks were intermittent and plausible; there was no alerting tripwire and no multi-tenant eval case.
3. **Which single control would have prevented it?** Row-level security with a fail-closed policy; the required typed tenant and post-retrieval verification are the other two independent layers.

#### Practical exercise

Reproduce this incident in a sandbox: two tenants with similar documents, a retriever with an optional tenant filter, and a call site passing the wrong property. Show the leak in a test. Then apply the fixes in order (required branded tenant type, RLS with fail-closed policy, post-retrieval verification, two-tenant eval gate) and show that each one alone blocks the leak. Write the blast-radius query against your retrieval log. Acceptance criteria: the buggy commit fails CI; each layer independently prevents foreign chunks from reaching the prompt.

## 41.10 Operating retrieval: re-embedding migrations and index health

### 41.10.1 Changing the embedding model without downtime

#### Concept

Sooner or later you will change the embedding model: a better or cheaper one appears, or you need a different dimension. Because vectors from different models are not comparable (41.1.1), the change is a **data migration** of every row, run like any zero-downtime schema change (Part 27): add, backfill, verify, switch, remove.

#### Why does it exist?

Re-embedding in place mixes models while it runs, which silently degrades search for the duration (the failure scenario in 41.1.1). Stopping search to re-embed millions of rows is not acceptable either. A side-by-side migration keeps the old index serving until the new one is complete and measured.

#### How it works

1. **Add** a new column (`embedding_v2 vector(1024)`, `embedding_v2_model text`) with no index.
2. **Dual-write**: the re-index worker writes both columns for every changed document from now on.
3. **Backfill** old rows in batches by primary-key range, using the provider's batch endpoint where available (cheaper), throttled to protect the database and the provider quota.
4. **Index** the new column with `CREATE INDEX CONCURRENTLY` once the backfill is complete.
5. **Verify**: run the retrieval evaluation (41.6) against both columns; shadow-query a sample of live traffic against v2 and compare results and latency.
6. **Switch** reads to v2 with a feature flag (instant rollback by flipping it back).
7. **Remove** the old column and index after a safe period.

#### PostgreSQL example

```sql
ALTER TABLE doc_chunks ADD COLUMN embedding_v2 vector(1024), ADD COLUMN embedding_v2_model text;

-- Backlog and progress, for the dashboard and the go/no-go decision.
SELECT count(*) FILTER (WHERE embedding_v2 IS NULL)                 AS remaining,
       round(100.0 * count(*) FILTER (WHERE embedding_v2 IS NOT NULL) / count(*), 1) AS pct_done
  FROM doc_chunks;

-- Backfill worker: one batch by id range (the worker embeds content, then writes vectors).
SELECT id, content FROM doc_chunks
 WHERE id > $1 AND embedding_v2 IS NULL
 ORDER BY id LIMIT 500;

-- After backfill: build the new index without blocking writes.
SET maintenance_work_mem = '8GB';
CREATE INDEX CONCURRENTLY doc_chunks_hnsw_v2 ON doc_chunks USING hnsw (embedding_v2 vector_cosine_ops);
```

At 3.2 million chunks of about 350 tokens, the backfill is about 1.1 billion tokens (tens to low hundreds of dollars at typical embedding prices); at 2,000 chunks per second of write throughput it takes under an hour of database time, but the provider's rate limit usually makes the real duration hours to a day. The table temporarily holds both vectors, so plan disk and memory for both indexes during the overlap.

#### Failure scenario

A team skipped step 5 because the new model scored better on a public benchmark. After the switch, searches for their domain jargon (dental procedure codes, brand abbreviations) got noticeably worse; the public benchmark had none of them. Because the old column and index were still present, the rollback was a flag flip. The re-run of their own retrieval eval showed recall@5 dropping from 0.88 to 0.81 on jargon-heavy queries; they kept the old model and revisited later with hybrid weighting. The lesson: benchmarks rank models in general; only your evaluation ranks them for your data.

#### Edge cases & failure modes

- **Index health**: monitor index size, `VACUUM` activity on heavily updated chunk tables, and the share of rows with NULL embeddings (the embedding backlog).
- **Recall drift**: as the corpus grows, recall at fixed `ef_search` can slowly drop; re-measure monthly.
- **Two indexes during migration** double memory pressure; schedule the overlap and watch buffer reads.
- **Query cache**: query-embedding cache keys include the model name, so the switch does not serve stale vectors.
- **Dimension change** breaks any code that hard-codes the size; read it from the provider configuration.

#### Interview questions

1. **How do you change embedding models for millions of rows without downtime?** Add a new column, dual-write, backfill in batches (batch API if available), build the index concurrently, verify with your eval and shadow traffic, switch with a flag, then drop the old column.
2. **What do you monitor for a pgvector-based retrieval system?** Query latency percentiles, recall against exact search on a sample, embedding backlog, index size versus RAM, vacuum health, and cross-tenant verification alerts.

#### Practical exercise

Migrate your chunk table from one embedding model to another using the seven steps above, with a feature flag for reads and a dashboard showing backfill progress and recall@5 for both columns. Acceptance criteria: search keeps working throughout, the flag switches and rolls back instantly, and the old column is dropped only after the new one matches or beats it on the eval.

## Senior Checklist — Part 41

- [ ] I understand the concept
- [ ] I can explain it simply
- [ ] I can implement it
- [ ] I understand its failure modes
- [ ] I understand its scaling limitations
- [ ] I understand its security implications
- [ ] I understand its operational implications
- [ ] I can choose between alternatives
- [ ] I can explain the tradeoffs
- [ ] I can answer senior-level interview questions
- [ ] I can explain embeddings, similarity metrics, and that the embedding model is a versioned dependency stored with every row
- [ ] I can size a vector workload: bytes per vector, index memory, embedding cost and latency
- [ ] I can model and index embeddings in pgvector (HNSW/IVFFlat), tune `ef_search`, and measure recall against exact search
- [ ] I can read pgvector EXPLAIN output and recognize both a missing index and the filtered-HNSW trap
- [ ] I can decide between pgvector and a dedicated vector database, including the sync cost
- [ ] I can build a RAG pipeline with structure-aware chunking, re-ranking, grounding and verified citations
- [ ] I keep the index in sync with a transactional outbox and content hashes, including deletes
- [ ] I can build hybrid search with RRF across vector, full-text and exact-identifier branches
- [ ] I can build an agent with strict tools, authorization, idempotent action requests, approval gates, a bounded loop and an audit log
- [ ] I build evaluation sets with retrieval metrics, a validated judge and a noise-aware CI gate with hard gates
- [ ] I enforce tenant isolation structurally: RLS with transaction-local settings, a single retriever, post-retrieval verification
- [ ] I log retrieved chunk ids per call so I can compute a blast radius
- [ ] I can migrate embedding models with zero downtime

## Part 41 — Key Takeaways

- An embedding represents meaning as a vector; it is only comparable with vectors from the same model, so store the model with every row and re-embed on change.
- pgvector does vector search inside PostgreSQL, joined to relational data, inside transactions and under RLS; it is the right first choice for most teams.
- HNSW is the default index; tune `ef_search`, measure recall against exact search, and build indexes concurrently with enough memory.
- Filtered HNSW queries can silently return fewer rows than asked; check `Rows Removed by Filter` and use iterative scans, exact search for small tenants, or partitioning.
- RAG is a data pipeline: chunk by structure, retrieve wide, re-rank narrow, ground the prompt, and verify citations in code.
- Keep the index in sync with a transactional outbox and content hashes; a stale index produces confident, wrong answers.
- Hybrid search (vectors plus full-text plus exact identifiers, fused by rank) beats either method alone in real traffic.
- An agent's tool call is an action: strict schemas, authorization against the acting user, idempotent action requests, human approval for consequential writes, a bounded loop.
- Evaluate retrieval and answers separately, validate LLM judges against humans, and design CI gates around measured noise with zero-tolerance hard gates.
- Tenant isolation in RAG must be structural (RLS, a required tenant type, one retriever, post-retrieval checks); a prompt instruction is not a control.
- Log retrieved chunk ids for every call; without them a leak's blast radius is "everything".
- Change embedding models like a schema migration: add, backfill, index, verify, switch, remove.
