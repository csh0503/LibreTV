// Trace scrolling down and summarise main-thread work by event name.
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const waiting = new Map();
const events = [];
let done;
const finished = new Promise((r) => { done = r; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Tracing.dataCollected') events.push(...m.params.value);
  if (m.method === 'Tracing.tracingComplete') done();
  if (waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); }
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const run = (expression) => send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
await run('window.scrollTo(0,0);new Promise(r=>setTimeout(r,1500))');
await send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
await run('(async()=>{for(let i=0;i<8;i++){window.scrollBy(0,300);await new Promise(r=>setTimeout(r,400))}})()');
await send('Tracing.end');
await finished;
const sum = {};
const top = [];
events.filter((e) => e.ph === 'X' && e.dur).forEach((e) => {
  sum[e.name] = sum[e.name] || { ms: 0, n: 0 };
  sum[e.name].ms += e.dur / 1000; sum[e.name].n++;
  if (['Layout', 'UpdateLayoutTree', 'FunctionCall', 'Paint', 'UpdateLayerTree', 'CompositeLayers', 'TimerFire', 'FireIntersectionObserver', 'IntersectionObserverController::computeIntersections', 'EventDispatch', 'RasterTask', 'ImageDecodeTask', 'PrePaint', 'Layerize'].includes(e.name)) top.push([Math.round(e.dur / 1000), e.name, JSON.stringify(e.args && (e.args.beginData || e.args.data) || {}).slice(0, 110)]);
});
console.log(Object.entries(sum).sort((a, b) => b[1].ms - a[1].ms).slice(0, 18).map(([k, v]) => Math.round(v.ms) + 'ms x' + v.n + ' ' + k).join('\n'));
console.log('--- longest');
console.log(top.sort((a, b) => b[0] - a[0]).slice(0, 12).map((t) => t.join(' ')).join('\n'));
ws.close();
