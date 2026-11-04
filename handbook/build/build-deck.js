/* Builds the Masterclass deck from slides/*.json:
 *   dist/senior-backend-engineering-masterclass.pptx
 *   dist/masterclass-deck.html        (web artifact deck, same slides)
 *   dist/deck-map.md                  (section -> slide range -> handbook parts)
 */
const fs = require('fs');
const path = require('path');
const pptxgen = require('pptxgenjs');
const hljs = require('highlight.js');

const ROOT = path.resolve(__dirname, '..');
const SLIDES_DIR = path.join(ROOT, 'slides');
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

const C = { navy: '1B2A4A', accent: '0B5FFF', green: '0A7F5A', light: 'F4F6FA', gray: '59636E', dark: '1E1E2E', white: 'FFFFFF', box: 'E8EEFF', boxLine: '3B6FE0', text: '1F2328', amber: 'B54708', boxAlt: 'E6F4EE' };
const FONT = 'Calibri';
const MONO = 'Consolas';
const W = 13.333, H = 7.5;

// ---------- load sections ----------
const sectionFiles = fs.readdirSync(SLIDES_DIR).filter(f => /^\d{2}-.*\.json$/.test(f)).sort();
const sections = sectionFiles.map(f => {
  const s = JSON.parse(fs.readFileSync(path.join(SLIDES_DIR, f), 'utf8'));
  s.file = f; s.slides = (s.slides || []).filter(x => x && x.title && Array.isArray(x.points));
  return s;
}).sort((a, b) => (a.order || 0) - (b.order || 0));
if (!sections.length) { console.error('No slide sections found'); process.exit(1); }

// ---------- helpers ----------
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; };
const partsLabel = p => Array.isArray(p) ? p.join(', ') : String(p || '');

// Convert highlight.js HTML into colored runs [{text, color}]
const HL_COLORS = { keyword: 'C792EA', built_in: 'FFCB6B', type: 'FFCB6B', literal: 'F78C6C', number: 'F78C6C', string: 'C3E88D', attr: 'F07178', property: 'F07178', title: '82AAFF', 'title.function': '82AAFF', 'title.class': 'FFCB6B', comment: '7E8A9A', meta: '89DDFF', params: 'E6E9EF', variable: 'E6E9EF', operator: '89DDFF', punctuation: 'E6E9EF', attribute: 'F07178', selector: 'C792EA', tag: 'F07178', name: 'F07178', section: '82AAFF', bullet: 'C792EA', symbol: 'F78C6C', regexp: 'C3E88D', deletion: 'F07178', addition: 'C3E88D', subst: 'E6E9EF' };
function decodeEntities(s) { return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&'); }
function highlightRuns(code, lang) {
  const map = { ts: 'typescript', js: 'javascript', sh: 'bash', yml: 'yaml', text: 'plaintext', txt: 'plaintext', dockerfile: 'dockerfile' };
  const l = map[lang] || lang || 'plaintext';
  let html;
  try { html = hljs.getLanguage(l) ? hljs.highlight(code, { language: l, ignoreIllegals: true }).value : esc(code); } catch { html = esc(code); }
  const runs = []; const stack = [];
  const re = /<span class="([^"]+)">|<\/span>|([^<]+)/g; let m;
  while ((m = re.exec(html))) {
    if (m[1]) { const cls = m[1].split(/\s+/).map(c => c.replace(/^hljs-/, '')).find(c => HL_COLORS[c]) || null; stack.push(cls ? HL_COLORS[cls] : (stack[stack.length - 1] || null)); }
    else if (m[0] === '</span>') stack.pop();
    else if (m[2]) runs.push({ text: decodeEntities(m[2]), color: stack[stack.length - 1] || 'E6E9EF' });
  }
  return { runs, html };
}

