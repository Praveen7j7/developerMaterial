/* Renders one PDF per Part with local Chrome, then merges them into volume PDFs
 * and (with --full) the complete book.
 *
 * Chrome's PDF printer crashes on a whole volume in one pass — the target dies
 * with "Protocol error (IO.read): Target closed" — so each Part is rendered in
 * its own short-lived browser and the pieces are merged with pdf-lib. A failure
 * in one Part therefore costs one Part, not the whole run.
 *
 *   node make-pdf-chunked.js                # parts + volume PDFs
 *   node make-pdf-chunked.js --full         # also the complete book PDF
 *   node make-pdf-chunked.js --parts 12,19  # re-render only these parts
 *   node make-pdf-chunked.js --stale        # re-render only parts whose HTML
 *                                           # is newer than their PDF, then merge
 *   node make-pdf-chunked.js --merge-only   # skip rendering, just merge
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PARTDIR = path.join(DIST, 'parts');
const PARTPDF = path.join(DIST, 'parts-pdf');
const PDFDIR = path.join(DIST, 'pdf');
fs.mkdirSync(PARTPDF, { recursive: true });
fs.mkdirSync(PDFDIR, { recursive: true });

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));
if (!CHROME) { console.error('No Chrome or Edge found'); process.exit(1); }

const meta = JSON.parse(fs.readFileSync(path.join(PARTDIR, 'parts.json'), 'utf8'));
const argv = process.argv.slice(2);
const wantFull = argv.includes('--full');
const mergeOnly = argv.includes('--merge-only');
const staleOnly = argv.includes('--stale');
const pi = argv.indexOf('--parts');
const onlyParts = pi >= 0 ? argv[pi + 1].split(',').map(Number) : null;

/* A part needs re-rendering when its PDF is missing, empty, or older than the
   HTML it was built from. Chapters keep landing while PDFs render, so this is
   what keeps the output consistent without redoing all fifty every time. */
function isStale(p) {
  const html = path.join(PARTDIR, p.file);
  const pdf = path.join(PARTPDF, p.file.replace(/-print\.html$/, '.pdf'));
  if (!fs.existsSync(pdf)) return true;
  const ps = fs.statSync(pdf);
  if (ps.size < 1024) return true;
  return fs.statSync(html).mtimeMs > ps.mtimeMs;
}

function footerTemplate(text) {
  return `<div style="font-size:8px;color:#666;width:100%;padding:0 14mm;font-family:Arial,sans-serif;display:flex;justify-content:space-between">
<span>${text}</span><span class="pageNumber"></span></div>`;
}

async function renderPart(p) {
  const input = path.join(PARTDIR, p.file);
  const output = path.join(PARTPDF, p.file.replace(/-print\.html$/, '.pdf'));
  let browser;
  const t0 = Date.now();
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME, headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
      protocolTimeout: 1800000,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('pageerror', () => {});
    await page.goto('file:///' + input.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 0 });
    await page.waitForFunction('document.body.getAttribute("data-mermaid-done")==="1"', { timeout: 600000, polling: 500 });
    const errs = JSON.parse(await page.evaluate('document.body.getAttribute("data-mermaid-errors")') || '[]');
    await page.emulateMediaType('print');
    await page.pdf({
      path: output, format: 'A4', printBackground: true, preferCSSPageSize: true, timeout: 0,
      displayHeaderFooter: true, headerTemplate: '<div></div>',
      footerTemplate: footerTemplate(`Senior Backend Engineering Handbook — ${p.title}`),
      margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
    await browser.close();
    return { ok: true, output, mb: fs.statSync(output).size / 1048576, secs: (Date.now() - t0) / 1000, diagramErrors: errs.length };
  } catch (e) {
    if (browser) try { await browser.close(); } catch {}
    return { ok: false, output, error: String(e.message).slice(0, 140), secs: (Date.now() - t0) / 1000 };
  }
}

async function mergePdfs(inputs, output, title) {
  const merged = await PDFDocument.create();
  merged.setTitle(title);
  merged.setAuthor('Senior Backend Engineering Handbook');
  let pages = 0; const skipped = [];
  for (const f of inputs) {
    // A failed Chrome render leaves a zero-byte file, so check the size and not
    // just existence, and never let one bad chunk abort the whole merge.
    if (!fs.existsSync(f) || fs.statSync(f).size < 1024) { skipped.push(path.basename(f)); continue; }
    try {
      const src = await PDFDocument.load(fs.readFileSync(f), { ignoreEncryption: true });
      const copied = await merged.copyPages(src, src.getPageIndices());
      copied.forEach(pg => merged.addPage(pg));
      pages += copied.length;
    } catch (e) { skipped.push(`${path.basename(f)} (${String(e.message).slice(0, 40)})`); }
  }
  if (skipped.length) console.log(`    skipped ${skipped.length}: ${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ', ...' : ''}`);
  const bytes = await merged.save({ useObjectStreams: true });
  fs.writeFileSync(output, bytes);
  return { pages, mb: bytes.length / 1048576, skipped: skipped.length };
}

(async () => {
  let parts = meta.parts.filter(p => !onlyParts || onlyParts.includes(p.part));
  if (staleOnly) {
    const before = parts.length;
    parts = parts.filter(isStale);
    console.log(`Stale check: ${parts.length} of ${before} parts need re-rendering` + (parts.length ? ` (${parts.map(p => p.part).join(', ')})` : ''));
  }

  if (!mergeOnly) {
    console.log(`Rendering ${parts.length} part PDFs\n`);
    let done = 0;
    for (const p of parts) {
      process.stdout.write(`  Part ${String(p.part).padStart(2)} ${p.title.slice(0, 46).padEnd(48)} `);
      const r = await renderPart(p);
      done++;
      if (r.ok) console.log(`${r.mb.toFixed(1)} MB  ${r.secs.toFixed(0)}s${r.diagramErrors ? `  (${r.diagramErrors} diagram errors)` : ''}   [${done}/${parts.length}]`);
      else console.log(`FAILED — ${r.error}   [${done}/${parts.length}]`);
    }
  }

  console.log('\nMerging volumes');
  const results = [];
  for (const v of meta.volumes) {
    const vParts = meta.parts.filter(p => p.volume === v.n).sort((a, b) => a.part - b.part);
    if (!vParts.length) continue;
    const inputs = vParts.map(p => path.join(PARTPDF, p.file.replace(/-print\.html$/, '.pdf')));
    const out = path.join(PDFDIR, `vol-${v.n}-${v.slug}.pdf`);
    const r = await mergePdfs(inputs, out, `Senior Backend Engineering Handbook — Volume ${v.n}: ${v.title}`);
    console.log(`  Volume ${v.n} ${v.title.padEnd(26)} ${String(r.pages).padStart(5)} pages  ${r.mb.toFixed(1)} MB`);
    results.push({ vol: v.n, ...r });
  }

  if (wantFull) {
    console.log('\nMerging the complete book');
    const inputs = meta.parts.slice().sort((a, b) => a.part - b.part).map(p => path.join(PARTPDF, p.file.replace(/-print\.html$/, '.pdf')));
    const out = path.join(DIST, 'senior-backend-engineering-handbook.pdf');
    const r = await mergePdfs(inputs, out, 'Senior Backend Engineering Handbook');
    console.log(`  Complete book                      ${String(r.pages).padStart(5)} pages  ${r.mb.toFixed(1)} MB`);
  }

  const totalPages = results.reduce((n, r) => n + r.pages, 0);
  console.log(`\nTotal across volumes: ${totalPages} pages`);
})().catch(e => { console.error(e); process.exit(1); });
