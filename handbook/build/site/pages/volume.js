/* One page per volume: the volume header, then each Part (header card, body, end with
 * Mark-as-read and Previous / Next), the "On this page" rail, and the old-bookmark redirects.
 */
const { PAST_NUMBERINGS, SITE_TITLE } = require('../config');
const { slugify, escapeHtml, inlineMd, plainMd, duration, num } = require('../util');
const { icon } = require('../icons');
const { cover } = require('../covers');
const { renderPart } = require('../markdown');
const { shell } = require('../components');

const plural = (n, one, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`;

function partHeader(p, v, id) {
  const learn = p.sections.map(h => {
    const m = /^(\d+\.\d+)\s+(.*)$/.exec(h.text);
    return `<li><a href="#${h.id}"><span class="ll-n">${m ? m[1] : ''}</span><span class="ll-t">${inlineMd(m ? m[2] : h.text)}</span></a></li>`;
  }).join('');
  const meta = [
    ['clock', `${duration(p.minutes)} read`],
    ['layers', plural(p.sections.length, 'section')],
    p.diagrams ? ['git-branch', plural(p.diagrams, 'diagram')] : null,
    p.code ? ['code-xml', plural(p.code, 'code example')] : null,
    Object.keys(p.tries).length ? ['pencil-line', plural(Object.keys(p.tries).length, 'design to try first', 'designs to try first')] : null,
  ].filter(Boolean).map(([ic, t]) => `<li>${icon(ic)}<span>${t}</span></li>`).join('');
  return `<header class="part-head">
<div class="ph-top"><span class="ph-num" aria-hidden="true"><small>Part</small>${p.num}</span>
<div class="ph-titles"><p class="ph-vol"><a href="${v.file}">Volume ${v.n}: ${escapeHtml(v.title)}</a></p>
<h1 id="${id}" class="part-title"><span class="sr-only">Part ${p.num} — </span><span class="ph-title">${inlineMd(p.title)}</span></h1></div></div>
<ul class="ph-meta">${meta}</ul>
${learn ? `<div class="ph-learn"><h2 class="ph-learn-h">What you will learn</h2><ol class="learn-list${p.sections.length > 8 ? ' is-long' : ''}">${learn}</ol>` +
    (p.sections.length > 8 ? `<button type="button" class="learn-more" aria-expanded="false">${icon('chevron-down')}<span class="lm-more">Show all ${p.sections.length} sections</span><span class="lm-less">Show fewer</span></button>` : '') + '</div>' : ''}
${Object.keys(p.tries).length ? `<div class="ph-actions"><p>Each design opens with a short brief to try on paper; the model design stays folded until you open it.</p><button type="button" class="btn btn-small designs-toggle" data-part="${p.num}" aria-pressed="false">${icon('book-open')}<span>Open all model designs</span></button></div>` : ''}
</header>`;
}

function partEnd(p) {
  const link = (q, dir) => q ? `<a class="pn pn-${dir}" href="${q.href}" rel="${dir}">` +
    `<span class="pn-dir">${dir === 'prev' ? icon('chevron-left') + 'Previous' : 'Next' + icon('chevron-right')}</span>` +
    `<span class="pn-t"><span class="pn-num">Part ${q.num}</span> ${escapeHtml(plainMd(q.title))}</span></a>` : '<span class="pn pn-none"></span>';
  return `<footer class="part-end">
<nav class="part-nav" aria-label="Previous and next Part">${link(p.prev, 'prev')}${link(p.next, 'next')}</nav>
</footer>`;
}

function volumeHead(v) {
  const rows = v.parts.map(p => `<li><a href="#part-${p.num}" data-part="${p.num}"><span class="vp-n">${p.num}</span><span class="vp-t">${escapeHtml(plainMd(p.title))}</span><span class="vp-m">${duration(p.minutes)}</span></a></li>`).join('');
  return `<header class="vol-head">
<div class="vh-cover">${cover(v.cover, '')}</div>
<div class="vh-text"><p class="vh-n">Volume ${v.n}</p><h1 class="vol-h1">${escapeHtml(v.title)}</h1>
<p class="vol-blurb">${escapeHtml(v.blurb)}</p>
<ul class="vh-meta"><li>${icon('book-open')}<span>${plural(v.parts.length, 'Part')}</span></li><li>${icon('clock')}<span>${duration(v.minutes)} reading</span></li><li>${icon('git-branch')}<span>${plural(v.diagrams, 'diagram')}</span></li></ul></div>
<ol class="vh-parts">${rows}</ol>
</header>`;
}

function rail() {
  return `<aside id="rail" class="rail" aria-labelledby="rail-h"><div class="rail-in">
<div class="rail-head"><h2 id="rail-h" class="rail-title">On this page</h2><button type="button" class="rail-hide" data-action="toggle-rail" aria-controls="rail" aria-expanded="true" aria-label="Hide On this page">${icon('panel-right-close')}<span>Hide</span></button></div>
<p class="rail-part"><a href="#" data-rail-part></a></p>
<ol class="rail-list" data-rail-list></ol>
<div class="rail-foot"><button type="button" class="btn btn-small btn-quiet" data-action="to-top">${icon('arrow-up')}<span>Back to top</span></button></div>
</div></aside>`;
}

// Old bookmarks: the same heading as it was numbered before each renumbering.
function oldAnchorMap(v) {
  const oldAnchors = {}; const pageIds = new Set();
  for (const p of v.parts) {
    pageIds.add(`part-${p.num}`);
    for (const h of p.headings) pageIds.add(h.id);
    for (const oldOf of PAST_NUMBERINGS) {
      const old = oldOf(p.num);
      if (old == null || old === p.num) continue;
      oldAnchors[`part-${old}`] = `part-${p.num}`;
      for (const h of p.headings) {
        const oldText = h.level === 1 ? h.text.replace(/^Part \d+/, `Part ${old}`) : h.text.replace(new RegExp(`^${p.num}\\.`), `${old}.`);
        const oldId = slugify(oldText);
        if (oldId && oldId !== h.id) oldAnchors[oldId] = h.id;
      }
    }
  }
  for (const k of Object.keys(oldAnchors)) if (pageIds.has(k) || oldAnchors[k] === k) delete oldAnchors[k];  // a current anchor always wins
  return oldAnchors;
}

function volumePage(v, book) {
  let main = volumeHead(v);
  for (const p of v.parts) {
    const body = renderPart(p, (id) => partHeader(p, v, id));
    main += `<section class="part" id="part-${p.num}" data-part="${p.num}" data-title="${escapeHtml(plainMd(p.title))}"><div class="prose">${body}</div>${partEnd(p)}</section>\n`;
  }
  const m = oldAnchorMap(v);
  main += `<script>(function(){var m=${JSON.stringify(m)};function go(){var h=decodeURIComponent(location.hash.slice(1));if(h&&!document.getElementById(h)&&m[h]){history.replaceState(null,'','#'+m[h]);var e=document.getElementById(m[h]);if(e){for(var d=e.closest('details');d;d=d.parentElement.closest('details'))d.open=true;e.scrollIntoView();}}}go();window.addEventListener('hashchange',go);})();</script>`;
  return shell({
    page: 'vol', vol: v, book, main, rail: rail(),
    title: `Volume ${v.n} — ${v.title} | ${SITE_TITLE}`,
    description: v.blurb,
  });
}

module.exports = { volumePage };
