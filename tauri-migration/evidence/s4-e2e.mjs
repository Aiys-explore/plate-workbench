// S4 端到端验收：融合导图 CRUD 与节点坐标持久化。
const port = process.env.CDP_PORT ?? '9223';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
if (!page) throw new Error('dev page not found');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evalJs = async (body) => {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { try { const __f = async () => { ${body} }; return { ok: true, value: await __f() } } catch (e) { return { ok: false, error: String(e && e.message || e) } } })()`,
    awaitPromise: true, returnByValue: true,
  });
  return r.result.result.value;
};
const results = {};
const step = async (name, body) => { results[name] = await evalJs(body); console.log(name, JSON.stringify(results[name])); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const mouse = (type, x, y, opts = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...opts });
const results2 = { ok: true };
await send('Page.enable', {});

await step('seed', `
  await new Promise(r => setTimeout(r, 800));
  const click = (label) => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes(label));
    if (b) { b.click(); return true }
    return false;
  };
  const st = await window.workbench.startup.state();
  if (st.phase === 'choose') { click('使用默认建议'); await new Promise(r => setTimeout(r, 600)); }
  click('打开笔记');
  await new Promise(r => setTimeout(r, 800));
  const a = await window.workbench.notes.create('S4 父笔记', 'default', 'blank');
  const b = await window.workbench.notes.create('S4 目标笔记', 'default', 'blank');
  await window.workbench.graphLayout.saveBatch([
    { noteId: a.id, x: 400, y: 240, pinned: true },
    { noteId: b.id, x: 400, y: 430, pinned: true }
  ]);
  return { a: a.id, b: b.id };
`);
await wait(1000);

await step('dblclickCreate', `
  const svg = document.querySelector('[aria-label="笔记节点"]');
  const r = svg.getBoundingClientRect();
  window.__s4 = { blankX: Math.round(r.left + 120), blankY: Math.round(r.top + 160) };
  return { x: window.__s4.blankX, y: window.__s4.blankY };
`);
await mouse('mousePressed', results.dblclickCreate.value.x, results.dblclickCreate.value.y, { clickCount: 1 });
await mouse('mouseReleased', results.dblclickCreate.value.x, results.dblclickCreate.value.y, { clickCount: 1 });
await mouse('mousePressed', results.dblclickCreate.value.x, results.dblclickCreate.value.y, { clickCount: 2 });
await mouse('mouseReleased', results.dblclickCreate.value.x, results.dblclickCreate.value.y, { clickCount: 2 });
await wait(1200);
await step('createdAt', `
  const all = await window.workbench.graphLayout.getAll();
  const idx = await window.workbench.notes.links();
  const created = idx.nodes.find(n => n.title.startsWith('新笔记'));
  window.__s4.createdId = created?.id;
  return { count: idx.nodes.length, created: created?.title ?? null, layout: created ? all[created.id] : null };
`);
await wait(500);

await step('tabDerive', `
  const parentId = window.__s4 ? null : null;
  return true;
`);
// Tab 派生：聚焦父笔记节点后按 Tab
const parentFocus = await evalJs(`
  const node = document.querySelector('[data-graph-node][aria-label*="S4 父笔记"]');
  if (!node) return { ok: false };
  node.focus();
  return { ok: true, id: node.dataset.graphNode };
`);
results.tabDerive = parentFocus;
console.log('focusParent', JSON.stringify(parentFocus));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
await wait(1400);
await step('deriveResult', `
  const idx = await window.workbench.notes.links();
  const child = idx.nodes.find(n => n.title.includes('· 子项'));
  window.__s4.childId = child?.id;
  const edge = idx.edges.find(e => e.source === 'PARENT' || true);
  const parentEdge = idx.edges.find(e => (child && (e.source === child.id || e.target === child.id)));
  const parent = await window.workbench.notes.read('${''}');
  return {
    child: child?.title ?? null,
    edge: parentEdge ? parentEdge.source.slice(0, 8) + '->' + parentEdge.target.slice(0, 8) : null,
    parentContentHasChild: null
  };
