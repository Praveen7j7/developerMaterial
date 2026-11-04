/* Validates slides/*.json against the contract in _spec/SLIDES.md.
 * The renderer truncates silently, so this makes violations visible.
 * Exit code 2 on any hard error.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SLIDES = path.join(ROOT, 'slides');
const VISUALS = new Set(['flow', 'stack', 'table', 'compare', 'steps', 'graph', 'cycle']);
const LANGS = new Set(['ts', 'js', 'sql', 'bash', 'sh', 'yaml', 'yml', 'json', 'text', 'dockerfile', 'http']);

const errors = [], warns = [];
let totalSlides = 0, withVisual = 0, withCode = 0, plain = 0;
const byType = {};
const sections = [];

const files = fs.existsSync(SLIDES) ? fs.readdirSync(SLIDES).filter(f => /^\d{2}-.*\.json$/.test(f)).sort() : [];
if (!files.length) { console.log('No slide sections found in slides/'); process.exit(0); }

for (const f of files) {
  const where = f;
  let s;
  try { s = JSON.parse(fs.readFileSync(path.join(SLIDES, f), 'utf8')); }
  catch (e) { errors.push(`${where}: invalid JSON — ${e.message}`); continue; }

  if (!s.section) errors.push(`${where}: missing "section"`);
  if (typeof s.order !== 'number') errors.push(`${where}: missing numeric "order"`);
  if (!Array.isArray(s.parts) || !s.parts.length) errors.push(`${where}: missing "parts" array`);
  if (!Array.isArray(s.slides) || !s.slides.length) { errors.push(`${where}: missing "slides"`); continue; }

  const fileOrder = Number(f.slice(0, 2));
  if (s.order !== fileOrder) errors.push(`${where}: order ${s.order} does not match filename prefix ${fileOrder}`);

  sections.push({ file: f, order: s.order, section: s.section, parts: s.parts, count: s.slides.length });

  s.slides.forEach((sl, i) => {
    const at = `${where} slide ${i + 1} ("${String(sl.title || '').slice(0, 42)}")`;
    totalSlides++;

    if (!sl.title) errors.push(`${at}: missing title`);
    else if (sl.title.length > 90) errors.push(`${at}: title ${sl.title.length} chars, max 90`);
    if (!sl.part) warns.push(`${at}: missing "part"`);
    if (!sl.takeaway) errors.push(`${at}: missing takeaway`);
    else if (sl.takeaway.length > 150) warns.push(`${at}: takeaway ${sl.takeaway.length} chars, max 150`);
    if (sl.example && sl.example.length > 170) warns.push(`${at}: example ${sl.example.length} chars, max 170`);

    if (!Array.isArray(sl.points)) errors.push(`${at}: missing points array`);
    else {
      if (sl.points.length < 3 || sl.points.length > 7) errors.push(`${at}: ${sl.points.length} points, must be 3-7`);
      sl.points.forEach((p, j) => {
        if (typeof p !== 'string') errors.push(`${at}: point ${j + 1} is not a string`);
        else if (p.length > 120) warns.push(`${at}: point ${j + 1} is ${p.length} chars, max 110-120`);
      });
    }

    const hasV = !!(sl.visual && sl.visual.type), hasC = !!(sl.code && sl.code.text);
    if (hasV && hasC) warns.push(`${at}: has both visual and code; only the visual renders`);
    if (hasV) withVisual++; else if (hasC) withCode++; else plain++;

    if (hasC) {
      const lang = String(sl.code.lang || '').toLowerCase();
      if (!LANGS.has(lang)) warns.push(`${at}: code lang "${sl.code.lang}" is unusual`);
      const lines = String(sl.code.text).split('\n');
      if (lines.length > 14) errors.push(`${at}: code has ${lines.length} lines, max 14`);
      const wide = lines.filter(l => l.length > 64);
      if (wide.length) errors.push(`${at}: ${wide.length} code line(s) over 64 chars (longest ${Math.max(...lines.map(l => l.length))})`);
    }

    if (hasV) {
      const v = sl.visual, t = v.type;
      byType[t] = (byType[t] || 0) + 1;
      if (!VISUALS.has(t)) { errors.push(`${at}: unknown visual type "${t}"`); return; }
      const long = (arr, max, label) => (arr || []).forEach(x => { if (String(x).length > max) warns.push(`${at}: ${label} "${String(x).slice(0, 30)}..." is ${String(x).length} chars, max ${max}`); });

      if (t === 'flow') {
        const n = (v.nodes || []).length;
        if (n < 2) errors.push(`${at}: flow needs at least 2 nodes`);
        const cap = v.direction === 'v' ? 7 : 5;
        if (n > cap) errors.push(`${at}: flow direction "${v.direction || 'h'}" has ${n} nodes, max ${cap}`);
        long(v.nodes, 30, 'node');
        if (v.labels && v.labels.length && v.labels.length !== n - 1) warns.push(`${at}: flow has ${v.labels.length} labels for ${n} nodes (expected ${n - 1})`);
      } else if (t === 'stack') {
        const rows = v.rows || [];
        if (rows.length < 2 || rows.length > 5) errors.push(`${at}: stack has ${rows.length} rows, must be 2-5`);
        rows.forEach((r, k) => { const a = Array.isArray(r) ? r : [r]; if (a.length > 4) errors.push(`${at}: stack row ${k + 1} has ${a.length} boxes, max 4`); long(a, 30, 'box'); });
      } else if (t === 'table') {
        const h = v.headers || [], rows = v.rows || [];
        if (h.length > 5) errors.push(`${at}: table has ${h.length} columns, max 5`);
        if (rows.length > 7) errors.push(`${at}: table has ${rows.length} rows, max 7`);
        long(h, 26, 'header');
        rows.forEach(r => { long(r, 26, 'cell'); if ((r || []).length !== h.length) warns.push(`${at}: table row has ${(r || []).length} cells for ${h.length} headers`); });
      } else if (t === 'compare') {
        [['left', v.left], ['right', v.right]].forEach(([side, o]) => {
          if (!o || !o.title) { errors.push(`${at}: compare missing ${side}.title`); return; }
          const it = o.items || [];
          if (it.length < 2 || it.length > 6) errors.push(`${at}: compare ${side} has ${it.length} items, must be 2-6`);
          long(it, 44, `${side} item`);
        });
      } else if (t === 'steps') {
        const it = v.items || [];
        if (it.length < 3 || it.length > 8) errors.push(`${at}: steps has ${it.length} items, must be 3-8`);
        long(it, 52, 'step');
      } else if (t === 'graph') {
        const n = (v.nodes || []).length, e = (v.edges || []).length;
        if (n < 3 || n > 8) errors.push(`${at}: graph has ${n} nodes, must be 3-8`);
        if (e > 12) errors.push(`${at}: graph has ${e} edges, max 12`);
        long((v.nodes || []).map(x => (typeof x === 'string' ? x : x.label || x.id)), 26, 'node label');
        const ids = new Set((v.nodes || []).map((x, k) => (typeof x === 'string' ? x : x.id || 'n' + k)));
        (v.edges || []).forEach(ed => { const [a, b] = Array.isArray(ed) ? ed : [ed.from, ed.to];
          if (!ids.has(a)) errors.push(`${at}: graph edge references unknown node "${a}"`);
          if (!ids.has(b)) errors.push(`${at}: graph edge references unknown node "${b}"`); });
      } else if (t === 'cycle') {
        const it = v.items || [];
        if (it.length < 3 || it.length > 6) errors.push(`${at}: cycle has ${it.length} items, must be 3-6`);
        long(it, 26, 'item');
      }
    }
  });
}

sections.sort((a, b) => a.order - b.order);
console.log('ORDER  SECTION                              PARTS                  SLIDES  FILE');
for (const s of sections) {
  console.log(`  ${String(s.order).padStart(2)}   ${s.section.padEnd(36).slice(0, 36)} ${String(s.parts.join(',')).padEnd(22).slice(0, 22)} ${String(s.count).padStart(4)}    ${s.file}`);
}

// which of the 22 planned sections are missing
const planned = [[1,'Backend Foundations'],[2,'Node.js and NestJS'],[3,'Networking'],[4,'Architecture and API Design'],[5,'Databases and SQL'],[6,'PostgreSQL'],[7,'ORM Engineering'],[8,'Caching'],[9,'Messaging and Background Jobs'],[10,'Distributed Systems and Reliability'],[11,'Security'],[12,'Testing'],[13,'Performance and Capacity'],[14,'Observability'],[15,'Docker'],[16,'Kubernetes'],[17,'Cloud, Storage, Search and Cost'],[18,'CI/CD and Compatibility'],[19,'Git'],[20,'System Design'],[21,'Production Engineering'],[22,'Senior Engineering Mindset']];
const have = new Set(sections.map(s => s.order));
const missing = planned.filter(([n]) => !have.has(n));

const pct = n => totalSlides ? Math.round(n / totalSlides * 100) : 0;
console.log(`\nContent slides: ${totalSlides}   visual ${withVisual} (${pct(withVisual)}%)   code ${withCode} (${pct(withCode)}%)   neither ${plain} (${pct(plain)}%)   target 60/25/15`);
console.log(`Visual types used: ${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
const deckTotal = totalSlides + sections.length + 3;
console.log(`Projected deck size: ${deckTotal} slides (${totalSlides} content + ${sections.length} dividers + title, agenda, closing)`);
if (missing.length) console.log(`\nMISSING SECTIONS (${missing.length}): ${missing.map(([n, t]) => `${n} ${t}`).join(' | ')}`);
if (warns.length) { console.log(`\nWARNINGS (${warns.length}):`); warns.slice(0, 40).forEach(w => console.log('  - ' + w)); if (warns.length > 40) console.log(`  ... and ${warns.length - 40} more`); }
if (errors.length) { console.log(`\nERRORS (${errors.length}):`); errors.forEach(e => console.log('  - ' + e)); }
else console.log('\nNo hard errors.');

process.exit(errors.length ? 2 : 0);
