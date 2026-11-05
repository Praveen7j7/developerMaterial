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

The finished handbook is over 1.5 million words. A single HTML page exceeds what can be published, and a single PDF runs to thousands of pages. The six volumes follow the learning roadmap in Part 62, so each one is a coherent stage of the journey rather than an arbitrary slice:

| Volume | Parts | Covers |
|---|---|---|
| 1 Foundations | 1–4 | Data structures, algorithms, operating systems, the Node.js runtime, networking |
| 2 Architecture and APIs | 5–8 | Architecture styles, clean design and patterns, domain-driven design, API design |
| 3 Data | 9–15, 31, 32 | Relational model, SQL, PostgreSQL internals, indexing, transactions, ORMs, scaling, migrations, compatibility |
| 4 Distributed Systems | 16–21, 33–36 | Caching, messaging, distributed systems and transactions, reliability, concurrency, storage, search, real-time, jobs |
| 5 Production Engineering | 22–30, 37–39 | Security, testing, performance, observability, Docker, Kubernetes, cloud, CI/CD, Git, SRE, disaster recovery, cost |
| 6 Mastery | 40–50 | Fifteen system designs, capacity estimation, debugging, mindset, levels, interviews, projects, patterns, decisions, roadmap |

The complete single-file Markdown and the complete PDF are still produced for anyone who wants to search the whole book at once.

## Conventions that hold across the book

- Every major concept follows one teaching template: Concept, Why it exists, Mental model, How it works, Practical example, NestJS example, PostgreSQL example, TypeORM and Sequelize examples where they apply, Production scenario, Failure scenario, Edge cases and failure modes, How a senior engineer thinks about it, Common mistakes, Interview questions, Practical exercise.
- Every Part ends with a Senior Checklist and Key Takeaways.
- Examples are drawn from real backend domains: orders, payments, inventory, notifications, authentication, e-commerce, food delivery, ride booking, social feeds, file uploads.
- The senior mantra runs through the whole book. For every network dependency ask: can it timeout, fail, become slow, duplicate, return an incorrect response, or partially succeed?