`);
await step('deriveLinkCheck', `
  const idx = await window.workbench.notes.links();
  const child = idx.nodes.find(n => n.title.includes('· 子项'));
  const note = await window.workbench.notes.read(child.id);
  const parent = idx.nodes.find(n => n.title === 'S4 父笔记');
  return { childRefsParent: note.content.includes('[[' + parent.title + ']]') };
`);

// 端口拖拽连线：从子笔记右侧端口拖到 S4 目标笔记
const portDrag = await evalJs(`
  const child = [...document.querySelectorAll('[data-graph-node]')].find(n => n.getAttribute('aria-label').includes('· 子项'));
  const target = [...document.querySelectorAll('[data-graph-node]')].find(n => n.getAttribute('aria-label').includes('S4 目标笔记'));
  if (!child || !target) return { ok: false };
  const port = child.querySelector('.relationship-port-group[data-side="right"] .relationship-port-hit');
  const tr = port.getBoundingClientRect();
  const ttr = target.getBoundingClientRect();
  return { ok: true, sx: Math.round(tr.left + tr.width / 2), sy: Math.round(tr.top + tr.height / 2),
    tx: Math.round(ttr.left + ttr.width / 2), ty: Math.round(ttr.top + ttr.height / 2) };
`);
results.portStart = portDrag;
console.log('portStart', JSON.stringify(portDrag));
if (portDrag.value?.ok) {
  const { sx, sy, tx, ty } = portDrag.value;
  await mouse('mousePressed', sx, sy);
  await wait(120);
  await mouse('mouseMoved', Math.round((sx + tx) / 2), Math.round((sy + ty) / 2));
  await wait(120);
  await mouse('mouseMoved', tx, ty);
  await wait(200);
  await mouse('mouseReleased', tx, ty);
  await wait(1200);
}
await step('portLink', `
  const idx = await window.workbench.notes.links();
  const target = idx.nodes.find(n => n.title === 'S4 目标笔记');
  const child = idx.nodes.find(n => n.title.includes('· 子项'));
  const note = await window.workbench.notes.read(target.id);
  return { targetRefsChild: note.content.includes('[[' + child.title + ']]'), edges: idx.edges.length };
`);

// 拖拽节点移动 → 坐标持久化
const dragFrom = await evalJs(`
  const node = [...document.querySelectorAll('[data-graph-node]')].find(n => n.getAttribute('aria-label').includes('S4 目标笔记'));
  const r = node.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), id: node.dataset.graphNode };
`);
results.dragFrom = dragFrom;
console.log('dragFrom', JSON.stringify(dragFrom));
if (dragFrom.value) {
  const { x, y } = dragFrom.value;
  await mouse('mousePressed', x, y);
  await wait(150);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x + i * 25, y - i * 15);
  await wait(150);
  await mouse('mouseReleased', x + 150, y - 90);
  await wait(900);
}
await step('coordsPersisted', `
  const all = await window.workbench.graphLayout.getAll();
  const id = '${''}';
  return { all: Object.fromEntries(Object.entries(all).map(([k, v]) => [k.slice(0, 8), { x: v.x, y: v.y }])) };
`);

// 右键菜单删除子项节点
const ctx = await evalJs(`
  const node = [...document.querySelectorAll('[data-graph-node]')].find(n => n.getAttribute('aria-label').includes('· 子项'));
  const r = node.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
`);
results.ctx = ctx;
console.log('ctx', JSON.stringify(ctx));
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: ctx.value.x, y: ctx.value.y, button: 'right', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: ctx.value.x, y: ctx.value.y, button: 'right', clickCount: 1 });
await wait(500);
await step('menuClick', `
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.includes('删除笔记'));
  if (!item) return { found: false };
  item.click();
  return { found: true };
`);
await wait(500);
await step('confirmDelete', `
  const btn = [...document.querySelectorAll('dialog[open] button')].find(b => b.textContent.includes('确认删除'));
  if (!btn) return { found: false };
  btn.click();
  return { found: true };
`);
await wait(1500);
await step('deletedGone', `
  const idx = await window.workbench.notes.links();
  return { childGone: !idx.nodes.some(n => n.title.includes('· 子项')), count: idx.nodes.length };
`);

// 重启后坐标保持
results.restartNote = 'restart handled outside';
console.log('RESTART_NOW');
