## 41.2 Retrieval-augmented generation

### 41.2.1 The RAG pipeline

#### Concept

**RAG** (Retrieval-Augmented Generation) is the pattern of retrieving relevant data and putting it into the prompt so the LLM answers from your facts instead of its training (which may be stale, generic, or wrong about your domain). The pipeline: chunk your documents, embed and index them, retrieve the most relevant chunks for a query, and generate an answer grounded in those chunks, with citations. RAG is how you build "ask a question about our data" features that are accurate and current.

#### Why does it exist?

An LLM alone cannot answer questions about your specific, current, private data — your product catalog, your support articles, this customer's orders — because it was never trained on them and cannot see them. Fine-tuning a model on your data is expensive, slow to update, and still hallucinates. RAG is simpler and better for most cases: keep your data in a store, retrieve the relevant pieces at query time, and let the model answer from them. When the data changes, you update the store, not the model. The model supplies language ability; your data supplies the facts.

#### Mental model

Imagine an open-book exam versus a closed-book one. A closed-book exam (the bare LLM) tests what the student memorized, and they will bluff when they do not know. An open-book exam (RAG) lets the student look up the relevant passage and answer from it, with a page reference. RAG hands the model the right pages for each question and asks it to answer from those pages and cite them. The retrieval step is finding the right pages; the generation step is writing the answer from them.

#### How it works — the pipeline

```mermaid
flowchart LR
    subgraph Indexing["Indexing (offline / on change)"]
        D["Documents"] --> C["Chunk"]
        C --> E1["Embed each chunk"]
        E1 --> I["Store in pgvector"]
    end
    subgraph Query["Query (per request)"]
        Q["User question"] --> E2["Embed question"]
        E2 --> R["Retrieve top-k chunks"]
        R --> RR["Re-rank (optional)"]
        RR --> P["Build prompt with chunks"]
        P --> G["LLM generates answer + citations"]
    end
    I -.serves.-> R
```

The two phases:

**Indexing (offline, or when data changes):**

1. **Chunk**: split documents into pieces small enough to be precise and to fit in the prompt (a product description, a paragraph of a support article, a section of a manual). Too large and retrieval is imprecise and the prompt bloats; too small and you lose context. Chunks often overlap slightly so a sentence spanning a boundary is not lost.
2. **Embed**: compute an embedding for each chunk.
3. **Index**: store the chunk text, its embedding, and metadata (document id, tenant, section) in pgvector.

**Query (per request):**

4. **Embed the question** with the same embedding model.
5. **Retrieve** the top-k most similar chunks (a vector search, scoped by tenant/metadata).
6. **Re-rank** (optional): a second, more precise step reorders the retrieved chunks by relevance, because the vector search is fast but approximate.
7. **Build the prompt**: insert the retrieved chunks into the prompt as context, with instructions to answer only from them and to cite sources.
8. **Generate**: the LLM produces the answer, grounded in the chunks, with citations.

#### How it works — code

```ts
// RAG query, continued from Part 40's LlmService and Part 41.1's pgvector.
async function answerWithRag(question: string, tenantId: string): Promise<{ answer: string; sources: string[] }> {
  // 5. Embed the question and retrieve top-k chunks for this tenant.
  const qEmbedding = await embedder.embed(question);
  const chunks = await db.query(
    `SELECT content, document_id, 1 - (embedding <=> $1) AS similarity
       FROM doc_chunks
      WHERE tenant_id = $2
      ORDER BY embedding <=> $1
      LIMIT 6`,
    [qEmbedding, tenantId],
  );

  // 7. Build a grounded prompt. Number the chunks so the model can cite them.
  const context = chunks
    .map((c, i) => `[${i + 1}] (doc ${c.document_id})\n${c.content}`)
    .join('\n\n');

  const system =
    'Answer the question using ONLY the numbered context below. ' +
    'Cite sources like [1], [2]. If the context does not contain the answer, ' +
    'say you do not have that information. Do not use outside knowledge.';

  // 8. Generate.
  const answer = await llm.complete({
    system,
    user: `Context:\n${context}\n\nQuestion: ${question}`,
    maxTokens: 500,
  });

  return { answer, sources: chunks.map((c) => c.document_id) };
}
```

The grounding instruction ("answer ONLY from the context, cite sources, say you do not know otherwise") is what keeps RAG honest. Citations let users (and you) verify the answer against the source, which is the main defense against hallucination (Part 40): a cited answer can be checked; an uncited one cannot.

#### Chunking in practice

