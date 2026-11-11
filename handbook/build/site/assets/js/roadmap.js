/* Roadmap page: the role switch highlights the stages (and extra track) for one kind of engineer.
 * The choice is remembered in this browser. */
(function (BH) {
  'use strict';
  var list = BH.$('.stages'), dataEl = BH.$('#role-data');
  if (!list || !dataEl) return;
  var roles = JSON.parse(dataEl.textContent);
  function apply(id) {
    var r = roles[id] || roles.all;
    list.setAttribute('data-role', id);
    // a role with no stages (System design) shows only its own track
    if (r.stages.length) list.removeAttribute('data-nostages'); else list.setAttribute('data-nostages', '');
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