// ---------- visual layout -> primitives (inches) ----------
function boxFont(label, w) { const n = label.length; if (n <= 12 && w >= 1.2) return 12; if (n <= 22) return 11; if (n <= 32) return 10; return 9; }
function prim(v, area) {
  const P = []; const { x: ax, y: ay, w: aw, h: ah } = area;
  const rect = (x, y, w, h, text, o = {}) => P.push({ k: 'rect', x, y, w, h, text, fontSize: o.fontSize || boxFont(text, w), fill: o.fill || C.box, line: o.line || C.boxLine, color: o.color || C.navy, bold: o.bold || false });
  const line = (x1, y1, x2, y2, label) => P.push({ k: 'line', x1, y1, x2, y2, label });
  const type = v.type;
  if (type === 'flow') {
    const nodes = (v.nodes || []).slice(0, v.direction === 'v' ? 7 : 5).map(s => clip(s, 30)); const n = nodes.length; if (n < 2) return P;
    const labels = v.labels || [];
    if (v.direction === 'v') {
      const gap = 0.42; const bh = Math.min(0.72, (ah - gap * (n - 1)) / n); const bw = Math.min(aw - 1.6, 3.4); const x = ax + (aw - bw) / 2;
      const total = n * bh + (n - 1) * gap; let y = ay + (ah - total) / 2;
      for (let i = 0; i < n; i++) { rect(x, y, bw, bh, nodes[i]); if (i < n - 1) line(x + bw / 2, y + bh, x + bw / 2, y + bh + gap, labels[i]); y += bh + gap; }
    } else {
      const gap = 0.5; const bw = (aw - gap * (n - 1)) / n; const bh = Math.min(1.05, ah * 0.32); const y = ay + (ah - bh) / 2 - 0.2; let x = ax;
      for (let i = 0; i < n; i++) { rect(x, y, bw, bh, nodes[i]); if (i < n - 1) line(x + bw, y + bh / 2, x + bw + gap, y + bh / 2, labels[i]); x += bw + gap; }
    }
  } else if (type === 'stack') {
    const rows = (v.rows || []).slice(0, 5).map(r => (Array.isArray(r) ? r : [r]).slice(0, 4).map(s => clip(s, 30))); const r = rows.length; if (!r) return P;
    const rowGap = 0.45; const rh = Math.min(0.85, (ah - rowGap * (r - 1)) / r); const total = r * rh + (r - 1) * rowGap; let y = ay + (ah - total) / 2;
    for (let i = 0; i < r; i++) {
      const k = rows[i].length; const gx = 0.25; const bw = (aw - gx * (k - 1)) / k; let x = ax;
      for (let j = 0; j < k; j++) { rect(x, y, bw, rh, rows[i][j], { fill: i === 0 ? C.boxAlt : C.box }); x += bw + gx; }
      if (i < r - 1) line(ax + aw / 2, y + rh, ax + aw / 2, y + rh + rowGap);
      y += rh + rowGap;
    }
  } else if (type === 'compare') {
    const L = v.left || {}, R = v.right || {}; const gap = 0.3; const bw = (aw - gap) / 2; const th = 0.5;
    [[L, ax], [R, ax + bw + gap]].forEach(([side, x]) => {
      P.push({ k: 'rect', x, y: ay, w: bw, h: th, text: clip(side.title || '', 34), fontSize: 13, fill: C.navy, line: C.navy, color: C.white, bold: true });
      P.push({ k: 'text', x, y: ay + th, w: bw, h: ah - th, lines: (side.items || []).slice(0, 6).map(s => clip(s, 44)), fontSize: 12, bullet: true, fill: C.light, line: C.boxLine });
    });
  } else if (type === 'steps') {
    const items = (v.items || []).slice(0, 8).map(s => clip(s, 52)); const n = items.length; if (!n) return P;
    const ih = Math.min(0.58, ah / n); const d = 0.42; let y = ay + (ah - ih * n) / 2;
    for (let i = 0; i < n; i++) {
      P.push({ k: 'ellipse', x: ax + 0.1, y: y + (ih - d) / 2, w: d, h: d, text: String(i + 1), fill: C.accent, color: C.white, fontSize: 12 });
      P.push({ k: 'text', x: ax + 0.65, y, w: aw - 0.7, h: ih, lines: [items[i]], fontSize: 13, bullet: false, valign: 'middle' });
      if (i < n - 1) P.push({ k: 'line', x1: ax + 0.1 + d / 2, y1: y + (ih + d) / 2, x2: ax + 0.1 + d / 2, y2: y + ih + (ih - d) / 2, arrow: false });
      y += ih;
    }
  } else if (type === 'graph' || type === 'cycle') {
    let nodes, edges;
    if (type === 'cycle') { const items = (v.items || []).slice(0, 6).map(s => clip(s, 26)); nodes = items.map((label, i) => ({ id: 'n' + i, label })); edges = items.map((_, i) => ['n' + i, 'n' + ((i + 1) % items.length)]); }
    else { nodes = (v.nodes || []).slice(0, 8).map((nd, i) => typeof nd === 'string' ? { id: nd, label: clip(nd, 26) } : { id: nd.id || ('n' + i), label: clip(nd.label || nd.id || '', 26) }); edges = (v.edges || []).slice(0, 12); }
    const n = nodes.length; if (!n) return P; const pos = {};
    if (type === 'cycle') {
      const cx = ax + aw / 2, cy = ay + ah / 2; const rx = aw / 2 - 1.05, ry = ah / 2 - 0.42; const bw = 1.9, bh = 0.6;
      nodes.forEach((nd, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n; pos[nd.id] = { x: cx + rx * Math.cos(a) - bw / 2, y: cy + ry * Math.sin(a) - bh / 2, w: bw, h: bh }; });
    } else {
      const cols = n <= 4 ? 2 : (n <= 6 ? 3 : 4); const rows = Math.ceil(n / cols); const cw = aw / cols, ch = ah / rows; const bw = Math.min(cw * 0.74, 2.1), bh = Math.min(ch * 0.46, 0.75);
      nodes.forEach((nd, i) => { const r = Math.floor(i / cols), c = i % cols; pos[nd.id] = { x: ax + c * cw + (cw - bw) / 2, y: ay + r * ch + (ch - bh) / 2, w: bw, h: bh }; });
    }
    const center = p => ({ x: p.x + p.w / 2, y: p.y + p.h / 2 });
    // trim line to box borders so arrowheads land on the edge
    function trim(a, b) { const ca = center(a), cb = center(b); const dx = cb.x - ca.x, dy = cb.y - ca.y; const len = Math.hypot(dx, dy) || 1; const ux = dx / len, uy = dy / len;
      const tA = Math.min(Math.abs(a.w / 2 / (ux || 1e-6)), Math.abs(a.h / 2 / (uy || 1e-6))); const tB = Math.min(Math.abs(b.w / 2 / (ux || 1e-6)), Math.abs(b.h / 2 / (uy || 1e-6)));
      return { x1: ca.x + ux * tA, y1: ca.y + uy * tA, x2: cb.x - ux * tB, y2: cb.y - uy * tB }; }
    edges.forEach(e => { const [f, t, label] = Array.isArray(e) ? e : [e.from, e.to, e.label]; if (!pos[f] || !pos[t] || f === t) return; const s = trim(pos[f], pos[t]); P.push({ k: 'line', ...s, label: label ? clip(label, 22) : undefined }); });
    nodes.forEach(nd => { const p = pos[nd.id]; rect(p.x, p.y, p.w, p.h, nd.label, { fontSize: nd.label.length > 16 ? 10 : 11 }); });
  } else if (type === 'table') {
    const headers = (v.headers || []).slice(0, 5).map(s => clip(s, 26)); const rows = (v.rows || []).slice(0, 7).map(r => (r || []).slice(0, headers.length).map(s => clip(s, 26)));
    P.push({ k: 'table', x: ax, y: ay, w: aw, h: ah, headers, rows });
  }
  return P;
}

