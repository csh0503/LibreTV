(() => {
  const d = document.querySelector('[role="dialog"]');
  const out = { dialogs: document.querySelectorAll('[role="dialog"]').length };
  if (d) {
    let el = d;
    out.chain = [];
    for (let i = 0; el && i < 5; i++, el = el.parentElement) {
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      out.chain.push([el.tagName, (el.className + '').slice(0, 70), s.position, s.top, s.left, s.display, s.opacity, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(' | '));
    }
  }
  return out;
})()
