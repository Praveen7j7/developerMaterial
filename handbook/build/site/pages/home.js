/* The home page. In order: hero (what this is, who it is for, search, first step) with the
 * "shelf" of nine volumes; the Start-here path picker; the volume cards; the roadmap strip; and the book in numbers.
 */
const { SITE_TITLE, START_PATHS, volFile } = require('../config');
const { escapeHtml, plainMd, hours, duration, num } = require('../util');
const { icon } = require('../icons');
const { cover } = require('../covers');
const { shell } = require('../components');

function target(book, t) {
  if (typeof t === 'string' && t.startsWith('vol:')) {
    const v = book.volumes.find(x => x.n === Number(t.slice(4)));
    return { href: v.file, vol: v.n, title: `Volume ${v.n}: ${v.title}` };
  }
  const p = book.parts[t];
  return { href: p.href, vol: p.vol.n, title: `Part ${p.num}: ${plainMd(p.title)}` };
}

function shelf(book) {
  const spines = book.volumes.map(v => `<li data-vol="${v.n}" style="flex-grow:${v.minutes}"><a href="${v.file}" title="Volume ${v.n}: ${escapeHtml(v.title)}, ${hours(v.minutes)} of reading">` +
    `<span class="sp-t sp-long" aria-hidden="true">${escapeHtml(v.title)}</span><span class="sp-t sp-short" aria-hidden="true">${escapeHtml(v.short)}</span><span class="sp-n" aria-hidden="true">${v.n}</span>` +
    `<span class="sr-only">Volume ${v.n}: ${escapeHtml(v.title)}, ${hours(v.minutes)} of reading</span></a></li>`).join('');
  return `<figure class="shelf"><ol class="shelf-row" aria-label="The nine volumes">${spines}</ol>
<figcaption>The whole book on one shelf. Each spine is a volume; its width is its reading time${' '}(${hours(book.totals.minutes)} in all).</figcaption></figure>`;
}

function hero(book) {
  return `<section class="hero" aria-labelledby="hero-h">
<div class="hero-text">
<h1 id="hero-h" class="hero-h1">${SITE_TITLE}</h1>
<p class="hero-lead">How backend systems really work, from your first line of code to principal engineer: ${book.totals.parts} Parts in plain language, with diagrams, real code and production stories.</p>
<p class="hero-for">For beginners, working backend and full-stack developers, senior engineers and architects. Free to read in your browser.</p>
<div class="hero-search" role="search"><label class="search-field search-big">${icon('search')}<span class="sr-only">Search the handbook</span>
<input type="search" id="hero-q" placeholder="Search a topic" data-long-placeholder="Search a topic: caching, event loop, indexes…" autocomplete="off" spellcheck="false" aria-controls="hero-results" aria-autocomplete="list"></label>
<ul id="hero-results" class="search-results search-pop" role="listbox" aria-label="Search results" hidden></ul></div>
<div class="hero-actions"><a class="btn btn-primary" href="${book.parts[0].href}">${icon('book-open')}<span>Start with Part 0</span></a><a class="btn" href="#start">${icon('target')}<span>Find your starting point</span></a></div>
</div>
${shelf(book)}
</section>`;
}

function startHere(book) {
  const cards = START_PATHS.map(sp => {
    const ts = sp.go.map(([label, t]) => ({ label, ...target(book, t) }));
    const route = ts.map((t, i) => `<li><a href="${t.href}" data-vol="${t.vol}" title="${escapeHtml(t.title)}">${sp.id === 'interview' ? 'Part ' : ''}${escapeHtml(t.label)}</a></li>`).join('');
    return `<li class="path" data-vol="${ts[0].vol}">
<span class="path-icon">${icon(sp.icon)}</span>
<h3 class="path-who"><a href="${ts[0].href}">${escapeHtml(sp.who)}</a></h3>
<p class="path-why">${escapeHtml(sp.why)}</p>
<ol class="path-route" aria-label="Read in this order">${route}</ol>
</li>`;
  }).join('');
  return `<section class="start" id="start" aria-labelledby="start-h">
<h2 id="start-h" class="home-h2">Where do you want to start?</h2>
<p class="home-sub">Pick the line that sounds most like you. Every route is a reading order, not a lock: you can open any Part at any time.</p>
<ul class="paths">${cards}</ul>
</section>`;
}

function volumeCards(book) {
  const cards = book.volumes.map(v => `<li class="vol-card" data-vol="${v.n}">
<div class="vc-cover">${cover(v.cover, '')}</div>
<div class="vc-body"><p class="vc-n">Volume ${v.n}</p>
<h3 class="vc-title"><a href="${v.file}">${escapeHtml(v.title)}</a></h3>
<p class="vc-blurb">${escapeHtml(v.blurb)}</p>
<ul class="vc-meta"><li>${icon('book-open')}<span>${v.parts.length} Parts</span></li><li>${icon('clock')}<span>${hours(v.minutes)}</span></li></ul></div>
</li>`).join('');
  return `<section class="volumes" id="volumes" aria-labelledby="volumes-h">
<h2 id="volumes-h" class="home-h2">The nine volumes</h2>
<p class="home-sub">Read them in order or jump to the one you need. Each volume is one page; the contents button at the top left lists every Part.</p>
<ol class="vol-grid">${cards}</ol>
</section>`;
}

function roadmapStrip(stages) {
  const steps = stages.map(s => `<li><a href="roadmap.html#stage-${s.n}"><span class="rs-n">Stage ${s.n}</span><span class="rs-name">${escapeHtml(s.name)}</span><span class="rs-time">${escapeHtml(s.time)}</span></a></li>`).join('');
  return `<section class="road-strip" aria-labelledby="road-h">
<div class="rs-head"><h2 id="road-h" class="home-h2">The learning roadmap</h2>
<p class="home-sub">Five stages from beginner to staff engineer, each with its reading order, what to build and how to know you are ready.</p></div>
<ol class="rs-steps">${steps}</ol>
<a class="btn" href="roadmap.html">${icon('map')}<span>Open the roadmap</span></a>
</section>`;
}

function inside(book) {
  const t = book.totals;
  const words = t.words >= 1e6 ? `${(t.words / 1e6).toFixed(1)} million` : num(t.words);
  const stats = [[num(t.parts), 'Parts'], [words, 'words'], [num(t.diagrams), 'diagrams'], [num(t.code), 'code examples'], [`${num(Math.round(t.minutes / 60))} hours`, 'of reading']];
  return `<section class="inside" aria-labelledby="inside-h">
<h2 id="inside-h" class="home-h2">What’s inside</h2>
<dl class="stats">${stats.map(([n, l]) => `<div><dt>${l}</dt><dd>${n}</dd></div>`).join('')}</dl>
<p class="home-sub">Every Part follows the same shape: the concept, why it exists, a mental model, how it works, real code, failure stories, common mistakes, interview questions and an exercise, then a senior checklist and key takeaways.</p>
</section>`;
}

function homePage(book, stages) {
  const main = `<div class="home">${hero(book)}${startHere(book)}${volumeCards(book)}${roadmapStrip(stages)}${inside(book)}</div>`;
  return shell({
    page: 'home', book, main, title: SITE_TITLE,
    description: `From your first line of code to principal engineer: ${book.totals.parts} Parts on backend and full-stack engineering, in plain language with diagrams and real code.`,
  });
}

module.exports = { homePage, volFile, duration };
