/* Markdown -> HTML for one Part, with the site's transforms:
 *   - heading ids exactly as before (bookmarks keep working)
 *   - the Part's H1 becomes the Part header card (built by the caller)
 *   - #### teaching blocks get an icon and a tone wrapper
 *   - "Worked answer to the exercise" and the Q&A answers of Parts 59, 80 and 89 collapse
 *     behind "Show answer" (<details>, so the text stays in the page for search and print)
 *   - interview-question list items with an answer collapse the answer the same way
 *   - code blocks get a language label and a Copy button; diagrams get a full-screen button
 */
const { marked } = require('marked');
const hljs = require('highlight.js');
require('../hljs-extra')(hljs);
const { sanitizeMermaid } = require('../mermaid-sanitize');
const { TEACHING_BLOCKS } = require('./config');
const { slugify, escapeHtml, stripTags } = require('./util');
const { icon } = require('./icons');

const LANGMAP = { ts: 'typescript', js: 'javascript', sh: 'bash', shell: 'bash', yml: 'yaml', dockerfile: 'dockerfile', psql: 'sql', pgsql: 'sql', text: 'plaintext', txt: 'plaintext', http: 'http', json: 'json' };
const LANG_LABEL = { typescript: 'TypeScript', javascript: 'JavaScript', tsx: 'TSX', jsx: 'JSX', bash: 'Shell', sql: 'SQL', json: 'JSON', yaml: 'YAML', dockerfile: 'Dockerfile', plaintext: 'Text', http: 'HTTP', html: 'HTML', xml: 'XML', css: 'CSS', hcl: 'HCL', go: 'Go', python: 'Python', java: 'Java', rust: 'Rust', promql: 'PromQL', rego: 'Rego', graphql: 'GraphQL', protobuf: 'Protobuf', proto: 'Protobuf', nginx: 'Nginx', ini: 'INI', toml: 'TOML', diff: 'Diff', markdown: 'Markdown', md: 'Markdown', csharp: 'C#', c: 'C', cpp: 'C++', kotlin: 'Kotlin', ruby: 'Ruby', php: 'PHP', lua: 'Lua', makefile: 'Makefile', text: 'Text', console: 'Console' };


const teachingKind = text => {
  for (const [re, ic, tone] of TEACHING_BLOCKS) if (re.test(text)) return { icon: ic, tone };
  return null;
};

const html = text => ({ type: 'html', block: true, pre: false, raw: text, text });

// "Try it first" card: the blockquote's own parts become a practice card.
const TRY_LABELS = { 'Build': 'target', 'Requirements': 'list-checks', 'Scale and constraints': 'layers', 'Constraints': 'layers', 'Your task': 'pencil-line' };
function tryCard(raw) {
  const lines = raw.split('\n').map(l => l.replace(/^\s*>\s?/, ''));
  const head = /Level:\s*(\w+)\s*·\s*About\s+(\d+)\s+minutes/.exec(lines[0]) || [];
  const level = head[1] || 'Beginner', minutes = head[2] || '';
  let body = marked.parse(lines.slice(1).join('\n'), { gfm: true, mangle: false, headerIds: false });
  body = body.replace(/<p><strong>(Build|Requirements|Scale and constraints|Constraints|Your task):<\/strong>\s*([\s\S]*?)<\/p>/g, (m, label, rest) =>
    `<p class="try-label">${icon(TRY_LABELS[label])}<span>${label}</span></p>` + (rest.trim() ? `<p>${rest.trim().replace(/^[a-z]/, c => c.toUpperCase())}</p>` : ''));  // the body continued the bold label in Markdown, so it starts lowercase
  // the closing line ("Spend the time on paper ...") is the last paragraph
  body = body.replace(/<p>((?:(?!<p>)[\s\S])*?)<\/p>\s*$/, (m, t) => /class="try-label"/.test(m) ? m : `<p class="try-close">${t}</p>`);
  const lv = level.toLowerCase();
  return `<div class="try" role="note" aria-label="Try it first, ${level} level, about ${minutes} minutes">` +
    `<div class="try-head"><span class="try-icon">${icon('pencil-line')}</span><span class="try-title">Try it first</span>` +
    `<span class="lv" data-level="${lv}">${level}</span><span class="try-time">${icon('clock')}<span>About ${minutes} minutes</span></span></div>` +
    `<div class="try-body">${body}</div></div>\n`;
}

