const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
if (!page) throw new Error('dev page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => new Promise((res, rej) => {
  const mid = ++id;
  const onMsg = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id === mid) { ws.removeEventListener('message', onMsg); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send('Runtime.enable', {});
const eval1 = await send('Runtime.evaluate', { expression: "document.getElementById('root') ? document.getElementById('root').children.length : -1", returnByValue: true });
const eval2 = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true });
console.log('root children:', eval1.result.value);
console.log('body text:', JSON.stringify(eval2.result.value));
ws.close();
process.exit(0);
