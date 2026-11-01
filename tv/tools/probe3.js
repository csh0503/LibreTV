(async () => {
  const out = { path: location.pathname, active: document.activeElement && document.activeElement.tagName };
  out.dialogs = Array.prototype.map.call(document.querySelectorAll('[role="dialog"],.fixed'), (el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return [(el.className + '').slice(0, 80), s.display, s.opacity, s.zIndex, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), (el.textContent || '').slice(0, 40)].join(' | ');
  });
  out.profileBtn = Array.prototype.filter.call(document.querySelectorAll('button'), (b) => /设定档/.test(b.textContent)).map((b) => { const r = b.getBoundingClientRect(); return [b.textContent.slice(0, 20), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(' '); });
  out.storage = { keys: Object.keys(localStorage).slice(0, 20) };
  try { out.idb = (await indexedDB.databases()).map((d) => d.name); } catch (e) { out.idb = String(e); }
  out.status = await fetch('/api/status').then((r) => r.json()).then((s) => ({ v: s.verified })).catch(String);
  out.sync = await fetch('/api/profile-sync').then((r) => r.status).catch(String);
  return out;
})()