// Insert wrapper open/close tokens around heading-led groups.
// Each open wrapper has a level; a heading of depth d closes every wrapper with level >= d.
function wrapTokens(tokens, part) {
  const out = []; const stack = [];
  const closeTo = d => { while (stack.length && stack[stack.length - 1].level >= d) out.push(html(stack.pop().close)); };
  let lastHeading = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // a Try-it-first card right under a ## heading: card, then the model design collapsed until the next ##
    if (t.type === 'blockquote' && lastHeading && lastHeading.depth === 2 && /^\s*>\s*\*\*Try it first\*\*/.test(t.raw)) {
      let subs = 0;
      for (let j = i + 1; j < tokens.length && !(tokens[j].type === 'heading' && tokens[j].depth <= 2); j++) if (tokens[j].type === 'heading' && tokens[j].depth === 3) subs++;
      out.push(html(tryCard(t.raw)));
      out.push(html(`<details class="design" data-design><summary class="design-sum">${icon('book-open')}<span class="reveal-show">Show the model design</span><span class="reveal-hide">Hide the model design</span>${subs ? `<span class="design-meta">${subs} sections</span>` : ''}</summary><div class="design-body">`));
      stack.push({ level: 2, close: `<div class="design-end"><button type="button" class="btn btn-small design-close">${icon('arrow-up')}<span>Hide the model design</span></button></div></div></details>` });
      lastHeading = null;
      continue;
    }
    if (t.type !== 'space') lastHeading = t.type === 'heading' ? t : null;
    if (t.type === 'heading') {
      closeTo(t.depth);
      const plain = stripTags(t.text);
      if (t.depth === 4) {
        const kind = teachingKind(plain);
        if (/^worked answer/i.test(plain)) {
          out.push(html('<div class="tb tb-practice tb-worked">'), t,
            html(`<details class="reveal"><summary>${icon('circle-check')}<span class="reveal-show">Show worked answer</span><span class="reveal-hide">Hide worked answer</span></summary><div class="reveal-body">`));
          stack.push({ level: 4, close: '</div></details></div>' });
          continue;
        }
        if (kind) {
          out.push(html(`<div class="tb tb-${kind.tone}">`), t);
          stack.push({ level: 4, close: '</div>' });
          continue;
        }
      }
      if (t.depth === 3 && part.qa && /^Q\d+\b/.test(plain)) {
        out.push(t, html(`<details class="reveal reveal-q"><summary>${icon('circle-check')}<span class="reveal-show">Show answer</span><span class="reveal-hide">Hide answer</span></summary><div class="reveal-body">`));
        stack.push({ level: 4, close: '</div></details>' });  // closes at the next h1-h4
        continue;
      }
    }
    out.push(t);
  }
  closeTo(0);
  return out;
}

// An interview-question list item "<strong>Question</strong> answer" or "Question? Expected: answer"
// becomes the question plus a collapsed answer. Anything less regular is left as it is.
function splitInterviewItem(text) {
  if (/<(p|pre|ul|ol|div|table)\b/.test(text)) return null;
  let q, a;
  const lead = /^\s*(<(strong|em)>[\s\S]+?<\/\2>)\s*([\s\S]*)$/.exec(text);
  if (lead && stripTags(lead[3]).trim().length > 20) { q = lead[1]; a = lead[3]; }
  else {
    const m = /^([\s\S]+?[?.])\s+((?:<(?:strong|em)>)?Expected(?: answer)?:[\s\S]*)$/.exec(text);
    if (!m) return null;
    q = m[1]; a = m[2];
  }
  return `<span class="iq-q">${q}</span><details class="reveal reveal-inline"><summary><span class="reveal-show">Show answer</span><span class="reveal-hide">Hide answer</span></summary><div class="reveal-body">${a}</div></details>`;
}

