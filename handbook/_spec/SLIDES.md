# Masterclass Slide Deck — Writing Contract

> Part numbers in this file were updated on 2026-11-05 to the reading-order numbering (Volume 0 = Parts 1–6, the book runs 1–85). The file name keeps the original batch number.

You are writing slides for the **Senior Backend Engineering Masterclass**, the visual companion to the Senior Backend Engineering Handbook. The deck must NOT copy paragraphs from the handbook. It teaches visually: one idea per slide, 3–7 crisp points, a diagram or code snippet, a real-world example, and a "Senior takeaway".

The build script turns your JSON into a PowerPoint (.pptx) and an HTML deck. **Only the JSON shapes described here render.** Anything else is dropped.

## 1. File and top-level shape

Write one JSON file per deck section into `f:\learning\senior-backend-handbook\slides\` named `NN-slug.json` (NN = section order, two digits). Top-level:

```json
{
  "section": "PostgreSQL",
  "order": 6,
  "subtitle": "Internals, indexing, transactions, scaling, migrations",
  "parts": [11, 12, 13, 15, 31],
  "slides": [ ... ]
}
```

- `parts`: the handbook Part numbers this section summarises (keeps deck and handbook synchronised — the section divider slide prints "Handbook Parts 18–20 and 22, 23").
- `slides`: 5–12 content slides (see the per-section targets in section 4).

## 2. Slide shape

```json
{
  "title": "MVCC: readers never block writers",
  "part": "11",
  "points": [
    "Every UPDATE writes a new row version; the old one stays until VACUUM",
    "Each transaction sees a snapshot chosen at its start (or per statement in Read Committed)",
    "Readers never wait for writers; writers only wait for writers on the same row",
    "Dead tuples are why UPDATE-heavy tables bloat",
    "Transaction id wraparound is an emergency, not a warning"
  ],
  "visual": { "type": "flow", "direction": "h", "nodes": ["Txn A updates row", "New version v2 written", "Txn B still reads v1", "VACUUM removes v1"] },
  "example": "An orders table updated 2,000 times/min grew to 3x its live size when autovacuum fell behind during a backfill.",
  "takeaway": "Every UPDATE is an INSERT plus a dead tuple. Tune autovacuum for your write rate, not the defaults."
}
```

Fields:

- `title` (required): 3–9 words, a claim or a question, not a topic label. Good: "Why deep OFFSET pagination gets slower every page". Bad: "Pagination".
- `part` (required): the handbook part number(s) this slide draws from, as a string: `"12"` or `"13, 14"`.
- `points` (required): 3–7 strings, each ≤ 110 characters, no trailing periods, concrete and specific (numbers, names, consequences).
- `visual` (optional): one diagram — see section 3.
- `code` (optional): `{ "lang": "ts" | "sql" | "bash" | "yaml" | "json" | "text" | "dockerfile", "text": "..." }`. Max **14 lines**, max **64 characters per line**. Real, runnable-looking NestJS/TypeORM/Sequelize/SQL/kubectl code; no pseudo-APIs. Use `\n` for newlines inside the JSON string.
- Use **at most one of `visual` or `code` per slide** (if both are present only `visual` is shown). Roughly 60% of slides should have a visual, 25% a code snippet, 15% neither (those get full-width points).
- `example` (optional but recommended on most slides): one sentence, ≤ 160 characters, a concrete real-world situation ("At 02:14 the on-call..."). It renders as a small "Real world" box.
- `takeaway` (required): one sentence, ≤ 150 characters, the thing a senior engineer would say. Renders in the green "Senior takeaway" bar.
- `notes` (optional): speaker notes, 1–4 sentences, goes into the PowerPoint notes pane.

## 3. Visual types (the only ones that render)

Keep labels short (≤ 28 characters per box). Boxes wrap text but small is better.

### flow — boxes connected by arrows in one line
```json
{ "type": "flow", "direction": "h", "nodes": ["Client", "Load balancer", "NestJS", "PostgreSQL"], "labels": ["HTTPS", "HTTP/1.1", "TCP 5432"] }
```
- `direction`: `"h"` (2–5 nodes) or `"v"` (2–7 nodes). `labels` optional (edge labels, length = nodes − 1).

### stack — rows of boxes, arrows flowing downward between rows (architecture layers)
```json
{ "type": "stack", "rows": [["Client"], ["API Gateway / LB"], ["NestJS API", "NestJS Workers"], ["Redis", "PostgreSQL", "Kafka"]] }
```
- 2–5 rows, 1–4 boxes per row.

### table — small comparison table
```json
{ "type": "table", "headers": ["Level", "Dirty read", "Non-repeatable", "Phantom"], "rows": [["Read Committed", "No", "Yes", "Yes"], ["Repeatable Read", "No", "No", "No (PG)"], ["Serializable", "No", "No", "No"]] }
```
- Max 5 columns, max 7 rows, cells ≤ 24 characters.

### compare — two side-by-side lists
```json
{ "type": "compare", "left": { "title": "Modular monolith", "items": ["One deploy", "In-process calls", "One DB, schema per module"] }, "right": { "title": "Microservices", "items": ["Deploy per service", "Network calls + partial failure", "DB per service, sagas"] } }
```
- 2–6 items per side, ≤ 40 characters each.

### steps — numbered vertical sequence
```json
{ "type": "steps", "items": ["DNS resolves api.shop.com", "TCP handshake (1 RTT)", "TLS 1.3 handshake (1 RTT)", "HTTP request bytes", "LB picks a healthy pod", "NestJS guards, pipes, handler", "PostgreSQL query", "Response + keep-alive"] }
```
- 3–8 items, ≤ 48 characters each.

### graph — small node/edge diagram (state machines, sagas, dependency graphs)
```json
{ "type": "graph", "nodes": [{"id": "c", "label": "CREATED"}, {"id": "p", "label": "PAID"}, {"id": "s", "label": "SHIPPED"}, {"id": "x", "label": "CANCELLED"}], "edges": [["c", "p", "payment captured"], ["p", "s", "picked up"], ["c", "x", "timeout"], ["p", "x", "refund"]] }
```
- 3–8 nodes, ≤ 12 edges, edge label optional. Nodes are laid out automatically in a grid; keep graphs small.

### cycle — items arranged in a loop with arrows (feedback loops, lifecycles)
```json
{ "type": "cycle", "items": ["Measure", "Hypothesise", "Change one thing", "Verify", "Document"] }
```
- 3–6 items.

## 4. Deck sections, their handbook Parts, and slide targets

| Order | Section | Handbook Parts | Content slides |
|---|---|---|---|
| 01 | Backend Foundations | 1, 2 | 6 |
| 02 | Node.js & NestJS | 3, 21 (+ NestJS request lifecycle, DI from 6) | 8 |
| 03 | Networking | 4 | 6 |
| 04 | Architecture & API Design | 5, 6, 7, 8 | 9 |
| 05 | Databases & SQL | 9, 10 | 6 |
| 06 | PostgreSQL | 11, 12, 13, 15, 31 | 10 |
| 07 | ORM Engineering | 14 | 5 |
| 08 | Caching | 16 | 6 |
| 09 | Messaging & Background Jobs | 17, 36 | 7 |
| 10 | Distributed Systems & Reliability | 18, 19, 20 | 9 |
| 11 | Security | 22 | 7 |
| 12 | Testing | 23 | 5 |
| 13 | Performance & Capacity | 24, 41 | 6 |
| 14 | Observability | 25 | 6 |
| 15 | Docker | 26 | 4 |
| 16 | Kubernetes | 27 | 6 |
| 17 | Cloud, Storage, Search, DR & Cost | 28, 33, 34, 38, 39 | 7 |
| 18 | CI/CD & Compatibility | 29, 32 | 5 |
| 19 | Git | 30 | 4 |
| 20 | System Design | 40, 35 | 10 |
| 21 | Production Engineering | 37, 42, 47, 48 | 8 |
| 22 | Senior Engineering Mindset | 43, 44, 45, 46, 49, 50 | 7 |

Total ≈ 147 content slides + title, agenda, 22 dividers and closing ≈ 172 slides.

## 4a. A complete worked example

`F:\learning\senior-backend-handbook\_spec\EXAMPLE-SECTION.json` is a valid section file exercising **every** visual type and both code and no-visual slides. Read it before you write. It has been rendered to PowerPoint and checked, so its shapes are known-good. Copy its structure; do not copy its content.

## 5. Quality rules

- Read the handbook chapter files for your sections first (`f:\learning\senior-backend-handbook\chapters\part-NN-*.md`) so the slides summarise what the book actually says and use the same terms and examples.
- Every slide must teach one idea. If you need "and", split the slide.
- Points are claims, not topics. "Composite index column order: equality first, then range, then sort" — not "Composite indexes".
- Prefer visuals for: architecture, request lifecycle, transactions/isolation, caching flows, Kafka partitions/consumer groups, sagas, Kubernetes topology, CI/CD pipelines, distributed-systems failure paths, auth flows, observability pipelines.
- Prefer code for: NestJS guards/interceptors/transactions, SQL (`EXPLAIN`, `FOR UPDATE SKIP LOCKED`, upserts, keyset pagination), Dockerfile, Kubernetes probes, GitHub Actions steps, Redis Lua.
- Every section should include at least one "failure" slide (what goes wrong) and one "how a senior thinks" slide.
- Valid JSON only (double quotes, no trailing commas, no comments). Escape newlines in code as `\n` and double quotes as `\"`.
- Do not exceed the limits above; the renderer truncates silently.
