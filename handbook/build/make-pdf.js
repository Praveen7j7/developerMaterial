/* Prints dist/handbook-print.html to dist/senior-backend-engineering-handbook.pdf using local Chrome via puppeteer-core.
 * Usage: node make-pdf.js [input.html] [output.pdf]
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const input = path.resolve(process.argv[2] || path.join(DIST, 'handbook-print.html'));
const output = path.resolve(process.argv[3] || path.join(DIST, 'senior-backend-engineering-handbook.pdf'));
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));

(async () => {
  const t0 = Date.now();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096'], protocolTimeout: 3600000 });
  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  await page.goto('file:///' + input.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 0 });
  console.log('Loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's; waiting for mermaid...');
  await page.waitForFunction('document.body.getAttribute("data-mermaid-done")==="1"', { timeout: 0, polling: 1000 });
  const errors = await page.evaluate('document.body.getAttribute("data-mermaid-errors")');
  const errs = JSON.parse(errors || '[]');
  console.log('Mermaid done in', ((Date.now() - t0) / 1000).toFixed(1), 's; errors:', errs.length);
  if (errs.length) console.log(errs.slice(0, 20));
  await page.emulateMediaType('print');
  await page.pdf({ path: output, format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: 0,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="font-size:8px;color:#666;width:100%;text-align:center;font-family:Arial">Senior Backend Engineering Handbook &nbsp;·&nbsp; page <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
  await browser.close();
  const size = fs.statSync(output).size;
  console.log(`PDF written: ${output} (${(size / 1024 / 1024).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
})().catch(e => { console.error(e); process.exit(1); });
