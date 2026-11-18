const port = process.env.CDP_PORT ?? '9224';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
await new Promise(r => setTimeout(r, 1500));
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    bridge: typeof window.workbench,
    buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).slice(0, 8),
    graphNodes: document.querySelectorAll('[data-graph-node]').length,
    version: document.body.textContent.match(/v[0-9.]+-s[0-9.]+/)?.[0] ?? null
  })`,
  returnByValue: true,
});
console.log(r.result.result.value);
ws.close();
