/* Screenshots slides of dist/masterclass-deck.html for visual QA.
 * Usage: node shot-deck.js <outDir> <slideNumbers e.g. 1,3,5-9>
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const DIST = path.resolve(__dirname, '..', 'dist');
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
const out = path.resolve(process.argv[2] || path.join(DIST, 'shots'));
fs.mkdirSync(out, { recursive: true });
const spec = process.argv[3] || '1-5';
const nums = [];
spec.split(',').forEach(s => { const m = /^(\d+)-(\d+)$/.exec(s); if (m) { for (let i = +m[1]; i <= +m[2]; i++) nums.push(i); } else nums.push(+s); });
(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  const file = 'file:///' + path.join(DIST, 'masterclass-deck.html').replace(/\\/g, '/');
  await page.goto(file + '#1', { waitUntil: 'load' });
  await page.addStyleTag({ content: '#scaler{transform:none!important}#stage{align-items:flex-start;justify-content:flex-start}#ctl,#counter,#hud{display:none}' });
  for (const n of nums) {
    await page.evaluate(i => { location.hash = '#' + i; }, n);
    await new Promise(r => setTimeout(r, 150));
    const el = await page.$('.slide.active');
    await el.screenshot({ path: path.join(out, `slide-${String(n).padStart(3, '0')}.png`) });
  }
  await browser.close();
  console.log('Screenshots in', out, nums.join(','));
})().catch(e => { console.error(e); process.exit(1); });