// ---------- PPTX rendering ----------
const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE';
pptx.title = 'Senior Backend Engineering Masterclass';
pptx.author = 'Senior Backend Engineering Handbook';
pptx.subject = 'Visual companion to the Senior Backend Engineering Handbook';
let slideNo = 0;
const deckMap = [];

function footer(slide) {
  slideNo++;
  slide.addText('Senior Backend Engineering Masterclass', { x: 0.5, y: 7.08, w: 6, h: 0.3, fontSize: 9, fontFace: FONT, color: C.gray });
  slide.addText(String(slideNo), { x: 12.3, y: 7.08, w: 0.6, h: 0.3, fontSize: 9, fontFace: FONT, color: C.gray, align: 'right' });
}
function lineShape(slide, p) {
  const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
  slide.addShape(pptx.ShapeType.line, { x: Math.min(p.x1, p.x2), y: Math.min(p.y1, p.y2), w: Math.abs(dx), h: Math.abs(dy), flipH: dx < 0, flipV: dy < 0, line: { color: C.gray, width: 1.5, endArrowType: p.arrow === false ? undefined : 'triangle' } });
  if (p.label) { const mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2; const horiz = Math.abs(dx) >= Math.abs(dy);
    slide.addText(p.label, { x: mx - 0.75, y: horiz ? my - 0.42 : my - 0.16, w: 1.5, h: 0.3, fontSize: 9, fontFace: FONT, color: C.gray, align: 'center', valign: 'middle', fill: { color: C.white }, margin: 0 }); }
}
function renderPrimsPptx(slide, prims) {
  prims.filter(p => p.k === 'line').forEach(p => lineShape(slide, p));
  for (const p of prims) {
    if (p.k === 'rect') slide.addText(p.text, { shape: pptx.ShapeType.roundRect, rectRadius: 0.08, x: p.x, y: p.y, w: p.w, h: p.h, fill: { color: p.fill }, line: { color: p.line, width: 1 }, fontSize: p.fontSize, fontFace: FONT, color: p.color, bold: p.bold, align: 'center', valign: 'middle', margin: 4 });
    else if (p.k === 'ellipse') slide.addText(p.text, { shape: pptx.ShapeType.ellipse, x: p.x, y: p.y, w: p.w, h: p.h, fill: { color: p.fill }, line: { color: p.fill }, fontSize: p.fontSize, fontFace: FONT, color: p.color, bold: true, align: 'center', valign: 'middle', margin: 0 });
    else if (p.k === 'text') slide.addText(p.lines.map(t => ({ text: t, options: { bullet: p.bullet ? { indent: 12 } : false, breakLine: true, paraSpaceAfter: 4 } })), { x: p.x, y: p.y, w: p.w, h: p.h, fontSize: p.fontSize, fontFace: FONT, color: C.text, valign: p.valign || 'top', fill: p.fill ? { color: p.fill } : undefined, line: p.line ? { color: p.line, width: 1 } : undefined, margin: 8 });
    else if (p.k === 'table') {
      const cols = p.headers.length || 1; const colW = Array(cols).fill(p.w / cols);
      const rows = [p.headers.map(h => ({ text: h, options: { bold: true, color: C.white, fill: { color: C.navy }, fontSize: 11 } }))].concat(p.rows.map((r, i) => r.map(c => ({ text: c, options: { fontSize: 10.5, color: C.text, fill: { color: i % 2 ? C.white : C.light } } }))));
      slide.addTable(rows, { x: p.x, y: p.y, w: p.w, colW, fontFace: FONT, border: { type: 'solid', color: 'CBD2DA', pt: 0.75 }, margin: 0.06, autoPage: false });
    }
  }
}

