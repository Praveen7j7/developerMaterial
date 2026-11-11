/* Copies the static assets into site/assets/ as a few bundles, so each page loads only what it uses:
 *   site.css + site.js     every page (tokens, frame, dialogs, search, shortcuts)
 *   read.css + read.js     volume pages (prose, code, diagrams, answers, flashcards)
 *   home.css, roadmap.css  the home and roadmap pages
 *   mermaid.min.js (from node_modules), LICENSES.txt (Lucide's ISC licence and other notes)
 */
const fs = require('fs');
const path = require('path');
const { PATHS } = require('./config');

const BUNDLES = {
  'site.css': ['tokens.css', 'base.css', 'layout.css', 'components.css', 'print.css'],
  'read.css': ['content.css'],
  'home.css': ['home.css'],
  'roadmap.css': ['roadmap.css'],
  'site.js': ['core.js', 'layout.js', 'search.js', 'roadmap.js', 'keys.js'],
  'read.js': ['content.js', 'diagrams.js'],
};

// The sources stay commented and readable; the published copies are squeezed with two
// deliberately simple, safe passes (no renaming, no reordering).
function minCss(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')          // comments
    .replace(/\s+/g, ' ')                              // runs of whitespace
    .replace(/\s*([{};,>])\s*/g, '$1')                 // around punctuation that never needs it
    .replace(/\{([^{}]*)\}/g, (m, d) => '{' + d.replace(/:\s+/g, ':') + '}')  // "prop: value" inside declaration blocks only
    .replace(/;}/g, '}')
    .trim();
}
function minJs(s) {
  return s.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))  // whole-line comments only
    .join('\n');
}

function concat(dir, files, banner, min) {
  return banner + files.map(f => min(fs.readFileSync(path.join(PATHS.SRC_ASSETS, dir, f), 'utf8'))).join('\n') + '\n';
}

function writeAssets() {
  fs.mkdirSync(PATHS.SITE_ASSETS, { recursive: true });
  const sizes = {};
  for (const [out, files] of Object.entries(BUNDLES)) {
    const isCss = out.endsWith('.css');
    const text = concat(isCss ? 'css' : 'js', files,
      `/* Backend Engineering Handbook. Generated from build/site/assets/${isCss ? 'css' : 'js'}/ (${files.join(', ')}); do not edit here. */\n`,
      isCss ? minCss : minJs);
    fs.writeFileSync(path.join(PATHS.SITE_ASSETS, out), text);
    sizes[out] = Buffer.byteLength(text);
  }
  fs.copyFileSync(path.join(PATHS.NODE_MODULES, 'mermaid/dist/mermaid.min.js'), path.join(PATHS.SITE_ASSETS, 'mermaid.min.js'));
  const lucide = fs.readFileSync(path.join(__dirname, 'lucide-LICENSE.txt'), 'utf8');
  fs.writeFileSync(path.join(PATHS.SITE_ASSETS, 'LICENSES.txt'),
    'Third-party material used by this site\n======================================\n\n' +
    'Icons: Lucide (https://lucide.dev), lucide-static v0.460.0. Only the icons the site uses were copied,\n' +
    'inlined as an SVG sprite in each page.\n\n' + lucide.trim() + '\n\n' +
    '--------------------------------------\n\nDiagrams are rendered by Mermaid (https://mermaid.js.org), MIT licence, served from assets/mermaid.min.js.\n' +
    'Code colouring follows the highlight.js (https://highlightjs.org, BSD-3-Clause) token classes.\n' +
    'The volume covers and the logo were drawn for this site.\n');
  return sizes;
}

module.exports = { writeAssets };
