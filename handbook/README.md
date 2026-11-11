# Senior Backend Engineering Handbook — project layout

Two synchronized outputs are built from one set of sources:

1. **The handbook** — a long-form reference book in Markdown, HTML and PDF.
2. **The masterclass deck** — a PowerPoint and HTML presentation that is the visual summary of the same material.

Every deck section names the handbook Parts it summarises, and `dist/deck-map.md` records that mapping so the two never drift apart.

## Where things live

```text
_spec/                     the writing contracts every author followed
  STYLE.md                 handbook contract: teaching template, file naming,
                           heading levels, Mermaid rules, code rules
  SLIDES.md                deck contract: the only JSON shapes that render
  EXAMPLE-SECTION.json     a known-good deck section exercising every visual type

chapters/                  the book source, one file per chunk of a Part
                           part-NN-SS-slug.md concatenates in filename order

slides/                    the deck source, one JSON file per section
                           NN-slug.json

build/                     the build and QA pipeline (Node)
dist/                      everything that gets produced
```

## The build pipeline

| Script | What it does |
|---|---|
| `build/build-handbook.js` | Concatenates `chapters/` into the full Markdown book with a generated table of contents, then renders the full web page, the full print page, and **six volumes** (web, print and Markdown each) plus a hub index. |
| `build/build-deck.js` | Turns `slides/*.json` into `senior-backend-engineering-masterclass.pptx` and a matching HTML deck, and writes `deck-map.md`. |
| `build/make-all-pdfs.js` | Renders the volume print pages to PDF with local Chrome. `--full` also renders the complete single PDF, `--only N` renders one volume. |
| `build/check-structure.js` | Audits every Part: one H1, sequential section numbering, no duplicate numbers, correct part prefix, and the required closing sections. |
| `build/validate-mermaid.js` | Parses and renders every diagram in real headless Chrome and reports the file and line of any that break. |
| `build/validate-slides.js` | Checks every slide against the deck contract: point counts and lengths, code line count and width, label lengths, per-visual-type dimensions, and graph edges pointing at real nodes. |
| `build/mermaid-sanitize.js` | Shared repair pass used by both the validator and the builder. Fixes the characters Mermaid treats as syntax, most importantly semicolons inside sequence-diagram messages. |
| `build/shot-deck.js` | Screenshots slides from the HTML deck for visual review. |

Run order:

```bash
cd build
node check-structure.js      # structural audit of the chapters
node validate-mermaid.js     # every diagram parses and renders
node build-handbook.js       # Markdown, full HTML, six volumes
node validate-slides.js      # every slide obeys the deck contract
node build-deck.js           # PPTX + HTML deck + deck map
node make-all-pdfs.js        # six volume PDFs
```

## Why the book is split into volumes

The finished handbook is well over two million words. A single HTML page exceeds what can be published, so the site has one page per volume. The volumes follow the learning roadmap in Part 69, so each one is a coherent stage of the journey rather than an arbitrary slice:

| Volume | Title | Parts | Covers |
|---|---|---|---|
| 0 | From Scratch | 0–8 | How to understand any technology, JavaScript and TypeScript (with classes), async, the web, Linux, Git, your first backend, your first frontend, your first developer job |
| 1 | Foundations | 9–14 | Advanced TypeScript, data structures, algorithms, a coding-practice ladder, operating systems and the Node.js runtime, networking |
| 2 | Architecture and APIs | 15–19 | Architecture styles, clean code and patterns, domain-driven design, REST, GraphQL and gRPC |
| 3 | Data | 20–29 | Relational model, SQL, PostgreSQL internals, indexing, transactions, ORMs, scaling, migrations, compatibility, NoSQL |
| 4 | Distributed Systems | 30–43 | Caching, messaging, distributed transactions, reliability, concurrency, storage, search, real-time, jobs, LLM backends, RAG, data engineering, data platform architecture |
| 5 | Production Engineering | 44–57 | Security, testing, performance, observability, Docker, Kubernetes, cloud, CI/CD, Git, SRE, disaster recovery, cost, IaC, AI-assisted engineering |
| 6 | Mastery | 58–74 | System design from zero, 30 system designs, capacity estimation, debugging, mindset, levels, backend interviews, projects, patterns, decisions, roadmap, low-level design |
| 7 | Frontend and Full Stack | 75–87 | Browser, tooling, React, Next.js, data fetching, contracts, browser security, web performance, testing, shipping, a full-stack project, frontend architecture at scale, frontend interviews |
| 8 | Principal and Architect | 88–97 | Writing, strategy, governance, migrations, org design, influence, growing engineers, multi-tenant SaaS, security architecture, staff and principal interviews |

98 parts in all (Part 0 to Part 97), numbered in reading order.

The site is built by `build/build-site.js` (volume list in `VOLUMES`); old bookmarks from earlier numberings redirect to the new anchors.

## Conventions that hold across the book

- Every major concept follows one teaching template: Concept, Why it exists, Mental model, How it works, Practical example, NestJS example, PostgreSQL example, TypeORM and Sequelize examples where they apply, Production scenario, Failure scenario, Edge cases and failure modes, How a senior engineer thinks about it, Common mistakes, Interview questions, Practical exercise.
- Every Part ends with a Senior Checklist and Key Takeaways.
- Examples are drawn from real backend domains: orders, payments, inventory, notifications, authentication, e-commerce, food delivery, ride booking, social feeds, file uploads.
- The senior mantra runs through the whole book. For every network dependency ask: can it timeout, fail, become slow, duplicate, return an incorrect response, or partially succeed?
