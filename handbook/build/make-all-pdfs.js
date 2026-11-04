/* Renders every volume print page (and optionally the complete book) to PDF
 * with local Chrome. Volumes are rendered one at a time so a single failure
 * cannot take the whole run down, and so peak memory stays bounded.
 *
 *   node make-all-pdfs.js            # six volume PDFs
 *   node make-all-pdfs.js --full     # volumes plus the complete single PDF
 *   node make-all-pdfs.js --only 3   # just volume 3
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const VOLDIR = path.join(DIST, 'volumes');
const PDFDIR = path.join(DIST, 'pdf');
fs.mkdirSync(PDFDIR, { recursive: true });

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome or Edge found'); process.exit(1); }

const argv = process.argv.slice(2);
const wantFull = argv.includes('--full');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? Number(argv[onlyIdx + 1]) : null;

const jobs = [];
for (const f of fs.readdirSync(VOLDIR).filter(f => /-print\.html$/.test(f)).sort()) {
  const n = Number(/^vol-(\d+)-/.exec(f)[1]);
  if (only && n !== only) continue;
  jobs.push({
    label: `Volume ${n}`,
    input: path.join(VOLDIR, f),
    output: path.join(PDFDIR, f.replace(/-print\.html$/, '.pdf')),
    footer: `Senior Backend Engineering Handbook — Volume ${n}`,
  });
}
if (wantFull && !only) {
  jobs.push({
    label: 'Complete book',
    input: path.join(DIST, 'handbook-print.html'),
    output: path.join(DIST, 'senior-backend-engineering-handbook.pdf'),
    footer: 'Senior Backend Engineering Handbook',
  });
}
if (!jobs.length) { console.error('Nothing to render. Run build-handbook.js first.'); process.exit(1); }

function footerTemplate(text) {
  return `<div style="font-size:8px;color:#666;width:100%;padding:0 14mm;font-family:Arial,sans-serif;display:flex;justify-content:space-between">
<span>${text}</span><span>page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
}

(async () => {
  const results = [];
  for (const job of jobs) {
    const t0 = Date.now();
    process.stdout.write(`${job.label.padEnd(16)} rendering... `);
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath: CHROME, headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=6144'],
        protocolTimeout: 3600000,
      });
      const page = await browser.newPage();
      page.setDefaultTimeout(0);
      page.on('pageerror', () => {});
      await page.goto('file:///' + job.input.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 0 });
      await page.waitForFunction('document.body.getAttribute("data-mermaid-done")==="1"', { timeout: 0, polling: 1000 });
      const errs = JSON.parse(await page.evaluate('document.body.getAttribute("data-mermaid-errors")') || '[]');
      await page.emulateMediaType('print');
      const pdfOpts = {
        format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: 0,
        displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: footerTemplate(job.footer),
        margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
      };
      // A multi-hundred-page PDF returned as one protocol buffer crashes the
      // browser target ("Protocol error (IO.read): Target closed"), so stream
      // it to disk in chunks instead and only fall back to buffering.
      if (typeof page.createPDFStream === 'function') {
        const stream = await page.createPDFStream(pdfOpts);
        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(job.output);
          out.on('error', reject); out.on('finish', resolve);
          if (typeof stream.pipe === 'function') { stream.on('error', reject); stream.pipe(out); }
          else { // web ReadableStream
            (async () => {
              const reader = stream.getReader();
              try {
                for (;;) { const { done, value } = await reader.read(); if (done) break; out.write(Buffer.from(value)); }
                out.end();
              } catch (e) { reject(e); }
            })();
          }
        });
      } else {
        await page.pdf({ ...pdfOpts, path: job.output });
      }
      await browser.close();
      const mb = fs.statSync(job.output).size / 1048576;
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`${mb.toFixed(1)} MB in ${secs}s${errs.length ? `  (${errs.length} diagram errors)` : ''}`);
      results.push({ ...job, ok: true, mb, secs, diagramErrors: errs.length });
    } catch (e) {
      if (browser) try { await browser.close(); } catch {}
      console.log(`FAILED — ${String(e.message).slice(0, 120)}`);
      results.push({ ...job, ok: false, error: String(e.message) });
    }
  }

  console.log('\nSummary');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${path.basename(r.output).padEnd(40)} ${r.ok ? `${r.mb.toFixed(1)} MB, ${r.secs}s` : r.error.slice(0, 80)}`);
  }
  const failed = results.filter(r => !r.ok).length;
  const badDiagrams = results.reduce((n, r) => n + (r.diagramErrors || 0), 0);
  if (badDiagrams) console.log(`\n${badDiagrams} diagram render errors across all PDFs`);
  process.exit(failed ? 2 : 0);
})();
