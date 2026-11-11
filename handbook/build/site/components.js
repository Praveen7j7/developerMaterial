/* Shared page pieces: <head>, top bar, book-tree sidebar, footer, dialogs, and the page shell.
 * Pages (pages/*.js) only build their <main> content and hand it to shell().
 */
const { EDITION, REPO_URL, SITE_TITLE, SHORT_TITLE } = require('./config');
const { escapeHtml, rangeLabel } = require('./util');
const { icon, spriteFor } = require('./icons');

// Runs in <head> before first paint: theme and sidebar/rail visibility (device preferences only),
// so nothing jumps when site.js arrives. Every storage access is guarded.
const BOOT = `(function(d){var r=d.documentElement,c=r.classList;c.add('js');try{var s=window.localStorage,t=s.getItem('bh-theme');if(t==='dark'||t==='light')r.setAttribute('data-theme',t);if(s.getItem('bh-sidebar')==='0')c.add('sb-off');if(s.getItem('bh-rail')==='0')c.add('rail-off')}catch(e){}})(document)`;

// The brand mark: three book spines on a shelf.
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect x="5" y="6" width="6" height="20" rx="1.5" fill="var(--mark-1)"/><rect x="12.5" y="3" width="6" height="23" rx="1.5" fill="var(--mark-2)"/><rect x="20.5" y="8.5" width="6" height="18" rx="1.5" transform="rotate(12 23.5 17.5)" fill="var(--mark-3)"/><rect x="3" y="27" width="26" height="2.2" rx="1.1" fill="currentColor"/></svg>`;

function head({ title, description, withMermaid, pageCss }) {
  return `<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="5" y="6" width="6" height="20" rx="1.5" fill="#327437"/><rect x="12.5" y="3" width="6" height="23" rx="1.5" fill="#3e61a4"/><rect x="20.5" y="8.5" width="6" height="18" rx="1.5" transform="rotate(12 23.5 17.5)" fill="#9a4541"/><rect x="3" y="27" width="26" height="2.2" rx="1.1" fill="#221e19"/></svg>')}">
<meta name="theme-color" content="#fbf7ef" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1a1713" media="(prefers-color-scheme: dark)">
<script>${BOOT}</script>
<link rel="stylesheet" href="assets/site.css">
<link rel="stylesheet" href="assets/${pageCss}">
${withMermaid ? '<script defer src="assets/mermaid.min.js"></script>\n' : ''}<script defer src="assets/site.js"></script>
${withMermaid ? '<script defer src="assets/read.js"></script>' : ''}
</head>`;
}

function topbar({ page, vol, book }) {
  const isVol = page === 'vol';
  const crumbs = isVol ? `<nav class="crumbs" aria-label="Breadcrumb"><ol>
<li class="crumb-vol"><a href="${vol.file}">Volume ${vol.n}</a></li>
<li class="crumb-part"><a href="${vol.file}#part-${vol.partNums[0]}" data-crumb="part">Part ${vol.partNums[0]}</a></li>
<li class="crumb-sec"><span data-crumb="section" aria-current="location">${escapeHtml(vol.title)}</span></li></ol></nav>` : '<span class="tb-spacer"></span>';
  const volItems = book.volumes.map(v => `<li><a href="${v.file}" data-vol="${v.n}"${isVol && v.n === vol.n ? ' aria-current="page"' : ''}>` +
    `<span class="vm-dot" aria-hidden="true"></span><span class="vm-n">Volume ${v.n}</span><span class="vm-t">${escapeHtml(v.title)}</span>` +
    `<span class="vm-p">${v.parts.length} Parts</span></a></li>`).join('');
  const navLink = (href, ic, label, current) => `<a class="tb-link" href="${href}"${current ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  return `<header class="topbar">
<div class="topbar-in">
<button type="button" class="tb-btn tb-contents" data-action="toggle-sidebar" aria-controls="sidebar" aria-expanded="${isVol}" aria-label="${isVol ? 'Hide' : 'Show'} contents">${icon('panel-left-open', 'when-closed')}${icon('panel-left-close', 'when-open')}<span class="tb-label">Contents</span></button>
<a class="brand" href="index.html">${MARK}<span class="brand-name">${SHORT_TITLE}</span></a>
${crumbs}
<nav class="tb-nav" aria-label="Site">
${navLink('index.html', 'house', 'Home', page === 'home')}
${navLink('roadmap.html', 'map', 'Roadmap', page === 'roadmap')}
<div class="menu-wrap"><button type="button" class="tb-link" data-action="toggle-menu" aria-expanded="false" aria-controls="vol-menu">${icon('library')}<span>Volumes</span>${icon('chevron-down', 'ic-sm')}</button>
<div class="menu" id="vol-menu" hidden><ul>${volItems}</ul></div></div>
</nav>
<button type="button" class="tb-btn tb-search" data-action="open-search" aria-label="Search" aria-keyshortcuts="/">${icon('search')}<span class="tb-label">Search</span><kbd class="tb-kbd">/</kbd></button>
${isVol ? `<button type="button" class="tb-btn tb-rail" data-action="toggle-rail" aria-controls="rail" aria-expanded="true" aria-label="Hide On this page">${icon('panel-right-open', 'when-closed')}${icon('panel-right-close', 'when-open')}</button>` : ''}
<button type="button" class="tb-btn tb-theme" data-action="toggle-theme" aria-label="Switch to dark theme" aria-keyshortcuts="t">${icon('moon', 'when-light')}${icon('sun', 'when-dark')}</button>
</div>
</header>`;
}

