/* search-index.json: one entry per Part and per H2/H3 heading. The format is unchanged from
 * the first site ({p: part, t: title, v: volume, s: volume slug, a: anchor, k: 'part'|'section'})
 * so anything that already reads it keeps working. */
function searchIndex(book) {
  const out = [];
  for (const v of book.volumes) {
    for (const p of v.parts) {
      out.push({ p: p.num, t: p.title, v: v.n, s: v.slug, a: `part-${p.num}`, k: 'part' });
      for (const h of p.headings) {
        if (h.level >= 2) out.push({ p: p.num, t: `${p.title} › ${h.text}`, v: v.n, s: v.slug, a: h.id, k: 'section' });
      }
    }
  }
  return out;
}
module.exports = { searchIndex };
