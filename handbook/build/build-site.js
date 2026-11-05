/* Builds the reading website (project 1): a warm cream/paper, searchable, per-volume
 * static site from chapters/*.md.
 *
 * Output (all static, GitHub Pages ready):
 *   site/index.html              hub landing page (all 10 volumes + search)
 *   site/vol-N-<slug>.html       one page per volume, full sidebar across the whole book
 *   site/assets/mermaid.min.js   local copy (rendered in the browser)
 *   site/assets/site.css         the theme
 *   site/assets/site.js          sidebar toggle, theme toggle, search index
 *   site/search-index.json       title + heading index for client-side search
 *
 * Reuses the markdown->HTML, heading-anchor, code-highlight and mermaid handling
 * approach from build-handbook.js. Mermaid renders client-side, like the existing
 * web volumes do, so no headless Chrome is needed.
 */
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const hljs = require('highlight.js');
const { sanitizeMermaid } = require('./mermaid-sanitize');

const ROOT = path.resolve(__dirname, '..');
const CHAPTERS = path.join(ROOT, 'chapters');
const SITE = path.join(ROOT, 'site');
const ASSETS = path.join(SITE, 'assets');
fs.mkdirSync(ASSETS, { recursive: true });
const TODAY = new Date().toISOString().slice(0, 10);

// ---------- the ten volumes (writing is done up to Vol 8; 7 & 9 come later) ----------
const VOLUMES = [
  { n: 0, slug: 'from-scratch', title: 'From Scratch', parts: [1, 2, 3, 4, 5, 6], blurb: 'Starting from zero: JavaScript and TypeScript, async, how the web works, Linux, Git and your first NestJS backend.' },
  { n: 1, slug: 'foundations', title: 'Foundations', parts: [7, 8, 9, 10], blurb: 'Data structures, algorithms, operating systems, the Node.js runtime and networking. The layer underneath every framework.' },
  { n: 2, slug: 'architecture-and-apis', title: 'Architecture and APIs', parts: [11, 12, 13, 14, 15], blurb: 'Choosing a system shape, clean design and patterns, domain-driven design, and API design people can live with — REST, GraphQL and gRPC.' },
  { n: 3, slug: 'data', title: 'Data', parts: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25], blurb: 'The relational model, SQL, PostgreSQL internals, indexing, transactions, ORMs, scaling, migrations, compatibility and NoSQL modelling.' },
  { n: 4, slug: 'distributed-systems', title: 'Distributed Systems', parts: [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38], blurb: 'Caching, messaging, distributed systems and transactions, reliability, concurrency, storage, search, real-time, jobs, LLM backends, RAG and data engineering.' },
  { n: 5, slug: 'production-engineering', title: 'Production Engineering', parts: [39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51], blurb: 'Security, testing, performance, observability, containers, Kubernetes, cloud, CI/CD, Git, SRE, disaster recovery, cost and infrastructure as code.' },
  { n: 6, slug: 'mastery', title: 'Mastery', parts: [52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66], blurb: 'System designs, capacity estimation, debugging, the senior mindset, levels, interviews, projects, patterns, decisions, the roadmap, low-level design and the interview playbook.' },
  { n: 7, slug: 'frontend-and-full-stack', title: 'Frontend and Full Stack', parts: [67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77], blurb: 'How the browser builds a page, frontend tooling, React and Next.js, client data fetching, frontend-backend contracts, browser auth and security, web performance, testing, shipping frontends, and one feature built end to end.' },
  { n: 8, slug: 'principal-and-architect', title: 'Principal and Architect', parts: [78, 79, 80, 81, 82, 83, 84, 85], blurb: 'Writing as an architect, technical strategy, governance, large migrations, org design, influence, growing engineers, and enterprise multi-tenant SaaS.' },
];

// ---------- load chapters ----------
const files = fs.readdirSync(CHAPTERS).filter(f => /^part-\d{2}-\d{2}-.*\.md$/.test(f)).sort();
if (!files.length) { console.error('No chapter files found'); process.exit(1); }
const chapters = files.map(f => ({
  file: f, part: Number(f.slice(5, 7)),
  text: fs.readFileSync(path.join(CHAPTERS, f), 'utf8').replace(/\r\n/g, '\n').trim(),
}));

