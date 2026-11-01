(async () => {
  window.scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 800));
  const pairs = [];
  const frames = [];
  let last = performance.now(), run = true;
  (function tick(t) { frames.push(t - last); last = t; if (run) requestAnimationFrame(tick); })(last);
  const start = performance.now();
  // Like repeatedly pressing down on a remote: jump between rows, then come back.
  for (let i = 0; i < 16; i++) {
    window.scrollBy(0, i < 8 ? 300 : -300);
    await new Promise((r) => setTimeout(r, 400));
  }
  run = false;
  const secs = (performance.now() - start) / 1000;
  const s = frames.slice(1).sort((a, b) => a - b);
  const sec = Array.prototype.map.call(document.querySelectorAll('main section'), (e) => Math.round(e.getBoundingClientRect().height) + (e.classList.contains('tv-off') ? 'off' : ''));
  return { fps: +(frames.length / secs).toFixed(1), p50: +s[Math.floor(s.length * .5)].toFixed(1), p95: +s[Math.floor(s.length * .95)].toFixed(1), over50ms: s.filter((f) => f > 50).length, dom: document.querySelectorAll('*').length, imgs: document.images.length, sections: sec.slice(0, 14), docH: document.documentElement.scrollHeight };
})()
