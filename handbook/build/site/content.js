/* Loads chapters/*.md, groups the files into Parts and Parts into volumes, and
 * computes the numbers the pages show (words, reading time, diagrams, code blocks).
 * Read-only: nothing in chapters/ is ever written.
 */
const fs = require('fs');
const path = require('path');
const { PATHS, VOLUMES, WORDS_PER_MINUTE, volFile } = require('./config');
const { slugify } = require('./util');

// Every # / ## / ### heading outside code fences, with the id the page will give it.
// Ids are unique per Part; the first "Concept" is "concept", the next "concept-1", and so on.
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

// Counts fenced blocks: mermaid diagrams and code blocks with a language.
function countFences(md) {
  let inFence = false, diagrams = 0, code = 0;
  for (const line of md.split('\n')) {
    const f = /^\s*```\s*(\w*)/.exec(line);
    if (!f) continue;
    if (!inFence) { if (f[1] === 'mermaid') diagrams++; else code++; }
    inFence = !inFence;
  }
  return { diagrams, code };
}

// "Try it first" cards: a blockquote that opens a ## section with
// "> **Try it first** · Level: <level> · About <N> minutes". Returns { h2 id: { level, minutes } }.
const TRY_RE = /^> \*\*Try it first\*\*\s*·\s*Level:\s*(Beginner|Intermediate|Advanced|Staff)\s*·\s*About\s+(\d+)\s+minutes/;
function findTries(p) {
  const out = {}; let inFence = false, lastH2 = null, sawOther = false, h2Count = new Map();
  const h2s = p.headings.filter(h => h.level === 2);
  for (const line of p.md.split('\n')) {
    if (/^\s*```/.test(line)) { inFence = !inFence; sawOther = true; continue; }
    if (inFence) continue;
    if (/^#{1,2}\s/.test(line)) {
      const m = /^##\s+(.+?)\s*#*\s*$/.exec(line);
      lastH2 = m ? m[1].trim() : null; sawOther = false;
      if (lastH2) h2Count.set(lastH2, (h2Count.get(lastH2) || 0) + 1);
      continue;
    }
    if (!line.trim()) continue;
    const t = TRY_RE.exec(line);
    if (t && lastH2 && !sawOther) {
      const nth = h2Count.get(lastH2);
      const h = h2s.filter(x => x.text === lastH2)[nth - 1];
      if (h) out[h.id] = { level: t[1], minutes: +t[2] };
    }
    sawOther = true;
  }
  return out;
}

function loadBook() {
  const files = fs.readdirSync(PATHS.CHAPTERS).filter(f => /^part-\d{2}-\d{2}-.*\.md$/.test(f)).sort();
  if (!files.length) throw new Error('No chapter files found in ' + PATHS.CHAPTERS);

  const parts = {};  // number -> Part
  for (const f of files) {
    const n = Number(f.slice(5, 7));
    const text = fs.readFileSync(path.join(PATHS.CHAPTERS, f), 'utf8').replace(/\r\n/g, '\n').trim();
    (parts[n] ||= { num: n, chunks: [] }).chunks.push(text);
  }

  for (const p of Object.values(parts)) {
    p.md = p.chunks.join('\n\n'); delete p.chunks;
    const m = /^#\s+Part\s+\d+\s+[—-]\s+(.+)$/m.exec(p.md) || /^#\s+(.+)$/m.exec(p.md);
    p.title = m ? m[1].trim() : `Part ${p.num}`;
    p.headings = collectHeadings(p.md);
    p.words = p.md.split(/\s+/).filter(Boolean).length;
    p.minutes = Math.max(1, Math.round(p.words / WORDS_PER_MINUTE));
    Object.assign(p, countFences(p.md));
    // "What you will learn": the numbered H2 sections (closing checklist and takeaways left out)
    p.sections = p.headings.filter(h => h.level === 2 && /^\d+\.\d+/.test(h.text));
    p.tries = findTries(p);
    p.qa = /^###\s+Q\d+\b/m.test(p.md);  // a question bank: "### Q1." answers collapse
  }

  const volumes = VOLUMES.map(v => {
    const nums = v.parts.filter(n => parts[n]);
    for (const n of nums) { parts[n].vol = v; parts[n].href = `${volFile(v)}#part-${n}`; }
    const ps = nums.map(n => parts[n]);
    const vol = {
      ...v, file: volFile(v), partNums: nums, parts: ps,
      words: ps.reduce((a, p) => a + p.words, 0),
      minutes: ps.reduce((a, p) => a + p.minutes, 0),
      diagrams: ps.reduce((a, p) => a + p.diagrams, 0),
      code: ps.reduce((a, p) => a + p.code, 0),
    };
    for (const p of ps) p.vol = vol;  // each Part points at its full volume (with .file)
    return vol;
  }).filter(v => v.parts.length);

  // reading order across the whole book, for Previous / Next
  const order = volumes.flatMap(v => v.parts);
  order.forEach((p, i) => { p.prev = order[i - 1] || null; p.next = order[i + 1] || null; });

  const totals = {
    parts: order.length,
    words: order.reduce((a, p) => a + p.words, 0),
    minutes: order.reduce((a, p) => a + p.minutes, 0),
    diagrams: order.reduce((a, p) => a + p.diagrams, 0),
    code: order.reduce((a, p) => a + p.code, 0),
  };
  return { parts, volumes, order, totals };
}

module.exports = { loadBook, collectHeadings };
