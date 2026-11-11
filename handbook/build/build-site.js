/* Builds the reading website from chapters/*.md into site/ (static, GitHub Pages ready).
 *
 *   site/index.html            home page: what this is, where to start, the nine volumes
 *   site/roadmap.html          the five learning stages from Part 64, with role paths
 *   site/vol-N-<slug>.html     one page per volume (every Part of that volume)
 *   site/search-index.json     Part and heading index for the in-browser search
 *   site/assets/               site.css, site.js, mermaid.min.js, LICENSES.txt
 *
 * The code lives in build/site/ (see site/README-like comments at the top of each file):
 *   config.js      volumes, old numberings, start paths, role paths, teaching-block icons
 *   content.js     loads chapters and computes words, reading time, diagrams, code blocks
 *   markdown.js    markdown -> HTML with the site's transforms (answers, code blocks, diagrams)
 *   roadmap.js     parses the five stages out of Part 64
 *   components.js  head, top bar, sidebar, footer, dialogs, page shell
 *   pages/*.js     home, volume and roadmap pages
 *   search.js      search-index.json
 *   assets.js      copies assets/css/*.css and assets/js/*.js into site/assets/
 *   icons.js, icons-data.js (Lucide, ISC), covers.js (the nine volume covers)
 *
 * Usage: cd build && node build-site.js
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./site/config');
const { loadBook } = require('./site/content');
const { parseRoadmap, findRoadmapPart } = require('./site/roadmap');
const { homePage } = require('./site/pages/home');
const { volumePage } = require('./site/pages/volume');
const { roadmapPage } = require('./site/pages/roadmap');
const { searchIndex } = require('./site/search');
const { writeAssets } = require('./site/assets');

const t0 = Date.now();
fs.mkdirSync(PATHS.SITE_ASSETS, { recursive: true });
const book = loadBook();
const stages = parseRoadmap(findRoadmapPart(book.parts), book.parts);
const write = (name, html) => { fs.writeFileSync(path.join(PATHS.SITE, name), html); return Buffer.byteLength(html); };

const sizes = {};
sizes['index.html'] = write('index.html', homePage(book, stages));
sizes['roadmap.html'] = write('roadmap.html', roadmapPage(book, stages));
for (const v of book.volumes) {
  sizes[v.file] = write(v.file, volumePage(v, book));
  console.log(`Volume ${v.n} ${v.title.padEnd(26)} ${String(v.parts.length).padStart(2)} parts  ${(sizes[v.file] / 1024).toFixed(0).padStart(5)} KB`);
}
const idx = searchIndex(book);
fs.writeFileSync(path.join(PATHS.SITE, 'search-index.json'), JSON.stringify(idx));
const a = writeAssets();

console.log(`\nSite built to ${PATHS.SITE} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`Home + roadmap + ${book.volumes.length} volume pages, ${idx.length} search entries.`);
console.log(`Roadmap stages parsed from Part ${findRoadmapPart(book.parts).num}: ${stages.map(s => `${s.n}:${s.parts.length}`).join(' ')}`);
const tries = book.order.reduce((a, p) => a + Object.keys(p.tries).length, 0);
console.log(`Try-it-first cards: ${tries} in Parts ${book.order.filter(p => Object.keys(p.tries).length).map(p => p.num).join(', ')}`);
const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log(`Assets: ${Object.entries(a).map(([k, n]) => `${k} ${kb(n)}`).join(', ')}`);
console.log(`CSS + JS per page: volume ${kb(a['site.css'] + a['read.css'] + a['site.js'] + a['read.js'])}, home ${kb(a['site.css'] + a['home.css'] + a['site.js'])}, roadmap ${kb(a['site.css'] + a['roadmap.css'] + a['site.js'])} (Mermaid not counted)`);
console.log(`HTML: home ${kb(sizes['index.html'])}, roadmap ${kb(sizes['roadmap.html'])}`);
