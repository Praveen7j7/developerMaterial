/* Structural QA across chapters/*.md.
 * Reports, per Part: file count, words, H1 count, closing sections, and
 * section-numbering problems (gaps, duplicates, wrong part prefix).
 * Exit code 2 if any hard problem is found.
 */
const fs = require('fs');
const path = require('path');

const CHAPTERS = path.resolve(__dirname, '..', 'chapters');
const files = fs.readdirSync(CHAPTERS).filter(f => /^part-\d{2}-\d{2}-.*\.md$/.test(f)).sort();

const parts = new Map();
for (const f of files) {
  const pn = f.slice(5, 7);
  if (!parts.has(pn)) parts.set(pn, { files: [], words: 0, h1: [], h2: [], closing: false, takeaways: false, mermaid: 0, code: 0, tables: 0 });
  const p = parts.get(pn);
  const text = fs.readFileSync(path.join(CHAPTERS, f), 'utf8').replace(/\r\n/g, '\n');
  p.files.push(f);
  p.words += text.split(/\s+/).filter(Boolean).length;

  const lines = text.split('\n');
  let inFence = false;
  for (const line of lines) {
    const fence = /^\s*```(\w*)/.exec(line);
    if (fence) {
      if (!inFence && fence[1] === 'mermaid') p.mermaid++;
      else if (!inFence && fence[1]) p.code++;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\|.*\|/.test(line)) p.tables++;
    const h1 = /^#\s+(.+)$/.exec(line);
    if (h1) p.h1.push({ file: f, text: h1[1].trim() });
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) p.h2.push({ file: f, text: h2[1].trim() });
  }
  if (/^##\s+Senior Checklist\s*[—-]\s*Part/m.test(text)) p.closing = true;
  if (/^##\s+Part\s+\d+\s*[—-]\s*Key Takeaways/m.test(text)) p.takeaways = true;
}

const problems = [];
const warn = [];
let totalWords = 0, totalMermaid = 0, totalCode = 0;

console.log('PART  FILES   WORDS  H1  H2  MERMAID  CODE  CHECKLIST  TAKEAWAYS');
for (const pn of [...parts.keys()].sort()) {
  const p = parts.get(pn);
  totalWords += p.words; totalMermaid += p.mermaid; totalCode += p.code;
  console.log(
    `  ${pn}  ${String(p.files.length).padStart(5)}  ${String(p.words).padStart(6)}  ${String(p.h1.length).padStart(2)}  ${String(p.h2.length).padStart(2)}  ${String(p.mermaid).padStart(7)}  ${String(p.code).padStart(4)}  ${p.closing ? '   yes   ' : '   NO    '}  ${p.takeaways ? '  yes' : '  NO '}`
  );

  if (p.h1.length !== 1) problems.push(`Part ${pn}: expected exactly 1 H1, found ${p.h1.length}` + (p.h1.length > 1 ? ` (${p.h1.map(h => h.file).join(', ')})` : ''));
  if (p.h1.length === 1 && p.h1[0].file !== p.files[0]) problems.push(`Part ${pn}: H1 is in ${p.h1[0].file}, expected first file ${p.files[0]}`);
  if (!p.closing) problems.push(`Part ${pn}: missing "## Senior Checklist — Part ${Number(pn)}"`);
  if (!p.takeaways) problems.push(`Part ${pn}: missing "## Part ${Number(pn)} — Key Takeaways"`);

  // Section numbering: collect "## N.M title" and check prefix + duplicates + gaps
  const nums = [];
  for (const h of p.h2) {
    const m = /^(\d+)\.(\d+)\b/.exec(h.text);
    if (!m) continue;
    if (Number(m[1]) !== Number(pn)) problems.push(`Part ${pn}: section "${h.text}" has wrong part prefix (${h.file})`);
    else nums.push({ n: Number(m[2]), text: h.text, file: h.file });
  }
  const seen = new Map();
  for (const s of nums) {
    if (seen.has(s.n)) problems.push(`Part ${pn}: duplicate section number ${pn}.${s.n} ("${seen.get(s.n).text}" in ${seen.get(s.n).file} and "${s.text}" in ${s.file})`);
    else seen.set(s.n, s);
  }
  const sorted = [...seen.keys()].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) warn.push(`Part ${pn}: numbering gap between ${pn}.${sorted[i - 1]} and ${pn}.${sorted[i]}`);
  }
  // A leading ".0" intro section is intentional in some parts, so only warn above 1.
  if (sorted.length && sorted[0] > 1) warn.push(`Part ${pn}: sections start at ${pn}.${sorted[0]}, not ${pn}.1`);
}

const missing = [];
for (let i = 1; i <= 50; i++) { const k = String(i).padStart(2, '0'); if (!parts.has(k)) missing.push(i); }

console.log(`\nTOTAL: ${files.length} files, ${totalWords.toLocaleString()} words, ${totalMermaid} mermaid diagrams, ${totalCode} code blocks, ${parts.size}/50 parts`);
if (missing.length) console.log(`MISSING PARTS: ${missing.join(', ')}`);
if (warn.length) { console.log(`\nWARNINGS (${warn.length}):`); warn.forEach(w => console.log('  - ' + w)); }
if (problems.length) { console.log(`\nPROBLEMS (${problems.length}):`); problems.forEach(p => console.log('  - ' + p)); }
else console.log('\nNo structural problems.');

process.exit(problems.length || missing.length ? 2 : 0);
