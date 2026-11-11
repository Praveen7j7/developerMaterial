/* Responsive check of the reading site in headless Chrome.
 *
 * Serves site/ on a local port, opens four pages (home, roadmap, the top of vol-0 at Part 0,
 * and a diagram-and-code section of vol-4) at every size below, in light and dark, and:
 *   - FAILS if the page scrolls sideways (document.documentElement.scrollWidth > innerWidth)
 *   - FAILS if a control on a touch size is smaller than 44 x 44 px (buttons, summaries, nav links)
 *   - FAILS if any visible text is cut off with an ellipsis (text-overflow: ellipsis that overflows)
 *   - FAILS on any console error or page error
 *   - saves a screenshot of each view
 * Also shoots the sidebar/rail collapsed states at 1366x768 and 1920x1080, and a system design page
 * (vol-6 at 55.1: Try-it-first card with the model design folded, then opened) at four sizes.
 *
 * Usage: node shot-matrix.js [outDir] [--only=home,roadmap,vol0,vol4] [--sizes=390x844,1366x768] [--light]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const SITE = path.resolve(__dirname, '..', 'site');
const CHROME = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const args = process.argv.slice(2);
const opt = k => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1];
const OUT = path.resolve(args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'dist', 'shots-matrix'));
fs.mkdirSync(OUT, { recursive: true });

const SIZES = [[280, 653], [717, 512], [320, 568], [360, 800], [390, 844], [412, 915], [768, 1024], [820, 1180], [1024, 768], [1366, 768], [1920, 1080], [2560, 1080]]
  .filter(([w, h]) => !opt('sizes') || opt('sizes').split(',').includes(`${w}x${h}`));
const THEMES = args.includes('--light') ? ['light'] : ['light', 'dark'];
const PAGES = [
  { id: 'home', url: 'index.html' },
  { id: 'roadmap', url: 'roadmap.html' },
  { id: 'vol0', url: 'vol-0-from-scratch.html#part-0' },
  { id: 'vol4', url: 'vol-4-distributed-systems.html#275-the-classic-cache-problems', toDiagram: true },
  { id: 'design', url: 'vol-6-mastery.html#551-url-shortener', only: ['280x653', '320x568', '390x844', '768x1024', '1366x768', '1920x1080'] },
  { id: 'designopen', url: 'vol-6-mastery.html#551-url-shortener', open: true, only: ['390x844', '768x1024', '1366x768', '1920x1080'] },
].filter(p => !opt('only') || opt('only').split(',').includes(p.id));
const touch = w => w <= 1024;

// minimal static server for site/
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(req.url.split(/[?#]/)[0]).replace(/^\/+/, '') || 'index.html');
  if (!p.startsWith(SITE) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

const failures = [];
const fail = (where, what) => { failures.push(`${where}: ${what}`); console.log(`  FAIL ${where}: ${what}`); };

// runs in the page: sideways scroll and small touch targets
function audit(isTouch) {
  const de = document.documentElement;
  // innerWidth can grow past the device width on mobile when content is too wide, so report clientWidth too
  const out = { scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth), innerWidth: window.innerWidth, clientWidth: de.clientWidth, scrollX: window.scrollX, small: [], cut: [] };
  // text cut off with an ellipsis: find every CSS rule that sets text-overflow: ellipsis, then test its elements
  // (the breadcrumb section is shortened by site.js at a word boundary, not by CSS, so it never matches)
  const sels = [];
  const walk = rules => { for (const r of rules) { if (r.cssRules) walk(r.cssRules); if (r.style && r.style.textOverflow === 'ellipsis' && r.selectorText) sels.push(r.selectorText); } };
  for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) { /* cross-origin sheet */ } }
  for (const el of sels.length ? document.querySelectorAll(sels.join(',')) : []) {
    const cs = getComputedStyle(el);
    if (cs.textOverflow !== 'ellipsis' || cs.display === 'none' || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    if (el.closest('[hidden], dialog:not([open])')) continue;
    const vertical = cs.writingMode.startsWith('vertical');  // vertical text is cut along its height
    if (vertical ? el.scrollHeight > el.clientHeight + 1 : el.scrollWidth > el.clientWidth + 1) out.cut.push(`${el.className} "${el.textContent.trim().slice(0, 30)}"`);
  }
  if (isTouch) {
    const sel = 'button, summary, input, select, .tb-link, .brand, .crumbs a, .tv ol a, .sb-links a, .path-route a, .pn, .vh-parts a, .st-parts a, .search-results a, .footer-links a, .rs-steps a, .shelf-row a';
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('[hidden], dialog:not([open]), .sr-only, [inert]')) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || !r.height || cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;  // only what is on screen
      if (el.matches('input[type="radio"], input[type="checkbox"]')) continue;                  // labelled by a bigger target
      const minW = el.matches('.shelf-row a') ? 24 : 44;                                         // spines: width is reading time
      if (r.height < 43.5 || r.width < minW - .5) out.small.push(`${el.tagName.toLowerCase()}.${String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).split(' ')[0]} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  return out;
}

async function settle(page, toDiagram) {
  const target = () => {
    const h = document.getElementById(location.hash.slice(1));
    if (!h) return;
    const d = [...document.querySelectorAll('.diagram')].find(x => h.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
    window.scrollTo(0, (d || h).getBoundingClientRect().top + scrollY - 90);
  };
  // diagrams render lazily and change the layout above the target, so scroll, wait, and scroll again
  for (let i = 0; i < 3; i++) {
    if (toDiagram) await page.evaluate(target);
    await page.waitForFunction(() => [...document.querySelectorAll('pre.mermaid')].filter(e => { const r = e.getBoundingClientRect(); return r.bottom > -1500 && r.top < innerHeight + 1500; }).every(e => e.querySelector('svg')), { timeout: 15000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    if (!toDiagram) break;
  }
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Serving ${SITE} at ${base}\nShots to ${OUT}`);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars'], protocolTimeout: 300000 });
  let shots = 0;

  async function open(pg, theme, mobile, w, h, state = {}) {
    const page = await browser.newPage();
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(String(e)));
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
    await page.evaluateOnNewDocument((t, s) => {
      try { localStorage.setItem('bh-theme', t); localStorage.setItem('bh-sidebar', s.sb === false ? '0' : '1'); localStorage.setItem('bh-rail', s.rail === false ? '0' : '1'); } catch (e) {}
    }, theme, state);
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
    await page.goto(base + pg.url, { waitUntil: 'load', timeout: 120000 });
    return { page, errors };
  }

  async function check(page, errors, name, w, h, toDiagram) {
    await settle(page, toDiagram);
    const a = await page.evaluate(audit, touch(w));
    if (a.scrollWidth > a.innerWidth || a.innerWidth > w || a.clientWidth > w || a.scrollX > 0) fail(name, `horizontal scroll: scrollWidth ${a.scrollWidth}, innerWidth ${a.innerWidth}, clientWidth ${a.clientWidth}, scrollX ${a.scrollX}, viewport ${w}`);
    if (a.cut.length) fail(name, `${a.cut.length} labels cut off with an ellipsis: ${a.cut.slice(0, 6).join('; ')}`);
    if (a.small.length) fail(name, `${a.small.length} touch targets under 44px: ${a.small.slice(0, 6).join('; ')}`);
    if (errors.length) fail(name, `console errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    shots++;
  }

  for (const pg of PAGES) {
    for (const theme of THEMES) {
      for (const mobile of [true, false]) {
        const sizes = SIZES.filter(([w, h]) => (w <= 1024) === mobile && (!pg.only || pg.only.includes(`${w}x${h}`)));
        if (!sizes.length) continue;
        const { page, errors } = await open(pg, theme, mobile, sizes[0][0], sizes[0][1]);
        for (const [w, h] of sizes) {
          await page.setViewport({ width: w, height: h, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile });
          if (pg.toDiagram || pg.url.includes('#')) await page.evaluate(() => { const e = document.getElementById(location.hash.slice(1)); if (e) e.scrollIntoView(); });
          if (pg.open) {
            await page.mouse.wheel({ deltaY: 1 });  // a reader's own scroll ends the deep-link hold, as in real use
            // open the model design under the target heading and show where it starts (the folded state is the 'design' page)
            const ok = await page.evaluate(() => {
              const h = document.getElementById(location.hash.slice(1));
              const d = [...document.querySelectorAll('details.design')].find(x => h.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING);
              if (!d) return false;
              if (!d.open) d.querySelector('summary').click();
              const fig = d.querySelector('.diagram') || d;
              window.scrollTo({ top: fig.getBoundingClientRect().top + scrollY - 90, behavior: 'instant' });
              return d.open;
            });
            if (!ok) fail(`${pg.id}-${w}x${h}-${theme}`, 'the model design did not open');
            // a diagram inside an opened design must render at a real size
            await page.waitForFunction(() => { const s = document.querySelector('details.design[open] .diagram svg'); return s && s.getBoundingClientRect().width > 50; }, { timeout: 15000 })
              .catch(() => fail(`${pg.id}-${w}x${h}-${theme}`, 'diagram inside the opened design did not render at a real size'));
          } else if (pg.id === 'design') {
            const st = await page.evaluate(() => { const c = document.querySelector('.try'); const d = document.querySelector('details.design'); return { card: !!c && c.getBoundingClientRect().height > 100, folded: !!d && !d.open }; });
            if (!st.card || !st.folded) fail(`${pg.id}-${w}x${h}-${theme}`, `card visible ${st.card}, design folded ${st.folded}`);
          }
          await check(page, errors, `${pg.id}-${w}x${h}-${theme}`, w, h, pg.toDiagram);
        }
        await page.close();
      }
    }
  }

  // collapsed / expanded sidebar and rail on wide screens (volume page)
  if (!opt('only') || opt('only').includes('vol4')) {
    for (const [w, h] of [[1366, 768], [1920, 1080]]) {
      for (const [label, state] of [['sb-off', { sb: false }], ['rail-off', { rail: false }], ['both-off', { sb: false, rail: false }]]) {
        for (const theme of THEMES) {
          const pg = PAGES.find(p => p.id === 'vol4') || { url: 'vol-4-distributed-systems.html#275-the-classic-cache-problems', toDiagram: true };
          const { page, errors } = await open(pg, theme, false, w, h, state);
          await check(page, errors, `vol4-${w}x${h}-${theme}-${label}`, w, h, true);
          await page.close();
        }
      }
    }
  }

  await browser.close();
  server.close();
  console.log(`\n${shots} screenshots in ${OUT}`);
  if (failures.length) { console.log(`\n${failures.length} FAILURES`); process.exit(2); }
  console.log('All checks passed: no sideways scroll, no text cut off, touch targets >= 44px, no console errors.');
})().catch(e => { console.error(e); server.close(); process.exit(1); });
