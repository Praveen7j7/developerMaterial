/* Shared Mermaid source sanitizer.
 *
 * Twenty writers produce hundreds of diagrams; a handful will always contain
 * characters the parser treats as syntax. Rather than chase each one by hand we
 * normalise the known-hostile cases here, and both the validator and the book
 * builder run the same function so they never disagree.
 *
 * Fixes applied:
 *  1. Semicolons in sequenceDiagram message text (";" is a statement separator).
 *  2. Semicolons in flowchart/state edge labels written as |...| .
 *  3. "end" as a bare node id in flowcharts (reserved word).
 *  4. Trailing whitespace and tabs, which break indentation-sensitive blocks.
 */

const ARROW = /(-{1,2}>>?|--?[)x]|-{1,2}>|<<-{1,2}|\.\.>|-{1,2})/;

function sanitizeMermaid(src) {
  if (!src) return src;
  const lines = String(src).replace(/\r\n/g, '\n').replace(/\t/g, '  ').split('\n');
  // Determine the diagram type from the first non-empty, non-directive line.
  let type = '';
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith('%%')) continue;
    type = t.split(/\s+/)[0].toLowerCase();
    break;
  }
  const isSequence = type === 'sequencediagram';

  const out = lines.map(line => {
    let l = line.replace(/\s+$/, '');
    if (!l.trim()) return l;

    if (isSequence) {
      // participant/actor/note/loop/alt/opt/par/rect/activate lines: leave the
      // keyword alone but clean the label after the first colon.
      const msg = /^(\s*)([A-Za-z0-9_]+\s*(?:-{1,2}>>?|-{1,2}[)x]|-{1,2}>)\s*[A-Za-z0-9_]+\s*:)([\s\S]*)$/.exec(l);
      if (msg) {
        return msg[1] + msg[2] + msg[3].replace(/;/g, ',');
      }
      const noteLike = /^(\s*)(Note\s+(?:over|left of|right of)\s+[^:]+:)([\s\S]*)$/i.exec(l);
      if (noteLike) {
        return noteLike[1] + noteLike[2] + noteLike[3].replace(/;/g, ',');
      }
      return l;
    }

    // Non-sequence diagrams: clean |edge labels| and quoted labels.
    l = l.replace(/\|([^|]*)\|/g, (m, inner) => '|' + inner.replace(/;/g, ',') + '|');
    l = l.replace(/"([^"]*)"/g, (m, inner) => '"' + inner.replace(/;/g, ',') + '"');

    // `end` is reserved; rename a bare `end` node id to `endNode`.
    if (/^(flowchart|graph)$/.test(type)) {
      l = l.replace(/(^|[\s\[\]|>-])end(\s*[\[({])/g, (m, pre, post) => pre + 'endNode' + post);
      l = l.replace(/(-->|---|-\.->|==>)(\s*)end(\s|$)/g, (m, arrow, sp, tail) => arrow + sp + 'endNode' + tail);
    }
    return l;
  });

  return out.join('\n');
}

module.exports = { sanitizeMermaid };
