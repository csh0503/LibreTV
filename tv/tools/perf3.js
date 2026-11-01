(async () => {
  const sample = async (ms, act) => {
    const frames = [];
    let last = performance.now(), run = true, long = 0, longMs = 0;
    const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => { long++; longMs += e.duration; }));
    po.observe({ entryTypes: ['longtask'] });
    (function tick(t) { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick); })(last);
    const start = performance.now();
    if (act) await act(); else await new Promise((r) => setTimeout(r, ms));
    run = false; po.disconnect();
    const secs = (performance.now() - start) / 1000;
    const s = frames.slice(1).sort((a, b) => a - b);
    return { fps: +(frames.length / secs).toFixed(1), p50: +s[Math.floor(s.length * .5)].toFixed(1), p95: +s[Math.floor(s.length * .95)].toFixed(1), max: Math.round(s[s.length - 1]), over34: s.filter((f) => f > 34).length, n: s.length, long, longMs: Math.round(longMs) };
  };
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 1000));
  const idle = await sample(3000);
  const down = await sample(0, async () => { for (let i = 0; i < 8; i++) { window.scrollBy(0, 300); await new Promise((r) => setTimeout(r, 400)); } });
  const back = await sample(0, async () => { for (let i = 0; i < 8; i++) { window.scrollBy(0, -300); await new Promise((r) => setTimeout(r, 400)); } });
  const again = await sample(0, async () => { for (let i = 0; i < 8; i++) { window.scrollBy(0, 300); await new Promise((r) => setTimeout(r, 400)); } });
  return { idle, down, back, again };
})()
