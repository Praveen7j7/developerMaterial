/* Cross-references: "Part 14", "Part 14.3", "section 24.1", "(3.5)", "DNS in 14.3" become links
 * (class "xref"), and every target that is linked from somewhere gets a preview entry in
 * site/refs.json (title + the section's opening sentences), shown by assets/js/xref.js in a card,
 * so a reader can get the gist without leaving the page.
 *
 * Bare numbers are linked only when the text around them says they are a reference (see bareOk);
 * versions, measurements and prices ("TLS 1.3", "0.5 ms", "2.5x") are never linked.
 * Headings, code, links, buttons and diagrams are never touched.
 */
const { escapeHtml } = require('./util');

// ---------- index: section number -> target ----------
const HEAD_RE = /^(#{1,3})\s+(.+?)\s*#*\s*$/;

function plain(s) {
  return s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ').trim();
}

// The opening sentences of a paragraph, about 330 characters, cut at a sentence end.
function gist(text) {
  const sents = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(`])/);
  let out = '';
  for (const s of sents) {
    if (out && out.length >= 140 && out.length + s.length > 330) break;
    out = out ? out + ' ' + s : s;
  }
  if (out.length > 440) out = out.slice(0, out.lastIndexOf(' ', 420)) + ' …';
  return out;
}

// First prose paragraph under heading i (lines[] of the Part), before the next heading of the same
// or a higher level; a list item is accepted when there is no prose.
function opening(lines, from, level) {
  let inFence = false, para = [], listItem = null, done = [];
  const enough = () => plain(done.concat(para).join(' ')).length >= 120;  // a one-line label ("Pattern: hashing") is not a gist
  const endPara = () => { if (para.length) { done.push(para.join(' ')); para = []; } return enough(); };
  for (let i = from + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) { if (para.length && endPara()) break; inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^(#{1,6})\s/.exec(l);
    if (h) { if (endPara() || h[1].length <= level) break; continue; }
    if (!l.trim()) { if (para.length && endPara()) break; continue; }
    if (/^\s*([|>]|<|!\[|---)/.test(l)) { if (para.length && endPara()) break; continue; }
    const li = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(l);
    if (li) { if (para.length && endPara()) break; if (!listItem) listItem = li[1]; continue; }
    para.push(l.trim());
  }
  endPara();
  const t = plain(done.length ? done.join(' ') : (listItem || ''));
  return t ? gist(t) : '';
}

function buildRefIndex(book) {
  const secs = new Map();   // "14.3" / "14.3.2" -> { p, id, title, line, level }
  const parts = new Map();  // 14 -> { p, id, title, line }
  for (const p of book.order) {
    const lines = p.md.split('\n');
    let inFence = false, hi = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*```/.test(lines[i])) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = HEAD_RE.exec(lines[i]);
      if (!m) continue;
      const h = p.headings[hi++];  // same walk as content.js collectHeadings, so the ids line up
      if (!h) continue;
      if (h.level === 1) { if (!parts.has(p.num)) parts.set(p.num, { p, id: `part-${p.num}`, title: plain(p.title), line: i, level: 1 }); continue; }
      const n = /^(\d{1,2}(?:\.\d{1,2}){1,2})\s+(.+)$/.exec(h.text);
      if (n && Number(n[1].split('.')[0]) === p.num && !secs.has(n[1])) secs.set(n[1], { p, id: h.id, title: plain(n[2]), line: i, level: h.level });
    }
    p._lines = lines;
  }
  return { secs, parts, used: new Set() };
}