/**
 * Render one Part.
 * @param {object} part      from content.js (num, md, headings)
 * @param {function} titleCard (id, innerHtml) => HTML for the Part header card, replacing the H1
 */
function renderPart(part, titleCard) {
  const headings = part.headings;
  let cursor = 0; const extra = new Map();
  let inInterview = false;
  const renderer = new marked.Renderer();

  renderer.heading = function (text, level) {
    let id;
    const plain = stripTags(text);
    if (level <= 3) {
      const h = headings[cursor];
      if (h && h.level === level && slugify(h.text) === slugify(plain)) { id = h.id; cursor++; }
      else {
        const idx = headings.findIndex((x, i) => i >= cursor && x.level === level && slugify(x.text) === slugify(plain));
        if (idx >= 0) { id = headings[idx].id; cursor = idx + 1; }
      }
    }
    if (!id) { const b = slugify(plain) || 'section'; const n = (extra.get(b) || 0) + 1; extra.set(b, n); id = n > 1 ? `${b}-x${n}` : `${b}-x`; }
    if (level <= 4) inInterview = level === 4 && /^interview questions/i.test(plain);
    if (level === 1) return titleCard(id, text);
    if (level === 2) {
      const cls = /key takeaways\s*$/i.test(plain) ? ' class="takeaways-h"' : /^senior checklist/i.test(plain) ? ' class="checklist-h"' : '';
      const tr = part.tries && part.tries[id];  // a design section with a Try-it-first card: its level for the rail
      return `<h2 id="${id}"${cls}${tr ? ` data-try="${tr.level.toLowerCase()}"` : ''}>${text}</h2>\n`;
    }
    if (level === 4) {
      const kind = teachingKind(plain);
      if (kind) return `<h4 id="${id}" class="tb-h">${icon(kind.icon)}<span>${text}</span></h4>\n`;
    }
    return `<h${level} id="${id}">${text}</h${level}>\n`;
  };

  renderer.code = function (code, infostring) {
    const lang = (infostring || '').trim().split(/\s+/)[0].toLowerCase();
    if (lang === 'mermaid') {
      return `<figure class="diagram"><pre class="mermaid">${escapeHtml(sanitizeMermaid(code))}</pre>` +
        `<button type="button" class="diagram-open" aria-label="Open diagram full screen" title="Open full screen">${icon('maximize-2')}</button></figure>\n`;
    }
    const l = LANGMAP[lang] || lang;
    let body;
    if (l && hljs.getLanguage(l)) { try { body = hljs.highlight(code, { language: l, ignoreIllegals: true }).value; } catch { body = escapeHtml(code); } }
    else body = escapeHtml(code);
    const label = LANG_LABEL[l] || (l ? l[0].toUpperCase() + l.slice(1) : 'Text');
    // the Copy button is added by site.js into this fixed-height head (saves ~200 bytes per block)
    return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span></div>` +
      `<pre class="code" tabindex="0"><code class="hljs language-${escapeHtml(l || 'text')}">${body}</code></pre></div>\n`;
  };

  renderer.table = (header, body) => `<div class="table-wrap" tabindex="0"><table><thead>${header}</thead><tbody>${body}</tbody></table></div>\n`;

  const baseListItem = renderer.listitem.bind(renderer);
  renderer.listitem = function (text, task, checked) {
    if (inInterview && !task) {
      const split = splitInterviewItem(text);
      if (split) return `<li class="iq">${split}</li>\n`;
    }
    return baseListItem(text, task, checked);
  };

  const opts = { gfm: true, breaks: false, mangle: false, headerIds: false };
  const tokens = marked.lexer(part.md, opts);
  return marked.parser(wrapTokens(tokens, part), { ...opts, renderer });
}

module.exports = { renderPart };
