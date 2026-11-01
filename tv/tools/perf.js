(async () => {
  const label = window.__perfLabel || 'run';
  let long = 0, longMs = 0;
  const po = new PerformanceObserver((l) => { l.getEntries().forEach((e) => { long++; longMs += e.duration; }); });
  try { po.observe({ entryTypes: ['longtask'] }); } catch (e) {}
  const start = performance.now();
  const frames = [];
  let last = start, run = true;
  (function tick(t) { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick); })(start);
  for (let i = 0; i < 12; i++) {
    window.scrollBy({ top: i < 6 ? 500 : -500, behavior: 'smooth' });
    await new Promise((r) => setTimeout(r, 450));
  }
  run = false; po.disconnect();
  const secs = (performance.now() - start) / 1000;
  const sorted = frames.slice(1).sort((a, b) => a - b);
  const all = document.querySelectorAll('*');
  let blur = 0, shadow = 0, trans = 0, anim = 0;
  all.forEach((el) => {
    const s = getComputedStyle(el);
    if (s.backdropFilter && s.backdropFilter !== 'none') blur++;
    if (s.filter && s.filter !== 'none') blur++;
    if (s.boxShadow !== 'none') shadow++;
    if (s.transitionDuration !== '0s') trans++;
    if (s.animationName !== 'none') anim++;
  });
  const imgs = Array.prototype.slice.call(document.images);
  const natural = imgs.filter((i) => i.naturalWidth > 0);
  return {
    label, path: location.pathname,
    fps: +(frames.length / secs).toFixed(1),
    p50: +sorted[Math.floor(sorted.length * .5)].toFixed(1),
    p95: +sorted[Math.floor(sorted.length * .95)].toFixed(1),
    over50ms: sorted.filter((f) => f > 50).length, frames: sorted.length,
    longTasks: long, longMs: Math.round(longMs),
    dom: all.length, blur, shadow, trans, anim,
    imgs: imgs.length, loaded: natural.length,
    bigImg: natural.reduce((m, i) => Math.max(m, i.naturalWidth), 0),
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    dpr: devicePixelRatio, vw: innerWidth,
  };
})()
