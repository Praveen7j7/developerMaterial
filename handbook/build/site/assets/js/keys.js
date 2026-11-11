/* Keyboard shortcuts: / search, j and k next and previous section, t theme,
 * [ contents sidebar, ] On this page, Esc closes, ? shows the list. */
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
    var open = function (j) { return !h.list[j].closest('details:not([open])'); };  // folded headings are skipped
    if (dir > 0) { for (i = 0; i < h.tops.length; i++) if (h.tops[i] > y + 4 && open(i)) break; }
    else { for (i = h.tops.length - 1; i >= 0; i--) if (h.tops[i] < y - 40 && open(i)) break; }
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
