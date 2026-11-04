# Part 60 — Retrieval, Agents and Evaluation

Part 59 gave you the foundations: calling an LLM safely, structured output, cost control, failure handling. This Part builds the two things that turn an LLM from a clever text generator into a useful backend feature: **retrieval** (giving the model the right data at the right moment, so it answers from your facts instead of hallucinating) and **agents** (letting the model use tools to take actions, safely). It finishes with **evaluation** — how you know your LLM feature actually works and does not silently regress, which is the discipline that separates a demo from a production system.

The retrieval half centers on **RAG** (Retrieval-Augmented Generation) built on **pgvector**, the PostgreSQL extension for vector search. We stay in PostgreSQL deliberately, because the rest of this book's stack is PostgreSQL and because, for most teams, pgvector is the right first choice over a separate vector database (we give the decision table for when it is not). The running example is a product-catalog search and an order-support assistant for an e-commerce site, continued from Part 59.

As in Part 59, the patterns are provider-neutral and the SQL and NestJS are real. This Part leans on earlier material: caching (Part 16), full-text search (Part 34), the outbox and CDC for index sync (Part 19, Part 63), and tenant isolation (Part 58).

## 60.1 Embeddings and vector search

### 60.1.1 What an embedding is

#### Concept

An **embedding** is a list of numbers (a vector) that represents the meaning of a piece of text. A model turns text into a vector such that texts with similar meaning have vectors that are close together in space. "dental mirror" and "mouth mirror for dentists" land near each other; "dental mirror" and "car tire" land far apart. Searching by embedding finds things by meaning, not by matching keywords.

#### Why does it exist?

Keyword search (even good full-text search, Part 34) matches words, so it misses a document that means the same thing in different words and returns documents that share a word but not a meaning. Many tasks need meaning-based retrieval: "find products like this one", "find the support article that answers this question", "find the passage relevant to the user's query". Embeddings make that possible by turning meaning into geometry, so "find similar meaning" becomes "find nearby vectors", which a database can do efficiently.

#### Mental model

Imagine placing every product description as a pin on an enormous map, where the position is decided by meaning rather than geography. Descriptions about dental tools cluster in one region; descriptions about office furniture cluster in another. To find things similar to a query, you drop a pin for the query and look at the nearest pins. The map is the vector space; a pin's coordinates are its embedding; "nearest pins" is vector similarity search. The embedding model is the cartographer that decides where each text goes.

#### How it works

```text
Text  ->  embedding model  ->  vector (e.g. 1,536 numbers)

"dental mirror"           -> [0.021, -0.11, 0.08, ... ]   }
"mouth mirror, dentist"   -> [0.019, -0.10, 0.09, ... ]   } close together
"car tire, 17 inch"       -> [-0.22,  0.31, -0.05, ... ]  } far away
```

You compute an embedding by calling an embedding model (a different, cheaper model than the chat LLM) with your text; it returns a fixed-length vector (the length, the number of dimensions, is fixed per model — often several hundred to a couple of thousand). To find similar items, you compute the query's embedding and ask the database for the stored vectors closest to it.

**Similarity metrics** measure "close". The common ones:

| Metric | Measures | Note |
|---|---|---|
| Cosine similarity | Angle between vectors (direction) | Most common for text; ignores magnitude |
| Inner product (dot) | Direction and magnitude | Fast; used when vectors are normalized |
| Euclidean (L2) distance | Straight-line distance | Used in some models |

You use the metric the embedding model was designed for (usually cosine for text). The database computes the chosen metric between the query vector and stored vectors and returns the nearest.

#### How a Senior Backend Engineer thinks about this

A senior understands that an embedding captures meaning as learned by one specific model, so embeddings from different models are not comparable and the embedding model is a dependency you version like a schema — change it and you must re-embed everything. They pick the similarity metric the model expects. They know embeddings complement, not replace, keyword search: some queries (an exact product code, a specific name) are better served by exact or full-text matching, which is why hybrid search (60.2) combines both. They treat the embedding model as a cost and latency item too — embedding large corpora and every query has a price — and cache query embeddings for repeated queries (Part 16).

#### Common mistakes

- Mixing embeddings from different models or model versions, which are not comparable.
- Using the wrong similarity metric for the model.
- Assuming semantic search replaces keyword search; some queries need exact matching.
- Not versioning the embedding model, so an upgrade silently makes old and new vectors incomparable.
- Re-embedding the same query repeatedly instead of caching the query embedding.

#### Interview questions

1. **What is an embedding?** A fixed-length vector representing the meaning of text, such that semantically similar texts have nearby vectors, enabling meaning-based search.
2. **Why is semantic search better than keyword search for some queries, and worse for others?** It matches meaning, catching different wordings of the same idea, but it can miss exact matches (product codes, names) that keyword search handles precisely; hence hybrid search.
3. **What happens if you change the embedding model?** Old and new vectors become incomparable; you must re-embed the entire corpus, so the model is a versioned dependency.
4. **Which similarity metric is most common for text and what does it measure?** Cosine similarity, measuring the angle (direction) between vectors, ignoring magnitude.

#### Practical exercise

Compute embeddings for ten product descriptions and three query strings using an embedding model, then, by computing cosine similarity in code, rank the products for each query and confirm that semantically related products rank above unrelated ones even when they share no keywords. Acceptance criteria: a query like "tool to look inside a patient's mouth" ranks "dental mirror" highly despite no shared words.

