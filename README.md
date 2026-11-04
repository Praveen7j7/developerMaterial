# Developer Material — The Backend Engineering Handbook

A single place to read about everything in backend and full-stack development:
from your first line of code to principal engineer and architect. Plain language,
diagrams, real code and production war stories.

## Read it

The site is published with GitHub Pages from the `docs/` folder.
Once Pages is enabled (Settings → Pages → Branch: `main`, Folder: `/docs`):

**https://praveen7j7.github.io/developerMaterial/**

Open `docs/index.html` locally to read it without hosting.

## What's inside

| Volume | Title | Parts |
|---|---|---|
| 0 | From Scratch | 69–74 |
| 1 | Foundations | 1–4 |
| 2 | Architecture and APIs | 5–8, 61 |
| 3 | Data | 9–15, 31, 32, 62 |
| 4 | Distributed Systems | 16–21, 33–36, 59, 60, 63 |
| 5 | Production Engineering | 22–30, 37–39, 64 |
| 6 | Mastery | 40–50, 65–68 |
| 8 | Principal and Architect | 51–58 |

74 parts in all. Volumes 7 (Frontend and Full Stack) and 9 (Specialist Depth) are planned.

## Repo layout

- `docs/` — the generated static website (what GitHub Pages serves). Do not edit by hand.
- `handbook/chapters/` — the Markdown source, one file per chunk of a part (`part-NN-SS-slug.md`).
- `handbook/_spec/` — the writing contracts and outlines.
- `handbook/build/` — the build scripts.

## Rebuild the site after editing chapters

```bash
cd handbook/build
npm install
node build-site.js   # regenerates ../../docs
```