Good chunks follow the document's own structure. Split on headings and paragraphs first, then pack neighbouring paragraphs together up to a size budget, carrying a small overlap and the section title into each chunk so it still makes sense on its own.

```ts
// rag/chunker.ts -- structure-aware chunking with overlap and a heading prefix
export interface Chunk { chunkNo: number; content: string }

const approxTokens = (s: string) => Math.ceil(s.length / 4); // a budget, not billing: an estimate is fine

export function chunkArticle(title: string, markdown: string, maxTokens = 400, overlapParas = 1): Chunk[] {
  const chunks: Chunk[] = [];
  let section = title;
  let buf: string[] = [];

  const flush = () => {
    if (!buf.length) return;
    chunks.push({ chunkNo: chunks.length, content: `${title} > ${section}\n\n${buf.join('\n\n')}` });
    buf = buf.slice(-overlapParas); // keep the last paragraph as overlap for the next chunk
  };

  for (const block of markdown.split(/\n{2,}/)) {
    const heading = /^#{1,4}\s+(.*)/.exec(block);
    if (heading) { flush(); buf = []; section = heading[1]; continue; } // new section: no overlap across it
    if (approxTokens(buf.join('\n\n') + block) > maxTokens) flush();
    buf.push(block);
  }
  flush();
  return chunks;
}
```

Typical starting points: 200–500 tokens per chunk for help articles and manuals, one chunk per product for catalog entries (title, key attributes and description together), and 10–15% overlap. Tune with the retrieval evaluation (41.6), not by intuition: measure recall@k for a few chunk sizes and keep the best.

#### Re-ranking

Vector search is fast but coarse: it compares one query vector with one chunk vector. A **re-ranker** (a cross-encoder model, or a hosted re-rank API, or a small LLM asked to score relevance) reads the query and each candidate *together* and scores how well the candidate answers the query. The usual shape is "retrieve wide, re-rank narrow": fetch the top 40–50 by vector (or hybrid) score in a few milliseconds, re-rank them in 50–200 ms, keep the best 5–8 for the prompt. Re-ranking typically lifts answer quality more than any amount of prompt tuning, because the model can only be as good as the context it is given. It costs latency and money per query, so measure whether it pays on your evaluation set.

#### Citations you can verify

Ask for citations by number, then check them in code before showing anything:

```ts
// rag/citations.ts -- keep only citations that point at chunks we actually supplied
export function checkCitations(answer: string, supplied: { documentId: string }[]) {
  const cited = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
  const valid = [...new Set(cited)].filter((n) => n >= 1 && n <= supplied.length);
  return {
    sources: valid.map((n) => supplied[n - 1].documentId), // show only sources really cited
    hasInvalid: cited.some((n) => !valid.includes(n)),     // model cited a chunk that does not exist
    uncited: valid.length === 0,                            // factual answer with no citation: flag it
  };
}
```

An answer with invalid citations or no citations at all is logged, counted on the dashboard, and either shown with a "could not verify" note or replaced by the top retrieved snippets. Some providers can also return structured citations that point to exact spans of the documents you passed in; where available, those are stronger than parsing `[n]` markers.

#### Keeping the index in sync

The indexed chunks must stay consistent with the source data: when a product description or support article changes, its chunks must be re-embedded and updated, or RAG answers from stale data. The reliable pattern is the **outbox** or **CDC** (Part 33, Part 42): a change to the source emits an event that a worker consumes to re-chunk, re-embed and update the index. For pgvector this can even be in the same database and transaction as the source change; for a separate vector store it must be an asynchronous sync, which is one of the operational costs of that choice (41.1.3).

```text
Product updated (source of truth)
        |  emits event (outbox / CDC, Part 33, Part 42)
        v
Re-index worker: re-chunk -> re-embed -> upsert into pgvector
        |
        v
RAG retrieval now returns the current content
```

#### PostgreSQL example

The chunk table and an outbox written in the same transaction as the source change, so an article can never change without a re-index event (the transactional outbox, Part 33):

```sql
CREATE TABLE doc_chunks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  document_id     uuid NOT NULL,
  chunk_no        int  NOT NULL,
  content         text NOT NULL,
  content_hash    text NOT NULL,        -- sha256 of content: unchanged chunks are not re-embedded
  embedding       vector(1536),         -- NULL until embedded
  embedding_model text NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_no)
);
CREATE INDEX doc_chunks_hnsw   ON doc_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX doc_chunks_tenant ON doc_chunks (tenant_id);

CREATE TABLE outbox (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz
);
CREATE INDEX outbox_pending ON outbox (id) WHERE processed_at IS NULL;

-- The write path: the article and its re-index event commit together, or not at all.
BEGIN;
UPDATE articles SET body = $2, updated_at = now() WHERE id = $1 AND tenant_id = $3;
INSERT INTO outbox (aggregate_type, aggregate_id, event_type) VALUES ('article', $1, 'article.changed');
COMMIT;
```

