/* Small shared helpers. slugify() must stay exactly as it is: every heading id
 * (and so every bookmark people have saved) is derived from it. */

function slugify(s) {
  return s.toLowerCase().replace(/[`*_~]/g, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Turn rendered inline HTML back into plain text (for search, labels and titles).
function stripTags(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Inline markdown in a heading (backticks, emphasis) to safe HTML, without paragraphs.
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
}

// Plain heading text without markdown markers.
function plainMd(s) {
  return String(s).replace(/[`*_]/g, '');
}

// "Parts 5–8, 61" from [5,6,7,8,61]: collapses consecutive runs into ranges.
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

// 95 -> "1 h 35 min", 40 -> "40 min"
function duration(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function hours(min) {
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`;
}

const num = n => n.toLocaleString('en-US');

module.exports = { slugify, escapeHtml, stripTags, inlineMd, plainMd, rangeLabel, duration, hours, num };
