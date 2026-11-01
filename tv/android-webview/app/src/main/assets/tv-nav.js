(function () {
  if (window.__tvMove) return;
  var style = document.createElement('style');
  // Flexbox gap needs Chrome 84; approximate Tailwind's gap-* with margins on this WebView.
  var gaps = { '1': .25, '1\\.5': .375, '2': .5, '2\\.5': .625, '3': .75, '4': 1, '5': 1.25, '6': 1.5, '8': 2 };
  var gapCss = Object.keys(gaps).map(function (k) {
    return '.flex.gap-' + k + ':not(.flex-col)>*+*{margin-left:' + gaps[k] + 'rem}' +
      '.flex.flex-col.gap-' + k + '>*+*{margin-top:' + gaps[k] + 'rem}';
  }).join('');
  // Blur, shadows and transitions cost most of the frame on this GPU (1.3 fps vs 4.8 fps when scrolling).
  // No ::before/::after here: matching them on every element makes each style recalculation much slower.
  var liteCss = '*{backdrop-filter:none !important;-webkit-backdrop-filter:none !important;' +
    'filter:none !important;box-shadow:none !important;text-shadow:none !important;transition:none !important;' +
    'animation:none !important;scroll-behavior:auto !important}';
  var offCss = '.tv-off>*{display:none !important}';
  style.textContent = ':focus{outline:4px solid #fff !important;outline-offset:2px;}' + gapCss + liteCss + offCss;
  document.head.appendChild(style);
  var SEL = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"]),[role="button"]';
  var DIRS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  }
  // Dialogs and full-screen layers such as "who's watching" cover the page, so stay inside the topmost one.
  function scope() {
    var layers = Array.prototype.filter.call(document.querySelectorAll('[role="dialog"],.fixed.inset-0'), visible);
    return layers.length ? layers[layers.length - 1] : document;
  }
  function candidates() {
    return Array.prototype.filter.call(scope().querySelectorAll(SEL), visible);
  }
  function enterLayer() {
    var layer = scope();
    if (layer === document || layer.contains(document.activeElement)) return;
    var list = candidates();
    // Prefer an actual choice over a small link at the top of the layer.
    var first = list.filter(function (el) { return el.getAttribute('role') === 'button'; })[0] || list[0];
    if (first) first.focus();
  }
  // Posters show about 128px wide but some sources serve 3000px originals; ask for a small size instead.
  function shrinkImages() {
    Array.prototype.forEach.call(document.images, function (img) {
      if (img.__tvSized) return;
      img.__tvSized = true;
      img.decoding = 'async';
      var src = img.getAttribute('src') || '';
      var hero = img.closest('section[class*="group/hero"]');
      var next = src.replace(/(lain\.bgm\.tv\/pic\/cover)\/l\//, '$1/c/')
        .replace(/(image\.tmdb\.org\/t\/p)\/(original|w1280|w780|w500|w342)\//, hero ? '$1/w780/' : '$1/w185/')
        .replace(/\/m_ratio_poster\//, '/s_ratio_poster/');
      if (next !== src) img.src = next;
    });
  }
  // Only keep rows near the screen rendered; a row's height is held so the page does not jump.
  var rows = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      var el = entry.target;
      if (entry.isIntersecting) {
        el.classList.remove('tv-off');
        el.style.minHeight = '';
      } else if (!el.contains(document.activeElement)) {
        // The observer already measured it; measuring again would force another layout.
        el.style.minHeight = entry.boundingClientRect.height + 'px';
        el.classList.add('tv-off');
      }
    });
  }, { rootMargin: '700px 0px' });
  function watchRows() {
    Array.prototype.forEach.call(document.querySelectorAll('main section'), function (el) {
      if (el.__tvRow) return;
      el.__tvRow = true;
      rows.observe(el);
    });
  }
  // aspect-ratio needs Chrome 88; without it posters take the height of each image.
  function sizeAspect() {
    [['.aspect-\\[2\\/3\\]', 1.5], ['.aspect-video', 0.5625]].forEach(function (pair) {
      Array.prototype.forEach.call(document.querySelectorAll(pair[0]), function (el) {
        if (el.__tvAspect) return;
        var w = el.getBoundingClientRect().width;
        if (!w) return;
        el.__tvAspect = true;
        el.style.height = Math.round(w * pair[1]) + 'px';
      });
    });
  }
  // Rows hold 20+ posters but about 8 fit on screen. Render a few and add more as focus moves right
  // (scrolling at about 16 fps with every card, 30 fps without the off-screen ones).
  var ROW_STEP = 9;
  function applyRow(row) {
    if (!row.__tvLimit) row.__tvLimit = ROW_STEP;
    Array.prototype.forEach.call(row.children, function (card, i) {
      var show = i < row.__tvLimit;
      if ((card.style.display === 'none') === show) card.style.display = show ? '' : 'none';
    });
  }
  function limitRows() {
    Array.prototype.forEach.call(document.querySelectorAll('main section .overflow-x-auto'), applyRow);
  }
  document.addEventListener('focusin', function (e) {
    var row = e.target.closest && e.target.closest('main section .overflow-x-auto');
    if (!row) return;
    var index = Array.prototype.findIndex.call(row.children, function (card) { return card.contains(e.target); });
    if (index + ROW_STEP > row.__tvLimit) {
      row.__tvLimit = index + ROW_STEP;
      applyRow(row);
    }
  });
  // The row's own arrow buttons scroll without moving focus.
  document.addEventListener('scroll', function (e) {
    var row = e.target;
    if (row.__tvLimit && row.scrollLeft + row.clientWidth >= row.scrollWidth - 8) {
      row.__tvLimit += ROW_STEP;
      applyRow(row);
    }
  }, true);
  function refresh() {
    enterLayer();
    shrinkImages();
    limitRows();
    sizeAspect();
    watchRows();
  }
  var pending = false;
  new MutationObserver(function () {
    if (pending) return;
    pending = true;
    // Wait for an idle moment so this work never lands in the middle of a scroll.
    var run = function () { pending = false; refresh(); };
    if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 600 });
    else setTimeout(run, 150);
  }).observe(document.documentElement, { childList: true, subtree: true });
  refresh();
  function score(from, to, d) {
    var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    var dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    var main = dx * d[0] + dy * d[1];
    if (main <= 1) return Infinity;
    var cross = Math.abs(dx * d[1]) + Math.abs(dy * d[0]);
    return main + cross * 3;
  }
  function typing(el) {
    if (!el) return false;
    var t = el.tagName;
    return t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable ||
      (t === 'INPUT' && !/^(button|checkbox|radio|submit)$/.test(el.type));
  }
  // Returns true when focus was handled; false hands the key back to the page.
  window.__tvMove = function (key) {
    var d = DIRS[key];
    var cur = document.activeElement;
    // The player page handles arrows itself (seek and volume).
    if (location.pathname.indexOf('/watch') === 0 && document.querySelector('video')) return false;
    if (typing(cur) && d[0] !== 0) return false;
    var list = candidates();
    if (!list.length) return false;
    if (!cur || cur === document.body || !visible(cur) || list.indexOf(cur) < 0) { list[0].focus(); return true; }
    var from = cur.getBoundingClientRect(), best = null, bestScore = Infinity;
    list.forEach(function (el) {
      if (el === cur) return;
      var v = score(from, el.getBoundingClientRect(), d);
      if (v < bestScore) { bestScore = v; best = el; }
    });
    if (best) {
      best.focus({ preventScroll: true });
      best.scrollIntoView({ block: 'center', inline: 'center' });
    } else if (d[1]) {
      window.scrollBy(0, d[1] * 400);
    }
    return true;
  };
})();
