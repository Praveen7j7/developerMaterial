/* Validates every ```mermaid block in chapters/*.md using the real mermaid parser in headless Chrome.
 * Prints a report of broken diagrams with file + line, and writes dist/mermaid-report.json.
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { sanitizeMermaid } = require('./mermaid-sanitize');

const ROOT = path.resolve(__dirname, '..');
const CHAPTERS = path.join(ROOT, 'chapters');
const DIST = path.join(ROOT, 'dist');
fs.mkdirSync(DIST, { recursive: true });

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => fs.existsSync(p));

const blocks = [];
for (const f of fs.readdirSync(CHAPTERS).filter(f => f.endsWith('.md')).sort()) {
  const lines = fs.readFileSync(path.join(CHAPTERS, f), 'utf8').replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const m = /^\s*```\s*mermaid\s*$/.exec(lines[i]);
    if (m) {
      const start = i + 1; let j = start;
      while (j < lines.length && !/^\s*```/.test(lines[j])) j++;
      blocks.push({ file: f, line: start + 1, code: sanitizeMermaid(lines.slice(start, j).join('\n')) });
      i = j + 1;
    } else i++;
  }
}
console.log(`Found ${blocks.length} mermaid blocks in ${new Set(blocks.map(b => b.file)).size} files`);

const mermaidJs = fs.readFileSync(path.join(__dirname, 'node_modules/mermaid/dist/mermaid.min.js'), 'utf8');
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="out"></div>
<script>${mermaidJs}</script>
<script>
window.__blocks = ${JSON.stringify(blocks.map(b => b.code))};
(async function(){
  mermaid.initialize({ startOnLoad:false, securityLevel:'loose' });
  const results = [];
  for (let i=0;i<window.__blocks.length;i++){
    const code = window.__blocks[i];
    try {
      await mermaid.parse(code);
      // also try a real render to catch layout-time errors
      const el = document.createElement('div'); document.body.appendChild(el);
      await mermaid.render('v'+i, code, el);
      el.remove();
      results.push(null);
    } catch(e){ results.push(String(e && e.message || e).split('\\n').slice(0,3).join(' | ').slice(0,400)); }
  }
  window.__results = results; document.body.setAttribute('data-done','1');
})();
</script></body></html>`;
const page = path.join(DIST, 'validate-mermaid.html');
fs.writeFileSync(page, html);

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'], protocolTimeout: 600000 });
  const p = await browser.newPage();
  p.on('pageerror', e => {});
  await p.goto('file:///' + page.replace(/\\/g, '/'), { waitUntil: 'load', timeout: 0 });
  await p.waitForFunction('document.body.getAttribute("data-done")==="1"', { timeout: 600000, polling: 500 });
  const results = await p.evaluate('window.__results');
  await browser.close();
  const bad = [];
  results.forEach((err, i) => { if (err) bad.push({ ...blocks[i], error: err }); });
  fs.writeFileSync(path.join(DIST, 'mermaid-report.json'), JSON.stringify(bad, null, 1));
  console.log(`Valid: ${results.length - bad.length}, broken: ${bad.length}`);
  for (const b of bad) console.log(`- ${b.file}:${b.line}  ${b.error}`);
  process.exit(bad.length ? 2 : 0);
})().catch(e => { console.error(e); process.exit(1); });
