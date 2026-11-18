// 真实 Agent 实机验收：打包版（target/release），真实工作区，无 stub 注入。
// codex / claude 走真实 CLI（只读提示词，不写文件）；dsh 记录边界。
import { writeFileSync } from 'node:fs';
const port = process.env.CDP_PORT ?? '9225';
const connect = async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find(t => t.type === 'page');
  if (!target) throw new Error('page not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nid = 0;
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return { ws, pending, next: () => ++nid };
};
let conn = await connect();
const send = (method, params) => new Promise(res => { const mid = conn.next(); conn.pending.set(mid, res); conn.ws.send(JSON.stringify({ id: mid, method, params })); });
const reconnect = async () => { try { conn.ws.close() } catch {} await new Promise(r => setTimeout(r, 800)); conn = await connect(); };
const evalJs = async body => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { try { const __f = async () => { ${body} }; return { ok: true, value: await __f() } } catch (e) { return { ok: false, error: String(e && e.message || e) } } })()`, awaitPromise: true, returnByValue: true });
  return r.result.result.value;
};
const results = {};
const wait = ms => new Promise(r => setTimeout(r, ms));
const pollUntil = async (body, interval = 3000, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    await wait(interval);
    const r = await evalJs(body);
    if (r?.ok && r.value === true) return true;
  }
  return false;
};

// 1) 启动状态：choose 则直接 invoke startup_submit（UI 点击曾遇 IPC 抖动）。
await step('startup', `
  const st = await window.workbench.startup.state();
  if (st.phase === 'choose') {
    const out = await window.__TAURI_INTERNALS__.invoke('startup_submit', { token: st.suggested });
    return { submitted: true, phase: out.phase, path: out.path };
  }
  return { phase: st.phase, path: st.path ?? null };
`);

// 2) Agent 发现（真实 PATH）。
await step('discover', `
  const found = await window.__TAURI_INTERNALS__.invoke('agents_discover');
  return found.map(a => a.type + ' -> ' + a.executable);
`);

// 3) 建验收笔记，两条任务：codex 真实执行 / claude 真实执行。
const stamp = Date.now().toString(36);
await step('seed', `
  let note = (await window.workbench.notes.links()).nodes.find(n => n.title === '实机验收任务');
  if (!note) note = await window.workbench.notes.create('实机验收任务', 'default', 'blank');
  window.__real = { noteId: note.id, events: [] };
  window.workbench.tasks.onStateChanged(card => window.__real.events.push(card.state + ':' + card.taskId + ':' + card.agentId));
  const cur = await window.workbench.notes.read(note.id);
  const lines = [
    '# 实机验收任务',
    '',
    '- [ ] TODO(@codex): 实机验收 ${stamp}。请只回复一行文本：Plate real-agent OK ${stamp}。不要读写任何文件，不要执行任何命令。',
    '',
    '- [ ] TODO(@claude): 实机验收 ${stamp}。请只回复一行文本：Plate real-agent OK ${stamp}。不要读写任何文件。',
  ];
  const result = await window.workbench.notes.update(note.id, lines.join('\\n'), cur.revision);
  return { noteId: note.id, status: result.status };
`);

// 刷新重建 session（与 S6 相同路径）。
await send('Page.reload', {});
await reconnect();
await send('Page.enable', {});
await wait(2500);
await step('afterReload', `
  await new Promise(r => setTimeout(r, 500));
  window.__real = window.__real ?? { noteId: (await window.workbench.notes.links()).nodes.find(n => n.title === '实机验收任务')?.id, events: [] };
  window.workbench.tasks.onStateChanged(card => window.__real.events.push(card.state + ':' + card.taskId + ':' + card.agentId));
  return { noteId: window.__real.noteId };
`);

// 4) 打开抽屉（点图谱节点）。
await step('openDrawer', `
  for (let i = 0; i < 5; i++) {
    if (document.querySelector('[aria-label="笔记编辑抽屉"]')?.dataset.open === 'true') return { open: true };
    document.querySelector('[data-graph-node]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await new Promise(r => setTimeout(r, 800));
  }
  return { open: document.querySelector('[aria-label="笔记编辑抽屉"]')?.dataset.open === 'true' };
`);

// 5) codex 交办：真实执行，轮询最多 4 分钟。
await step('dispatchCodex', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const pill = [...drawer.querySelectorAll("[data-task-pill='todo']")].find(p => p.closest('[data-editor-role]')?.textContent.includes('codex'));
  if (!pill) return { clicked: false };
  pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { clicked: true };
`);
results.codexDoing = await pollUntil(`
  return !!document.querySelector("[data-task-pill='doing']");
`, 1000, 10);
results.codexPending = await pollUntil(`
  return !!document.querySelector("[data-task-pill='pending']");
`, 4000, 60);
await step('codexResult', `
  const cards = await window.workbench.tasks.listByNote(window.__real.noteId);
  const codex = cards.find(c => c.agentId === 'codex');
  return {
    state: codex?.state,
    logHead: (codex?.logTail ?? '').slice(0, 120),
    outputHead: (codex?.outputDraft ?? '').slice(0, 200),
    hasStamp: (codex?.outputDraft ?? '').includes('${stamp}'),
    events: window.__real.events
  };
`);

// 6) codex 采纳落盘。
await step('adoptCodex', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const adopt = drawer.querySelector("[data-task-pill='adopt']");
  if (!adopt) return { clicked: false };
  adopt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1500));
  const raw = (await window.workbench.notes.read(window.__real.noteId)).content;
  return { done: /DONE #t-[0-9a-z-]+/.test(raw), quote: raw.split('\\n').filter(l => l.startsWith('>')).length };
`);

// 7) claude 交办（未登录则 ERROR，也是有效证据）。
await step('dispatchClaude', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const pill = [...drawer.querySelectorAll("[data-task-pill='todo']")].find(p => p.closest('[data-editor-role]')?.textContent.includes('claude'));
  if (!pill) return { clicked: false };
  pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { clicked: true };
`);
results.claudeSettled = await pollUntil(`
  const cards = await window.workbench.tasks.listByNote(window.__real.noteId);
  const claude = cards.find(c => c.agentId === 'claude');
  return !!claude && (claude.state === 'PENDING' || claude.state === 'ERROR');
`, 4000, 60);
await step('claudeResult', `
  const cards = await window.workbench.tasks.listByNote(window.__real.noteId);
  const claude = cards.find(c => c.agentId === 'claude');
  return { state: claude?.state, error: claude?.errorMsg ?? null, outputHead: (claude?.outputDraft ?? '').slice(0, 200) };
`);

await step('final', `
  const cards = await window.workbench.tasks.listByNote(window.__real.noteId);
  const raw = (await window.workbench.notes.read(window.__real.noteId)).content;
  return { cards: cards.map(c => c.agentId + ':' + c.state), rawDone: /DONE #t-/.test(raw), events: window.__real.events };
`);

async function step(name, body) { results[name] = await evalJs(body); console.log(name, JSON.stringify(results[name])); }
writeFileSync(new URL('./real-agent-result.json', import.meta.url), JSON.stringify(results, null, 2));
console.log('DONE');
conn.ws.close();
