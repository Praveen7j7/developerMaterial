/* The roadmap page: the five stages of Part 64 as a path (vertical on phones, a rising
 * staircase on wide screens), each with its goal, time and Parts in reading order,
 * plus a role switch that highlights the stages (and extra track) for one kind of engineer.
 */
const { ROLE_PATHS, SITE_TITLE } = require('../config');
const { escapeHtml, plainMd, inlineMd } = require('../util');
const { icon } = require('../icons');
const { shell } = require('../components');

function partItem(p, reread) {
  return `<li data-part="${p.num}" data-vol="${p.vol.n}"><a href="${p.href}"><span class="sp-n">${p.num}</span><span class="sp-t">${escapeHtml(plainMd(p.title))}${reread ? ' <span class="badge">re-read</span>' : ''}</span></a></li>`;
}

function roadmapPage(book, stages) {
  const p64 = book.parts[64];
  const stageAnchor = s => (p64.headings.find(h => h.level === 3 && h.text === s.anchor) || {}).id || 'part-64';
  const items = stages.map(s => {
    // "re-read": Part 64 asks for it again after an earlier stage already listed it
    const list = s.parts.map(n => partItem(book.parts[n], s.reread.includes(n) && stages.some(o => o.n < s.n && o.parts.includes(n)))).join('');
    return `<li class="stage" id="stage-${s.n}" data-stage="${s.n}">
<div class="st-marker" aria-hidden="true"><span class="st-num">${s.n}</span></div>
<div class="st-card">
<p class="st-time">${icon('clock')}<span>${escapeHtml(s.time)}</span></p>
<h2 class="st-name"><span class="st-label">Stage ${s.n}</span> ${escapeHtml(s.name)}</h2>
<p class="st-goal">${inlineMd(s.goal)}</p>
<details class="st-more" open><summary>${icon('chevron-down')}<span>${s.parts.length} Parts, in order</span></summary><ol class="st-parts">${list}</ol></details>
${s.ready ? `<p class="st-ready"><strong>Ready for the next stage when:</strong> ${inlineMd(s.ready)}</p>` : ''}
<p class="st-src"><a href="${p64.vol.file}#${stageAnchor(s)}">Full stage in Part 64 (build alongside, skills, exit test)</a></p>
</div></li>`;
  }).join('');

  const extras = ROLE_PATHS.filter(r => r.extra).map(r => `<li class="stage stage-extra" data-extra="${r.id}" hidden>
<div class="st-marker" aria-hidden="true"><span class="st-num">${icon('layers')}</span></div>
<div class="st-card"><h2 class="st-name">${escapeHtml(r.extra.title)}</h2><p class="st-goal">${escapeHtml(r.extra.note)}</p>
<ol class="st-parts">${r.extra.parts.filter(n => book.parts[n]).map(n => partItem(book.parts[n], false)).join('')}</ol></div></li>`).join('');

  const roles = ROLE_PATHS.map((r, i) => `<label class="seg"><input type="radio" name="role" value="${r.id}"${i === 0 ? ' checked' : ''}><span>${escapeHtml(r.label)}</span></label>`).join('');
  const roleData = Object.fromEntries(ROLE_PATHS.map(r => [r.id, { stages: r.stages, extra: r.extra ? r.id : null }]));

  const main = `<div class="roadmap">
<header class="rm-head">
<p class="rm-from"><a href="${p64.href}">From Part 64: ${escapeHtml(plainMd(p64.title))}</a></p>
<h1 class="rm-h1">The learning roadmap</h1>
<p class="rm-lead">Five stages from beginner to staff engineer. Each stage has a goal, a reading order and a realistic time for someone who studies alongside a full-time job. Choose a path to see which stages it covers.</p>
<fieldset class="role-switch"><legend>Highlight a path</legend><div class="segs">${roles}</div></fieldset>
</header>
<ol class="stages" data-role="all">${items}${extras}</ol>
<script type="application/json" id="role-data">${JSON.stringify(roleData)}</script>
</div>`;
  return shell({
    page: 'roadmap', book, main, title: `Learning roadmap | ${SITE_TITLE}`,
    description: 'Five stages from beginner to staff engineer: what to read in which order, how long it takes, and how to know you are ready.',
  });
}

module.exports = { roadmapPage };