### 60.1.2 pgvector in PostgreSQL

#### Concept

**pgvector** is a PostgreSQL extension that adds a `vector` column type and vector similarity operators, so you can store embeddings next to your relational data and search them with SQL. For a team already running PostgreSQL, it means vector search without adding a new database — your products, their embeddings, and your relational constraints all live in one place, queried with one language and backed up as one system.

#### Why does it exist?

You could add a dedicated vector database, but that is another system to run, secure, back up, keep in sync and pay for. pgvector lets you do vector search in the database you already operate, joined directly to your relational data (filter by tenant, category, price in the same query as the similarity search) and inside the same transactions. For the large majority of applications, that is simpler and sufficient; you reach for a dedicated vector database only when scale or features demand it (60.1.3).

#### How it works — schema and search

```sql
-- Enable the extension (once per database).
CREATE EXTENSION IF NOT EXISTS vector;

-- Store embeddings alongside the product. The dimension (1536 here) must match the model.
CREATE TABLE product_embeddings (
  product_id  uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL,                       -- for tenant isolation (Part 58)
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

-- IVFFlat alternative (choose list count ~ rows/1000; must ANALYZE after loading data).
CREATE INDEX product_embeddings_ivf
  ON product_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

Both are **approximate**: they trade a little recall (occasionally missing a true nearest neighbour) for a large speed gain. You tune the recall/speed tradeoff with parameters (`ef_search` for HNSW, `probes` for IVFFlat) at query time. HNSW is the usual default for its superior speed-at-high-recall; IVFFlat is lighter to build and uses less memory, favored for very large datasets.

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

The `Index Scan using ...hnsw` confirms the vector index is used; without it you would see a sequential scan computing every distance. As with any PostgreSQL index (Part 12), you verify with `EXPLAIN ANALYZE` that your query actually uses the vector index — a mistake in the query or a filter that defeats the index drops you back to a full scan.

#### Metadata filtering

A key pgvector advantage is filtering by relational columns alongside the vector search (`WHERE tenant_id = ... AND category = ...`). This is essential for **tenant isolation** in a multi-tenant RAG system (Part 58): every vector query must scope to the current tenant, or you risk retrieving another tenant's documents (60.3 covers the incident this prevents). With pgvector, the tenant filter is just a `WHERE` clause in the same query; with a separate vector database, isolation is more work and more error-prone.

#### How a Senior Backend Engineer thinks about this

A senior reaches for pgvector first when the team already runs PostgreSQL, because it avoids a whole new system and keeps embeddings joined to relational data and inside transactions. They index with HNSW by default, verify with `EXPLAIN ANALYZE` that the index is used, and tune the recall/speed parameters to the workload. They always include the tenant filter in the vector query for multi-tenant systems, treating a missing tenant scope as a serious data-leak bug. They keep the embedding dimension matched to the model and re-embed on model change. And they know pgvector's limits (60.1.3) and the conditions under which a dedicated vector database earns its operational cost.

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

#### Practical exercise

Create a `product_embeddings` table with a `vector` column and a `tenant_id`, load a few thousand rows, build an HNSW cosine index, and run a nearest-neighbour query filtered by tenant. Use `EXPLAIN ANALYZE` to confirm the index is used, then run the same query without the tenant filter and observe the difference. Acceptance criteria: the tenant-scoped query uses the HNSW index and never returns another tenant's rows.

### 60.1.3 pgvector versus a dedicated vector database

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

#### How a Senior Backend Engineer thinks about this

A senior starts with pgvector unless a concrete requirement rules it out, because the simplest architecture that meets the need wins (the anti-hype principle from throughout this book) and a second datastore is a real, permanent operational tax — another thing to scale, secure, back up and keep in sync with the source of truth (Part 63). They move to a dedicated vector database only when scale (hundreds of millions of vectors), specialized features, or vector search being the core product at huge scale genuinely demands it, and they account for the sync problem (the vectors must be kept consistent with the relational source via outbox or CDC, which pgvector gets for free by living in the same database). They treat "add a vector database" as an architectural decision requiring an ADR (Part 49), not a default reach.

#### Common mistakes

- Adding a dedicated vector database by default when pgvector would do, paying unnecessary operational cost.
- Ignoring the sync problem a separate vector store creates (keeping it consistent with the source).
- Underestimating pgvector (it handles far more than people assume).

#### Interview questions

1. **When is pgvector the right choice and when is a dedicated vector database?** pgvector when you already run PostgreSQL, vectors join to relational data, and scale is up to tens of millions; a dedicated database at hundreds of millions of vectors or when specialized features or huge-scale vector-first products demand it.
2. **What hidden cost does a separate vector database add?** Keeping it in sync and consistent with the relational source (outbox/CDC), plus operating, scaling, securing and backing up another system.

#### Practical exercise

Write a one-page decision record (ADR, Part 49) for whether a product-catalog search at your scale should use pgvector or a dedicated vector database, covering scale, join needs, tenant isolation, sync, and operational cost, ending with a recommendation. Acceptance criteria: the recommendation follows from the stated factors, and the sync/consistency cost of the separate-database option is addressed.
