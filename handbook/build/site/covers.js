/* Nine original volume covers, drawn for this site (no stock art, no logos).
 * 120 x 160 book-cover box. They carry no colours of their own: the classes below are
 * painted by assets/css/components.css from the volume's tokens, so each cover follows
 * its volume colour in light and dark themes.
 *   .bg  cover background (volume tint)     .a  accent fill      .d  deep accent fill
 *   .p   paper fill                          .s  accent stroke    .sd deep stroke   .g  faint grid stroke
 */

// a book spine down the left edge and a page-edge line, shared by every cover
const frame = '<rect class="bg" width="120" height="160" rx="5"/><rect class="d" width="9" height="160" rx="3"/><path class="g" d="M14 6v148"/>';

const MOTIFS = {
  // Vol 0 — first steps: a sprout and a trail of footsteps
  sprout: `<path class="s" stroke-width="3" stroke-linecap="round" d="M28 112h72"/>
<path class="s" stroke-width="3.5" stroke-linecap="round" d="M64 112V70"/>
<path class="a" d="M64 84c-3-17-16-27-33-25 1 17 15 27 33 25z"/>
<path class="d" d="M64 72c2-19 17-30 36-28-1 19-17 30-36 28z"/>
<g class="a"><ellipse cx="34" cy="130" rx="3.2" ry="4.6"/><ellipse cx="46" cy="138" rx="3.2" ry="4.6"/><ellipse cx="58" cy="128" rx="3.2" ry="4.6"/><ellipse cx="70" cy="136" rx="3.2" ry="4.6"/><ellipse cx="82" cy="126" rx="3.2" ry="4.6"/></g>
<circle class="p" cx="96" cy="30" r="9"/><circle class="s" stroke-width="2.5" cx="96" cy="30" r="9"/>`,

  // Vol 1 — foundations: courses of blocks, the bottom row heaviest
  blocks: `<g class="d"><rect x="22" y="112" width="28" height="18" rx="2"/><rect x="53" y="112" width="28" height="18" rx="2"/><rect x="84" y="112" width="28" height="18" rx="2"/></g>
<g class="a"><rect x="37" y="91" width="28" height="18" rx="2"/><rect x="68" y="91" width="28" height="18" rx="2"/></g>
<rect class="p" x="52" y="70" width="28" height="18" rx="2"/><rect class="s" stroke-width="2.5" x="52" y="70" width="28" height="18" rx="2"/>
<path class="sd" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="3 5" d="M66 62V30"/>
<path class="s" stroke-width="2.5" stroke-linecap="round" d="M20 138h94"/>`,

  // Vol 2 — architecture: a blueprint floor plan with a dimension line
  blueprint: `<g class="g"><path d="M22 30h90M22 50h90M22 70h90M22 90h90M22 110h90M22 130h90M32 22v116M52 22v116M72 22v116M92 22v116"/></g>
<path class="s" stroke-width="3.5" stroke-linejoin="round" d="M30 40h76v80H30z"/>
<path class="s" stroke-width="3" d="M30 78h34M64 40v26M64 92v28M82 78h24"/>
<rect class="a" x="70" y="84" width="30" height="30" rx="2" opacity=".35"/>
<path class="sd" stroke-width="2" d="M30 136h76M30 132v8M106 132v8"/>
<circle class="d" cx="47" cy="59" r="5"/>`,

  // Vol 3 — data: three database cylinders
  cylinders: `<g stroke-width="2.5"><path class="a" d="M24 64v40c0 5 9 9 20 9s20-4 20-9V64z"/><ellipse class="d" cx="44" cy="64" rx="20" ry="8"/>
<path class="p" d="M58 92v32c0 5 9 9 20 9s20-4 20-9V92z"/><path class="s" d="M58 92v32c0 5 9 9 20 9s20-4 20-9V92"/><ellipse class="a" cx="78" cy="92" rx="20" ry="8"/>
<path class="d" d="M62 34v28c0 5 8 8 18 8s18-3 18-8V34z"/><ellipse class="a" cx="80" cy="34" rx="18" ry="7"/></g>
<path class="sd" stroke-width="2" d="M24 80c0 5 9 9 20 9s20-4 20-9M58 108c0 5 9 9 20 9s20-4 20-9"/>`,

  // Vol 4 — distributed systems: a network of nodes
  nodes: `<g class="s" stroke-width="2.5"><path d="M40 44 82 36M40 44 34 96M82 36 92 86M34 96 92 86M40 44 64 72M64 72 92 86M64 72 34 96M34 96 58 132M92 86 58 132"/></g>
<circle class="d" cx="40" cy="44" r="9"/><circle class="a" cx="82" cy="36" r="7"/><circle class="p" cx="64" cy="72" r="10"/><circle class="s" stroke-width="3" cx="64" cy="72" r="10"/>
<circle class="a" cx="34" cy="96" r="8"/><circle class="d" cx="92" cy="86" r="9"/><circle class="a" cx="58" cy="132" r="7"/>`,

  // Vol 5 — production: a gauge with its needle in the safe band
  gauge: `<path class="g" stroke-width="12" d="M28 104a38 38 0 0 1 76 0"/>
<path class="s" stroke-width="12" d="M28 104a38 38 0 0 1 55-34"/>
<path class="sd" stroke-width="12" d="M97 81a38 38 0 0 1 7 23"/>
<g class="sd" stroke-width="2.5" stroke-linecap="round"><path d="M66 56v8M38 70l6 5M94 70l-6 5"/></g>
<path class="d" d="M64 100 84 72l-15 33z"/><circle class="p" cx="66" cy="104" r="7"/><circle class="s" stroke-width="3" cx="66" cy="104" r="7"/>
<g class="a"><rect x="30" y="122" width="12" height="16" rx="2"/><rect x="46" y="116" width="12" height="22" rx="2"/><rect x="62" y="126" width="12" height="12" rx="2"/><rect x="78" y="112" width="12" height="26" rx="2"/></g>`,

  // Vol 6 — mastery: a summit with a flag and the climbing path
  summit: `<path class="a" d="M16 132 52 70l14 20 16-30 32 72z"/>
<path class="d" d="M52 70 66 90l-8 6-6-10-8 8zM82 60l14 32-10-6-4 8-6-14z"/>
<path class="p" stroke-width="0" d="M82 60V30"/><path class="sd" stroke-width="3" stroke-linecap="round" d="M82 60V28"/>
<path class="d" d="M82 28h20l-6 7 6 7H82z"/>
<path class="g" stroke-width="2.5" stroke-dasharray="3 5" stroke-linecap="round" d="M30 140c18-6 6-16 26-22s4-16 22-24 6-18 4-28"/>`,

  // Vol 7 — frontend: a browser window with a laid-out page
  browser: `<rect class="p" x="20" y="32" width="88" height="96" rx="6"/><rect class="s" stroke-width="3" x="20" y="32" width="88" height="96" rx="6"/>
<path class="s" stroke-width="3" d="M20 50h88"/><g class="d"><circle cx="30" cy="41" r="3"/><circle cx="40" cy="41" r="3"/><circle cx="50" cy="41" r="3"/></g>
<rect class="a" x="30" y="60" width="68" height="20" rx="3"/>
<rect class="d" x="30" y="88" width="30" height="30" rx="3"/>
<g class="sd" stroke-width="3" stroke-linecap="round"><path d="M68 92h30M68 102h22M68 112h26"/></g>`,

  // Vol 8 — principal: a compass rose
  compass: `<circle class="p" cx="64" cy="82" r="40"/><circle class="s" stroke-width="3" cx="64" cy="82" r="40"/><circle class="g" stroke-width="1.5" cx="64" cy="82" r="31"/>
<g class="sd" stroke-width="2.5" stroke-linecap="round"><path d="M64 36v8M64 120v8M18 82h8M102 82h8"/></g>
<path class="a" d="M64 46l9 36H55z"/><path class="d" d="M64 118l-9-36h18z"/>
<path class="g" stroke-width="2" d="M38 56l52 52M90 56l-52 52"/><circle class="d" cx="64" cy="82" r="4.5"/>`,
};

function cover(name, label) {
  const motif = MOTIFS[name];
  if (!motif) throw new Error('Unknown cover: ' + name);
  return `<svg class="cover" viewBox="0 0 120 160" role="img" aria-label="${label}">${frame}${motif.replace(/\n/g, '')}</svg>`;
}

module.exports = { cover };
