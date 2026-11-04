/* Assembles chapters/*.md into:
 *   dist/senior-backend-engineering-handbook.md      (single Markdown book with TOC)
 *   dist/handbook.html                               (full web version, may exceed artifact limits)
 *   dist/handbook-print.html                         (full print version, source for the complete PDF)
 *   dist/volumes/vol-N-<slug>.html                   (web version per volume, artifact-sized)
 *   dist/volumes/vol-N-<slug>-print.html             (print version per volume, source for volume PDFs)
 *   dist/volumes/index.html                          (hub page linking the volumes)
 *   dist/mermaid-blocks.json                         (all diagrams, for validation)
 *
 * The book is ~1.5M words, so a single HTML page is too large to publish and a
 * single PDF is unwieldy to read. Volumes follow the learning roadmap, so each
 * one is a coherent stage rather than an arbitrary slice.
 */
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const hljs = require('highlight.js');
const { sanitizeMermaid } = require('./mermaid-sanitize');

const ROOT = path.resolve(__dirname, '..');
const CHAPTERS = path.join(ROOT, 'chapters');
const DIST = path.join(ROOT, 'dist');
const VOLDIR = path.join(DIST, 'volumes');
fs.mkdirSync(VOLDIR, { recursive: true });

const TODAY = new Date().toISOString().slice(0, 10);

// ---------- volume definition (follows the Part 50 roadmap) ----------
const VOLUMES = [
  { n: 1, slug: 'foundations', title: 'Foundations', parts: [1, 2, 3, 4], blurb: 'Data structures, algorithms, operating systems, the Node.js runtime and networking. The layer underneath every framework.' },
  { n: 2, slug: 'architecture-and-apis', title: 'Architecture and APIs', parts: [5, 6, 7, 8], blurb: 'Choosing a system shape, clean design and patterns, domain-driven design, and API design people can live with.' },
  { n: 3, slug: 'data', title: 'Data', parts: [9, 10, 11, 12, 13, 14, 15, 31, 32], blurb: 'The relational model, SQL, PostgreSQL internals, indexing, transactions, ORMs, scaling, migrations and backward compatibility.' },
  { n: 4, slug: 'distributed-systems', title: 'Distributed Systems', parts: [16, 17, 18, 19, 20, 21, 33, 34, 35, 36], blurb: 'Caching, messaging, distributed systems and transactions, reliability, concurrency, storage, search, real-time and background jobs.' },
  { n: 5, slug: 'production-engineering', title: 'Production Engineering', parts: [22, 23, 24, 25, 26, 27, 28, 29, 30, 37, 38, 39], blurb: 'Security, testing, performance, observability, containers, Kubernetes, cloud, CI/CD, Git, SRE, disaster recovery and cost.' },
  { n: 6, slug: 'mastery', title: 'Mastery', parts: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50], blurb: 'Fifteen system designs, capacity estimation, production debugging, the senior mindset, levels, interviews, projects, patterns, decisions and the roadmap.' },
];

// ---------- load chapters ----------
const files = fs.readdirSync(CHAPTERS).filter(f => /^part-\d{2}-\d{2}-.*\.md$/.test(f)).sort();
if (!files.length) { console.error('No chapter files found'); process.exit(1); }
const chapters = files.map(f => ({
  file: f,
  part: Number(f.slice(5, 7)),
  text: fs.readFileSync(path.join(CHAPTERS, f), 'utf8').replace(/\r\n/g, '\n').trim(),
}));

// ---------- shared helpers ----------
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

/* Renders markdown to HTML, resolving heading anchors against `headings`. */
function renderBody(md, headings, mermaidSink) {
  let cursor = 0;
  const extra = new Map();
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
    if (lang === 'mermaid') {
      const clean = sanitizeMermaid(code);
      if (mermaidSink) mermaidSink.push(clean);
      return `<pre class="mermaid">${escapeHtml(clean)}</pre>\n`;
    }
    const l = LANGMAP[lang] || lang;
    let html;
    if (l && hljs.getLanguage(l)) { try { html = hljs.highlight(code, { language: l, ignoreIllegals: true }).value; } catch { html = escapeHtml(code); } }
    else html = escapeHtml(code);
    return `<pre class="code"><code class="hljs language-${escapeHtml(l || 'text')}">${html}</code></pre>\n`;
  };
  renderer.table = function (header, body) {
    return `<div class="table-wrap"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`;
  };
  marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false });
  return marked.parse(md, { renderer });
}

