// Profile the page while it scrolls and print the heaviest functions by self time.
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 2000 });
await run('window.scrollTo(0,0);new Promise(r=>setTimeout(r,1500))');
await send('Profiler.start');
await run('(async()=>{for(let i=0;i<10;i++){window.scrollBy(0,300);await new Promise(r=>setTimeout(r,400))}})()');
const { profile } = await send('Profiler.stop');
const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas;
profile.samples.forEach((sid, i) => {
  const n = byId.get(sid);
  const f = n.callFrame;
  const key = (f.functionName || '(anon)') + ' ' + f.url.split('/').pop().slice(0, 28) + ':' + f.lineNumber + ':' + f.columnNumber;
  self.set(key, (self.get(key) || 0) + dt[i] / 1000);
});
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log('total ms', Math.round(total));
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).forEach(([k, v]) => console.log(Math.round(v) + 'ms', k));
ws.close();
