(() => {
  window.scrollTo(0, 0);
  const main = document.querySelector('main');
  const list = Array.prototype.filter.call(main.querySelectorAll('*'), (e) => e.getBoundingClientRect().height > 500 && e.getBoundingClientRect().width > 200);
  return list.slice(0, 16).map((e) => { const r = e.getBoundingClientRect(); return [e.tagName, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), (e.className + '').slice(0, 95)].join(' '); });
})()