// ---------- helpers (same approach as build-handbook.js) ----------
function slugify(s) {
  return s.toLowerCase().replace(/[`*_~]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function collectHeadings(body) {
  const out = []; let inFence = false;
  for (const line of body.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].trim() });
  }
  const seen = new Map();
  for (const h of out) {
    const base = slugify(h.text) || 'section';
    const n = seen.get(base) || 0; seen.set(base, n + 1);
    h.id = n ? `${base}-${n}` : base;
  }
  return out;
}
const LANGMAP = { ts: 'typescript', js: 'javascript', sh: 'bash', yml: 'yaml', dockerfile: 'dockerfile', psql: 'sql', pgsql: 'sql', text: 'plaintext', txt: 'plaintext', http: 'http', json: 'json' };

// "Parts 5–8, 61" from [5,6,7,8,61] — collapses consecutive runs into ranges
function rangeLabel(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const runs = []; let start = s[0], prev = s[0];
  for (let i = 1; i <= s.length; i++) {
    if (i < s.length && s[i] === prev + 1) { prev = s[i]; continue; }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = prev = s[i];
  }
  return (runs.length === 1 && !runs[0].includes('–') ? 'Part ' : 'Parts ') + runs.join(', ');
}

function renderBody(md, headings) {
  let cursor = 0; const extra = new Map();
  const renderer = new marked.Renderer();
  renderer.heading = function (text, level) {
    let id;
    const plain = text.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    if (level <= 3) {
      const h = headings[cursor];
      if (h && h.level === level && slugify(h.text) === slugify(plain)) { id = h.id; cursor++; }
      else {
        const idx = headings.findIndex((x, i) => i >= cursor && x.level === level && slugify(x.text) === slugify(plain));
        if (idx >= 0) { id = headings[idx].id; cursor = idx + 1; }
      }
    }
    if (!id) { const b = slugify(plain) || 'section'; const n = (extra.get(b) || 0) + 1; extra.set(b, n); id = n > 1 ? `${b}-x${n}` : `${b}-x`; }
    return `<h${level} id="${id}"${level === 1 ? ' class="part-title"' : ''}>${text}</h${level}>\n`;
  };
  renderer.code = function (code, infostring) {
    const lang = (infostring || '').trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') return `<pre class="mermaid">${escapeHtml(sanitizeMermaid(code))}</pre>\n`;
    const l = LANGMAP[lang] || lang;
    let html;
    if (l && hljs.getLanguage(l)) { try { html = hljs.highlight(code, { language: l, ignoreIllegals: true }).value; } catch { html = escapeHtml(code); } }
    else html = escapeHtml(code);
    return `<pre class="code"><code class="hljs language-${escapeHtml(l || 'text')}">${html}</code></pre>\n`;
  };
  renderer.table = (header, body) => `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`;
  marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false });
  return marked.parse(md, { renderer });
}

// ---------- group chapters into parts, then parts into volumes ----------
const partTitle = {};
const partsMap = {}; // part number -> { num, title, md }
for (const c of chapters) {
  (partsMap[c.part] ||= { num: c.part, md: [] }).md.push(c.text);
}
for (const p of Object.values(partsMap)) {
  p.md = p.md.join('\n\n');
  const m = /^#\s+Part\s+\d+\s+[—-]\s+(.+)$/m.exec(p.md) || /^#\s+(.+)$/m.exec(p.md);
  p.title = m ? m[1].trim() : `Part ${p.num}`;
  partTitle[p.num] = p.title;
}

// ---------- shared shell ----------
function sidebar(activeVol) {
  const vols = VOLUMES.map(v => {
    const open = v.n === activeVol ? ' open' : '';
    const links = v.parts.filter(pn => partsMap[pn]).map(pn =>
      `<li><a href="vol-${v.n}-${v.slug}.html#part-${pn}">${pn}. ${escapeHtml(partTitle[pn])}</a></li>`).join('');
    return `<details class="nav-vol"${open}><summary>Vol ${v.n} — ${escapeHtml(v.title)}</summary><ul>${links}</ul></details>`;
  }).join('');
  return `<aside class="sidebar" id="sidebar">
    <a class="brand" href="index.html">The Backend Engineering Handbook</a>
    <div class="vol-sub">A single place to read about everything in development</div>
    <input id="q" type="search" placeholder="Search all parts…" autocomplete="off">
    <div id="results" class="results"></div>
    <nav id="nav">${vols}</nav>
  </aside>`;
}

function page({ title, activeVol, main }) {
  const isVol = activeVol >= 0;
  // desktop floating controls (top-right of the reading column)
  const controls = `<div class="controls">${isVol ? '<a class="ctl" href="index.html" title="Back to all volumes">← All volumes</a>' : ''}<button class="ctl" id="theme" title="Toggle light / dark">◑ Theme</button></div>`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="assets/site.css">
</head><body>
<div class="topbar"><button id="menu" aria-label="Menu">☰</button><span class="tbrand">Backend Handbook</span>${isVol ? '<a class="tb-back" href="index.html" title="Back to all volumes">←</a>' : ''}<button id="theme-m" class="tb-theme" aria-label="Theme">◑</button></div>
<div class="layout">${sidebar(activeVol)}<main>${controls}${main}</main></div>
<button id="to-top" class="to-top" title="Back to top" aria-label="Back to top">↑ Top</button>
<script src="assets/mermaid.min.js"></script>
<script src="assets/site.js"></script>
</body></html>`;
}

// ---------- hub ----------
const hubCards = VOLUMES.map(v => {
  const partsList = v.parts.filter(pn => partsMap[pn]);
  return `<a class="card" href="vol-${v.n}-${v.slug}.html">
    <div class="card-vol">Volume ${v.n}</div>
    <div class="card-title">${escapeHtml(v.title)}</div>
    <div class="card-blurb">${escapeHtml(v.blurb)}</div>
    <div class="card-meta">${partsList.length} parts · ${rangeLabel(partsList)}</div>
  </a>`;
}).join('');
const totalParts = Object.keys(partsMap).length;
const hubMain = `<div class="hub">
  <h1 class="hub-h1">The Backend Engineering Handbook</h1>
  <p class="hub-lead">From your first line of code to principal engineer and architect. One place to read about everything in backend and full-stack development — ${totalParts} parts, written in plain language with diagrams, real code and production war stories.</p>
  <div class="cards">${hubCards}</div>
  <p class="hub-foot">Edition ${TODAY}. Tip: press <kbd>/</kbd> to search.</p>
</div>`;
fs.writeFileSync(path.join(SITE, 'index.html'), page({ title: 'The Backend Engineering Handbook', activeVol: -1, main: hubMain }));

// ---------- per-volume pages + search index ----------
const searchIndex = [];
for (const v of VOLUMES) {
  const partNums = v.parts.filter(pn => partsMap[pn]);
  if (!partNums.length) continue;
  let bodyHtml = `<div class="vol-head"><div class="vol-kicker">Volume ${v.n}</div><h1 class="vol-h1">${escapeHtml(v.title)}</h1><p class="vol-blurb">${escapeHtml(v.blurb)}</p></div>`;
  for (const pn of partNums) {
    const p = partsMap[pn];
    const headings = collectHeadings(p.md);
    const html = renderBody(p.md, headings);
    // anchor each part with a stable id; the part title h1 already rendered inside
    bodyHtml += `<section class="part" id="part-${pn}">${html}</section>`;
    // search entries: the part + its h2/h3 headings
    searchIndex.push({ p: pn, t: partTitle[pn], v: v.n, s: v.slug, a: `part-${pn}`, k: 'part' });
    for (const h of headings) {
      if (h.level >= 2) searchIndex.push({ p: pn, t: `${partTitle[pn]} › ${h.text}`, v: v.n, s: v.slug, a: h.id, k: 'section' });
    }
  }
  fs.writeFileSync(path.join(SITE, `vol-${v.n}-${v.slug}.html`), page({ title: `Volume ${v.n} — ${v.title}`, activeVol: v.n, main: bodyHtml }));
  console.log(`Volume ${v.n} ${v.title.padEnd(26)} ${String(partNums.length).padStart(2)} parts`);
}
fs.writeFileSync(path.join(SITE, 'search-index.json'), JSON.stringify(searchIndex));

// ---------- assets ----------
const hljsCss = fs.readFileSync(path.join(__dirname, 'node_modules/highlight.js/styles/github.css'), 'utf8');
fs.copyFileSync(path.join(__dirname, 'node_modules/mermaid/dist/mermaid.min.js'), path.join(ASSETS, 'mermaid.min.js'));

const css = `
/* ---- warm cream / paper theme (default), with a dark toggle ---- */
:root{
  --bg:#faf4e2; --paper:#fffdf6; --fg:#2b2620; --muted:#7a6f5c;
  --accent:#b7791f; --accent-2:#946a00; --heading:#8a6d1a;
  --border:#e4d9b8; --code-bg:#f5eed6; --sidebar:#f5edd4;
  --pre-fg:#2b2620; --card:#fffdf6; --kbd:#efe6c8;
}
:root[data-theme="dark"]{
  --bg:#1b1812; --paper:#221e17; --fg:#ece3cf; --muted:#b4a98f;
  --accent:#e0a93a; --accent-2:#f0c35e; --heading:#e9c66a;
  --border:#3a3324; --code-bg:#15120c; --sidebar:#17140e;
  --pre-fg:#ece3cf; --card:#221e17; --kbd:#3a3324;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);
  font:17px/1.7 Georgia,"Iowan Old Style","Palatino Linotype",Palatino,"Times New Roman",serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4,h5{line-height:1.25;scroll-margin-top:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
h1.part-title{font-size:2rem;margin:3.2rem 0 1rem;padding-top:2rem;border-top:3px solid var(--accent);color:var(--fg)}
section.part:first-child h1.part-title{border-top:0;padding-top:0}
h2{font-size:1.5rem;margin:2.4rem 0 .8rem;padding-bottom:.3rem;border-bottom:1px solid var(--border);color:var(--heading)}
h3{font-size:1.2rem;margin:1.8rem 0 .6rem;color:var(--heading)}
h4{margin:1.5rem 0 .4rem;color:var(--accent-2);text-transform:uppercase;letter-spacing:.05em;font-size:.8rem;font-weight:700}
p,ul,ol{margin:.7rem 0}li{margin:.3rem 0}
blockquote{margin:1rem 0;padding:.6rem 1rem;border-left:4px solid var(--accent);background:var(--paper);border-radius:0 6px 6px 0}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:.9rem 1rem;overflow-x:auto;
  font:13.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:var(--pre-fg)}
pre.code code{background:transparent;padding:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;background:var(--code-bg);padding:.12em .38em;border-radius:4px}
pre.mermaid{background:var(--paper);text-align:center;padding:1rem;overflow-x:auto;border:1px solid var(--border);border-radius:8px}
pre.mermaid svg{max-width:100%;height:auto}
.table-wrap{overflow-x:auto;margin:1.1rem 0}
table{border-collapse:collapse;width:100%;font-size:.92rem;font-family:-apple-system,system-ui,sans-serif}
th,td{border:1px solid var(--border);padding:.5rem .65rem;vertical-align:top;text-align:left}
th{background:var(--paper)}
hr{border:0;border-top:1px solid var(--border);margin:2.2rem 0}
img{max-width:100%}
.hljs{background:transparent!important}
${hljsCss}

/* ---- layout ---- */
.layout{display:grid;grid-template-columns:340px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--sidebar);border-right:1px solid var(--border);
  padding:1.1rem 1rem;font-family:-apple-system,system-ui,sans-serif;font-size:.86rem}
.brand{display:block;font-weight:800;font-size:1.05rem;color:var(--fg);line-height:1.3}
.brand:hover{text-decoration:none}
.vol-sub{color:var(--muted);font-size:.78rem;margin:.2rem 0 .7rem}
#q{width:100%;padding:.5rem .65rem;border:1px solid var(--border);border-radius:7px;background:var(--paper);color:var(--fg);font-size:.9rem}
.results{margin:.4rem 0}
.results a{display:block;padding:.35rem .5rem;border-radius:6px;color:var(--fg);font-size:.82rem;line-height:1.3}
.results a:hover{background:var(--paper);text-decoration:none}
.results .rk{color:var(--muted);font-size:.72rem}
.nav-vol{margin:.15rem 0}
.nav-vol summary{cursor:pointer;font-weight:700;padding:.4rem 0;list-style:none;color:var(--fg)}
.nav-vol summary::-webkit-details-marker{display:none}
.nav-vol summary::before{content:"\\25B8";display:inline-block;width:1.1em;color:var(--accent)}
.nav-vol[open] summary::before{content:"\\25BE"}
.nav-vol ul{list-style:none;margin:.1rem 0 .5rem .6rem;padding:0;border-left:1px solid var(--border)}
.nav-vol li{margin:0}
.nav-vol li a{display:block;color:var(--fg);opacity:.82;padding:.22rem .5rem;line-height:1.35}
.nav-vol li a:hover{opacity:1;text-decoration:none;color:var(--accent)}
main{padding:2.4rem 3.4rem 7rem;max-width:860px;position:relative}
.topbar{display:none}

/* ---- desktop controls (back + theme), top-right of reading column ---- */
.controls{display:flex;gap:.5rem;position:fixed;top:.8rem;right:1.4rem;z-index:10}
.controls .ctl{box-shadow:0 2px 8px rgba(120,90,20,.12)}
.to-top{position:fixed;right:1.4rem;bottom:1.4rem;z-index:25;font-family:-apple-system,system-ui,sans-serif;font-size:.85rem;
  padding:.5rem .85rem;border:1px solid var(--border);border-radius:999px;background:var(--paper);color:var(--fg);cursor:pointer;
  box-shadow:0 4px 14px rgba(120,90,20,.18);opacity:0;visibility:hidden;transition:opacity .2s,visibility .2s}
.to-top.show{opacity:1;visibility:visible}
.to-top:hover{border-color:var(--accent);color:var(--accent)}
.ctl{display:inline-flex;align-items:center;gap:.3rem;font-family:-apple-system,system-ui,sans-serif;font-size:.82rem;
  padding:.35rem .7rem;border:1px solid var(--border);border-radius:7px;background:var(--paper);color:var(--fg);cursor:pointer}
.ctl:hover{text-decoration:none;border-color:var(--accent);color:var(--accent)}

/* ---- hub ---- */
.hub-h1{font-size:2.4rem;margin:.5rem 0 .4rem}
.hub-lead{font-size:1.15rem;color:var(--muted);max-width:40em;margin:0 0 2rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1rem}
.card{display:block;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.1rem 1.2rem;color:var(--fg);transition:transform .1s,box-shadow .1s}
.card:hover{text-decoration:none;transform:translateY(-2px);box-shadow:0 6px 18px rgba(120,90,20,.12);border-color:var(--accent)}
.card-vol{color:var(--accent);font-weight:700;font-size:.78rem;letter-spacing:.06em;text-transform:uppercase;font-family:-apple-system,system-ui,sans-serif}
.card-title{font-size:1.25rem;font-weight:700;margin:.2rem 0 .4rem;font-family:-apple-system,system-ui,sans-serif}
.card-blurb{color:var(--muted);font-size:.92rem;line-height:1.5}
.card-meta{margin-top:.6rem;color:var(--accent-2);font-size:.8rem;font-family:-apple-system,system-ui,sans-serif}
.hub-foot{margin-top:2.5rem;color:var(--muted);font-size:.85rem}
kbd{background:var(--kbd);border:1px solid var(--border);border-radius:4px;padding:.05em .4em;font-size:.85em;font-family:ui-monospace,monospace}
.vol-head{margin-bottom:1rem}
.vol-kicker{color:var(--accent);font-weight:700;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;font-family:-apple-system,system-ui,sans-serif}
.vol-h1{font-size:2.2rem;margin:.2rem 0 .4rem}
.vol-blurb{color:var(--muted);font-size:1.05rem;max-width:40em}

/* ---- mobile ---- */
@media (max-width:980px){
  .layout{grid-template-columns:1fr}
  .sidebar{position:fixed;left:0;top:0;width:86%;max-width:360px;transform:translateX(-100%);transition:transform .2s;z-index:30}
  .sidebar.open{transform:none}
  .topbar{display:flex;gap:.7rem;align-items:center;position:sticky;top:0;background:var(--paper);border-bottom:1px solid var(--border);padding:.6rem 1rem;z-index:20}
  .topbar button{padding:.35rem .7rem;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--fg);font-size:1rem}
  .tbrand{font-weight:700;font-family:-apple-system,system-ui,sans-serif}
  .tb-back{margin-left:auto;font-size:1.2rem;color:var(--fg);text-decoration:none;padding:.2rem .5rem}
  .tb-theme{margin-left:.3rem}
  main{padding:1.2rem 1.1rem 4rem}
  .controls{display:none}
}
.tb-back,.tb-theme{display:none}
@media (max-width:980px){.tb-back,.tb-theme{display:inline-flex}}
`;
fs.writeFileSync(path.join(ASSETS, 'site.css'), css);

const js = `
// theme toggle (default is the cream light theme; remember choice)
(function(){
  try{var t=localStorage.getItem('bh-theme'); if(t) document.documentElement.setAttribute('data-theme',t);}catch(e){}
  function flip(){var cur=document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark';
    document.documentElement.setAttribute('data-theme',cur); try{localStorage.setItem('bh-theme',cur);}catch(e){}}
  document.addEventListener('click',function(e){var id=e.target&&e.target.id;
    if(id==='theme'||id==='theme-m')flip();
    if(id==='menu')document.getElementById('sidebar').classList.toggle('open');
    if(id==='to-top')window.scrollTo({top:0,behavior:'smooth'});});
  // show the back-to-top button once the reader is a screen down
  var top=document.getElementById('to-top');
  if(top){var onScroll=function(){top.classList.toggle('show',window.scrollY>600);};
    window.addEventListener('scroll',onScroll,{passive:true});onScroll();}
})();
// mermaid, theme-aware
(function(){ if(!window.mermaid) return;
  var dark=document.documentElement.getAttribute('data-theme')==='dark';
  mermaid.initialize({startOnLoad:true, theme: dark?'dark':'neutral', securityLevel:'loose'});
})();
// search across all parts and headings
(function(){
  var q=document.getElementById('q'), box=document.getElementById('results'), nav=document.getElementById('nav');
  if(!q) return; var idx=null;
  document.addEventListener('keydown',function(e){if(e.key==='/'&&document.activeElement!==q){e.preventDefault();q.focus();}});
  function load(cb){ if(idx){cb();return;} fetch('search-index.json').then(function(r){return r.json();}).then(function(d){idx=d;cb();}).catch(function(){idx=[];cb();}); }
  function run(){
    var term=q.value.trim().toLowerCase();
    if(!term){box.innerHTML='';nav.style.display='';return;}
    load(function(){
      nav.style.display='none';
      var hits=[]; for(var i=0;i<idx.length&&hits.length<40;i++){ if(idx[i].t.toLowerCase().indexOf(term)>=0) hits.push(idx[i]); }
      if(!hits.length){box.innerHTML='<div class="rk" style="padding:.4rem .5rem">No matches</div>';return;}
      box.innerHTML=hits.map(function(h){return '<a href="vol-'+h.v+'-'+h.s+'.html#'+h.a+'"><span class="rk">Part '+h.p+(h.k==='part'?' · part':' · section')+'</span><br>'+h.t.replace(/</g,'&lt;')+'</a>';}).join('');
    });
  }
  q.addEventListener('input',run);
})();
`;
fs.writeFileSync(path.join(ASSETS, 'site.js'), js);

console.log(`\\nSite built to ${SITE}`);
console.log(`Hub + ${VOLUMES.filter(v => v.parts.some(p => partsMap[p])).length} volume pages, ${searchIndex.length} search entries.`);
