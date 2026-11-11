/* Page frame behaviour: contents sidebar (docked and collapsible on wide volume pages,
 * a drawer everywhere else), the On-this-page rail, the Volumes menu, the book tree,
 * and the scroll tracker (breadcrumbs, "you are here", rail scroll-spy, back-to-top).
 * Nothing about what a reader has read is stored: the same browser may be shared. */
(function (BH) {
  'use strict';
  var root = document.documentElement;
  var sidebar = BH.$('#sidebar'), scrim = BH.$('.scrim'), rail = BH.$('#rail');
  var isVol = BH.page === 'vol';
  var wide = BH.mq('(min-width: 1024px)'), xwide = BH.mq('(min-width: 1280px)');
  var docked = function () { return isVol && wide.matches; };
  var drawerOpen = false;

  // ---------- contents sidebar ----------
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
  // following a link inside the drawer closes it
  if (sidebar) sidebar.addEventListener('click', function (e) { if (drawerOpen && e.target.closest('a')) closeDrawer(false); });
  if (wide.addEventListener) wide.addEventListener('change', function () { closeDrawer(false); syncSidebar(); });
  syncSidebar();

  // ---------- right rail ----------
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

  // ---------- book tree, Volumes menu, "show all sections" ----------
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

  // ---------- back to top ----------
  var toTop = BH.$('.to-top');
  BH.action('to-top', function () {
    window.scrollTo({ top: 0, behavior: BH.reduced ? 'auto' : 'smooth' });
    var m = BH.$('#main'); if (m) m.focus({ preventScroll: true });
  });

  // ---------- scroll tracker (volume pages) ----------
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
  // last index i with arr[i] <= v (arr sorted), or -1
  function floor(arr, v) {
    var lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (arr[mid] <= v) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  function text(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  // the section crumb shortens at a word boundary, never mid-word
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
  // h3s appear under the h2 you are reading, so long Parts stay scannable
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
  // Deep links (#section): diagrams above the target render after load and push it down, so keep the
  // target pinned under the top bar until the reader scrolls themselves (or 12 s pass).
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
  // diagrams render and answers open after load; re-measure when the page grows or shrinks
  if (window.ResizeObserver && BH.$('#main')) new ResizeObserver(function () { dirty = true; holdPin(); schedule(); }).observe(BH.$('#main'));
  document.addEventListener('toggle', function () { dirty = true; }, true);
  BH.headings = function () { if (dirty) measure(); return { list: heads, tops: tops }; };
  onScroll();
})(window.BH);
