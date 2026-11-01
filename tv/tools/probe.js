(async () => {
  const label = () => { const a = document.activeElement; return a ? a.tagName + ':' + (a.getAttribute('aria-label') || a.textContent || '').slice(0, 20) : 'none'; };
  const out = { start: label(), hasMove: typeof window.__tvMove, steps: [] };
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowDown']) {
    const r = window.__tvMove(k);
    await new Promise((res) => setTimeout(res, 400));
    out.steps.push(k + ' ' + r + ' -> ' + label());
  }
  const st = await fetch('/api/status').then((r) => r.json()).catch((e) => String(e));
  out.verified = st.verified;
  out.passwordRequired = st.passwordRequired;
  out.dialogs = document.querySelectorAll('[role="dialog"]').length;
  out.inputs = Array.prototype.map.call(document.querySelectorAll('input'), (i) => i.type + ':' + (i.placeholder || '').slice(0, 12));
  const res = performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/')).map((e) => e.name.split('/api/')[1].slice(0, 28) + ' ' + Math.round(e.duration));
  out.api = res.slice(-8);
  return out;
})()
