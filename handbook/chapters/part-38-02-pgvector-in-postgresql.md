### 38.1.2 pgvector in PostgreSQL

#### Concept

**pgvector** is a PostgreSQL extension that adds a `vector` column type and vector similarity operators, so you can store embeddings next to your relational data and search them with SQL. For a team already running PostgreSQL, it means vector search without adding a new database — your products, their embeddings, and your relational constraints all live in one place, queried with one language and backed up as one system.

#### Why does it exist?

You could add a dedicated vector database, but that is another system to run, secure, back up, keep in sync and pay for. pgvector lets you do vector search in the database you already operate, joined directly to your relational data (filter by tenant, category, price in the same query as the similarity search) and inside the same transactions. For the large majority of applications, that is simpler and sufficient; you reach for a dedicated vector database only when scale or features demand it (38.1.3).

#### How it works — schema and search

```sql
-- Enable the extension (once per database).
CREATE EXTENSION IF NOT EXISTS vector;

-- Store embeddings alongside the product. The dimension (1536 here) must match the model.
CREATE TABLE product_embeddings (
  product_id  uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL,                       -- for tenant isolation (Part 90)
  embedding   vector(1536) NOT NULL,
  content     text NOT NULL,                        -- the text that was embedded
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Nearest-neighbour search: <=> is cosine distance (smaller = more similar).
-- $1 is the query embedding, passed as a parameter.
SELECT product_id, content, 1 - (embedding <=> $1) AS similarity
  FROM product_embeddings
 WHERE tenant_id = $2                               -- filter by tenant (metadata filter)
 ORDER BY embedding <=> $1                           -- order by distance (nearest first)
 LIMIT 10;
```

pgvector provides distance operators: `<=>` (cosine distance), `<#>` (negative inner product), `<->` (L2 distance). You use the one matching your embedding model's metric. Because it is ordinary SQL, you combine the vector search with any relational filter — `WHERE tenant_id = $2 AND category = $3 AND price_cents < $4` — in one query, which a separate vector database makes harder.

#### Indexes: HNSW vs IVFFlat

Without an index, a vector search scans every row and computes the distance to each — fine for thousands of rows, too slow for millions. pgvector offers two approximate-nearest-neighbour index types:

| Index | How it works | Build time | Query speed | Recall | Use when |
|---|---|---|---|---|---|
| HNSW | A navigable graph of vectors | Slower to build, more memory | Very fast | High | The default for most workloads; best speed/recall |
| IVFFlat | Partitions vectors into lists, searches nearest lists | Faster to build, less memory | Fast | Good, tunable | Very large datasets where build time/memory matters |

```sql
-- HNSW index for cosine distance (the common choice).
CREATE INDEX product_embeddings_hnsw
  ON product_embeddings USING hnsw (embedding vector_cosine_ops);

-- IVFFlat alternative. lists ~ rows/1000 up to 1M rows, ~sqrt(rows) above that.
-- Build it AFTER the table holds representative data: the lists are trained on existing rows.
CREATE INDEX product_embeddings_ivf
  ON product_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

Both are **approximate**: they trade a little recall (occasionally missing a true nearest neighbour) for a large speed gain. You tune the recall/speed tradeoff with parameters (`ef_search` for HNSW, `probes` for IVFFlat) at query time. HNSW is the usual default for its superior speed-at-high-recall; IVFFlat is lighter to build and uses less memory, favored for very large datasets.

#### Tuning HNSW and IVFFlat

The knobs that matter, with pgvector's defaults:

| Parameter | Index | Default | Effect of raising it |
|---|---|---|---|
| `m` (build) | HNSW | 16 | More links per node: better recall, bigger index, slower build |
| `ef_construction` (build) | HNSW | 64 | Better graph quality, slower build |
| `hnsw.ef_search` (query) | HNSW | 40 | More candidates examined: better recall, slower query |
| `lists` (build) | IVFFlat | none | More, smaller lists: faster probes, needs more `probes` for recall |
| `ivfflat.probes` (query) | IVFFlat | 1 | More lists searched: better recall, slower query |

```sql
-- Build: give the index build enough memory and parallel workers, without blocking writes.
SET maintenance_work_mem = '4GB';           -- an HNSW build that spills to disk is many times slower
SET max_parallel_maintenance_workers = 4;
CREATE INDEX CONCURRENTLY product_embeddings_hnsw
  ON product_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Query: raise recall for this transaction only (SET LOCAL resets at COMMIT).
