(() => {
  const imgs = Array.prototype.slice.call(document.images);
  const hosts = {};
  imgs.forEach((i) => { let h = ''; try { h = new URL(i.currentSrc || i.src).host; } catch (e) {} hosts[h] = (hosts[h] || 0) + 1; });
  const big = imgs.filter((i) => i.naturalWidth > 700).map((i) => [i.naturalWidth, Math.round(i.getBoundingClientRect().width), (i.currentSrc || i.src).slice(0, 90)].join(' '));
  const sized = imgs.filter((i) => i.naturalWidth).map((i) => i.naturalWidth).sort((a, b) => a - b);
  const main = document.querySelector('main') || document.body;
  const chain = [];
  let el = imgs[Math.floor(imgs.length / 2)];
  for (let i = 0; el && i < 9; i++, el = el.parentElement) chain.push(el.tagName + '.' + (el.className + '').slice(0, 60) + ' h=' + Math.round(el.getBoundingClientRect().height));
  const kids = (n) => Array.prototype.map.call(n.children, (c) => c.tagName + ' q=' + c.querySelectorAll('*').length + ' h=' + Math.round(c.getBoundingClientRect().height) + ' ' + (c.className + '').slice(0, 40));
  return { hosts, medianW: sized[Math.floor(sized.length / 2)], big: big.slice(0, 10), bigCount: big.length, chain, mainKids: kids(main).slice(0, 14), lazy: imgs.filter((i) => i.loading === 'lazy').length, docH: document.documentElement.scrollHeight };
})()
