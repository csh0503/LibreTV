(async () => {
  window.scrollTo(0, 1100);
  await new Promise((r) => setTimeout(r, 900));
  const row = Array.prototype.filter.call(document.querySelectorAll('main section .overflow-x-auto'), (r) => r.children.length > 12 && r.getBoundingClientRect().top > 0 && r.getBoundingClientRect().top < 500)[0];
  if (!row) return 'no row';
  const shown = () => Array.prototype.filter.call(row.children, (c) => c.style.display !== 'none').length;
  const before = shown();
  const first = row.querySelector('[tabindex],a,button');
  first.focus();
  const seq = [];
  for (let i = 0; i < 12; i++) {
    window.__tvMove('ArrowRight');
    await new Promise((r) => setTimeout(r, 200));
    seq.push((document.activeElement.textContent || '').slice(0, 6));
  }
  return { total: row.children.length, before, after: shown(), scrollLeft: Math.round(row.scrollLeft), seq };
})()