function sidebar({ page, vol, book }) {
  const tree = book.volumes.map(v => {
    const open = page === 'vol' && v.n === vol.n;
    const items = v.parts.map(p => `<li><a href="${p.href}" data-part="${p.num}"><span class="tp-n">${p.num}</span><span class="tp-t">${escapeHtml(p.title)}</span></a></li>`).join('');
    return `<li class="tv" data-vol="${v.n}"><button type="button" class="tv-btn" aria-expanded="${open}" aria-controls="tv-${v.n}"><span class="tv-dot" aria-hidden="true"></span><span class="tv-name"><span class="tv-n">Volume ${v.n}</span><span class="tv-t">${escapeHtml(v.title)}</span></span><span class="tv-count">${v.parts.length}</span>${icon('chevron-down', 'tv-chev')}</button>` +
      `<ol id="tv-${v.n}"${open ? '' : ' hidden'}>${items}</ol></li>`;
  }).join('');
  return `<nav id="sidebar" class="sidebar" aria-label="Book contents">
<div class="sb-head"><span class="sb-title">Contents</span><button type="button" class="sb-hide" data-action="toggle-sidebar" aria-controls="sidebar" aria-expanded="true" aria-label="Hide contents">${icon('panel-left-close')}<span>Hide</span></button></div>
<ul class="sb-links">
<li><a href="index.html">${icon('house')}<span>Home</span></a></li>
<li><a href="roadmap.html">${icon('map')}<span>Roadmap</span></a></li>
</ul>
<ol class="tree">${tree}</ol>
</nav>`;
}

function footer(book) {
  return `<footer class="site-footer"><div class="footer-in">
<p class="footer-brand">${MARK}<span><strong>${SITE_TITLE}</strong><br>Edition ${EDITION}. ${book.totals.parts} Parts in ${book.volumes.length} volumes.</span></p>
<ul class="footer-links">
<li><a href="${REPO_URL}">${icon('code-xml')}<span>Source on GitHub</span></a></li>
<li><a href="roadmap.html">${icon('map')}<span>Learning roadmap</span></a></li>
<li><button type="button" data-action="open-keys">${icon('keyboard')}<span>Keyboard shortcuts</span></button></li>
<li><a href="assets/LICENSES.txt">${icon('book-open')}<span>Icon licence (Lucide, ISC)</span></a></li>
</ul></div></footer>`;
}

function dialogs(book) {
  const keys = [['/', 'Search'], ['j', 'Next section'], ['k', 'Previous section'], ['t', 'Switch light or dark theme'], ['[', 'Show or hide the contents sidebar'], [']', 'Show or hide On this page'], ['Esc', 'Close a menu, drawer or dialog'], ['?', 'Show these shortcuts']];
  return `<dialog id="search-dlg" class="dlg dlg-search" aria-labelledby="search-h">
<form method="dialog" class="search-form" role="search"><h2 id="search-h" class="sr-only">Search the handbook</h2>
<label class="search-field">${icon('search')}<span class="sr-only">Search all Parts and sections</span><input type="search" id="search-input" placeholder="Search the handbook" data-long-placeholder="Search ${book.totals.parts} Parts and every section" autocomplete="off" spellcheck="false" aria-controls="search-results" aria-autocomplete="list"></label>
<button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close search">${icon('x')}</button></form>
<ul id="search-results" class="search-results" role="listbox" aria-label="Search results"></ul>
<p class="search-hint">Try a topic such as <em>idempotency</em>, <em>event loop</em> or a Part number. Use the arrow keys to move, Enter to open.</p>
</dialog>
<dialog id="keys-dlg" class="dlg dlg-small" aria-labelledby="keys-h">
<div class="dlg-head"><h2 id="keys-h">Keyboard shortcuts</h2><button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close">${icon('x')}</button></div>
<dl class="keys">${keys.map(([k, d]) => `<div><dt><kbd>${escapeHtml(k)}</kbd></dt><dd>${d}</dd></div>`).join('')}</dl>
</dialog>
<dialog id="diagram-dlg" class="dlg dlg-diagram" aria-label="Diagram, full screen">
<div class="dg-bar"><button type="button" class="icon-btn" data-action="zoom-out" aria-label="Zoom out">${icon('zoom-out')}</button><button type="button" class="icon-btn" data-action="zoom-reset" aria-label="Fit to screen">${icon('rotate-ccw')}</button><button type="button" class="icon-btn" data-action="zoom-in" aria-label="Zoom in">${icon('zoom-in')}</button><span class="dg-spacer"></span><button type="button" class="icon-btn" data-action="close-dialog" aria-label="Close diagram">${icon('x')}</button></div>
<div class="dg-stage" tabindex="0"></div>
</dialog>`;
}

// The full page. `main` is the page's own content; `rail` is the right "On this page" rail (Part pages only).
function shell({ page, title, description, vol = null, book, main, rail = '', search = true }) {
  const body = `<a class="skip" href="#main">Skip to content</a>
${topbar({ page, vol, book })}
<div class="shell${rail ? ' has-rail' : ''}">
${sidebar({ page, vol, book })}
<main id="main" class="main" tabindex="-1">
${main}
</main>
${rail}
</div>
<div class="scrim" data-action="close-drawer" hidden></div>
${footer(book)}
${dialogs(book)}
<button type="button" class="to-top" data-action="to-top" aria-label="Back to top">${icon('arrow-up')}</button>`;
  return `<!doctype html>
<html lang="en" data-page="${page}"${vol ? ` data-vol="${vol.n}"` : ''}>
${head({ title, description, withMermaid: page === 'vol', pageCss: page === 'vol' ? 'read.css' : page + '.css' })}
<body>
${spriteFor(body)}
${body}
</body>
</html>
`;
}

module.exports = { shell, MARK, rangeLabel };
