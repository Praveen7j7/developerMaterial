/* Cross-reference previews. A tap or click on a reference ("Part 14", "14.3") opens a small card
 * with the target's title and opening sentences (refs.json, loaded on first use), so the reader
 * gets the gist without leaving the page. "Go to section" jumps there; a "Back to where you were"
 * pill then returns to the exact reference. Mouse users also get the card on hover.
 * Nothing is stored beyond this tab's return point (sessionStorage), never reading progress. */
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
      '<span class="xc-note">' + (same ? 'On this page' : 'In Volume ' + (/^vol-(\d+)/.exec(file) || [0, '?'])[1]) + '</span></div>';
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

  // ---------- return point ----------
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
    // diagrams above the reference render after load and push it down: keep it in place until the reader scrolls
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
  // on arrival: a pending return to this page, or a jump that came from another page
  (function () {
    var b = getBack();
    if (!b || Date.now() - b.t > 3600000) { setBack(null); return; }
    if (b.restore && b.page === here) { setBack(null); userMoved = false; setTimeout(function () { restore(b); }, 50); }
    else if (b.to === here) showPill(b);
    else setBack(null);
  })();

  // ---------- events ----------
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