// ---------- linking ----------
const SKIP = new Set(['a', 'code', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'script', 'style', 'svg', 'button', 'summary', 'kbd', 'textarea', 'title']);
const BLOCK = /^(p|li|td|th|div|blockquote|h[1-6]|dd|dt|figure|section|header|footer|details|table|tr|ul|ol)$/;
const UNIT = /^\s?(?:ms|µs|ns|s|sec|secs|x|×|%|GB|MB|KB|TB|PB|GiB|MiB|KiB|kB|km|m|cm|mm|seconds?|minutes?|mins?|hours?|days?|weeks?|months?|years?|million|billion|thousand|k|K|M|B|px|rem|em|vw|vh|pt|rps|qps|req|requests|cores?|vCPUs?|GHz|MHz|Hz|USD|dollars?|times|points?|stars?)\b/;
const NUM = '\\d{1,2}(?:\\.\\d{1,2}){0,2}';
// a head word followed by a number, then optional chained numbers ("Parts 30, 31 and 34", "sections 60.3 to 60.7")
const HEAD = new RegExp(`(?<!\\w)(Parts?|[Ss]ections?|§)\\s?(${NUM})((?:\\s*(?:,|and|or|to|–|-)\\s*(?:${NUM}))*)(?![\\d.]*\\d)`, 'g');
const BARE = /(?<![\w.\/$€£#₹-])(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)(?![\w%]|\.\d)/g;

function resolve(key, idx, partLevel) {
  if (!partLevel && idx.secs.has(key)) return key;
  if (!partLevel) { const k2 = key.split('.').slice(0, 2).join('.'); if (k2 !== key && idx.secs.has(k2)) return k2; }
  const n = Number(key.split('.')[0]);
  return idx.parts.has(n) ? String(n) : null;
}

function anchor(text, key, idx, ctx) {
  idx.used.add(key);
  const t = key.includes('.') ? idx.secs.get(key) : idx.parts.get(Number(key));
  const file = t.p.vol.file;
  const href = (file === ctx.file ? '' : file) + '#' + t.id;
  return `<a class="xref" href="${href}" data-x="${key}">${text}</a>`;
}

// Is a bare "N.M" at text[pos] a reference? (pre = the text before it in this block)
function bareOk(key, pre, post, ctx, title) {
  if (UNIT.test(post)) return false;
  const rng = /^\s*(?:to|-|–|and|or)\s*[\d.,]+/.exec(post);  // "(0.2 to 0.5 ms)" is a range of numbers
  if (rng && UNIT.test(post.slice(rng[0].length))) return false;
  // followed by the section's own title ("82.3 LCP", "24.1 The incident") or by a verb about itself ("76.12 shows how")
  const words = s => s.toLowerCase().match(/[a-z0-9+#-]+/g) || [];
  const tw = words(title || ''), pw = words(post.slice(0, 60));
  const need = /^(the|a|an|how|what|why|when|where|which|from|to|in|on|of|and|with)$/.test(tw[0] || '') ? 2 : 1;
  if (tw.length >= need && tw[0].length >= 2 && /^\s\S/.test(post) && tw.slice(0, need).every((w, i) => pw[i] === w)) return true;
  if (/^\s(?:shows?|makes?|explains?|covers?|describes?|walks?|builds?|goes|lists?|gives?|introduces?|returns? to|expands?|turns?)\b/.test(post)) return true;
  const n = Number(key.split('.')[0]);
  const tail = pre.slice(-24);
  if (/[A-Z][\w-]*\s$/.test(tail) && !/\b(?:See|In|From|As|Also)\s$/.test(tail)) return false;  // "TLS 1.3", "Node 20.1", "React 18.2"
  if (/[=~≈<>≤≥±×*\/+^]\s*$/.test(tail) || /\b(?:about|roughly|around|approximately|under|over|above|below|to|by|of|is|was|at|v|version|ver)\s$/i.test(tail)) return false;
  if (/\((?:see |also |and |cf\. )?$/i.test(tail)) return /^\s*(?:\)|,|;|\s(?:and|or|to)\s)/.test(post);  // "(3.5)", "(see 14.11.2)"
  if (/\b(?:see|See|also)\s$/.test(tail)) return true;
  if (/[,;]\s$/.test(tail) && /^\)/.test(post) && /\([^()]*$/.test(pre)) return true;  // "(a request id helps, 6.6)"
  if (/(?:,|and|or|—|–)\s*$/.test(tail) && ctx.lastLinked) return true;  // continuing a list of references
  if (/\b(?:in|from|as|In|From|As)\s$/.test(tail)) return n === ctx.part || ctx.recent.has(n);
  return ctx.recent.has(n) && n !== 0;
}

function linkText(text, idx, ctx) {
  // pass 1: head words ("Part 14.3", "sections 60.3 to 60.7")
  let out = '', last = 0;
  const spans = [];
  HEAD.lastIndex = 0;
  for (let m; (m = HEAD.exec(text));) {
    const word = m[1], partLevel = /^Parts?$/.test(word);
    if (!partLevel && !m[2].includes('.')) continue;  // "section 4" is not a reference
    const key = resolve(m[2], idx, false);
    if (!key) continue;
    const pieces = [{ s: m.index, e: m.index + m[1].length + (m[0].length - m[1].length - m[3].length), key }];
    if (m[3]) {
      const chainStart = m.index + m[0].length - m[3].length;
      const re = new RegExp(`(${NUM})`, 'g');
      for (let c; (c = re.exec(m[3]));) {
        if (!c[1].includes('.') && word !== 'Parts') break;  // "Part 14 and 2 more" is not a list of Parts
        const k = resolve(c[1], idx, false);
        if (!k) break;
        pieces.push({ s: chainStart + c.index, e: chainStart + c.index + c[1].length, key: k });
      }
    }
    for (const pc of pieces) { spans.push(pc); ctx.recent.add(Number(pc.key.split('.')[0])); }
    if (partLevel) ctx.recent.add(Number(m[2].split('.')[0]));
  }
  // pass 2: bare numbers outside pass-1 spans
  BARE.lastIndex = 0;
  const inSpan = i => spans.some(s => i >= s.s && i < s.e);
  const bare = [];
  for (let m; (m = BARE.exec(text));) {
    if (inSpan(m.index) || !idx.secs.has(m[1])) continue;
    const pre = text.slice(0, m.index), post = text.slice(m.index + m[1].length);
    ctx.lastLinked = spans.concat(bare).some(s => s.e <= m.index && /^[\s,;—–andor]*$/.test(text.slice(s.e, m.index)));
    if (bareOk(m[1], ctx.prefix + pre, post, ctx, idx.secs.get(m[1]).title)) bare.push({ s: m.index, e: m.index + m[1].length, key: m[1] });
  }
  const all = spans.concat(bare).sort((a, b) => a.s - b.s);
  for (const s of all) { out += text.slice(last, s.s) + anchor(text.slice(s.s, s.e), s.key, idx, ctx); last = s.e; }
  out += text.slice(last);
  ctx.prefix = (ctx.prefix + text).slice(-40);
  return out;
}

/**
 * Link the references in one Part's rendered HTML.
 * @param {string} html  output of renderPart
 * @param {object} p     the Part (num, vol)
 * @param {object} idx   from buildRefIndex
 */
function linkRefs(html, p, idx) {
  const ctx = { part: p.num, file: p.vol.file, recent: new Set(), prefix: '', lastLinked: false };
  const toks = html.split(/(<[^>]+>)/);
  let skip = 0, n = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t[0] === '<') {
      const m = /^<(\/)?([a-zA-Z][\w-]*)/.exec(t);
      if (!m) continue;
      const tag = m[2].toLowerCase();
      if (SKIP.has(tag) && !t.endsWith('/>')) skip += m[1] ? -1 : 1;
      if (BLOCK.test(tag)) { ctx.recent = new Set(); ctx.prefix = ''; }
      if (skip < 0) skip = 0;
      continue;
    }
    if (skip) { ctx.prefix = (ctx.prefix + t).slice(-40); continue; }
    const before = t;
    toks[i] = linkText(t, idx, ctx);
    if (toks[i] !== before) n++;
  }
  return toks.join('');
}

// ---------- refs.json: only the targets something links to ----------
function refsJson(idx) {
  const out = { p: {}, s: {} };
  for (const key of [...idx.used].sort()) {
    if (key.includes('.')) {
      const t = idx.secs.get(key);
      out.s[key] = [`${t.p.vol.file}#${t.id}`, t.title, opening(t.p._lines, t.line, t.level), t.p.num];
    } else {
      const t = idx.parts.get(Number(key));
      out.p[key] = [`${t.p.vol.file}#${t.id}`, t.title, opening(t.p._lines, t.line, 1)];
    }
  }
  // every Part's title, for the card's "Part 14 · Networking" line
  for (const t of idx.parts.values()) if (!out.p[t.p.num]) out.p[t.p.num] = [`${t.p.vol.file}#${t.id}`, t.title];
  return out;
}

module.exports = { buildRefIndex, linkRefs, refsJson, _test: { bareOk, linkText, gist, plain } };