function addTitleSlide() {
  const s = pptx.addSlide(); s.background = { color: C.navy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 5.2, w: W, h: 0.08, fill: { color: C.green }, line: { color: C.green } });
  s.addText('Senior Backend Engineering Masterclass', { x: 0.8, y: 1.6, w: 11.7, h: 1.4, fontSize: 44, bold: true, color: C.white, fontFace: FONT });
  s.addText('From "I can build backend APIs" to "I can architect, build, scale, secure, test, debug, deploy, operate and explain production-grade backend systems."', { x: 0.8, y: 3.05, w: 11.7, h: 1.1, fontSize: 18, color: 'D5DEF5', fontFace: FONT, italic: true });
  s.addText('TypeScript · Node.js · NestJS · TypeORM · Sequelize · PostgreSQL · Redis · Kafka · Docker · Kubernetes · AWS · CI/CD · Observability · SRE · System Design', { x: 0.8, y: 4.3, w: 11.7, h: 0.7, fontSize: 13, color: '9FB4E8', fontFace: FONT });
  s.addText('Visual companion to the Senior Backend Engineering Handbook. Each section names the handbook Parts it summarises.', { x: 0.8, y: 5.5, w: 11.7, h: 0.6, fontSize: 13, color: 'D5DEF5', fontFace: FONT });
  slideNo++;
}
function addAgendaSlide(map) {
  const s = pptx.addSlide(); s.background = { color: C.white };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.5, fill: { color: C.navy }, line: { color: C.navy } });
  s.addText('Agenda', { x: 0.5, y: 0.6, w: 12, h: 0.7, fontSize: 28, bold: true, color: C.navy, fontFace: FONT });
  const half = Math.ceil(map.length / 2);
  [map.slice(0, half), map.slice(half)].forEach((col, ci) => {
    s.addText(col.map(m => ({ text: `${String(m.order).padStart(2, '0')}  ${m.section}`, options: { breakLine: true, bold: true, paraSpaceAfter: 1 } })).flatMap((t, i) => [t, { text: `      slides ${col[i].from}–${col[i].to} · Handbook Parts ${col[i].parts}`, options: { breakLine: true, color: C.gray, fontSize: 9.5, paraSpaceAfter: 5 } }]),
      { x: 0.5 + ci * 6.3, y: 1.4, w: 6.1, h: 5.5, fontSize: 12, fontFace: FONT, color: C.navy, valign: 'top' });
  });
  footer(s);
}
function addDividerSlide(sec, idx) {
  const s = pptx.addSlide(); s.background = { color: C.navy };
  s.addText(String(idx).padStart(2, '0'), { x: 0.8, y: 1.2, w: 4, h: 1.6, fontSize: 96, bold: true, color: '3B6FE0', fontFace: FONT });
  s.addText(sec.section, { x: 0.8, y: 2.9, w: 11.7, h: 1.1, fontSize: 40, bold: true, color: C.white, fontFace: FONT });
  if (sec.subtitle) s.addText(sec.subtitle, { x: 0.8, y: 4.0, w: 11.7, h: 0.8, fontSize: 18, color: 'D5DEF5', fontFace: FONT });
  s.addShape(pptx.ShapeType.rect, { x: 0.8, y: 5.0, w: 3.2, h: 0.06, fill: { color: C.green }, line: { color: C.green } });
  s.addText(`Handbook Parts ${partsLabel(sec.parts)}`, { x: 0.8, y: 5.2, w: 11.7, h: 0.5, fontSize: 14, color: '9FB4E8', fontFace: FONT });
  s.addText(`${sec.slides.length} slides`, { x: 0.8, y: 5.65, w: 11.7, h: 0.4, fontSize: 12, color: '9FB4E8', fontFace: FONT });
  slideNo++;
}
function addContentSlide(sec, sl) {
  const s = pptx.addSlide(); s.background = { color: C.white };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.5, fill: { color: C.navy }, line: { color: C.navy } });
  s.addText(sec.section, { x: 0.5, y: 0.08, w: 8, h: 0.34, fontSize: 11, color: 'D5DEF5', fontFace: FONT, bold: true });
  s.addText(sl.part ? `Handbook Part ${sl.part}` : `Handbook Parts ${partsLabel(sec.parts)}`, { x: 7.5, y: 0.08, w: 5.33, h: 0.34, fontSize: 11, color: '9FB4E8', fontFace: FONT, align: 'right' });
  const title = clip(sl.title, 90);
  s.addText(title, { x: 0.5, y: 0.58, w: 12.3, h: 0.9, fontSize: title.length > 62 ? 22 : 26, bold: true, color: C.navy, fontFace: FONT, valign: 'middle' });

  const visual = sl.visual && sl.visual.type ? sl.visual : null;
  const code = !visual && sl.code && sl.code.text ? sl.code : null;
  const hasRight = !!(visual || code);
  const example = sl.example ? clip(sl.example, 170) : null;
  const points = (sl.points || []).slice(0, 7).map(p => clip(p, 120));
  const leftW = hasRight ? 5.7 : 12.3;
  const contentTop = 1.55, contentBottom = 6.3;
  const exH = example ? 0.72 : 0;
  const chars = points.join('').length;
  let fs = hasRight ? (points.length <= 4 ? 16 : points.length <= 5 ? 15 : 14) : (points.length <= 4 ? 20 : points.length <= 5 ? 18 : 16);
  if (hasRight && chars > 520) fs -= 1; if (hasRight && chars > 640) fs -= 1; if (!hasRight && chars > 700) fs -= 2;
  const gapAfter = fs >= 16 ? 8 : 6;
  // Estimate how tall the bullet list actually renders so the example box can sit
  // just beneath it instead of floating at the bottom of an empty column.
  const charsPerLine = Math.max(10, Math.floor((leftW - 0.35) * 72 / (fs * 0.5)));
  const lineH = fs * 1.3 / 72;
  const ptsEst = points.reduce((h, p) => h + Math.max(1, Math.ceil(p.length / charsPerLine)) * lineH + gapAfter / 72, 0.1);
  const ptsH = Math.min(ptsEst, contentBottom - contentTop - exH - (example ? 0.15 : 0));
  s.addText(points.map(p => ({ text: p, options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: gapAfter } })), { x: 0.5, y: contentTop, w: leftW, h: ptsH, fontSize: fs, fontFace: FONT, color: C.text, valign: 'top', margin: 2 });
  if (example) {
    const exY = Math.min(contentTop + ptsH + 0.22, contentBottom - exH);
    s.addText([{ text: 'Real world  ', options: { bold: true, color: C.amber } }, { text: example, options: { italic: true, color: C.text } }], { x: 0.5, y: exY, w: leftW, h: exH, fontSize: 11, fontFace: FONT, fill: { color: 'FFF7ED' }, line: { color: 'F5D0A9', width: 0.75 }, valign: 'middle', margin: 6 });
  }
  if (visual) renderPrimsPptx(s, prim(visual, { x: 6.55, y: contentTop, w: 6.3, h: contentBottom - contentTop }));
  if (code) {
    const lines = String(code.text).replace(/\r/g, '').split('\n').slice(0, 16).map(l => l.replace(/\t/g, '  '));
    const maxLen = Math.max(...lines.map(l => l.length), 1);
    const cfs = maxLen <= 46 ? 12 : maxLen <= 56 ? 11 : maxLen <= 66 ? 10 : 9;
    const boxH = Math.min(contentBottom - contentTop, 0.35 + lines.length * (cfs * 1.22 / 72));
    const { runs } = highlightRuns(lines.join('\n'), code.lang);
    const rich = []; runs.forEach(r => { const segs = r.text.split('\n'); segs.forEach((seg, i) => { if (seg) rich.push({ text: seg, options: { color: r.color } }); if (i < segs.length - 1) rich.push({ text: '', options: { breakLine: true } }); }); });
    s.addText(rich, { x: 6.55, y: contentTop, w: 6.3, h: boxH, fontSize: cfs, fontFace: MONO, color: 'E6E9EF', fill: { color: C.dark }, line: { color: C.dark }, valign: 'top', margin: 8 });
    s.addText((code.lang || 'code').toUpperCase(), { x: 11.65, y: contentTop + 0.05, w: 1.1, h: 0.25, fontSize: 8, fontFace: FONT, color: '9AA4B2', align: 'right' });
  }
  const tk = clip(sl.takeaway || '', 160);
  s.addText([{ text: 'Senior takeaway  ', options: { bold: true } }, { text: tk }], { x: 0.5, y: 6.42, w: 12.3, h: 0.58, fontSize: tk.length > 120 ? 12 : 13, fontFace: FONT, color: C.white, fill: { color: C.green }, line: { color: C.green }, valign: 'middle', margin: 8 });
  if (sl.notes) s.addNotes(String(sl.notes));
  footer(s);
}
function addClosingSlide() {
  const s = pptx.addSlide(); s.background = { color: C.navy };
  s.addText('The senior mantra', { x: 0.8, y: 0.8, w: 11.7, h: 0.9, fontSize: 36, bold: true, color: C.white, fontFace: FONT });
  s.addText(['Can it timeout?', 'Can it fail?', 'Can it become slow?', 'Can it duplicate?', 'Can it return an incorrect response?', 'Can it partially succeed?'].map(t => ({ text: t, options: { breakLine: true, bullet: { indent: 14 }, paraSpaceAfter: 4 } })), { x: 0.8, y: 1.8, w: 5.6, h: 3.2, fontSize: 20, color: 'D5DEF5', fontFace: FONT });
  s.addText([{ text: 'Learning roadmap', options: { bold: true, breakLine: true, color: C.white, paraSpaceAfter: 6 } }].concat(['Beginner Foundation — Parts 1–4', 'Backend Engineer — Parts 5–10', 'Advanced Backend Engineer — Parts 11–24', 'Senior Backend Engineer — Parts 25–42', 'Staff Engineer — Parts 43–50'].map(t => ({ text: t, options: { breakLine: true, paraSpaceAfter: 4 } }))), { x: 6.8, y: 1.8, w: 5.8, h: 3.2, fontSize: 16, color: 'D5DEF5', fontFace: FONT });
  s.addText('The best architecture is not the most sophisticated one. It is the simplest one that meets the requirement, that you can operate at 3 a.m., and that you can change later.', { x: 0.8, y: 5.3, w: 11.7, h: 1.0, fontSize: 15, italic: true, color: '9FB4E8', fontFace: FONT });
  slideNo++;
}

