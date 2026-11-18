// S3 端到端验收：图谱即桌面 + 右侧编辑抽屉。
const port = process.env.CDP_PORT ?? '9222';
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
  if (!r.result || !r.result.result) throw new Error('bad cdp response');
  return r.result.result.value ?? { ok: false, error: 'undefined result' };
};
const results = {};
const step = async (name, body) => { results[name] = await evalJs(body); console.log(name, JSON.stringify(results[name])); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
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
  const existing = await window.workbench.notes.links();
  let a = existing.nodes.find(n => n.title === 'S3 主笔记');
  let b = existing.nodes.find(n => n.title === 'S3 下游笔记');
  if (!a) a = await window.workbench.notes.create('S3 主笔记', 'default', 'blank');
  if (!b) b = await window.workbench.notes.create('S3 下游笔记', 'default', 'blank');
  await window.workbench.notes.update(a.id, '# S3 主笔记\\n\\n这是主笔记正文。', (await window.workbench.notes.read(a.id)).revision);
  await window.workbench.graphLayout.connectNodes(a.id, b.id);
  return { a: a.id, b: b.id };
`);
await wait(600);

await step('stageNoSwitch', `
  return {
    viewSwitch: !!document.querySelector('.view-switch'),
    terminalPage: !!document.querySelector('.collab-workspace'),
    graph: !!document.querySelector('[aria-label="笔记关系图"]'),
    drawerClosed: document.querySelector('[aria-label="笔记编辑抽屉"]')?.dataset.open === 'false'
  };
`);
await step('clickNode', `
  const node = document.querySelector('[data-graph-node]');
  if (!node) return { clicked: false };
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  return { clicked: true, id: node.dataset.graphNode };
`);
await wait(900);
await step('drawerOpened', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  return {
    open: drawer?.dataset.open === 'true',
    editor: !!drawer?.querySelector('[data-editor-host]'),
    title: drawer?.querySelector('[data-editor-meta-title]')?.value ?? null,
    framed: document.querySelector('[aria-label="关系图画布"]')?.dataset.framed ?? null
  };
`);
// 真实输入链路：鼠标点击正文首段放置光标，CDP Input.insertText + IME 组合态
const bodyPointRaw = await evalJs(`
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const para = [...drawer.querySelectorAll('[data-editor-host] p, [data-editor-host] h1')].pop();
  if (!para) return null;
  const r = para.getBoundingClientRect();
  return { x: Math.round(r.left + 24), y: Math.round(r.top + r.height / 2) };
`);
const bodyPoint = bodyPointRaw?.value ?? bodyPointRaw;
if (!bodyPoint) throw new Error('no body paragraph');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: bodyPoint.x, y: bodyPoint.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: bodyPoint.x, y: bodyPoint.y, button: 'left', clickCount: 1 });
await wait(200);
const insert = await send('Input.insertText', { text: '中文输入S3验收' });
results.cdpInsert = { ok: true };
await wait(300);
// IME 组合态：setComposition → commit
await send('Input.imeSetComposition', { text: '组合态测', selectionStart: 4, selectionEnd: 4 });
await wait(200);
await send('Input.imeSetComposition', { text: '组合态测试完成', selectionStart: 8, selectionEnd: 8 });
await wait(200);
await send('Input.insertText', { text: '组合态测试完成' });
await wait(500);
await step('dirtyState', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  return {
    status: drawer?.querySelector('[data-editor-status-item]')?.textContent,
    draftState: drawer?.querySelector('[data-draft-state]')?.textContent ?? null,
    hostHasText: drawer?.querySelector('[data-editor-host]')?.textContent?.includes('中文输入S3验收') ?? false
  };
`);
await step('save', `
  const buttons = [...document.querySelectorAll('[aria-label="笔记编辑抽屉"] button')];
  const save = buttons.find(b => b.textContent.trim() === '保存');
  if (!save) return { clicked: false };
  save.click();
  return { clicked: true, disabled: save.disabled };
`);
await wait(1000);
await step('savedToDisk', `
  const idx = await window.workbench.notes.links();
  const b = idx.nodes.find(n => n.title === 'S3 下游笔记');
  const note = await window.workbench.notes.read(b.id);
  return { hasChinese: note.content.includes('中文输入S3验收'), hasComposition: note.content.includes('组合态测试完成') };
`);
await step('escCloses', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return { closed: drawer.dataset.open };
`);
await wait(700);
await step('reopened', `
  const node = document.querySelector('[data-graph-node]');
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  return { clicked: true };
`);
await wait(900);
await step('contentAfterResume', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const host = drawer?.querySelector('[data-editor-host]');
  return { open: drawer?.dataset.open === 'true', text: host?.textContent?.includes('中文输入S3验收') ?? false };
`);
const fs = await import('fs');
const shot = async (name, theme) => {
  await evalJs(`
    document.documentElement.classList.remove('theme-light', 'theme-dark');
    document.documentElement.classList.add('theme-${theme}');
    localStorage.setItem('workbench.theme', '${theme}');
    return true;
  `);
  await wait(350);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (!r.result?.data) return 'shot failed: ' + JSON.stringify(r.result ?? r).slice(0, 200);
  fs.writeFileSync(process.env.S3_SHOT_DIR + '/s3-' + name + '.png', Buffer.from(r.result.data, 'base64'));
  return name + '.png saved';
};
results.shotLight = await shot('light', 'light');
results.shotDark = await shot('dark', 'dark');
console.log(results.shotLight, results.shotDark);

const fails = Object.entries(results).filter(([, v]) => v && v.ok === false);
console.log('FAILS:', fails.map(([k]) => k).join(', ') || 'none');
fs.writeFileSync(process.env.S3_SHOT_DIR + '/s3-e2e-result.json', JSON.stringify(results, null, 2));
process.exit(fails.length ? 1 : 0);
