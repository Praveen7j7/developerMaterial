/* Search across every Part and heading (search-index.json, loaded on first use).
 * Used by the top-bar dialog (opened with "/") and the home page's big search box.
 * Every word must match; Part titles, then headings starting with the word, rank first. */
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

  // wire one input + listbox pair
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
  // the long placeholder only where it fits whole (a cut-off hint reads as a mistake)
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
