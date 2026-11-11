/* Mermaid diagrams: rendered lazily as they come near the screen (a volume page holds up to
 * 150), themed with the volume colour in light and dark, re-rendered when the theme changes,
 * and opened full screen (zoomable, scrollable) with a tap or the corner button. */
(function (BH) {
  'use strict';
  if (BH.page !== 'vol' || !window.mermaid) return;
  var nodes = BH.$$('pre.mermaid');
  nodes.forEach(function (el) { el._src = el.textContent; });

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function themeVars() {
    var dark = BH.isDark();
    var v = cssVar('--v'), tint = cssVar('--v-tint'), mid = cssVar('--v-mid'), ink = cssVar('--ink'), surface = cssVar('--surface');
    var paper = cssVar('--paper'), muted = cssVar('--muted'), rule = cssVar('--rule-2'), sunk = cssVar('--sunk');
    return {
      darkMode: dark, background: surface, fontFamily: cssVar('--font-ui'), fontSize: '15px',
      primaryColor: tint, primaryTextColor: ink, primaryBorderColor: v,
      secondaryColor: sunk, secondaryTextColor: ink, secondaryBorderColor: rule,
      tertiaryColor: paper, tertiaryTextColor: ink, tertiaryBorderColor: rule,
      lineColor: muted, textColor: ink, titleColor: ink, nodeTextColor: ink, mainBkg: tint, nodeBorder: v,
      clusterBkg: paper, clusterBorder: rule, edgeLabelBackground: surface, labelBackground: surface,
      noteBkgColor: mid, noteTextColor: ink, noteBorderColor: v,
      actorBkg: tint, actorBorder: v, actorTextColor: ink, actorLineColor: muted, signalColor: ink, signalTextColor: ink,
      labelBoxBkgColor: tint, labelBoxBorderColor: v, labelTextColor: ink, loopTextColor: ink,
      activationBkgColor: mid, activationBorderColor: v, sequenceNumberColor: cssVar('--on-v'),
      altBackground: sunk, classText: ink, stateBkg: tint, stateLabelColor: ink, compositeBackground: paper,
      git0: v, gitBranchLabel0: ink, pie1: v, pieStrokeColor: surface, pieOuterStrokeColor: rule, pieTitleTextColor: ink, pieSectionTextColor: ink, pieLegendTextColor: ink
    };
  }
  function init() {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'base', themeVariables: themeVars(), flowchart: { useMaxWidth: true, htmlLabels: true }, sequence: { useMaxWidth: true } });
  }
  init();

  // render one at a time so a slow phone never stalls on fifty at once
  var queue = [], busy = false;
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var el = queue.shift();
    Promise.resolve(mermaid.run({ nodes: [el], suppressErrors: true })).catch(function () {}).then(function () {
      busy = false;
      if (el.querySelector('svg')) el.closest('.diagram').setAttribute('data-ready', '');
      pump();
    });
  }
  function want(el) { if (!el.hasAttribute('data-processed') && queue.indexOf(el) < 0) { queue.push(el); pump(); } }

  var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); want(en.target); } });
  }, { rootMargin: '1500px 0px' }) : null;
  function observeAll() { nodes.forEach(function (el) { if (io) io.observe(el); else want(el); }); }
  observeAll();

  BH.on('theme', function () {
    queue = [];
    nodes.forEach(function (el) {
      if (io) io.unobserve(el);
      el.removeAttribute('data-processed'); el.textContent = el._src; el.closest('.diagram').removeAttribute('data-ready');
    });
    init(); observeAll();
  });

  // ---------- full screen ----------
  var dlg = BH.$('#diagram-dlg'), stage = dlg && BH.$('.dg-stage', dlg), zoom = 1, base = 0, svgEl = null;
  function apply() { if (svgEl) { svgEl.style.width = Math.round(base * zoom) + 'px'; svgEl.style.maxWidth = 'none'; } }
  function open(fig) {
    var src = fig.querySelector('pre.mermaid svg');
    if (!src || !dlg) { var pre = fig.querySelector('pre.mermaid'); if (pre) want(pre); return; }
    stage.innerHTML = '';
    svgEl = src.cloneNode(true); svgEl.removeAttribute('style'); svgEl.removeAttribute('height');
    stage.appendChild(svgEl);
    BH.openDialog(dlg);
    var vb = src.viewBox && src.viewBox.baseVal, natural = vb && vb.width ? vb.width : src.getBoundingClientRect().width;
    var fit = Math.min(1, (stage.clientWidth - 32) / natural);
    base = natural; zoom = Math.max(fit, 0.2); apply();
    BH._fit = zoom;
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('.diagram-open, .diagram[data-ready] pre.mermaid') : null;
    if (b) open(b.closest('.diagram'));
  });
  BH.action('zoom-in', function () { zoom = Math.min(zoom * 1.3, 6); apply(); });
  BH.action('zoom-out', function () { zoom = Math.max(zoom / 1.3, 0.2); apply(); });
  BH.action('zoom-reset', function () { zoom = BH._fit || 1; apply(); });
  if (dlg) dlg.addEventListener('close', function () { stage.innerHTML = ''; svgEl = null; });
})(window.BH);
