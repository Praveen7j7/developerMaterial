/* Backend Engineering Handbook. Generated from build/site/assets/js/ (content.js, diagrams.js, xref.js); do not edit here. */
(function (BH) {
'use strict';
if (BH.page !== 'vol') return;
function copyText(text) {
if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
return new Promise(function (ok, fail) {
var ta = document.createElement('textarea');
ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
document.body.appendChild(ta); ta.select();
try { document.execCommand('copy') ? ok() : fail(); } catch (e) { fail(e); }
document.body.removeChild(ta);
});
}
BH.$$('.code-head').forEach(function (head) {
var b = document.createElement('button');
b.type = 'button'; b.className = 'copy-btn';
b.setAttribute('aria-label', 'Copy ' + head.textContent + ' code');
b.innerHTML = '<svg class="ic" aria-hidden="true"><use href="#i-copy"/></svg><span>Copy</span>';
head.appendChild(b);
});
document.addEventListener('click', function (e) {
var b = e.target.closest ? e.target.closest('.copy-btn') : null;
if (!b) return;
var code = b.closest('.code-block').querySelector('pre code');
var label = b.querySelector('span'), use = b.querySelector('use');
copyText(code.textContent).then(function () {
b.classList.add('copied'); label.textContent = 'Copied'; use.setAttribute('href', '#i-clipboard-check'); BH.say('Code copied');
clearTimeout(b._t); b._t = setTimeout(function () { b.classList.remove('copied'); label.textContent = 'Copy'; use.setAttribute('href', '#i-copy'); }, 1800);
}, function () { label.textContent = 'Select and copy'; BH.say('Copy failed. Select the code and copy it.'); });
});
function cue(t) {
var m = /^(.{12,}?)(?::|;| — | – )\s/.exec(t);
if (m && m[1].length < t.length * .7) return m[1] + ' …';
var w = t.split(/\s+/);
return w.length > 8 ? w.slice(0, 6).join(' ') + ' …' : t;
}
function svg(name) { return '<svg class="ic" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
BH.$$('h2.takeaways-h').forEach(function (h) {
var ul = h.nextElementSibling;
if (!ul || ul.tagName !== 'UL') return;
var cards = BH.$$(':scope > li', ul).map(function (li) { return li.textContent.replace(/\s+/g, ' ').trim(); });
if (cards.length < 2) return;
var tools = document.createElement('div'); tools.className = 'takeaways-tools';
tools.innerHTML = '<button type="button" class="btn btn-small" aria-pressed="false">' + svg('repeat') + '<span>Practise as flashcards</span></button>';
h.parentNode.insertBefore(tools, ul);
var toggle = tools.firstChild, box = null, i = 0, flipped = false;
function show() {
var card = BH.$('.flash-card', box);
card.setAttribute('aria-pressed', String(flipped));
BH.$('.flash-text', box).textContent = flipped ? cards[i] : cue(cards[i]);
BH.$('.flash-hint', box).textContent = flipped ? 'Tap to see the prompt again' : 'Recall the rest, then tap to check';
BH.$('.flash-count', box).textContent = (i + 1) + ' of ' + cards.length;
}
function build() {
box = document.createElement('div'); box.className = 'flash';
box.innerHTML = '<button type="button" class="flash-card" aria-pressed="false" aria-describedby="' + h.id + '-fc"><span><span class="flash-text"></span><span class="flash-hint"></span></span></button>' +
'<div class="flash-bar"><button type="button" class="btn btn-small" data-d="-1">' + svg('chevron-left') + '<span>Previous</span></button>' +
'<span class="flash-count" id="' + h.id + '-fc" aria-live="polite"></span>' +
'<button type="button" class="btn btn-small" data-d="1"><span>Next</span>' + svg('chevron-right') + '</button></div>';
tools.parentNode.insertBefore(box, ul);
BH.$('.flash-card', box).addEventListener('click', function () { flipped = !flipped; show(); });
box.addEventListener('click', function (e) {
var d = e.target.closest('[data-d]'); if (!d) return;
i = (i + (+d.getAttribute('data-d')) + cards.length) % cards.length; flipped = false; show();
});
box.addEventListener('keydown', function (e) {
if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); i = (i + (e.key === 'ArrowRight' ? 1 : -1) + cards.length) % cards.length; flipped = false; show(); }
});
}
toggle.addEventListener('click', function () {
var on = toggle.getAttribute('aria-pressed') !== 'true';
toggle.setAttribute('aria-pressed', String(on));
BH.$('span', toggle).textContent = on ? 'Show as a list' : 'Practise as flashcards';
if (on && !box) build();
box.hidden = !on; ul.hidden = on;
if (on) { i = 0; flipped = false; show(); BH.$('.flash-card', box).focus(); }
});
});
document.addEventListener('click', function (e) {
var b = e.target.closest ? e.target.closest('.design-close') : null;
if (!b) return;
var d = b.closest('details.design'), sum = d.querySelector('summary');
d.open = false;
sum.scrollIntoView({ block: 'center', behavior: 'instant' });
sum.focus();
});
var KEY = 'bh-designs-open';
function openParts() { try { return JSON.parse(sessionStorage.getItem(KEY) || '[]'); } catch (e) { return []; } }
function saveParts(list) { try { sessionStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { /* works without it */ } }
function setDesigns(btn, on) {
var part = btn.closest('section.part');
BH.$$('details.design', part).forEach(function (d) { d.open = on; });
btn.setAttribute('aria-pressed', String(on));
BH.$('span', btn).textContent = on ? 'Fold all model designs' : 'Open all model designs';
}
BH.$$('.designs-toggle').forEach(function (btn) {
if (openParts().indexOf(btn.getAttribute('data-part')) >= 0) setDesigns(btn, true);
btn.addEventListener('click', function () {
var on = btn.getAttribute('aria-pressed') !== 'true', n = btn.getAttribute('data-part');
setDesigns(btn, on);
var list = openParts().filter(function (x) { return x !== n; }); if (on) list.push(n); saveParts(list);
BH.say(on ? 'All model designs in this Part are open' : 'All model designs in this Part are folded');
});
});
var closed = [];
window.addEventListener('beforeprint', function () {
closed = BH.$$('details:not([open])'); closed.forEach(function (d) { d.open = true; });
});
window.addEventListener('afterprint', function () { closed.forEach(function (d) { d.open = false; }); closed = []; });
})(window.BH);
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
altBackground: sunk, attributeBackgroundColorOdd: surface, attributeBackgroundColorEven: sunk, rowOdd: surface, rowEven: sunk, classText: ink, stateBkg: tint, stateLabelColor: ink, compositeBackground: paper,
git0: v, gitBranchLabel0: ink, pie1: v, pieStrokeColor: surface, pieOuterStrokeColor: rule, pieTitleTextColor: ink, pieSectionTextColor: ink, pieLegendTextColor: ink
};
}
function init() {
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose', theme: 'base', themeVariables: themeVars(), flowchart: { useMaxWidth: true, htmlLabels: true }, sequence: { useMaxWidth: true } });
}
init();
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
(function (BH) {
'use strict';
if (BH.page !== 'vol') return;
var data = null, loading = null;
function load() {
if (!loading) loading = fetch('refs.json').then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
.then(function (j) { data = j; return j; }, function (e) { loading = null; throw e; });
return loading;
}
var here = location.pathname.split('/').pop() || 'index.html';
function svg(n) { return '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"/></svg>'; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
var card = document.createElement('div');
card.className = 'xcard'; card.hidden = true;
card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'false'); card.setAttribute('aria-labelledby', 'xcard-t');
document.body.appendChild(card);
var cur = null, hoverT = 0, leaveT = 0, byHover = false;
function fill(a) {
var key = a.getAttribute('data-x'), isSec = key.indexOf('.') > 0, e = isSec ? data.s[key] : data.p[key];
if (!e) { card.innerHTML = ''; return false; }
var partN = isSec ? key.split('.')[0] : key, part = data.p[partN];
var crumb = 'Part ' + partN + (part ? ' · ' + part[1] : '');
var title = isSec ? '<span class="xc-n">' + esc(key) + '</span> ' + esc(e[1]) : esc(e[1]);
var file = e[0].split('#')[0], same = file === here;
card.innerHTML = '<div class="xc-top"><p class="xc-crumb">' + esc(crumb) + '</p>' +
'<button type="button" class="xc-x" aria-label="Close preview">' + svg('x') + '</button></div>' +
'<p class="xc-t" id="xcard-t">' + title + '</p>' +
(e[2] ? '<p class="xc-g">' + esc(e[2]) + '</p>' : '') +
'<div class="xc-bar"><a class="btn btn-small btn-primary xc-go" href="' + esc(same ? '#' + e[0].split('#')[1] : e[0]) + '">' +
'<span>' + (isSec ? 'Go to section ' + esc(key) : 'Go to Part ' + esc(key)) + '</span>' + svg('arrow-right') + '</a>' +
'<span class="xc-note">' + (same ? 'On this page' : 'Volume page') + '</span></div>';
return true;
}
function place(a) {
var narrow = window.innerWidth < 640;
card.classList.toggle('xc-sheet', narrow);
if (narrow) { card.style.left = card.style.top = ''; return; }
var r = a.getClientRects()[0] || a.getBoundingClientRect(), w = card.offsetWidth, h = card.offsetHeight;
var left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), window.innerWidth - w - 12);
var below = r.bottom + 10, above = r.top - h - 10, topbar = 64;
var top = (below + h < window.innerHeight - 8 || above < topbar) ? below : above;
card.style.left = left + 'px'; card.style.top = (top + window.pageYOffset) + 'px';
}
function open(a, hover) {
clearTimeout(leaveT);
if (cur === a && !card.hidden) return;
cur = a; byHover = !!hover;
var go = function () {
if (cur !== a) return;
if (!fill(a)) { if (!hover) location.href = a.href; return; }
card.hidden = false; place(a);
a.setAttribute('aria-expanded', 'true');
if (!hover) { var x = card.querySelector('.xc-go'); if (x) x.focus({ preventScroll: true }); }
};
if (data) go();
else {
if (!hover) { card.innerHTML = '<p class="xc-g">Loading preview…</p>'; card.hidden = false; place(a); }
load().then(go, function () { if (!hover && cur === a) location.href = a.href; });
}
}
function close(refocus) {
if (card.hidden) return;
card.hidden = true;
if (cur) { cur.setAttribute('aria-expanded', 'false'); if (refocus) cur.focus({ preventScroll: true }); }
cur = null;
}
var KEY = 'bh-xref-back';
function getBack() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
function setBack(v) { try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch (e) { /* works without it */ } }
var links = BH.$$('a.xref');
function label(a) {
var hs = BH.headings ? BH.headings() : null, y = a.getBoundingClientRect().top + window.pageYOffset, best = null;
if (hs) for (var i = 0; i < hs.list.length && hs.tops[i] <= y; i++) best = hs.list[i];
var t = best ? best.textContent.replace(/\s+/g, ' ').trim() : '';
var m = /^(\d+(?:\.\d+)+)\s/.exec(t);
return m ? m[1] : (t.length > 28 ? 'where you were' : t || 'where you were');
}
var pill = document.createElement('div');
pill.className = 'xback'; pill.hidden = true;
pill.innerHTML = '<button type="button" class="xb-go">' + svg('undo-2') + '<span></span></button><button type="button" class="xb-x" aria-label="Dismiss">' + svg('x') + '</button>';
document.body.appendChild(pill);
function showPill(b) { pill.querySelector('.xb-go span').textContent = 'Back to ' + b.label; pill.hidden = false; }
function restore(b) {
var a = links[b.i];
if (!a) return;
BH.reveal(a);
if (BH.unpin) BH.unpin();
var until = Date.now() + 10000;
var go = function () {
if (userMoved || Date.now() > until) return;
var d = a.getBoundingClientRect().top - b.off;
if (Math.abs(d) > 2) window.scrollTo({ top: window.pageYOffset + d, behavior: 'instant' });
};
go(); [120, 600, 1500, 3000].forEach(function (ms) { setTimeout(go, ms); });
if (window.ResizeObserver && BH.$('#main')) new ResizeObserver(go).observe(BH.$('#main'));
a.classList.add('xref-flash'); setTimeout(function () { a.classList.remove('xref-flash'); }, 1600);
}
var userMoved = false;
['wheel', 'touchstart', 'keydown'].forEach(function (ev) { window.addEventListener(ev, function () { userMoved = true; }, { passive: true }); });
function jump(a, href) {
var i = links.indexOf(a), b = { page: here, i: i, off: a.getBoundingClientRect().top, label: label(a), t: Date.now() };
close(false);
var file = href.split('#')[0];
if (!file || file === here) {
setBack(b);
var id = href.slice(href.indexOf('#') + 1);
if (location.hash === '#' + id) { if (BH.goHash) BH.goHash(); } else location.hash = id;
showPill(b);
} else { b.to = file; setBack(b); location.href = href; }
}
pill.addEventListener('click', function (e) {
var b = getBack();
if (e.target.closest('.xb-x') || !b) { pill.hidden = true; setBack(null); return; }
pill.hidden = true;
if (b.page === here) { setBack(null); userMoved = false; history.replaceState(null, '', location.pathname + location.search); restore(b); }
else { b.restore = true; setBack(b); location.href = b.page; }
});
(function () {
var b = getBack();
if (!b || Date.now() - b.t > 3600000) { setBack(null); return; }
if (b.restore && b.page === here) { setBack(null); userMoved = false; setTimeout(function () { restore(b); }, 50); }
else if (b.to === here) showPill(b);
else setBack(null);
})();
document.addEventListener('click', function (e) {
var go = e.target.closest ? e.target.closest('.xc-go') : null;
if (go) { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); jump(cur, go.getAttribute('href')); return; }
if (e.target.closest && e.target.closest('.xc-x')) { close(true); return; }
var a = e.target.closest ? e.target.closest('a.xref') : null;
if (a) {
if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;  // new tab etc. stay as plain links
e.preventDefault();
if (cur === a && !card.hidden && !byHover) close(false); else { cur = null; open(a, false); }
return;
}
if (!card.hidden && !card.contains(e.target)) close(false);
});
document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !card.hidden) close(true); });
window.addEventListener('resize', function () { if (!card.hidden && cur) place(cur); });
if (BH.mq('(hover: hover) and (pointer: fine)').matches) {
document.addEventListener('mouseover', function (e) {
var a = e.target.closest ? e.target.closest('a.xref') : null;
if (a) { clearTimeout(leaveT); clearTimeout(hoverT); if (cur !== a || card.hidden) hoverT = setTimeout(function () { load().then(function () { open(a, true); }, function () {}); }, 380); return; }
if (card.contains(e.target)) { clearTimeout(leaveT); return; }
});
document.addEventListener('mouseout', function (e) {
var from = e.target.closest ? (e.target.closest('a.xref') || (card.contains(e.target) ? card : null)) : null;
if (!from) return;
var to = e.relatedTarget;
if (to && (card.contains(to) || (to.closest && to.closest('a.xref') === cur))) return;
clearTimeout(hoverT);
if (byHover) leaveT = setTimeout(function () { close(false); }, 260);
});
}
})(window.BH);
