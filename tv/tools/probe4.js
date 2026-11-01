(async () => {
  const label = () => { const a = document.activeElement; return a ? a.tagName + ':' + (a.getAttribute('aria-label') || a.textContent || '').slice(0, 16) : 'none'; };
  const out = { start: label(), steps: [] };
  for (const k of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
    window.__tvMove(k);
    await new Promise((r) => setTimeout(r, 300));
    out.steps.push(k + ' -> ' + label());
  }
  return out;
})()