// ---------- CSS ----------
const hljsLight = fs.readFileSync(path.join(__dirname, 'node_modules/highlight.js/styles/github.css'), 'utf8');
const hljsDark = fs.readFileSync(path.join(__dirname, 'node_modules/highlight.js/styles/github-dark.css'), 'utf8');

const baseCss = `
:root{--bg:#f7f7f5;--fg:#1f2328;--muted:#59636e;--accent:#0b5fff;--accent-2:#0a7f5a;--panel:#ffffff;--border:#d9dde3;--code-bg:#f2f4f7;--sidebar:#f0f1f3;--pre-fg:#1f2328}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0f1115;--fg:#e6e9ef;--muted:#9aa4b2;--accent:#6ea8ff;--accent-2:#3ecf8e;--panel:#161a22;--border:#2a3140;--code-bg:#11151c;--sidebar:#12161d;--pre-fg:#e6e9ef}}
:root[data-theme="dark"]{--bg:#0f1115;--fg:#e6e9ef;--muted:#9aa4b2;--accent:#6ea8ff;--accent-2:#3ecf8e;--panel:#161a22;--border:#2a3140;--code-bg:#11151c;--sidebar:#12161d;--pre-fg:#e6e9ef}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1,h2,h3,h4,h5{line-height:1.25;scroll-margin-top:12px}
h1.part-title{font-size:2rem;margin:3rem 0 1rem;padding-top:2rem;border-top:3px solid var(--accent)}
main>h1.part-title:first-child{border-top:0;padding-top:0;margin-top:0}
h2{font-size:1.5rem;margin:2.2rem 0 .8rem;padding-bottom:.3rem;border-bottom:1px solid var(--border)}
h3{font-size:1.2rem;margin:1.8rem 0 .6rem}
h4{margin:1.4rem 0 .4rem;color:var(--accent-2);text-transform:uppercase;letter-spacing:.04em;font-size:.82rem}
p,ul,ol{margin:.6rem 0}li{margin:.25rem 0}
blockquote{margin:1rem 0;padding:.6rem 1rem;border-left:4px solid var(--accent);background:var(--panel)}
pre{background:var(--code-bg);border:1px solid var(--border);border-radius:8px;padding:.9rem 1rem;overflow-x:auto;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:var(--pre-fg)}
pre.code code{background:transparent;padding:0}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;background:var(--code-bg);padding:.1em .35em;border-radius:4px}
pre.mermaid{background:var(--panel);text-align:center;padding:1rem;overflow-x:auto}
pre.mermaid svg{max-width:100%;height:auto}
.table-wrap{overflow-x:auto;margin:1rem 0}
table{border-collapse:collapse;width:100%;font-size:.92rem}
th,td{border:1px solid var(--border);padding:.45rem .6rem;vertical-align:top;text-align:left}
th{background:var(--panel)}
hr{border:0;border-top:1px solid var(--border);margin:2rem 0}
img{max-width:100%}
.hljs{background:transparent!important}
`;