// ---------- build PPTX ----------
// Pre-compute the map (title + agenda = slides 1-2)
let cursor = 3;
const map = sections.map((sec, i) => { const from = cursor; cursor += 1 + sec.slides.length; return { order: i + 1, section: sec.section, parts: partsLabel(sec.parts), from, to: cursor - 1, count: sec.slides.length }; });
addTitleSlide();
addAgendaSlide(map);
sections.forEach((sec, i) => { addDividerSlide(sec, i + 1); sec.slides.forEach(sl => addContentSlide(sec, sl)); });
addClosingSlide();
const total = slideNo;

// ---------- deck map ----------
const mapMd = ['| Deck section | Slides | Handbook Parts | Content slides |', '|---|---|---|---|'].concat(map.map(m => `| ${String(m.order).padStart(2, '0')} ${m.section} | ${m.from}–${m.to} | ${m.parts} | ${m.count} |`)).join('\n');
fs.writeFileSync(path.join(DIST, 'deck-map.md'), `# Masterclass deck ↔ Handbook map\n\nTotal slides: ${total}\n\n${mapMd}\n`);

// ---------- HTML deck ----------
const PX = 96;
function svgText(x, y, w, h, text, fontSize, color, opts = {}) {
  // naive word wrap
  const maxChars = Math.max(6, Math.floor((w * 72) / (fontSize * 0.52)));
  const words = String(text).split(/\s+/); const lines = []; let cur = '';
  for (const wd of words) { if ((cur + ' ' + wd).trim().length > maxChars && cur) { lines.push(cur); cur = wd; } else cur = (cur + ' ' + wd).trim(); }
  if (cur) lines.push(cur);
  const lh = fontSize * 1.2 / 72; const startY = y + h / 2 - (lines.length - 1) * lh / 2;
  return `<text x="${(x + w / 2) * PX}" y="${startY * PX}" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize * PX / 72}" fill="#${color}" font-family="Segoe UI, Calibri, Arial, sans-serif"${opts.bold ? ' font-weight="700"' : ''}>${lines.map((l, i) => `<tspan x="${(x + w / 2) * PX}" dy="${i ? lh * PX : 0}">${esc(l)}</tspan>`).join('')}</text>`;
}
function renderPrimsSvg(prims, area) {
  const parts = [];
  parts.push(`<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#59636E"/></marker></defs>`);
  for (const p of prims.filter(p => p.k === 'line')) {
    parts.push(`<line x1="${p.x1 * PX}" y1="${p.y1 * PX}" x2="${p.x2 * PX}" y2="${p.y2 * PX}" stroke="#59636E" stroke-width="2"${p.arrow === false ? '' : ' marker-end="url(#arr)"'}/>`);
    if (p.label) { const mx = (p.x1 + p.x2) / 2, my = (p.y1 + p.y2) / 2; const horiz = Math.abs(p.x2 - p.x1) >= Math.abs(p.y2 - p.y1); const ly = horiz ? my - 0.22 : my; const lx = horiz ? mx : mx + 0.12;
      parts.push(`<rect x="${(lx - 0.7) * PX}" y="${(ly - 0.12) * PX}" width="${1.4 * PX}" height="${0.24 * PX}" fill="#FFFFFF" opacity="0.9"/>`); parts.push(svgText(lx - 0.7, ly - 0.12, 1.4, 0.24, p.label, 9, C.gray)); }
  }
  for (const p of prims) {
    if (p.k === 'rect') { parts.push(`<rect x="${p.x * PX}" y="${p.y * PX}" width="${p.w * PX}" height="${p.h * PX}" rx="8" fill="#${p.fill}" stroke="#${p.line}" stroke-width="1"/>`); parts.push(svgText(p.x, p.y, p.w, p.h, p.text, p.fontSize, p.color, { bold: p.bold })); }
    else if (p.k === 'ellipse') { parts.push(`<ellipse cx="${(p.x + p.w / 2) * PX}" cy="${(p.y + p.h / 2) * PX}" rx="${p.w / 2 * PX}" ry="${p.h / 2 * PX}" fill="#${p.fill}"/>`); parts.push(svgText(p.x, p.y, p.w, p.h, p.text, p.fontSize, p.color, { bold: true })); }
    else if (p.k === 'text') {
      if (p.fill) parts.push(`<rect x="${p.x * PX}" y="${p.y * PX}" width="${p.w * PX}" height="${p.h * PX}" fill="#${p.fill}" stroke="#${p.line || p.fill}"/>`);
      const lh = p.fontSize * 1.45 / 72; let y = p.y + 0.14; if (p.valign === 'middle') y = p.y + p.h / 2 - (p.lines.length * lh) / 2 + 0.05;
      p.lines.forEach(l => { parts.push(`<text x="${(p.x + 0.12) * PX}" y="${(y + lh * 0.75) * PX}" font-size="${p.fontSize * PX / 72}" fill="#${C.text}" font-family="Segoe UI, Calibri, Arial, sans-serif">${p.bullet ? '• ' : ''}${esc(l)}</text>`); y += lh; });
    }
  }
  return `<svg class="visual" viewBox="${area.x * PX} ${area.y * PX} ${area.w * PX} ${area.h * PX}" width="${area.w * PX}" height="${area.h * PX}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`;
}
function tableHtml(p) { return `<table class="vtable"><thead><tr>${p.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${p.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`; }

