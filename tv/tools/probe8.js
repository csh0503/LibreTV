(() => {
  const by = {};
  performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'img').forEach((e) => {
    let h = ''; try { h = new URL(e.name).host; } catch (x) {}
    by[h] = by[h] || { n: 0, sample: e.name.slice(0, 110) };
    by[h].n++;
  });
  const sizes = {};
  Array.prototype.forEach.call(document.images, (i) => { if (!i.naturalWidth) return; let h = ''; try { h = new URL(i.currentSrc).host; } catch (x) {} sizes[h] = sizes[h] || []; sizes[h].push(i.naturalWidth); });
  Object.keys(sizes).forEach((k) => { const a = sizes[k].sort((x, y) => x - y); sizes[k] = 'median ' + a[Math.floor(a.length / 2)] + ' max ' + a[a.length - 1] + ' n' + a.length; });
  return { by, sizes };
})()
