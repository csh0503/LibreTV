// usage: node cdp.mjs <file with an expression>; prints the JSON-serialised result
import { readFileSync } from 'node:fs';
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
const expression = readFileSync(process.argv[2], 'utf8');
ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
const msg = await new Promise((r) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m); }; });
console.log(JSON.stringify(msg.result.result?.value ?? msg.result, null, 1));
ws.close();