BEGIN;
SET LOCAL hnsw.ef_search = 100;
SELECT product_id FROM product_embeddings ORDER BY embedding <=> $1 LIMIT 10;
COMMIT;
```

Two hard limits to know. An index on the `vector` type supports up to 2,000 dimensions; for larger embeddings, or to halve memory, store or index `halfvec` (16-bit floats, indexable up to 4,000 dimensions) with `halfvec_cosine_ops`, which usually costs very little recall. And recall must be **measured**, not assumed: compare the index's top 10 against an exact search (run with the index disabled, `SET enable_indexscan = off`) on a few hundred real queries, and tune `ef_search` until recall@10 meets your target (0.95 is a common bar) at an acceptable latency.

#### EXPLAIN output

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT product_id FROM product_embeddings
 WHERE tenant_id = $2 ORDER BY embedding <=> $1 LIMIT 10;
```

```text
Limit  (actual time=0.42..1.85 rows=10 loops=1)
  ->  Index Scan using product_embeddings_hnsw on product_embeddings
        Order By: (embedding <=> $1)
        Filter: (tenant_id = $2)
        Buffers: shared hit=128
Planning Time: 0.21 ms
Execution Time: 1.95 ms
```

The `Index Scan using ...hnsw` confirms the vector index is used; without it you would see a sequential scan computing every distance. As with any PostgreSQL index (Part 20), you verify with `EXPLAIN ANALYZE` that your query actually uses the vector index — a mistake in the query or a filter that defeats the index drops you back to a full scan.

#### EXPLAIN before the index, and the filtered-search trap

Here is the same kind of query on 1.2 million rows **without** a vector index. PostgreSQL computes the distance for every row and keeps the 10 smallest:

```text
Limit  (actual time=1843.2..1843.3 rows=10 loops=1)
  ->  Sort  (actual time=1843.2..1843.2 rows=10 loops=1)
        Sort Key: ((embedding <=> '[0.0213,-0.1102,...]'::vector))
        Sort Method: top-N heapsort  Memory: 26kB
        ->  Seq Scan on product_embeddings  (actual time=0.03..1611.4 rows=1200000 loops=1)
              Buffers: shared hit=12034 read=148310
Planning Time: 0.18 ms
Execution Time: 1843.5 ms
```

Nearly two seconds and 150,000 buffer reads per search; with the HNSW index the same query takes about 2 ms. That is the difference between a feature and an outage.

Now the trap. HNSW finds the `ef_search` nearest candidates (40 by default) **first** and applies the `WHERE` filter **afterwards**. If the tenant owns only 2% of the rows, most of those 40 candidates belong to other tenants and are filtered out:

```text
Limit  (actual time=0.91..1.12 rows=3 loops=1)
  ->  Index Scan using product_embeddings_hnsw on product_embeddings  (actual time=0.90..1.11 rows=3 loops=1)
        Order By: (embedding <=> $1)
        Filter: (tenant_id = $2)
        Rows Removed by Filter: 37
        Buffers: shared hit=141
Execution Time: 1.19 ms
```

You asked for 10 and got 3: fast, isolated, and wrong. Users see "only 3 results" for a query that should have dozens. The fixes, from simplest:

- **pgvector 0.8 and later: iterative index scans.** `SET hnsw.iterative_scan = relaxed_order;` makes the scan keep fetching candidates until the `LIMIT` is satisfied (bounded by `hnsw.max_scan_tuples`). Results may come back slightly out of order, so wrap the query and re-sort by distance in an outer `SELECT` if exact order matters.
- **Small tenants: exact search.** With a B-tree index on `tenant_id`, a tenant with 20,000 rows is scanned and sorted exactly in a few milliseconds, with perfect recall. The planner often chooses this on its own when the filter is selective.
- **Large tenants: partitioning or partial indexes.** Partition the table by tenant (or by tenant group) so each partition has its own HNSW index, or create a partial HNSW index for each very large tenant (`WHERE tenant_id = '...'`).
- **Raise `ef_search`** for filtered queries, accepting the latency cost.

