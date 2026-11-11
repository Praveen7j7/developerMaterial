/* Reading features: Copy buttons on code, Key Takeaways flashcards, and printing with
 * every answer expanded. */
(function (BH) {
  'use strict';
  if (BH.page !== 'vol') return;

  // ---------- copy code ----------
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

  // ---------- Key Takeaways flashcards ----------
  // front: the opening idea of a takeaway (up to its first colon, semicolon or dash), back: the whole takeaway
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

  // ---------- print with every answer open ----------
  var closed = [];
  window.addEventListener('beforeprint', function () {
    closed = BH.$$('details:not([open])'); closed.forEach(function (d) { d.open = true; });
  });
  window.addEventListener('afterprint', function () { closed.forEach(function (d) { d.open = false; }); closed = []; });
})(window.BH);
