// End-to-end check of cross-reference previews: node xref-check.js (from build/, with site/ served on 127.0.0.1:8761)
const puppeteer = require('puppeteer-core');
const OUT = require('path').resolve(__dirname, '../_work/flow/shots') + '/';
const BASE = 'http://127.0.0.1:8761/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new' });
  for (const [name, vp, dark] of [['desktop', { width: 1440, height: 900 }, false], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }, false], ['desktop-dark', { width: 1440, height: 900 }, true]]) {
    const pg = await b.newPage(); await pg.setViewport(vp);
    if (dark) await pg.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await pg.goto(BASE + 'vol-0-from-scratch.html#311-the-request-response-model', { waitUntil: 'networkidle0' });
    await sleep(800);
    // the Part 14 reference in 3.1.1 step 2
    const sel = 'a.xref[data-x="14.3"]';
    const has = await pg.$(sel); ok(!!has, `${name}: 14.3 reference is a link`);
    const unpin = () => pg.evaluate(() => window.dispatchEvent(new WheelEvent('wheel')));  // a reader's own scroll ends the deep-link pin
    await unpin();
    await pg.evaluate(s => { const a = document.querySelector(s); a.scrollIntoView({ block: 'center', behavior: 'instant' }); }, sel);
    await sleep(1000);
    const yBefore = await pg.evaluate(s => document.querySelector(s).getBoundingClientRect().top, sel);
    if (vp.hasTouch) await pg.tap(sel); else await pg.click(sel);
    await pg.waitForSelector('.xcard:not([hidden]) .xc-go', { timeout: 5000 }).catch(() => {});
    const card = await pg.evaluate(() => { const c = document.querySelector('.xcard'); return c && !c.hidden ? { t: c.querySelector('.xc-t').textContent, g: (c.querySelector('.xc-g') || {}).textContent || '', r: c.getBoundingClientRect().toJSON(), sheet: c.classList.contains('xc-sheet') } : null; });
    ok(card && /DNS/.test(card.t) && card.g.length > 40, `${name}: card shows "${card && card.t}"`);
    ok(card && card.r.left >= 0 && card.r.right <= vp.width + 1, `${name}: card fits the screen width`);
    ok(card && card.sheet === (vp.width < 640), `${name}: ${vp.width < 640 ? 'bottom sheet' : 'popover'} layout`);
    ok(await pg.evaluate(() => location.hash) === '#311-the-request-response-model', `${name}: opening a preview does not leave the page`);
    await pg.screenshot({ path: OUT + name + '-card.png' });
    // Escape closes
    await pg.keyboard.press('Escape'); await sleep(150);
    ok(await pg.evaluate(() => document.querySelector('.xcard').hidden), `${name}: Escape closes the card`);
    // open again and go (cross-volume: Part 14 is in Volume 1)
    if (vp.hasTouch) await pg.tap(sel); else await pg.click(sel);
    await pg.waitForSelector('.xcard:not([hidden]) .xc-go');
    await Promise.all([pg.waitForNavigation({ waitUntil: 'networkidle0' }), pg.click('.xc-go')]);
    await sleep(900);
    ok(/vol-1-foundations\.html#143-/.test(pg.url()), `${name}: Go to section lands on ${pg.url().split('/').pop()}`);
    const pill = await pg.evaluate(() => { const p = document.querySelector('.xback'); return p && !p.hidden ? p.textContent.trim() : null; });
    ok(pill && /Back to 3\.1\.1/.test(pill), `${name}: back pill reads "${pill}"`);
    const tgt = await pg.evaluate(() => { const h = document.getElementById(location.hash.slice(1)); return h ? h.getBoundingClientRect().top : null; });
    ok(tgt != null && tgt >= 0 && tgt < 200, `${name}: target heading is at the top (${tgt && tgt.toFixed(0)}px)`);
    await pg.screenshot({ path: OUT + name + '-arrived.png' });
    await Promise.all([pg.waitForNavigation({ waitUntil: 'networkidle0' }), pg.click('.xback .xb-go')]);
    await sleep(1800);
    const back = await pg.evaluate(s => { const a = document.querySelector(s); return { url: location.href, top: a.getBoundingClientRect().top }; }, sel);
    ok(/vol-0-from-scratch\.html/.test(back.url) && Math.abs(back.top - yBefore) < 60, `${name}: back returns to the same reference (y ${yBefore.toFixed(0)} -> ${back.top.toFixed(0)})`);
    await pg.screenshot({ path: OUT + name + '-back.png' });
    // same-page reference: (3.5)
    const s35 = 'a.xref[data-x="3.5"]';
    await unpin(); await pg.evaluate(s => document.querySelector(s).scrollIntoView({ block: 'center', behavior: 'instant' }), s35); await sleep(1000);
    const y35 = await pg.evaluate(s => document.querySelector(s).getBoundingClientRect().top, s35);
    if (vp.hasTouch) await pg.tap(s35); else await pg.click(s35);
    await pg.waitForSelector('.xcard:not([hidden]) .xc-go');
    ok(/On this page/.test(await pg.$eval('.xcard', c => c.textContent)), `${name}: same-page card says "On this page"`);
    await pg.click('.xc-go'); await sleep(900);
    ok(/#35-rest-apis/.test(pg.url()), `${name}: same-page jump to 3.5`);
    await pg.click('.xback .xb-go'); await sleep(1800);
    const y35b = await pg.evaluate(s => document.querySelector(s).getBoundingClientRect().top, s35);
    ok(Math.abs(y35b - y35) < 60, `${name}: same-page back returns to the reference (y ${y35.toFixed(0)} -> ${y35b.toFixed(0)})`);
    // horizontal overflow
    ok(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name}: no horizontal scroll`);
    await pg.close();
  }
  // hover on desktop
  const pg = await b.newPage(); await pg.setViewport({ width: 1280, height: 800 });
  await pg.goto(BASE + 'vol-0-from-scratch.html#311-the-request-response-model', { waitUntil: 'networkidle0' }); await sleep(600);
  await pg.evaluate(() => { window.dispatchEvent(new WheelEvent('wheel')); document.querySelector('a.xref[data-x="14.4"]').scrollIntoView({ block: 'center', behavior: 'instant' }); }); await sleep(1000);
  await pg.hover('a.xref[data-x="14.4"]'); await sleep(900);
  ok(await pg.evaluate(() => !document.querySelector('.xcard').hidden && /TCP/.test(document.querySelector('.xcard').textContent)), 'hover: card opens on hover');
  await pg.mouse.move(5, 400); await sleep(600);
  ok(await pg.evaluate(() => document.querySelector('.xcard').hidden), 'hover: card closes when the mouse leaves');
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.reload({ waitUntil: 'networkidle0' }); await sleep(500);
  ok(!errs.length, 'no page errors ' + errs.join('; '));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