const webCss = baseCss + `
.layout{display:grid;grid-template-columns:330px minmax(0,1fr);min-height:100vh}
.sidebar{position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--sidebar);border-right:1px solid var(--border);padding:1rem;font-size:.86rem}
.sidebar .brand{font-weight:700;font-size:1rem;margin-bottom:.15rem}
.sidebar .vol{color:var(--muted);font-size:.8rem;margin-bottom:.5rem}
.sidebar input{width:100%;padding:.45rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--fg);margin:.4rem 0 .8rem}
.nav-part summary{cursor:pointer;font-weight:600;padding:.3rem 0;list-style:none}
.nav-part summary::-webkit-details-marker{display:none}
.nav-part summary::before{content:"\\25B8";display:inline-block;width:1em;color:var(--muted)}
.nav-part[open] summary::before{content:"\\25BE"}
.nav-part ul{list-style:none;margin:0 0 .4rem 1em;padding:0}
.nav-part li{margin:.15rem 0;line-height:1.35}
.nav-part li a{color:var(--fg);opacity:.85}
.nav-part li a:hover{opacity:1}
.nav-part.hidden,.nav-part li.hidden{display:none}
.otherv{margin-top:1rem;padding-top:.7rem;border-top:1px solid var(--border);font-size:.82rem}
.otherv a{display:block;margin:.25rem 0}
main{padding:2rem 3rem 6rem;max-width:1080px}
.topbar{display:none}
@media (max-width:980px){.layout{grid-template-columns:1fr}.sidebar{position:fixed;left:0;top:0;width:85%;max-width:360px;transform:translateX(-100%);transition:transform .2s;z-index:20}.sidebar.open{transform:none}.topbar{display:flex;gap:.6rem;align-items:center;position:sticky;top:0;background:var(--panel);border-bottom:1px solid var(--border);padding:.6rem 1rem;z-index:10}.topbar button{padding:.35rem .7rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)}main{padding:1rem 1rem 4rem}}
.hljs-dark{display:none}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .hljs-light{display:none}:root:not([data-theme="light"]) .hljs-dark{display:block}}
:root[data-theme="dark"] .hljs-light{display:none}:root[data-theme="dark"] .hljs-dark{display:block}
`;

const printCss = baseCss + `
:root{--bg:#ffffff;--fg:#111;--panel:#f6f7f9;--code-bg:#f3f4f6;--border:#cfd4da;--accent:#0b3fa0;--accent-2:#0a6b4f;--pre-fg:#111}
body{font-size:11.5pt;line-height:1.5;background:#fff}
main{max-width:100%;padding:0}
h1.part-title{page-break-before:always;break-before:page;border-top:0;padding-top:0;margin-top:0;font-size:26pt}
h2{font-size:17pt;page-break-after:avoid}h3{font-size:13.5pt;page-break-after:avoid}h4{page-break-after:avoid}
pre{white-space:pre-wrap;word-break:break-word;font-size:9pt;page-break-inside:avoid}
pre.mermaid{page-break-inside:avoid}
pre.mermaid svg{max-width:100%;max-height:8in;height:auto}
table{font-size:9.5pt}tr{page-break-inside:avoid}
.cover{page-break-after:always;break-after:page;display:flex;flex-direction:column;justify-content:center;min-height:9.4in;text-align:center}
.cover h1{font-size:32pt;border:0;margin:0 0 .5rem}
.cover .vol{font-size:15pt;color:#0b3fa0;font-weight:700;letter-spacing:.08em;text-transform:uppercase;margin-bottom:1.2rem}
.cover p{font-size:12.5pt;color:#333;max-width:34em;margin:.4rem auto}
.toc{page-break-after:always;break-after:page;column-count:2;column-gap:1.6rem;font-size:9.5pt}
.toc h2{column-span:all}
.toc ul{list-style:none;padding-left:0;margin:0}.toc li{margin:.13rem 0;break-inside:avoid}
.toc li.l2{padding-left:1.1em;color:#333}
.toc a{color:#111}
@page{size:A4;margin:16mm 14mm 16mm 14mm}
`;