const htmlSlides = [];
let n = 0;
htmlSlides.push(`<section class="slide dark title" data-n="${++n}"><div class="tbox"><h1>Senior Backend Engineering Masterclass</h1><p class="sub">From "I can build backend APIs" to "I can architect, build, scale, secure, test, debug, deploy, operate and explain production-grade backend systems."</p><p class="stack">TypeScript · Node.js · NestJS · TypeORM · Sequelize · PostgreSQL · Redis · Kafka · Docker · Kubernetes · AWS · CI/CD · Observability · SRE · System Design</p><p class="small">Visual companion to the Senior Backend Engineering Handbook. Each section names the handbook Parts it summarises. Use ← → keys, or the menu.</p></div></section>`);
htmlSlides.push(`<section class="slide agenda" data-n="${++n}"><div class="band"><span>Agenda</span></div><h2>Agenda</h2><div class="cols">${[map.slice(0, Math.ceil(map.length / 2)), map.slice(Math.ceil(map.length / 2))].map(col => `<ol>${col.map(m => `<li value="${m.order}"><a href="#${m.from}"><strong>${esc(m.section)}</strong></a><span>slides ${m.from}–${m.to} · Handbook Parts ${esc(m.parts)}</span></li>`).join('')}</ol>`).join('')}</div><footer><span>Senior Backend Engineering Masterclass</span><span>${n}</span></footer></section>`);
sections.forEach((sec, i) => {
  htmlSlides.push(`<section class="slide dark divider" data-n="${++n}" data-section="${esc(sec.section)}"><div class="tbox"><div class="num">${String(i + 1).padStart(2, '0')}</div><h1>${esc(sec.section)}</h1>${sec.subtitle ? `<p class="sub">${esc(sec.subtitle)}</p>` : ''}<div class="rule"></div><p class="small">Handbook Parts ${esc(partsLabel(sec.parts))} · ${sec.slides.length} slides</p></div></section>`);
  sec.slides.forEach(sl => {
    n++;
    const visual = sl.visual && sl.visual.type ? sl.visual : null; const code = !visual && sl.code && sl.code.text ? sl.code : null; const hasRight = !!(visual || code);
    const points = (sl.points || []).slice(0, 7).map(p => clip(p, 120)); const example = sl.example ? clip(sl.example, 170) : null;
    let right = '';
    if (visual) { const area = { x: 0, y: 0, w: 6.3, h: 4.75 }; const prims = prim(visual, area); const tbl = prims.find(p => p.k === 'table'); right = tbl ? tableHtml(tbl) : renderPrimsSvg(prims, area); }
    if (code) { const lines = String(code.text).replace(/\r/g, '').split('\n').slice(0, 16).join('\n'); const { html } = highlightRuns(lines, code.lang); const maxLen = Math.max(...lines.split('\n').map(l => l.length), 1); right = `<pre class="code" data-lang="${esc(code.lang || '')}" style="font-size:${maxLen <= 46 ? 15 : maxLen <= 56 ? 14 : maxLen <= 66 ? 13 : 12}px"><code>${html}</code></pre>`; }
    const chars = points.join('').length; const fs = hasRight ? (points.length <= 4 ? 21 : points.length <= 5 ? 20 : 18) - (chars > 520 ? 1 : 0) - (chars > 640 ? 1 : 0) : (points.length <= 4 ? 26 : points.length <= 5 ? 24 : 21) - (chars > 700 ? 2 : 0);
    htmlSlides.push(`<section class="slide content${hasRight ? ' two' : ''}" data-n="${n}"><div class="band"><span>${esc(sec.section)}</span><span>${sl.part ? 'Handbook Part ' + esc(sl.part) : 'Handbook Parts ' + esc(partsLabel(sec.parts))}</span></div><h2 class="${clip(sl.title, 90).length > 62 ? 'long' : ''}">${esc(clip(sl.title, 90))}</h2><div class="body"><div class="left"><ul style="font-size:${fs}px">${points.map(p => `<li>${esc(p)}</li>`).join('')}</ul>${example ? `<div class="example"><b>Real world</b> ${esc(example)}</div>` : ''}</div>${hasRight ? `<div class="right">${right}</div>` : ''}</div><div class="takeaway"><b>Senior takeaway</b> ${esc(clip(sl.takeaway || '', 160))}</div><footer><span>Senior Backend Engineering Masterclass</span><span>${n}</span></footer>${sl.notes ? `<aside class="notes">${esc(sl.notes)}</aside>` : ''}</section>`);
  });
});
htmlSlides.push(`<section class="slide dark closing" data-n="${++n}"><div class="tbox"><h1>The senior mantra</h1><div class="cols"><ul class="mantra"><li>Can it timeout?</li><li>Can it fail?</li><li>Can it become slow?</li><li>Can it duplicate?</li><li>Can it return an incorrect response?</li><li>Can it partially succeed?</li></ul><div><p class="sub"><b>Learning roadmap</b></p><ul class="road"><li>Beginner Foundation — Parts 1–4</li><li>Backend Engineer — Parts 5–10</li><li>Advanced Backend Engineer — Parts 11–24</li><li>Senior Backend Engineer — Parts 25–42</li><li>Staff Engineer — Parts 43–50</li></ul></div></div><p class="small quote">The best architecture is not the most sophisticated one. It is the simplest one that meets the requirement, that you can operate at 3 a.m., and that you can change later.</p></div></section>`);

