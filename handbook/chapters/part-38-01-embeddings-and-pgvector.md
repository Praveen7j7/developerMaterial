# Part 38 — Retrieval, Agents and Evaluation

Part 37 gave you the foundations: calling an LLM safely, structured output, cost control, failure handling. This Part builds the two things that turn an LLM from a clever text generator into a useful backend feature: **retrieval** (giving the model the right data at the right moment, so it answers from your facts instead of hallucinating) and **agents** (letting the model use tools to take actions, safely). It finishes with **evaluation** — how you know your LLM feature actually works and does not silently regress, which is the discipline that separates a demo from a production system.

The retrieval half centers on **RAG** (Retrieval-Augmented Generation) built on **pgvector**, the PostgreSQL extension for vector search. We stay in PostgreSQL deliberately, because the rest of this book's stack is PostgreSQL and because, for most teams, pgvector is the right first choice over a separate vector database (we give the decision table for when it is not). The running example is a product-catalog search and an order-support assistant for an e-commerce site, continued from Part 37.

As in Part 37, the patterns are provider-neutral and the SQL and NestJS are real. This Part leans on earlier material: caching (Part 27), full-text search (Part 34), the outbox and CDC for index sync (Part 30, Part 39), and tenant isolation (Part 88).

## 38.1 Embeddings and vector search

### 38.1.1 What an embedding is

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

#### Similarity in numbers

Cosine similarity between vectors `a` and `b` is `dot(a, b) / (|a| x |b|)`: 1 means same direction (same meaning), 0 means unrelated, and negative values are rare for text embeddings. Many embedding models return **normalized** vectors (length 1). For those, cosine similarity equals the plain dot product, which is cheaper to compute, and cosine distance (what pgvector's `<=>` returns) is simply `1 - similarity`. In practice, scores are only meaningful relative to each other for one model: one model's "0.82" can mean "very similar" while another model's very similar pairs sit around 0.5. Never hard-code a similarity threshold without measuring it on your own data.

#### Practical example

A dental-supplies store has 40,000 products. A shopper searches "something to stop gloves tearing on sharp instruments". No product title contains those words, but the description of "nitrile gloves, extra-thick fingertips, puncture resistant" lands close in vector space, and it comes first. The same store also needs "SKU 4410-B" to return exactly that product; the embedding of a code is nearly meaningless, which is why the catalog search later combines both methods (38.5).

#### NestJS example

Embedding providers differ in names and request shapes, so we hide them behind a small interface and keep the provider-specific code in one adapter. The interface below is ours, not a library's.

```ts
// embeddings/embedding.service.ts -- provider behind an interface, query embeddings cached
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { REDIS } from '../redis/redis.module';

export interface EmbeddingProvider {
  readonly model: string;      // e.g. 'acme-embed-3'; stored with every vector
  readonly dimensions: number; // must equal the vector(N) column size
  // Many providers want to know whether the text is a query or a document; pass it through.
  embed(texts: string[], kind: 'query' | 'document'): Promise<number[][]>;
}
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

@Injectable()
export class EmbeddingService {
  constructor(
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  get model() { return this.provider.model; }

  async embedQuery(text: string): Promise<number[]> {
    const norm = text.trim().toLowerCase().replace(/\s+/g, ' ');
    const key = `emb:${this.provider.model}:${createHash('sha256').update(norm).digest('hex')}`;
    const hit = await this.redis.getBuffer(key);  // popular queries skip the provider entirely
    if (hit) return Array.from(new Float32Array(hit.buffer, hit.byteOffset, hit.byteLength / 4));

    const [vec] = await this.provider.embed([norm], 'query');
    this.assertDims(vec);
    await this.redis.set(key, Buffer.from(new Float32Array(vec).buffer), 'EX', 86_400);
    return vec;
  }

  async embedDocuments(texts: string[], batchSize = 96): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) {  // providers cap inputs per request
      const vecs = await this.provider.embed(texts.slice(i, i + batchSize), 'document');
      vecs.forEach((v) => this.assertDims(v));
      out.push(...vecs);
    }
    return out;
  }

  private assertDims(v: number[]) {
    if (v.length !== this.provider.dimensions) {
      throw new Error(`Embedding has ${v.length} dims, expected ${this.provider.dimensions}`);
    }
  }
}
```

The cache key contains the model name. That one detail prevents the worst embedding bug there is (see the failure scenario below).

#### Production scenario

The numbers that size an embedding system, for a catalog plus help center of 2 million chunks with a 1,536-dimension model:

```text
Storage per vector     1,536 floats x 4 bytes        = ~6 KB  (halfvec: ~3 KB)
Raw vectors            2,000,000 x 6 KB              = ~12 GB, plus the HNSW index on top
Embedding the corpus   2,000,000 chunks x ~350 tokens = ~700 M tokens
                       at $0.02 to $0.15 per 1M tokens = ~$14 to $105, one time
Query embedding        ~20 to 80 ms per call, fractions of a cent per 1,000 queries
Query cache hit rate   30 to 60% on e-commerce search (popular queries repeat)
```

The surprise for most teams is not cost but **memory**: vector search is fast only when the index fits in RAM. Twelve gigabytes of vectors plus the index means a database instance sized for it, which is why dimension count (and `halfvec`, 38.1.2) is an infrastructure decision, not just a model choice.

#### Failure scenario

A team upgraded to a newer embedding model with the same 1,536 dimensions and pointed the indexing pipeline at it. New and edited products got new-model vectors; the other 90% kept old-model vectors; queries were embedded with the new model. Nothing errored, because the dimensions matched. Search quality for older products collapsed: their vectors lived in a different "map", so distances to new-model queries were noise. It took two weeks of "search got worse" tickets to find it. The fix: an `embedding_model` column on every row, queries filtered to the model they were embedded with, and model changes done as a full re-embed into a new column with an atomic switch (38.10). The lesson: an embedding is only comparable with embeddings from the same model, and the database must know which model made each row.

#### Edge cases & failure modes

- **Empty or very short text** ("ok", a single SKU) produces near-meaningless vectors; skip embedding or use keyword search for those.
- **Text longer than the model's input limit** is truncated by some providers silently; chunk first (38.3).
- **Mixed languages**: multilingual models map "guantes de nitrilo" near "nitrile gloves"; monolingual ones do not. Test with your real query languages.
- **Provider outage** on the query path breaks semantic search; fall back to full-text search (38.5).
- **Floating-point identity**: the same text can produce very slightly different vectors across calls; never use a vector as a key.

#### How a Senior Backend Engineer thinks about this

A senior understands that an embedding captures meaning as learned by one specific model, so embeddings from different models are not comparable and the embedding model is a dependency you version like a schema — change it and you must re-embed everything. They pick the similarity metric the model expects. They know embeddings complement, not replace, keyword search: some queries (an exact product code, a specific name) are better served by exact or full-text matching, which is why hybrid search (38.2) combines both. They treat the embedding model as a cost and latency item too — embedding large corpora and every query has a price — and cache query embeddings for repeated queries (Part 27).

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

5. **Your similarity threshold of 0.8 worked with one model and returns nothing with another. Why?** Similarity scales differ between models; thresholds must be calibrated per model on your own labelled data, or avoided in favor of top-k plus re-ranking.

#### Practical exercise

Compute embeddings for ten product descriptions and three query strings using an embedding model, then, by computing cosine similarity in code, rank the products for each query and confirm that semantically related products rank above unrelated ones even when they share no keywords. Acceptance criteria: a query like "tool to look inside a patient's mouth" ranks "dental mirror" highly despite no shared words.