// ---------- page builders ----------
function webPage({ title, brandTitle, volLabel, introHtml, mainHtml, navParts, otherVolumes }) {
  const navHtml = navParts.map((p, i) => `
<details class="nav-part"${i === 0 ? ' open' : ''}>
  <summary><a href="#${p.id}">${escapeHtml(p.text)}</a></summary>
  <ul>${p.children.map(c => `<li><a href="#${c.id}">${escapeHtml(c.text)}</a></li>`).join('')}</ul>
</details>`).join('');
  const other = otherVolumes && otherVolumes.length
    ? `<div class="otherv"><strong>Other volumes</strong>${otherVolumes.map(v => `<a href="${v.href}">Volume ${v.n} — ${escapeHtml(v.title)}</a>`).join('')}</div>` : '';
  return `<title>${escapeHtml(title)}</title>
<style>${webCss}</style>
<style class="hljs-light">${hljsLight}</style>
<style class="hljs-dark">${hljsDark}</style>
<div class="layout">
<aside class="sidebar" id="sidebar">
  <div class="brand">${escapeHtml(brandTitle)}</div>
  ${volLabel ? `<div class="vol">${escapeHtml(volLabel)}</div>` : ''}
  <input id="navsearch" type="search" placeholder="Filter chapters..." aria-label="Filter chapters">
  <details class="nav-part" open><summary><a href="#top">Introduction</a></summary></details>
  ${navHtml}
  ${other}
</aside>
<div>
<div class="topbar"><button id="menu">Menu</button><strong>${escapeHtml(brandTitle)}</strong></div>
<main id="top">
${introHtml}
${mainHtml}
</main>
</div>
</div>
<script>
(function(){
  var s=document.getElementById('navsearch'), sb=document.getElementById('sidebar');
  s.addEventListener('input',function(){
    var q=s.value.trim().toLowerCase();
    document.querySelectorAll('.nav-part').forEach(function(p){
      var sum=p.querySelector('summary').textContent.toLowerCase(), any=false;
      p.querySelectorAll('li').forEach(function(li){
        var ok=!q||li.textContent.toLowerCase().indexOf(q)>=0||sum.indexOf(q)>=0;
        li.classList.toggle('hidden',!ok); if(ok) any=true;
      });
      var show=!q||any||sum.indexOf(q)>=0;
      p.classList.toggle('hidden',!show); if(q&&show) p.open=true;
    });
  });
  var m=document.getElementById('menu');
  if(m){m.addEventListener('click',function(){sb.classList.toggle('open');});
    sb.addEventListener('click',function(e){if(e.target.tagName==='A') sb.classList.remove('open');});}
  function syncNav(){var h=location.hash.slice(1);if(!h)return;var a=sb.querySelector('a[href="#'+CSS.escape(h)+'"]');if(a){var d=a.closest('details');if(d)d.open=true;}}
  window.addEventListener('hashchange',syncNav);syncNav();
})();
</script>`;
}