Always check `Rows Removed by Filter` and the returned row count when you `EXPLAIN` a filtered vector query.

#### Metadata filtering

A key pgvector advantage is filtering by relational columns alongside the vector search (`WHERE tenant_id = ... AND category = ...`). This is essential for **tenant isolation** in a multi-tenant RAG system (Part 90): every vector query must scope to the current tenant, or you risk retrieving another tenant's documents (38.4 and the incident story in 38.9 cover what happens without it). With pgvector, the tenant filter is just a `WHERE` clause in the same query; with a separate vector database, isolation is more work and more error-prone.

#### TypeORM example

ORM support for the `vector` type varies by version, so the robust approach is to create the column and index in a migration with raw SQL and query it through `DataSource.query()`, passing the vector as its text form (`[0.1,0.2,...]`, which is exactly what `JSON.stringify` produces for a number array) and casting it.

```ts
// migrations/1730000000000-product-embeddings.ts
import { MigrationInterface, QueryRunner } from 'typeorm';

export class ProductEmbeddings1730000000000 implements MigrationInterface {
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction; opt this migration out.
  public transaction = false;

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await q.query(`ALTER TABLE product_embeddings ADD COLUMN IF NOT EXISTS embedding_model text NOT NULL DEFAULT 'acme-embed-3'`);
    await q.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS product_embeddings_hnsw
                     ON product_embeddings USING hnsw (embedding vector_cosine_ops)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX CONCURRENTLY IF EXISTS product_embeddings_hnsw`);
  }
}
```

```ts
// search/vector-search.repository.ts
@Injectable()
export class VectorSearchRepository {
  constructor(private readonly dataSource: DataSource) {}

  async nearest(tenantId: string, model: string, query: number[], k = 10) {
    return this.dataSource.query(
      `SELECT product_id, 1 - (embedding <=> $1::vector) AS similarity
         FROM product_embeddings
        WHERE tenant_id = $2 AND embedding_model = $3     -- tenant scope and model scope, always
        ORDER BY embedding <=> $1::vector
        LIMIT $4`,
      [JSON.stringify(query), tenantId, model, k],
    );
  }
}
```

#### Sequelize example

```ts
import { QueryTypes } from 'sequelize';

