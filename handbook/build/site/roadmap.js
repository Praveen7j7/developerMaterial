/* Parses the five learning stages out of Part 64 (sections 64.2.1 to 64.2.5) at build time.
 * Each stage: number, name, goal, time, "ready when", and the Parts from its "Read in this order"
 * paragraph, in order, with ranges like "Volume 0 (Parts 1–7)" expanded.
 * If Part 64 changes shape the build stops with a clear message instead of publishing a broken roadmap.
 */

function partsIn(text) {
  const nums = [];
  const re = /\bParts?\s+(\d+(?:\s*[–-]\s*\d+)?(?:\s*(?:,|and)\s*\d+(?:\s*[–-]\s*\d+)?)*)/g;
  for (const m of text.matchAll(re)) {
    for (const piece of m[1].split(/\s*(?:,|and)\s*/)) {
      const r = /^(\d+)\s*[–-]\s*(\d+)$/.exec(piece.trim());
      if (r) { for (let i = +r[1]; i <= +r[2]; i++) nums.push(i); }
      else if (/^\d+$/.test(piece.trim())) nums.push(+piece);
    }
  }
  return [...new Set(nums)];
}

// first sentence of a paragraph, for the short goal line
const firstSentence = s => (/^(.+?[.!?])(\s|$)/.exec(s) || [null, s])[1];

function field(block, label) {
  const m = new RegExp(`\\*\\*${label}\\.?\\*\\*\\.?\\s*([^\\n]+)`).exec(block);
  return m ? m[1].trim().replace(/\*\*/g, '').replace(/`/g, '') : '';
}

function parseRoadmap(part64, knownParts) {
  if (!part64) throw new Error('roadmap: Part 64 not found');
  const md = part64.md;
  const stages = [];
  const re = /^###\s+64\.2\.(\d)\s+Stage\s+(\d)\s+[—-]\s+(.+)$/gm;
  const heads = [...md.matchAll(re)];
  heads.forEach((h, i) => {
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : md.indexOf('\n### ', start) > 0 ? md.indexOf('\n### ', start) : md.length;
    const block = md.slice(start, end);
    const read = field(block, 'Read in this order');
    const parts = partsIn(read).filter(n => knownParts[n]);
    stages.push({
      n: Number(h[2]), name: h[3].trim(), anchor: h[0].replace(/^###\s+/, ''),
      goal: firstSentence(field(block, 'Goal')),
      time: field(block, 'Time').split(/[,;.]/)[0].trim(),
      reread: partsIn((read.split(/re-read/i)[1]) || ''),
      ready: field(block, 'Ready for the next stage when'),
      parts,
    });
  });
  if (stages.length !== 5) throw new Error(`roadmap: expected 5 stages in Part 64, found ${stages.length}`);
  for (const s of stages) {
    if (s.parts.length < 3 || !s.goal) throw new Error(`roadmap: Stage ${s.n} parsed badly (${s.parts.length} parts, goal "${s.goal}")`);
  }
  return stages;
}

module.exports = { parseRoadmap, partsIn };
