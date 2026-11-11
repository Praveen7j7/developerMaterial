/* Inline SVG icons. Pages reference icons with <use href="#i-name">, and each page
 * carries one hidden sprite with only the symbols it (and site.js) uses.
 * Icon artwork: Lucide, ISC licence (see icons-data.js and site/assets/LICENSES.txt).
 */
const DATA = require('./icons-data');

// icons that site.js creates at run time, so every page must carry them
const JS_ICONS = ['copy', 'clipboard-check', 'zoom-in', 'zoom-out', 'rotate-ccw', 'x', 'check', 'circle-check', 'chevron-right', 'repeat'];

function icon(name, cls = '') {
  if (!DATA[name]) throw new Error('Unknown icon: ' + name);
  return `<svg class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

// Build the sprite for a finished page body: only the symbols it references.
function spriteFor(html) {
  const used = new Set(JS_ICONS);
  for (const m of html.matchAll(/#i-([a-z0-9-]+)/g)) if (DATA[m[1]]) used.add(m[1]);
  const symbols = [...used].sort().map(n =>
    `<symbol id="i-${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${DATA[n]}</symbol>`).join('');
  return `<!-- Icons: Lucide (lucide.dev), ISC licence, see assets/LICENSES.txt -->\n<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols}</svg>`;
}

module.exports = { icon, spriteFor };