const rows = await sequelize.query(
  `SELECT product_id, 1 - (embedding <=> CAST(:q AS vector)) AS similarity
     FROM product_embeddings
    WHERE tenant_id = :tenantId AND embedding_model = :model
    ORDER BY embedding <=> CAST(:q AS vector)
    LIMIT :k`,
  { replacements: { q: JSON.stringify(queryVec), tenantId, model, k: 10 }, type: QueryTypes.SELECT },
);
```

`CAST(... AS vector)` is used instead of the `::vector` shorthand because Sequelize's named replacements also use a colon and the two can be confused.

#### Production scenario

A catalog of 1.2 million product chunks on a database instance with 64 GB of RAM: vectors and HNSW index together take about 14 GB and stay in memory. A tenant-scoped query with iterative scan enabled runs at p50 3 ms and p99 11 ms inside PostgreSQL; the whole search request, including the query embedding call (~40 ms, or ~0.5 ms on a Redis hit), is around 60 ms at p50. Recall@10 measured weekly against exact search stays at 0.96 with `ef_search = 80`. Writes (about 30,000 product updates a day) update the index in place; the main operational chore is `VACUUM`, because deleted and updated rows leave dead entries that the index must skip until vacuum removes them.

#### Failure scenario

An engineer ran `CREATE INDEX ... USING hnsw` on a 5-million-row table at 11:00 on a weekday, with the default `maintenance_work_mem` of 64 MB and without `CONCURRENTLY`. A plain `CREATE INDEX` holds a lock that blocks inserts and updates on the table for the whole build. The graph did not fit in memory, so the build crawled; product updates queued behind the lock, the admin panel timed out, and the deploy pipeline that ran migrations hung. They cancelled it after 70 minutes. The rebuild that evening used `CREATE INDEX CONCURRENTLY`, 8 GB of `maintenance_work_mem` and 4 parallel workers, and finished in 25 minutes without blocking writes. The lesson is the same as for any index on a big table (Part 24 — Database Migrations): concurrently, with enough memory, outside peak hours.

#### Edge cases & failure modes

- **Index does not fit in RAM**: latency jumps from milliseconds to tens of milliseconds as pages come from disk; watch buffer `read` counts.
- **Dimension mismatch on insert**: PostgreSQL rejects it (good); catch it in the embedding service first.
- **NULL embeddings** (rows waiting to be embedded) are skipped by the index; make sure "not yet embedded" rows are visible somewhere else or they silently vanish from search.
- **Heavy update churn** bloats the index; vacuum, and consider periodic `REINDEX CONCURRENTLY`.
- **Very selective filters** defeat HNSW (above); check `Rows Removed by Filter`.
- **Read replicas** serve vector queries well, but replication lag means a just-updated product may not be searchable for a moment.

#### How a Senior Backend Engineer thinks about this

A senior reaches for pgvector first when the team already runs PostgreSQL, because it avoids a whole new system and keeps embeddings joined to relational data and inside transactions. They index with HNSW by default, verify with `EXPLAIN ANALYZE` that the index is used, and tune the recall/speed parameters to the workload. They always include the tenant filter in the vector query for multi-tenant systems, treating a missing tenant scope as a serious data-leak bug. They keep the embedding dimension matched to the model and re-embed on model change. And they know pgvector's limits (38.1.3) and the conditions under which a dedicated vector database earns its operational cost.

#### Common mistakes

- No vector index on a large table, so every search is a full scan.
- Mismatched dimension between the column and the embedding model.
- Using the wrong distance operator for the model's metric.
- Forgetting the tenant filter, leaking cross-tenant documents.
- Not verifying with `EXPLAIN` that the index is used; a filter or query shape can defeat it.
- Expecting exact results from an approximate index without tuning recall.

#### Interview questions

1. **What does pgvector add to PostgreSQL and why use it over a separate vector database?** A `vector` type and similarity operators/indexes; use it to avoid a new system, keep embeddings joined to relational data and in transactions, and filter by metadata in one SQL query.
2. **HNSW vs IVFFlat — how do you choose?** HNSW is the default for best speed at high recall (slower build, more memory); IVFFlat builds faster and uses less memory, favored for very large datasets; both are approximate and tunable.
3. **Why is metadata filtering important in a multi-tenant RAG system?** Every vector query must scope to the current tenant, or it can retrieve another tenant's documents; pgvector does this with a `WHERE` clause in the same query.
4. **How do you confirm a vector query uses the index?** `EXPLAIN (ANALYZE, BUFFERS)` should show an index scan on the HNSW/IVFFlat index, not a sequential scan.

5. **A tenant-filtered vector query returns 3 rows when you asked for 10. What is happening and how do you fix it?** HNSW collects `ef_search` candidates and filters afterwards, so a selective filter removes most of them. Use iterative index scans (pgvector 0.8+), exact search for small tenants, partitioning or partial indexes for large ones, or a higher `ef_search`.
6. **How do you know your approximate index is good enough?** Measure recall@k against exact search on a sample of real queries, and tune `ef_search` or `probes` until recall meets the target at acceptable latency.
7. **Why must `CREATE INDEX` for HNSW be run carefully on a large table?** A plain build blocks writes for its whole duration and is slow if `maintenance_work_mem` is too small; use `CONCURRENTLY`, enough memory, parallel workers and off-peak timing.

#### Practical exercise

Create a `product_embeddings` table with a `vector` column and a `tenant_id`, load a few thousand rows, build an HNSW cosine index, and run a nearest-neighbour query filtered by tenant. Use `EXPLAIN ANALYZE` to confirm the index is used, then run the same query without the tenant filter and observe the difference. Acceptance criteria: the tenant-scoped query uses the HNSW index and never returns another tenant's rows.

### 38.1.3 pgvector versus a dedicated vector database

#### Concept

Dedicated vector databases exist and are sometimes the right choice. The decision is the same build-vs-operate tradeoff as everywhere in this book: pgvector reuses a system you already run; a dedicated vector database is another system with its own scaling, features and operational cost. You choose based on scale, feature needs and how tightly the vectors must join to your relational data.

#### How it works — the decision table

| Factor | pgvector | Dedicated vector database |
|---|---|---|
| Operational cost | None extra; it is your PostgreSQL | A new system to run, secure, back up, sync |
| Join to relational data | Native (one SQL query, transactions) | Separate; you join in application code |
| Tenant isolation / filtering | A `WHERE` clause | More work, varies by product |
| Scale (vectors) | Comfortable to tens of millions; beyond needs care | Built for hundreds of millions to billions |
| Advanced features | Core ANN search | Richer: sharding, specialized indexes, hybrid built in |
| Consistency with source data | Same database, transactional | Must sync (outbox/CDC), eventual |
| Team familiarity | You already know PostgreSQL | New tool to learn and operate |

```text
Choose pgvector when:                      Choose a dedicated vector DB when:
- you already run PostgreSQL               - vectors number in the hundreds of millions+
- vectors join tightly to relational data  - you need its specialized scaling/features
- scale is up to ~tens of millions         - vector search is the core product at huge scale
- you want one system to operate           - a dedicated team will own the extra system
- tenant filtering must be easy and exact
```

#### Failure scenario

A team chose a hosted vector database "for scale" with 300,000 documents. Products were written to PostgreSQL and then, in the same request handler, upserted to the vector database. When the vector database had a 20-minute incident, the handler's second write failed after the first had committed (a classic dual write, Part 30). About 4,000 product edits never reached the vector store; nobody noticed for a month, until shoppers kept finding discontinued products by semantic search. They added an outbox and a nightly reconciliation job comparing ids and content hashes between the two stores, which is exactly the machinery pgvector would not have needed at that size.

#### Edge cases & failure modes

- **Dual writes** to PostgreSQL and a vector store drift on partial failure; use an outbox or CDC (38.3).
- **Deletes** are the most forgotten sync event; a deleted or unpublished product still found by search is a common bug.
- **Tenant isolation** in a separate store depends on its namespace or filter features and on every caller using them.
- **Two backups, two restore points**: after a restore, the stores disagree until re-synced.
- **Vendor limits** on metadata size, filter expressiveness or namespace count can force redesigns later.

#### How a Senior Backend Engineer thinks about this

A senior starts with pgvector unless a concrete requirement rules it out, because the simplest architecture that meets the need wins (the anti-hype principle from throughout this book) and a second datastore is a real, permanent operational tax — another thing to scale, secure, back up and keep in sync with the source of truth (Part 39). They move to a dedicated vector database only when scale (hundreds of millions of vectors), specialized features, or vector search being the core product at huge scale genuinely demands it, and they account for the sync problem (the vectors must be kept consistent with the relational source via outbox or CDC, which pgvector gets for free by living in the same database). They treat "add a vector database" as an architectural decision requiring an ADR (Part 64), not a default reach.

#### Common mistakes

- Adding a dedicated vector database by default when pgvector would do, paying unnecessary operational cost.
- Ignoring the sync problem a separate vector store creates (keeping it consistent with the source).
- Underestimating pgvector (it handles far more than people assume).

#### Interview questions

1. **When is pgvector the right choice and when is a dedicated vector database?** pgvector when you already run PostgreSQL, vectors join to relational data, and scale is up to tens of millions; a dedicated database at hundreds of millions of vectors or when specialized features or huge-scale vector-first products demand it.
2. **What hidden cost does a separate vector database add?** Keeping it in sync and consistent with the relational source (outbox/CDC), plus operating, scaling, securing and backing up another system.

#### Practical exercise

Write a one-page decision record (ADR, Part 64) for whether a product-catalog search at your scale should use pgvector or a dedicated vector database, covering scale, join needs, tenant isolation, sync, and operational cost, ending with a recommendation. Acceptance criteria: the recommendation follows from the stated factors, and the sync/consistency cost of the separate-database option is addressed.