#### NestJS example

A small worker drains the outbox. `FOR UPDATE SKIP LOCKED` lets several worker pods share the work without processing the same event twice (Part 39 — Background Jobs).

```ts
// rag/reindex.worker.ts -- outbox-driven re-chunk, re-embed (only what changed), upsert
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import { chunkArticle } from './chunker';
import { EmbeddingService } from '../embeddings/embedding.service';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class ReindexWorker {
  private readonly logger = new Logger(ReindexWorker.name);
  constructor(private readonly ds: DataSource, private readonly embeddings: EmbeddingService) {}

  @Interval(2_000)
  async drain(): Promise<void> {
    await this.ds.transaction(async (m) => {
      const events: { id: string; aggregate_id: string }[] = await m.query(
        `SELECT id, aggregate_id FROM outbox
          WHERE processed_at IS NULL AND aggregate_type = 'article'
          ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`);

      for (const e of events) {
        const [article] = await m.query(
          `SELECT id, tenant_id, title, body, published FROM articles WHERE id = $1`, [e.aggregate_id]);

        if (!article || !article.published) {           // deleted or unpublished: remove from search
          await m.query(`DELETE FROM doc_chunks WHERE document_id = $1`, [e.aggregate_id]);
        } else {
          const chunks = chunkArticle(article.title, article.body);
          const existing: { chunk_no: number; content_hash: string }[] = await m.query(
            `SELECT chunk_no, content_hash FROM doc_chunks WHERE document_id = $1`, [article.id]);
          const known = new Map(existing.map((r) => [r.chunk_no, r.content_hash]));
          const changed = chunks.filter((c) => known.get(c.chunkNo) !== sha(c.content));
          const vectors = await this.embeddings.embedDocuments(changed.map((c) => c.content));

          for (const [i, c] of changed.entries()) {
            await m.query(
              `INSERT INTO doc_chunks (tenant_id, document_id, chunk_no, content, content_hash, embedding, embedding_model)
               VALUES ($1, $2, $3, $4, $5, $6::vector, $7)
               ON CONFLICT (document_id, chunk_no) DO UPDATE
                 SET content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
                     embedding = EXCLUDED.embedding, embedding_model = EXCLUDED.embedding_model,
                     updated_at = now()`,
              [article.tenant_id, article.id, c.chunkNo, c.content, sha(c.content),
               JSON.stringify(vectors[i]), this.embeddings.model]);
          }
          await m.query(`DELETE FROM doc_chunks WHERE document_id = $1 AND chunk_no >= $2`,
            [article.id, chunks.length]);              // the article got shorter: drop the tail
          this.logger.log(`reindexed ${article.id}: ${changed.length}/${chunks.length} chunks embedded`);
        }
        await m.query(`UPDATE outbox SET processed_at = now() WHERE id = $1`, [e.id]);
      }
    });
  }
}
```

This version holds the outbox row locks while it calls the embedding provider, which is fine at a few events per second. At higher volume, claim events with a lease (`claimed_at`, `claimed_by`) in a short transaction, do the embedding outside any transaction, and commit the upsert in a second short transaction. The content-hash comparison matters for cost: editing one paragraph of a 30-chunk article re-embeds one or two chunks, not thirty.

#### Hybrid search

Pure vector search misses exact matches (a product code, an exact name) that keyword/full-text search (Part 37) handles well, and keyword search misses paraphrases that vector search catches. **Hybrid search** runs both and combines the results (for example, blend the vector similarity rank and the full-text rank), getting the best of each. In PostgreSQL you can do both in one place: full-text search (Part 37) and pgvector in the same database, combining their scores. For many real search features, hybrid beats either alone. Section 41.5 builds it in full, with the SQL, the score fusion and the EXPLAIN output.

#### Production scenario

A product-catalog search using RAG retrieves the six most relevant product chunks for a shopper's natural-language query, scoped to the tenant and in-stock products (a metadata filter in the same SQL), and the LLM produces a short grounded summary with the matching products cited. Hybrid search ensures that a query containing an exact SKU still returns that product. The index is kept in sync by an outbox-driven re-index worker, so a price or description change is reflected within seconds. Query embeddings are cached (Part 30) so repeated popular queries skip the embedding call. The result is a search that understands intent, stays current, and does not hallucinate products that do not exist.

#### Failure scenario

