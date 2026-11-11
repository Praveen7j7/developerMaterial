/* Shared helpers for every feature file: DOM shortcuts, safe storage, click actions,
 * dialogs, theme, and a polite live region for announcements. */
(function () {
  'use strict';
  var root = document.documentElement;
  var BH = window.BH = {};

  BH.$ = function (s, el) { return (el || document).querySelector(s); };
  BH.$$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  BH.page = root.getAttribute('data-page');
  BH.mq = function (q) { return window.matchMedia ? window.matchMedia(q) : { matches: false, addEventListener: function () {} }; };
  BH.reduced = BH.mq('(prefers-reduced-motion: reduce)').matches;

  // localStorage can be missing or throw (private mode, blocked storage): every access is guarded
  // device preferences only (theme, sidebar, rail, roadmap role); reading progress is never stored
  BH.store = {
    raw: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    setRaw: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* page still works */ } },
    get: function (k, d) { var v = BH.store.raw(k); if (v == null) return d; try { return JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { BH.store.setRaw(k, JSON.stringify(v)); },
    del: function (k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // an earlier build kept reading progress here; remove it from shared browsers
  BH.store.del('bh-read'); BH.store.del('bh-last');

  // one delegated click listener; features register handlers by data-action name
  var actions = {};
  BH.action = function (name, fn) { actions[name] = fn; };
  document.addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-action]') : null;
    if (el && actions[el.getAttribute('data-action')]) actions[el.getAttribute('data-action')](e, el);
  });

  BH.reveal = function (el) {
    var opened = false;
    for (var d = el && el.closest ? el.closest('details') : null; d; d = d.parentElement.closest('details')) { if (!d.open) { d.open = true; opened = true; } }
    return opened;
  };
  BH.emit = function (name, detail) { document.dispatchEvent(new CustomEvent('bh:' + name, { detail: detail })); };
  BH.on = function (name, fn) { document.addEventListener('bh:' + name, function (e) { fn(e.detail); }); };

  // live region for "Copied", "Marked as read", ...
  var live = document.createElement('div');
  live.className = 'sr-only'; live.setAttribute('aria-live', 'polite');
  document.body.appendChild(live);
  BH.say = function (msg) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30); };

  // dialogs: native <dialog> with a fallback; focus returns to whatever opened it
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
    // a click on the backdrop (outside the box) closes
    dlg.addEventListener('click', function (e) {
      if (e.target !== dlg) return;
      var r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) BH.closeDialog(dlg);
    });
  });
  BH.action('close-dialog', function (e, el) { BH.closeDialog(el.closest('dialog')); });
  BH.action('open-keys', function () { BH.openDialog(BH.$('#keys-dlg')); });

  // theme: the reader's choice wins, otherwise the system setting
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
