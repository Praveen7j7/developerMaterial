/* Backend Engineering Handbook. Generated from build/site/assets/js/ (core.js, layout.js, search.js, roadmap.js, keys.js); do not edit here. */
(function () {
'use strict';
var root = document.documentElement;
var BH = window.BH = {};
BH.$ = function (s, el) { return (el || document).querySelector(s); };
BH.$$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
BH.page = root.getAttribute('data-page');
BH.mq = function (q) { return window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener: function () {} }; };
BH.reduced = BH.mq('(prefers-reduced-motion: reduce)').matches;
BH.store = {
raw: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
setRaw: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* page still works */ } },
get: function (k, d) { var v = BH.store.raw(k); if (v == null) return d; try { return JSON.parse(v); } catch (e) { return d; } },
set: function (k, v) { BH.store.setRaw(k, JSON.stringify(v)); },
del: function (k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
};
BH.store.del('bh-read'); BH.store.del('bh-last');
var actions = {};
BH.action = function (name, fn) { actions[name] = fn; };
document.addEventListener('click', function (e) {
var el = e.target.closest ? e.target.closest('[data-action]') : null;
if (el && actions[el.getAttribute('data-action')]) actions[el.getAttribute('data-action')](e, el);
});
BH.emit = function (name, detail) { document.dispatchEvent(new CustomEvent('bh:' + name, { detail: detail })); };
BH.on = function (name, fn) { document.addEventListener('bh:' + name, function (e) { fn(e.detail); }); };
var live = document.createElement('div');
live.className = 'sr-only'; live.setAttribute('aria-live', 'polite');
document.body.appendChild(live);
BH.say = function (msg) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30); };
var opener = null;
BH.openDialog = function (dlg) {
if (!dlg) return;
opener = document.activeElement;
if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
BH.emit('dialog', dlg);
};
BH.closeDialog = function (dlg) {
if (!dlg) return;
if (dlg.close) dlg.close(); else dlg.removeAttribute('open');
};
BH.$$('dialog').forEach(function (dlg) {
dlg.addEventListener('close', function () { if (opener && opener.focus) opener.focus(); opener = null; });
dlg.addEventListener('click', function (e) {
if (e.target !== dlg) return;
var r = dlg.getBoundingClientRect();
if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) BH.closeDialog(dlg);
});
});
BH.action('close-dialog', function (e, el) { BH.closeDialog(el.closest('dialog')); });
BH.action('open-keys', function () { BH.openDialog(BH.$('#keys-dlg')); });
BH.isDark = function () {
var t = root.getAttribute('data-theme');
return t ? t === 'dark' : BH.mq('(prefers-color-scheme: dark)').matches;
};
function themeLabels() {
BH.$$('[data-action="toggle-theme"]').forEach(function (b) { b.setAttribute('aria-label', BH.isDark() ? 'Switch to light theme' : 'Switch to dark theme'); });
}
BH.toggleTheme = function () {
var next = BH.isDark() ? 'light' : 'dark';
root.setAttribute('data-theme', next);
BH.store.setRaw('bh-theme', next);
themeLabels();
BH.say(next === 'dark' ? 'Dark theme' : 'Light theme');
BH.emit('theme', next);
};
BH.action('toggle-theme', BH.toggleTheme);
themeLabels();
})();
(function (BH) {
'use strict';
var root = document.documentElement;
var sidebar = BH.$('#sidebar'), scrim = BH.$('.scrim'), rail = BH.$('#rail');
var isVol = BH.page === 'vol';
var wide = BH.mq('(min-width: 1024px)'), xwide = BH.mq('(min-width: 1280px)');
var docked = function () { return isVol && wide.matches; };
var drawerOpen = false;
function syncSidebar() {
var open = docked() ? !root.classList.contains('sb-off') : drawerOpen;
BH.$$('[data-action="toggle-sidebar"]').forEach(function (b) {
b.setAttribute('aria-expanded', String(open));
b.setAttribute('aria-label', (open ? (docked() ? 'Hide' : 'Close') : 'Show') + ' contents');
});
var t = BH.$('.sb-hide span'); if (t) t.textContent = docked() ? 'Hide' : 'Close';
}
function setInert(on) {
BH.$$('.topbar, .main, .rail, .site-footer, .to-top').forEach(function (el) {
if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
});
}
function openDrawer() {
drawerOpen = true; root.classList.add('drawer-open'); scrim.hidden = false; setInert(true); syncSidebar();
var cur = BH.$('a[aria-current]', sidebar);
(BH.$('.sb-hide', sidebar)).focus();
if (cur) cur.scrollIntoView({ block: 'center' });
}
function closeDrawer(restore) {
if (!drawerOpen) return;
drawerOpen = false; root.classList.remove('drawer-open'); scrim.hidden = true; setInert(false); syncSidebar();
if (restore !== false) { var b = BH.$('.tb-contents'); if (b) b.focus(); }
}
BH.closeDrawer = closeDrawer;
BH.toggleSidebar = function () {
if (docked()) {
var off = !root.classList.contains('sb-off');
root.classList.toggle('sb-off', off);
BH.store.setRaw('bh-sidebar', off ? '0' : '1');
syncSidebar();
BH.say(off ? 'Contents hidden' : 'Contents shown');
var focusTo = off ? BH.$('.tb-contents') : BH.$('.sb-hide');
if (focusTo && document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-action="toggle-sidebar"]')) focusTo.focus();
} else if (drawerOpen) closeDrawer(); else openDrawer();
};
BH.action('toggle-sidebar', BH.toggleSidebar);
BH.action('close-drawer', function () { closeDrawer(); });
if (sidebar) sidebar.addEventListener('click', function (e) { if (drawerOpen && e.target.closest('a')) closeDrawer(false); });
if (wide.addEventListener) wide.addEventListener('change', function () { closeDrawer(false); syncSidebar(); });
syncSidebar();
function syncRail() {
var open = !root.classList.contains('rail-off');
BH.$$('[data-action="toggle-rail"]').forEach(function (b) {
b.setAttribute('aria-expanded', String(open));
b.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' On this page');
});
}
BH.toggleRail = function () {
if (!rail || !xwide.matches) return;
var off = !root.classList.contains('rail-off');
root.classList.toggle('rail-off', off);
BH.store.setRaw('bh-rail', off ? '0' : '1');
syncRail();
BH.say(off ? 'On this page hidden' : 'On this page shown');
};
BH.action('toggle-rail', BH.toggleRail);
syncRail();
BH.$$('.tv-btn').forEach(function (b) {
b.addEventListener('click', function () {
var open = b.getAttribute('aria-expanded') !== 'true';
b.setAttribute('aria-expanded', String(open));
document.getElementById(b.getAttribute('aria-controls')).hidden = !open;
});
});
var menuBtn = BH.$('[data-action="toggle-menu"]'), menu = BH.$('#vol-menu');
function setMenu(open) { if (!menu) return; menu.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open)); }
BH.closeMenu = function () { if (menu && !menu.hidden) { setMenu(false); return true; } return false; };
BH.action('toggle-menu', function () { setMenu(menu.hidden); if (!menu.hidden) { var a = BH.$('a', menu); if (a) a.focus(); } });
document.addEventListener('click', function (e) { if (menu && !menu.hidden && !e.target.closest('.menu-wrap')) setMenu(false); });
if (menu) menu.addEventListener('focusout', function (e) { if (e.relatedTarget && !e.relatedTarget.closest('.menu-wrap')) setMenu(false); });
BH.$$('.learn-more').forEach(function (b) {
b.addEventListener('click', function () {
var open = b.getAttribute('aria-expanded') !== 'true';
b.setAttribute('aria-expanded', String(open));
b.previousElementSibling.classList.toggle('is-open', open);
});
});
var toTop = BH.$('.to-top');
BH.action('to-top', function () {
window.scrollTo({ top: 0, behavior: BH.reduced ? 'auto' : 'smooth' });
var m = BH.$('#main'); if (m) m.focus({ preventScroll: true });
});
var parts = BH.$$('section.part');
var heads = BH.$$('.prose h2[id], .prose h3[id]').filter(function (h) { return !h.closest('.part-head'); });
var tops = [], partTops = [], dirty = true;
var crumbPart = BH.$('[data-crumb="part"]'), crumbSec = BH.$('[data-crumb="section"]');
var railPart = BH.$('[data-rail-part]'), railList = BH.$('[data-rail-list]');
var curPart = null, curHead, curH2 = null;  // curHead starts undefined so the first pass always paints
var topbarH = function () { var t = BH.$('.topbar'); return t ? t.getBoundingClientRect().height : 56; };
function measure() {
var y = window.pageYOffset;
tops = heads.map(function (h) { return h.getBoundingClientRect().top + y; });
partTops = parts.map(function (p) { return p.getBoundingClientRect().top + y; });
dirty = false;
}
function floor(arr, v) {
var lo = 0, hi = arr.length - 1, ans = -1;
while (lo <= hi) { var mid = (lo + hi) >> 1; if (arr[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
return ans;
}
function text(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
function fitCrumb(t) {
if (!crumbSec) return;
crumbSec.textContent = t; crumbSec.title = t;
if (!crumbSec.clientWidth) return;
var words = t.split(' ');
while (words.length > 1 && crumbSec.scrollWidth > crumbSec.clientWidth) { words.pop(); crumbSec.textContent = words.join(' ').replace(/[,:;]$/, '') + ' …'; }
}
function buildRail(part) {
if (!railList) return;
var h2s = BH.$$('.prose h2[id]', part).filter(function (h) { return !h.closest('.part-head'); });
railList.innerHTML = '';
h2s.forEach(function (h) {
var li = document.createElement('li'); li.className = 'r2';
var a = document.createElement('a'); a.href = '#' + h.id; a.textContent = text(h); a.setAttribute('data-for', h.id);
li.appendChild(a); railList.appendChild(li);
});
if (railPart) { railPart.textContent = 'Part ' + part.getAttribute('data-part') + ': ' + part.getAttribute('data-title'); railPart.href = '#' + part.id; }
}
function railSubs(h2) {
if (!railList) return;
BH.$$('.r3', railList).forEach(function (li) { li.parentNode.removeChild(li); });
if (!h2) return;
var a = BH.$('a[data-for="' + h2.id + '"]', railList); if (!a) return;
var after = a.parentNode, el = h2.nextElementSibling, n = 0;
while (el && el.tagName !== 'H2' && n < 30) {
if (el.tagName === 'H3' && el.id) {
var li = document.createElement('li'); li.className = 'r3';
var b = document.createElement('a'); b.href = '#' + el.id; b.textContent = text(el); b.setAttribute('data-for', el.id);
li.appendChild(b); after.parentNode.insertBefore(li, after.nextSibling); after = li; n++;
}
el = el.nextElementSibling;
}
}
function markRail(id) {
if (!railList) return;
BH.$$('a[aria-current]', railList).forEach(function (a) { a.removeAttribute('aria-current'); });
var a = id && BH.$('a[data-for="' + id + '"]', railList);
if (a) {
a.setAttribute('aria-current', 'location');
var box = railList.closest('.rail-in');
if (box) { var r = a.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.top < b.top + 60 || r.bottom > b.bottom - 40) box.scrollTop += r.top - b.top - b.height / 3; }
}
}
function setPart(part) {
curPart = part;
var n = part.getAttribute('data-part');
if (crumbPart) { crumbPart.textContent = 'Part ' + n; crumbPart.href = '#' + part.id; }
BH.$$('#sidebar a[aria-current]').forEach(function (a) { a.removeAttribute('aria-current'); });
var link = BH.$('#sidebar a[data-part="' + n + '"]');
if (link) {
link.setAttribute('aria-current', 'location');
if (docked()) {
var r = link.getBoundingClientRect(), s = sidebar.getBoundingClientRect();
if (r.top < s.top + 40 || r.bottom > s.bottom - 20) sidebar.scrollTop += r.top - s.top - s.height / 3;
}
}
buildRail(part); curH2 = null;
}
function onScroll() {
var y = window.pageYOffset;
if (toTop) toTop.classList.toggle('show', y > 900);
if (!isVol || !parts.length) return;
if (dirty) measure();
var line = y + topbarH() + 24;
var pi = floor(partTops, line); var part = parts[Math.max(0, pi)];
if (part !== curPart) setPart(part);
var hi = floor(tops, line); var h = hi >= 0 ? heads[hi] : null;
if (h && !part.contains(h)) h = null;
if (h !== curHead) {
curHead = h;
var h2 = h ? (h.tagName === 'H2' ? h : (function (el) { while (el && el.tagName !== 'H2') el = el.previousElementSibling; return el; })(h)) : null;
if (h2 !== curH2) { curH2 = h2; railSubs(h2); }
markRail(h ? h.id : null);
fitCrumb(h ? text(h) : part.getAttribute('data-title'));
}
}
var ticking = false;
function schedule() { if (!ticking) { ticking = true; requestAnimationFrame(function () { ticking = false; onScroll(); }); } }
window.addEventListener('scroll', schedule, { passive: true });
window.addEventListener('resize', function () { dirty = true; if (crumbSec && crumbSec.title) fitCrumb(crumbSec.title); schedule(); });
var pin = null, pinUntil = 0;
function pinHash() {
var id = decodeURIComponent(location.hash.slice(1));
pin = id ? document.getElementById(id) : null; pinUntil = Date.now() + 12000;
}
function unpin() { pin = null; }
['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) { window.addEventListener(ev, unpin, { passive: true }); });
window.addEventListener('hashchange', function () { pinHash(); });
if (isVol) pinHash();
function holdPin() {
if (!pin || Date.now() > pinUntil) { pin = null; return; }
var off = pin.getBoundingClientRect().top - topbarH() - 16;
if (Math.abs(off) > 4) window.scrollTo({ top: window.pageYOffset + off, behavior: 'instant' });
}
if (window.ResizeObserver && BH.$('#main')) new ResizeObserver(function () { dirty = true; holdPin(); schedule(); }).observe(BH.$('#main'));
document.addEventListener('toggle', function () { dirty = true; }, true);
BH.headings = function () { if (dirty) measure(); return { list: heads, tops: tops }; };
onScroll();
})(window.BH);
(function (BH) {
'use strict';
var idx = null, loading = null;
function load() {
if (idx) return Promise.resolve(idx);
if (!loading) loading = fetch('search-index.json').then(function (r) { return r.json(); })
.then(function (d) { idx = d.map(function (e) { var s = e.t.split(' › '); e.h = s.length > 1 ? s.slice(1).join(' › ') : e.t; e.l = e.t.toLowerCase(); e.hl = e.h.toLowerCase(); return e; }); return idx; })
.catch(function () { loading = null; return null; });
return loading;
}
function find(q) {
var words = q.toLowerCase().replace(/[^\w\s.#+-]/g, ' ').split(/\s+/).filter(Boolean);
if (!words.length || !idx) return [];
var num = /^\d{1,2}$/.test(q.trim()) ? +q.trim() : (/^part\s+(\d{1,2})$/i.exec(q.trim()) || [])[1];
var hits = [];
for (var i = 0; i < idx.length; i++) {
var e = idx[i], s = 0, ok = true;
if (num != null && e.k === 'part' && e.p === +num) { hits.push({ e: e, s: 1000 }); continue; }
for (var w = 0; w < words.length; w++) {
var at = e.l.indexOf(words[w]);
if (at < 0) { ok = false; break; }
if (e.hl.indexOf(words[w]) === 0 || e.hl.indexOf(' ' + words[w]) >= 0) s += 4;
else if (e.hl.indexOf(words[w]) >= 0) s += 2;
}
if (!ok) continue;
if (e.k === 'part') s += 6;
s -= e.h.length / 80;
hits.push({ e: e, s: s });
}
hits.sort(function (a, b) { return b.s - a.s; });
return hits.slice(0, 30).map(function (h) { return h.e; });
}
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function mark(s, q) {
var out = esc(s);
q.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 1; }).forEach(function (w) {
out = out.replace(new RegExp('(' + esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
});
return out;
}
function attach(input, list, opts) {
var sel = -1, items = [];
function select(i) {
items.forEach(function (li, j) { li.setAttribute('aria-selected', String(j === i)); });
sel = i;
if (i >= 0 && items[i]) { input.setAttribute('aria-activedescendant', items[i].id); items[i].scrollIntoView({ block: 'nearest' }); }
else input.removeAttribute('aria-activedescendant');
}
function render() {
var q = input.value.trim();
if (!q) { list.innerHTML = ''; items = []; if (opts.pop) list.hidden = true; return; }
load().then(function () {
if (input.value.trim() !== q) return;
if (!idx) { list.innerHTML = '<li class="sr-empty">Search could not load. Check your connection and try again.</li>'; return; }
var hits = find(q);
list.innerHTML = hits.length ? hits.map(function (e, i) {
var title = e.k === 'part' ? e.t : e.h;
var sub = e.k === 'part' ? 'Volume ' + e.v + ', the whole Part' : 'Part ' + e.p + ': ' + e.t.split(' › ')[0];
return '<li role="option" id="' + list.id + '-' + i + '" aria-selected="false" data-vol="' + e.v + '"><a href="vol-' + e.v + '-' + e.s + '.html#' + e.a + '" tabindex="-1">' +
'<span class="sr-part">' + e.p + '</span><span class="sr-title">' + mark(title, q) + '</span><span class="sr-sub">' + esc(sub) + '</span></a></li>';
}).join('') : '<li class="sr-empty">No Part or section matches “' + esc(q) + '”. Try a shorter or different word.</li>';
items = BH.$$('[role="option"]', list); sel = -1;
if (opts.pop) list.hidden = false;
BH.say(hits.length ? hits.length + ' results' : 'No results');
});
}
function go(a) {
if (!a) return;
var dlg = input.closest('dialog');
if (dlg) BH.closeDialog(dlg);
window.location.href = a.getAttribute('href');
}
input.addEventListener('input', render);
input.addEventListener('focus', function () { load(); if (opts.pop && input.value.trim()) list.hidden = false; });
input.addEventListener('keydown', function (e) {
if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(items.length - 1, sel + 1)); }
else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, sel - 1)); }
else if (e.key === 'Enter') { e.preventDefault(); var it = items[sel >= 0 ? sel : 0]; if (it) go(BH.$('a', it)); }
else if (e.key === 'Escape') { e.preventDefault(); if (opts.pop) list.hidden = true; else BH.closeDialog(input.closest('dialog')); }  // one Esc closes, even with text typed
});
list.addEventListener('click', function (e) { var a = e.target.closest('a'); if (a) { e.preventDefault(); go(a); } });
if (opts.pop) document.addEventListener('click', function (e) { if (!e.target.closest('.hero-search')) list.hidden = true; });
}
var dlg = BH.$('#search-dlg'), dIn = BH.$('#search-input'), dList = BH.$('#search-results');
if (dlg && dIn) attach(dIn, dList, {});
BH.openSearch = function () { BH.openDialog(dlg); dIn.focus(); dIn.select(); load(); };
BH.action('open-search', BH.openSearch);
function fitPlaceholders() {
BH.$$('input[data-long-placeholder]').forEach(function (inp) {
if (!inp._short) inp._short = inp.placeholder;
var w = inp.clientWidth; if (!w) return;
var c = fitPlaceholders.c || (fitPlaceholders.c = document.createElement('canvas').getContext('2d'));
var cs = getComputedStyle(inp); c.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
inp.placeholder = c.measureText(inp.getAttribute('data-long-placeholder')).width + 8 <= w ? inp.getAttribute('data-long-placeholder') : inp._short;
});
}
fitPlaceholders();
window.addEventListener('resize', fitPlaceholders);
BH.on('dialog', fitPlaceholders);
var hIn = BH.$('#hero-q'), hList = BH.$('#hero-results');
if (hIn && hList) attach(hIn, hList, { pop: true });
})(window.BH);
(function (BH) {
'use strict';
var list = BH.$('.stages'), dataEl = BH.$('#role-data');
if (!list || !dataEl) return;
var roles = JSON.parse(dataEl.textContent);
function apply(id) {
var r = roles[id] || roles.all;
list.setAttribute('data-role', id);
BH.$$('.stage[data-stage]', list).forEach(function (st) {
var on = r.stages.indexOf(+st.getAttribute('data-stage')) >= 0;
st.classList.toggle('on-path', on && id !== 'all');
st.classList.toggle('off-path', !on);
var d = BH.$('details', st); if (d) d.open = on;
});
BH.$$('.stage-extra', list).forEach(function (x) {
var on = x.getAttribute('data-extra') === r.extra;
x.hidden = !on; x.classList.toggle('on-path', on);
});
}
var saved = BH.store.raw('bh-role');
BH.$$('input[name="role"]').forEach(function (inp) {
if (saved && inp.value === saved) inp.checked = true;
inp.addEventListener('change', function () {
if (!inp.checked) return;
apply(inp.value); BH.store.setRaw('bh-role', inp.value);
BH.say('Showing the ' + inp.parentNode.textContent.trim() + ' path');
});
});
apply(saved && roles[saved] ? saved : 'all');
})(window.BH);
(function (BH) {
'use strict';
function typing(el) {
if (!el) return false;
var t = el.tagName;
return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable;
}
function jump(dir) {
if (!BH.headings || BH.page !== 'vol') return;
var h = BH.headings(), bar = BH.$('.topbar');
var y = window.pageYOffset + (bar ? bar.offsetHeight : 56) + 30, i;
if (dir > 0) { for (i = 0; i < h.tops.length; i++) if (h.tops[i] > y + 4) break; }
else { for (i = h.tops.length - 1; i >= 0; i--) if (h.tops[i] < y - 40) break; }
var el = h.list[i];
if (!el) return;
el.scrollIntoView({ behavior: BH.reduced ? 'auto' : 'smooth', block: 'start' });
if (history.replaceState) history.replaceState(null, '', '#' + el.id);
}
var keys = {
'/': function () { BH.openSearch(); },
'j': function () { jump(1); },
'k': function () { jump(-1); },
't': function () { BH.toggleTheme(); },
'[': function () { BH.toggleSidebar(); },
']': function () { BH.toggleRail(); },
'?': function () { BH.openDialog(BH.$('#keys-dlg')); }
};
document.addEventListener('keydown', function (e) {
if (e.key === 'Escape') {
if (BH.closeMenu && BH.closeMenu()) return;
if (document.documentElement.classList.contains('drawer-open')) BH.closeDrawer();
return;
}
if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || BH.$('dialog[open]')) return;
var fn = keys[e.key];
if (fn) { e.preventDefault(); fn(); }
});
})(window.BH);