A support RAG system retrieved chunks and generated answers, but when an article was updated, the old chunks stayed in the index because there was no sync mechanism. Customers got confidently wrong answers citing the outdated article for weeks until someone noticed. The fix was an outbox-driven re-index worker (Part 33) that re-embeds and updates chunks whenever an article changes, plus a staleness check on the index. The lesson: RAG is only as good as the freshness of its index, and index sync is a first-class part of the system, not an afterthought.

#### Edge cases & failure modes

- **Stale index**: source data changed but chunks did not; answers from old data. Sync via outbox/CDC.
- **Poor chunking**: chunks too large (imprecise, bloated prompt) or too small (lost context); tune size and overlap.
- **Retrieval misses**: the relevant chunk is not in the top-k; raise k, improve chunking, add re-ranking or hybrid search.
- **Prompt overflow**: too many or too large chunks exceed the context window; bound total retrieved tokens.
- **No grounding instruction**: the model answers from training and hallucinates; always instruct "only from the context".
- **Cross-tenant retrieval**: missing tenant filter leaks another tenant's chunks (41.3).
- **Ungrounded citations**: the model cites a source that does not support its claim; spot-check, and prefer short, verifiable answers.

#### How a Senior Backend Engineer thinks about this

A senior treats RAG as a data pipeline, not a prompt trick: chunking, embedding, indexing, retrieval, re-ranking and generation are each a tunable stage, and index freshness (sync via outbox/CDC) is as important as the prompt. They ground every answer in retrieved context with explicit "answer only from this, cite sources, say you do not know otherwise" instructions, because grounding plus citations is the main defense against hallucination and the way answers become verifiable. They use hybrid search where exact matches matter, scope every retrieval to the tenant, bound the retrieved token count, and cache query embeddings. They measure retrieval quality (does the right chunk get retrieved?) and answer quality (is the answer correct and grounded?) separately with an evaluation set (41.4), because a RAG system can fail at retrieval or at generation and the fixes differ.

#### Common mistakes

- No index sync, so RAG answers from stale data.
- Bad chunking (too large or too small), hurting retrieval precision.
- No grounding instruction, so the model hallucinates instead of answering from context.
- No citations, so answers cannot be verified.
- Pure vector search where exact matches matter (needs hybrid).
- Missing tenant filter, leaking other tenants' data.
- Not measuring retrieval and generation quality separately.

#### Interview questions

1. **What is RAG and what problem does it solve?** Retrieval-Augmented Generation: retrieve relevant data and put it in the prompt so the LLM answers from your current, specific facts instead of its training, avoiding hallucination and staleness without fine-tuning.
2. **Walk through the RAG pipeline.** Indexing: chunk, embed, store with metadata. Query: embed the question, retrieve top-k (scoped by tenant), optionally re-rank, build a grounded prompt with citations, generate.
3. **How do you keep the RAG index in sync with source data?** Emit an event on source change (outbox/CDC) that a worker consumes to re-chunk, re-embed and upsert the index; staleness otherwise produces confidently wrong answers.
4. **What is hybrid search and why use it?** Combining vector (semantic) and keyword/full-text search; vectors catch paraphrases, keywords catch exact matches (codes, names), and together they outperform either alone.
5. **How do you defend a RAG answer against hallucination?** Ground it in retrieved context with instructions to answer only from that context and cite sources, and to say it does not know otherwise, so answers are verifiable.

6. **Why use an outbox instead of re-indexing directly in the request that edits the article?** The edit and the re-index event must be atomic; a direct call can fail after the commit (dual write) and leave the index stale forever. The outbox commits with the edit, and a worker retries until the index catches up.
7. **What does a re-ranker add, and what does it cost?** It scores query and candidate together, which is more precise than comparing two vectors; retrieve 40–50 candidates, re-rank, keep the top 5–8. It adds roughly 50–200 ms and a per-query cost, so justify it with retrieval evaluation.
8. **How do you verify citations in a RAG answer?** Number the supplied chunks, parse cited numbers, discard citations to chunks that were not supplied, show only sources actually cited, and flag answers with no valid citations.

#### Practical exercise

Build a RAG pipeline for support articles: chunk the articles with overlap, embed and store them in pgvector with tenant and document metadata, retrieve the top-k for a question scoped to the tenant, and generate a grounded, cited answer. Add an outbox-driven re-index worker so editing an article updates its chunks. Finally, add a hybrid step so a query containing an exact article title ranks that article highly. Acceptance criteria: answers cite real sources, editing an article changes subsequent answers within seconds, and no cross-tenant chunk is ever retrieved.