const hljsCss = fs.readFileSync(path.join(__dirname, 'node_modules/highlight.js/styles/github-dark.css'), 'utf8');
const deckCss = `
:root{--bg:#e9ecf1;--fg:#1f2328;--panel:#fff;--muted:#59636e;--navy:#1B2A4A;--accent:#0B5FFF;--green:#0A7F5A;--box:#E8EEFF;--border:#d9dde3}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0b0d12;--border:#2a3140}}
:root[data-theme="dark"]{--bg:#0b0d12;--border:#2a3140}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:"Segoe UI",Calibri,Roboto,Helvetica,Arial,sans-serif;overflow:hidden;height:100vh}
#stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
#scaler{width:1280px;height:720px;transform-origin:center center;position:relative}
.slide{position:absolute;inset:0;width:1280px;height:720px;background:#fff;color:#1f2328;display:none;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.25)}
.slide.active{display:block}
.slide.dark{background:#1B2A4A;color:#fff}
.band{position:absolute;top:0;left:0;right:0;height:48px;background:#1B2A4A;color:#D5DEF5;display:flex;justify-content:space-between;align-items:center;padding:0 48px;font-size:14px;font-weight:600}
.band span:last-child{color:#9FB4E8;font-weight:500}
.slide h2{position:absolute;top:56px;left:48px;right:48px;height:84px;margin:0;display:flex;align-items:center;font-size:34px;color:#1B2A4A;line-height:1.15}
.slide h2.long{font-size:28px}
.body{position:absolute;top:150px;left:48px;right:48px;bottom:112px;display:grid;grid-template-columns:1fr;gap:32px}
.slide.two .body{grid-template-columns:548px 1fr}
.left{display:flex;flex-direction:column;justify-content:flex-start;min-width:0}
.left ul{margin:0;padding-left:26px;line-height:1.35}
.left li{margin:0 0 9px}
.example{background:#FFF7ED;border:1px solid #F5D0A9;border-radius:6px;padding:8px 12px;font-size:14px;font-style:italic;color:#1f2328;margin-top:10px}
.example b{font-style:normal;color:#B54708;margin-right:6px}
.right{min-width:0;display:flex;align-items:flex-start;justify-content:center;overflow:hidden}
.right svg{max-width:100%;height:auto}
pre.code{margin:0;width:100%;max-height:100%;overflow:hidden;background:#1E1E2E;color:#E6E9EF;border-radius:8px;padding:14px 16px;font-family:Consolas,"Cascadia Mono",Menlo,monospace;line-height:1.4;position:relative}
pre.code::after{content:attr(data-lang);position:absolute;top:8px;right:12px;font-size:10px;color:#9AA4B2;text-transform:uppercase;font-family:"Segoe UI",Arial,sans-serif}
.hljs{background:transparent!important}
.vtable{border-collapse:collapse;width:100%;font-size:15px}
.vtable th{background:#1B2A4A;color:#fff;padding:7px 9px;text-align:left}
.vtable td{border:1px solid #CBD2DA;padding:6px 9px}
.vtable tbody tr:nth-child(odd) td{background:#F4F6FA}
.takeaway{position:absolute;left:48px;right:48px;bottom:48px;height:56px;background:#0A7F5A;color:#fff;border-radius:6px;display:flex;align-items:center;padding:0 16px;font-size:17px;line-height:1.25}
.takeaway b{margin-right:10px;white-space:nowrap}
footer{position:absolute;left:48px;right:48px;bottom:14px;display:flex;justify-content:space-between;font-size:12px;color:#59636e}
.slide.dark footer{color:#9FB4E8}
.tbox{position:absolute;left:80px;right:80px;top:110px}
.title h1,.divider h1,.closing h1{font-size:56px;margin:0 0 20px;line-height:1.1}
.divider h1{font-size:52px}
.divider .num{font-size:120px;font-weight:800;color:#3B6FE0;line-height:1;margin-bottom:10px}
.sub{font-size:22px;color:#D5DEF5;margin:0 0 18px;line-height:1.35}
.stack{font-size:16px;color:#9FB4E8;margin:0 0 30px}
.small{font-size:16px;color:#D5DEF5}
.rule{width:300px;height:6px;background:#0A7F5A;margin:22px 0 14px}
.agenda h2{position:absolute}
.agenda .cols{position:absolute;top:150px;left:48px;right:48px;display:grid;grid-template-columns:1fr 1fr;gap:40px}
.agenda ol{margin:0;padding-left:30px}
.agenda li{margin:0 0 10px;font-size:16px;line-height:1.2}
.agenda li a{color:#1B2A4A;text-decoration:none}
.agenda li span{display:block;font-size:12px;color:#59636e}
.closing .cols{display:grid;grid-template-columns:1fr 1fr;gap:40px}
.closing ul{font-size:24px;line-height:1.5;color:#D5DEF5;margin:0;padding-left:26px}
.closing ul.road{font-size:19px}
.closing .quote{margin-top:36px;font-style:italic;color:#9FB4E8;font-size:18px}
.notes{display:none}
#hud{position:fixed;left:0;right:0;bottom:0;height:5px;background:rgba(0,0,0,.15)}
#bar{height:100%;background:#0B5FFF;width:0}
#ctl{position:fixed;top:10px;right:12px;display:flex;gap:6px;z-index:5}
#ctl button,#ctl select{background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:5px 9px;font-size:13px}
#counter{position:fixed;top:14px;left:14px;font-size:13px;color:var(--muted)}
@media print{body{overflow:visible;height:auto}#stage{position:static;display:block}#scaler{transform:none!important;width:auto;height:auto}.slide{position:relative;display:block;margin:0 auto 16px;page-break-after:always;box-shadow:none}#hud,#ctl,#counter{display:none}}
`;
const optionsHtml = map.map(m => `<option value="${m.from}">${String(m.order).padStart(2, '0')} ${esc(m.section)}</option>`).join('');
const deckHtml = `<title>Senior Backend Engineering Masterclass</title>
<style>${deckCss}</style><style>${hljsCss}</style>
<div id="counter">1 / ${n}</div>
<div id="ctl"><select id="jump" aria-label="Jump to section"><option value="1">Go to section…</option>${optionsHtml}</select><button id="prev" aria-label="Previous">◀</button><button id="next" aria-label="Next">▶</button></div>
<div id="stage"><div id="scaler">${htmlSlides.join('\n')}</div></div>
<div id="hud"><div id="bar"></div></div>
<script>
(function(){
  var slides=Array.prototype.slice.call(document.querySelectorAll('.slide')), total=slides.length, cur=0;
  function show(i){ i=Math.max(0,Math.min(total-1,i)); slides[cur].classList.remove('active'); cur=i; slides[cur].classList.add('active');
    document.getElementById('counter').textContent=(cur+1)+' / '+total; document.getElementById('bar').style.width=((cur+1)/total*100)+'%';
    if(location.hash!=='#'+(cur+1)) history.replaceState(null,'','#'+(cur+1)); try{localStorage.setItem('sbem-deck-slide',String(cur+1));}catch(e){} }
  function fit(){ var s=Math.min(window.innerWidth/1280, window.innerHeight/720)*0.96; document.getElementById('scaler').style.transform='scale('+s+')'; }
  window.addEventListener('resize',fit); fit();
  var start=parseInt(location.hash.slice(1),10); if(!start){ try{ start=parseInt(localStorage.getItem('sbem-deck-slide'),10);}catch(e){} }
  slides[0].classList.add('active'); show((start||1)-1);
  document.addEventListener('keydown',function(e){ if(e.key==='ArrowRight'||e.key===' '||e.key==='PageDown'){show(cur+1);e.preventDefault();} else if(e.key==='ArrowLeft'||e.key==='PageUp'){show(cur-1);e.preventDefault();} else if(e.key==='Home'){show(0);} else if(e.key==='End'){show(total-1);} });
  document.getElementById('next').onclick=function(){show(cur+1)}; document.getElementById('prev').onclick=function(){show(cur-1)};
  document.getElementById('jump').onchange=function(e){ show(parseInt(e.target.value,10)-1); e.target.value='1'; };
  document.getElementById('stage').addEventListener('click',function(e){ if(e.target.closest('a')) return; var r=this.getBoundingClientRect(); show(e.clientX-r.left>r.width/2?cur+1:cur-1); });
  window.addEventListener('hashchange',function(){ var h=parseInt(location.hash.slice(1),10); if(h&&h-1!==cur) show(h-1); });
  document.addEventListener('click',function(e){ var a=e.target.closest('a[href^="#"]'); if(a){ e.preventDefault(); e.stopPropagation(); var h=parseInt(a.getAttribute('href').slice(1),10); if(h) show(h-1);} }, true);
})();
</script>`;
fs.writeFileSync(path.join(DIST, 'masterclass-deck.html'), deckHtml, 'utf8');

pptx.writeFile({ fileName: path.join(DIST, 'senior-backend-engineering-masterclass.pptx') }).then(f => {
  console.log(`PPTX: ${f} (${total} slides, ${sections.length} sections)`);
  console.log(mapMd);
}).catch(e => { console.error(e); process.exit(1); });