const mermaidJs = fs.readFileSync(path.join(__dirname, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8');

function printPage({ title, volLabel, subtitle, stats, headings, introHtml, mainHtml }) {
  const toc = `<div class="toc"><h2>Contents</h2><ul>${headings.filter(h => h.level <= 2).map(h => `<li class="l${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`).join('')}</ul></div>`;
  const cover = `<div class="cover">
${volLabel ? `<div class="vol">${escapeHtml(volLabel)}</div>` : ''}
<h1>${escapeHtml(title)}</h1>
<p><strong>From "I can build backend APIs" to "I can architect, build, scale, secure, test, debug, deploy, operate and explain production-grade backend systems."</strong></p>
${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
<p>TypeScript, Node.js, NestJS, TypeORM, Sequelize, PostgreSQL, Redis, Kafka, Docker, Kubernetes, AWS, CI/CD, Observability, SRE, System Design</p>
<p>${escapeHtml(stats)} Edition ${TODAY}.</p></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${printCss}</style><style>${hljsLight}</style></head><body>
${cover}
${toc}
<main>
${introHtml}
${mainHtml}
</main>
<script>${mermaidJs}</script>
<script>
(async function(){
  mermaid.initialize({ startOnLoad:false, theme:'neutral', securityLevel:'loose', flowchart:{ useMaxWidth:true, htmlLabels:true }, sequence:{ useMaxWidth:true }, er:{ useMaxWidth:true } });
  var nodes = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid'));
  var errors = [];
  for (var i=0;i<nodes.length;i++){
    var el = nodes[i], src = el.textContent;
    try { var r = await mermaid.render('m'+i, src);
      var d = document.createElement('div'); d.className='mermaid-rendered'; d.innerHTML = r.svg; el.replaceWith(d);
    } catch(e){ errors.push(String(e && e.message || e).slice(0,200)); el.classList.add('mermaid-error'); }
  }
  document.body.setAttribute('data-mermaid-done','1');
  document.body.setAttribute('data-mermaid-errors', JSON.stringify(errors));
})();
</script>
</body></html>`;
}

function buildNav(headings) {
  const out = []; let cur = null;
  for (const h of headings) {
    if (h.level === 1) { cur = { ...h, children: [] }; out.push(cur); }
    else if (h.level === 2 && cur) cur.children.push(h);
  }
  return out;
}

const FRONT_COMMON = `**From "I can build backend APIs" to "I can architect, build, scale, secure, test, debug, deploy, operate and explain production-grade backend systems."**

Stack focus: TypeScript, Node.js, NestJS, TypeORM, Sequelize, PostgreSQL, Redis, Kafka and RabbitMQ, Docker, Kubernetes, AWS, GitHub Actions, OpenTelemetry with Prometheus and Grafana, and Git.

## How to read this book

- Each Part teaches every major concept with one pattern: **Concept, Why it exists, Mental model, How it works, Practical example, NestJS / PostgreSQL / TypeORM / Sequelize examples, Production scenario, Failure scenario, Edge cases, How a senior thinks, Common mistakes, Interview questions, Exercise.**
- Every Part ends with a **Senior Checklist** and **Key Takeaways**.
- Part 50 holds the knowledge map and a week-by-week learning roadmap. If you are unsure where to start, read Part 50 first.
- The companion slide deck, the Senior Backend Engineering Masterclass, is the visual summary. Each deck section names the Parts it summarises.

## The reference architecture used throughout

\`\`\`mermaid
flowchart TB
    Client["Client: browser, mobile or Postman"] --> GW["API Gateway and Load Balancer"]
    GW --> Nest["NestJS Application on Node.js"]
    Nest --> Redis["Redis: cache, locks, rate limits"]
    Nest --> PG["PostgreSQL: source of truth"]
    Nest --> Broker["Message Broker: Kafka or RabbitMQ"]
    Broker --> Workers["Background Workers on NestJS"]
    Workers --> PG
    Workers --> Redis
\`\`\`

## The senior mantra

For every network dependency ask: *Can it timeout? Can it fail? Can it become slow? Can it duplicate? Can it return an incorrect response? Can it partially succeed?*
`;

// ---------- 1. Full markdown ----------
const fullBody = chapters.map(c => c.text).join('\n\n');
const fullHeadings = collectHeadings(fullBody);
const fullWords = fullBody.split(/\s+/).filter(Boolean).length;
const fullParts = fullHeadings.filter(h => h.level === 1).length;

const roadmapBlock = `## The learning roadmap and the six volumes

\`\`\`text
${VOLUMES.map(v => `Volume ${v.n}  ${v.title.padEnd(24)} Parts ${v.parts[0]}-${v.parts[v.parts.length - 1]}`).join('\n')}
\`\`\`

${VOLUMES.map(v => `- **Volume ${v.n} — ${v.title}** (Parts ${v.parts.join(', ')}). ${v.blurb}`).join('\n')}
`;

const fullFront = `# Senior Backend Engineering Handbook

${FRONT_COMMON}
${roadmapBlock}
Edition ${TODAY}. Approximately ${Math.round(fullWords / 1000)},000 words across ${fullParts} parts.

## Table of contents

`;
const fullToc = fullHeadings.filter(h => h.level <= 2).map(h => `${h.level === 1 ? '' : '  '}- [${h.text}](#${h.id})`).join('\n');
fs.writeFileSync(path.join(DIST, 'senior-backend-engineering-handbook.md'), fullFront + fullToc + '\n\n---\n\n' + fullBody + '\n', 'utf8');
console.log(`Markdown: ${files.length} chapter files, ${fullParts} parts, ~${fullWords.toLocaleString()} words`);

// ---------- 2. Full HTML (web + print) ----------
const allMermaid = [];
{
  const introMd = fullFront.replace(/## Table of contents\n\n$/, '');
  const introHeadings = collectHeadings(introMd);
  const introHtml = renderBody(introMd, introHeadings, allMermaid);
  const mainHtml = renderBody(fullBody, fullHeadings, allMermaid);
  const nav = buildNav(fullHeadings);

  fs.writeFileSync(path.join(DIST, 'handbook.html'), webPage({
    title: 'Senior Backend Engineering Handbook',
    brandTitle: 'Senior Backend Engineering Handbook',
    volLabel: `${fullParts} parts · ~${Math.round(fullWords / 1000)}k words`,
    introHtml, mainHtml, navParts: nav, otherVolumes: [],
  }), 'utf8');

  const printIntro = renderBody(introMd.replace(/^# Senior Backend Engineering Handbook\n/, '# Introduction\n'), collectHeadings(introMd), null);
  fs.writeFileSync(path.join(DIST, 'handbook-print.html'), printPage({
    title: 'Senior Backend Engineering Handbook',
    volLabel: '', subtitle: 'The complete edition, all six volumes',
    stats: `${fullParts} parts, approximately ${Math.round(fullWords / 1000)},000 words.`,
    headings: fullHeadings, introHtml: printIntro, mainHtml,
  }), 'utf8');
}
fs.writeFileSync(path.join(DIST, 'mermaid-blocks.json'), JSON.stringify(allMermaid, null, 1));
console.log(`Full HTML: ${allMermaid.length} mermaid diagrams`);

// ---------- 3. Volumes ----------
const volMeta = [];
for (const v of VOLUMES) {
  const vChaps = chapters.filter(c => v.parts.includes(c.part));
  if (!vChaps.length) { console.log(`Volume ${v.n} (${v.title}): no chapters yet, skipped`); continue; }
  const body = vChaps.map(c => c.text).join('\n\n');
  const headings = collectHeadings(body);
  const words = body.split(/\s+/).filter(Boolean).length;
  const nParts = headings.filter(h => h.level === 1).length;
  const partList = [...new Set(vChaps.map(c => c.part))].sort((a, b) => a - b);

  const front = `# Volume ${v.n} — ${v.title}

*Senior Backend Engineering Handbook, Volume ${v.n} of ${VOLUMES.length}. Parts ${partList.join(', ')}.*

${v.blurb}

${FRONT_COMMON}
Volume ${v.n} contains ${nParts} parts and approximately ${Math.round(words / 1000)},000 words. Edition ${TODAY}.
`;
  const frontHeadings = collectHeadings(front);
  const mermaidSink = [];
  const introHtml = renderBody(front, frontHeadings, mermaidSink);
  const mainHtml = renderBody(body, headings, mermaidSink);

  const others = VOLUMES.filter(o => o.n !== v.n && chapters.some(c => o.parts.includes(c.part)))
    .map(o => ({ n: o.n, title: o.title, href: `vol-${o.n}-${o.slug}.html` }));

  const webFile = path.join(VOLDIR, `vol-${v.n}-${v.slug}.html`);
  fs.writeFileSync(webFile, webPage({
    title: `Volume ${v.n} — ${v.title} · Senior Backend Engineering Handbook`,
    brandTitle: 'Senior Backend Engineering Handbook',
    volLabel: `Volume ${v.n} — ${v.title} · Parts ${partList.join(', ')} · ~${Math.round(words / 1000)}k words`,
    introHtml, mainHtml, navParts: buildNav(headings), otherVolumes: others,
  }), 'utf8');

  const printFile = path.join(VOLDIR, `vol-${v.n}-${v.slug}-print.html`);
  fs.writeFileSync(printFile, printPage({
    title: 'Senior Backend Engineering Handbook',
    volLabel: `Volume ${v.n} — ${v.title}`,
    subtitle: v.blurb,
    stats: `Parts ${partList.join(', ')}. ${nParts} parts, approximately ${Math.round(words / 1000)},000 words.`,
    headings, introHtml, mainHtml,
  }), 'utf8');

  const mdFile = path.join(VOLDIR, `vol-${v.n}-${v.slug}.md`);
  const vToc = headings.filter(h => h.level <= 2).map(h => `${h.level === 1 ? '' : '  '}- [${h.text}](#${h.id})`).join('\n');
  fs.writeFileSync(mdFile, front + '\n## Table of contents\n\n' + vToc + '\n\n---\n\n' + body + '\n', 'utf8');

  volMeta.push({ ...v, parts: partList, nParts, words, mermaid: mermaidSink.length,
    webMB: fs.statSync(webFile).size / 1048576, printMB: fs.statSync(printFile).size / 1048576 });
  console.log(`Volume ${v.n} ${v.title.padEnd(24)} parts ${String(partList.length).padStart(2)}  ~${String(Math.round(words / 1000)).padStart(4)}k words  ${mermaidSink.length.toString().padStart(3)} diagrams  web ${volMeta[volMeta.length - 1].webMB.toFixed(1)}MB  print ${volMeta[volMeta.length - 1].printMB.toFixed(1)}MB`);
}

// ---------- 3b. Chunked print pages ----------
// Chrome's PDF printer silently produces a zero-byte file once a document grows
// past roughly a hundred pages: a whole volume fails, and so does a large Part.
// So the print source is also emitted in word-capped chunks that never approach
// that limit. make-pdf-chunked.js renders these and merges them back together.
// 23k words rendered fine; 48k produced a zero-byte PDF. 18k keeps every chunk
// comfortably inside the range that is known to work.
const CHUNK_WORDS = 18000;
const PARTDIR = path.join(DIST, 'parts');
fs.mkdirSync(PARTDIR, { recursive: true });
const chunkMeta = [];
const partNums = [...new Set(chapters.map(c => c.part))].sort((a, b) => a - b);
for (const pn of partNums) {
  const pChaps = chapters.filter(c => c.part === pn);
  // Group consecutive chapter files until the word cap would be exceeded.
  const groups = [];
  let cur = [], curWords = 0;
  for (const c of pChaps) {
    const w = c.text.split(/\s+/).filter(Boolean).length;
    if (cur.length && curWords + w > CHUNK_WORDS) { groups.push(cur); cur = []; curWords = 0; }
    cur.push(c); curWords += w;
  }
  if (cur.length) groups.push(cur);

  groups.forEach((g, gi) => {
    const body = g.map(c => c.text).join('\n\n');
    const headings = collectHeadings(body);
    const h1 = headings.find(h => h.level === 1);
    const words = body.split(/\s+/).filter(Boolean).length;
    const sink = [];
    const mainHtml = renderBody(body, headings, sink);
    const title = h1 ? h1.text : `Part ${pn}` + (groups.length > 1 ? ` (${gi + 1}/${groups.length})` : '');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>${printCss}
h1.part-title{page-break-before:auto;break-before:auto}
</style><style>${hljsLight}</style></head><body>
<main>${mainHtml}</main>
<script>${mermaidJs}</script>
<script>
(async function(){
  mermaid.initialize({ startOnLoad:false, theme:'neutral', securityLevel:'loose', flowchart:{ useMaxWidth:true, htmlLabels:true }, sequence:{ useMaxWidth:true }, er:{ useMaxWidth:true } });
  var nodes = Array.prototype.slice.call(document.querySelectorAll('pre.mermaid')), errors = [];
  for (var i=0;i<nodes.length;i++){ var el=nodes[i];
    try { var r = await mermaid.render('m'+i, el.textContent);
      var d = document.createElement('div'); d.innerHTML = r.svg; el.replaceWith(d);
    } catch(e){ errors.push(String(e && e.message || e).slice(0,160)); el.classList.add('mermaid-error'); } }
  document.body.setAttribute('data-mermaid-done','1');
  document.body.setAttribute('data-mermaid-errors', JSON.stringify(errors));
})();
</script></body></html>`;
    const name = `part-${String(pn).padStart(2, '0')}-c${String(gi + 1).padStart(2, '0')}-print.html`;
    fs.writeFileSync(path.join(PARTDIR, name), html, 'utf8');
    const vol = VOLUMES.find(v => v.parts.includes(pn));
    chunkMeta.push({ part: pn, chunk: gi + 1, of: groups.length, title, words, diagrams: sink.length,
      volume: vol ? vol.n : null, file: name, files: g.map(c => c.file) });
  });
}
fs.writeFileSync(path.join(PARTDIR, 'parts.json'), JSON.stringify({
  chunkWords: CHUNK_WORDS,
  volumes: VOLUMES.map(v => ({ n: v.n, slug: v.slug, title: v.title, blurb: v.blurb })),
  parts: chunkMeta,
}, null, 1));
console.log(`Chunked print pages: ${chunkMeta.length} chunks across ${partNums.length} parts (largest ${Math.max(...chunkMeta.map(c => c.words)).toLocaleString()} words, ${Math.max(...chunkMeta.map(c => c.diagrams))} diagrams)`);

// ---------- 4. Volume index page ----------
const indexHtml = `<title>Senior Backend Engineering Handbook</title>
<style>${baseCss}
body{display:flex;justify-content:center}
main{max-width:900px;padding:3rem 1.5rem 5rem}
.hero{border-bottom:3px solid var(--accent);padding-bottom:1.2rem;margin-bottom:1.5rem}
.hero h1{font-size:2.3rem;margin:0 0 .5rem}
.lede{font-size:1.1rem;color:var(--muted)}
.vols{display:grid;gap:1rem;margin:1.5rem 0}
.vol{display:block;border:1px solid var(--border);border-radius:10px;padding:1.1rem 1.3rem;background:var(--panel);color:var(--fg)}
.vol:hover{border-color:var(--accent);text-decoration:none}
.vol h2{margin:0 0 .3rem;font-size:1.25rem;border:0;padding:0;color:var(--accent)}
.vol .meta{font-size:.85rem;color:var(--muted);margin-bottom:.4rem}
.vol p{margin:0}
.stats{display:flex;gap:2rem;flex-wrap:wrap;margin:1.5rem 0;padding:1rem;background:var(--panel);border:1px solid var(--border);border-radius:10px}
.stat b{display:block;font-size:1.5rem;color:var(--accent)}
.stat span{font-size:.85rem;color:var(--muted)}
</style>
<main>
<div class="hero">
<h1>Senior Backend Engineering Handbook</h1>
<p class="lede">From "I can build backend APIs" to "I can architect, build, scale, secure, test, debug, deploy, operate and explain production-grade backend systems."</p>
</div>
<p>TypeScript · Node.js · NestJS · TypeORM · Sequelize · PostgreSQL · Redis · Kafka · Docker · Kubernetes · AWS · CI/CD · Observability · SRE · System Design</p>
<div class="stats">
<div class="stat"><b>${fullParts}</b><span>parts</span></div>
<div class="stat"><b>${Math.round(fullWords / 1000)}k</b><span>words</span></div>
<div class="stat"><b>${allMermaid.length}</b><span>diagrams</span></div>
<div class="stat"><b>${VOLUMES.length}</b><span>volumes</span></div>
</div>
<h2>The volumes</h2>
<p>The six volumes follow the learning roadmap in Part 50. Read them in order, or jump to the one that matches the problem in front of you.</p>
<div class="vols">
${volMeta.map(v => `<a class="vol" href="vol-${v.n}-${v.slug}.html">
<h2>Volume ${v.n} — ${escapeHtml(v.title)}</h2>
<div class="meta">Parts ${v.parts.join(', ')} · ${v.nParts} parts · ~${Math.round(v.words / 1000)}k words · ${v.mermaid} diagrams</div>
<p>${escapeHtml(v.blurb)}</p></a>`).join('\n')}
</div>
<h2>The senior mantra</h2>
<p>For every network dependency ask: <em>Can it timeout? Can it fail? Can it become slow? Can it duplicate? Can it return an incorrect response? Can it partially succeed?</em></p>
<p style="color:var(--muted);font-size:.9rem;margin-top:2rem">Edition ${TODAY}.</p>
</main>`;
fs.writeFileSync(path.join(VOLDIR, 'index.html'), indexHtml, 'utf8');

console.log(`\nTotal: ${fullParts} parts, ${fullWords.toLocaleString()} words, ${allMermaid.length} diagrams`);
console.log(`Full web ${(fs.statSync(path.join(DIST, 'handbook.html')).size / 1048576).toFixed(1)} MB, full print ${(fs.statSync(path.join(DIST, 'handbook-print.html')).size / 1048576).toFixed(1)} MB`);
