// S6 端到端验收：行内任务胶囊全链路（隔离 stub，不触真实账号）。
// 输入路径：任务行经 notes.update 桥接写入磁盘 → 重开抽屉由编辑器从磁盘加载真实 session。
// （CDP 真实键盘输入链路已在 S3 验收覆盖；S6 验收对象是任务胶囊本身。）
// 覆盖：TODO 交办胶囊 → DOING（图谱呼吸灯/徽标）→ 停止回退；
//       快速 stub → PENDING 审阅面板 → 采纳落盘（DONE + 输出引用块，session 不 dirty）；
//       PENDING 驳回回退；无假投递。
import { writeFileSync } from 'node:fs';
const port = process.env.CDP_PORT ?? '9223';
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find(t => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
if (!page) throw new Error('dev page not found');
// 连接层：Page.reload 会销毁旧 target 的 WebSocket，send 前按需重连。
let ws = null;
let id = 0;
let pending = new Map();
const connect = async () => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  // reload 后旧 target 可能残留在列表里，逐个探活选可用的。
  const candidates = targets.filter(t => t.type === 'page' && t.url.includes('127.0.0.1:5173'));
  for (const target of candidates) {
    try {
      const probe = new WebSocket(target.webSocketDebuggerUrl);
      const probePending = new Map();
      probe.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && probePending.has(m.id)) { probePending.get(m.id)(m); probePending.delete(m.id); }
      };
      await new Promise((res, rej) => { probe.onopen = res; probe.onerror = rej; });
      const ok = await new Promise((res) => {
        const mid = -1;
        probePending.set(mid, (m) => res(!!m.result));
        probe.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: '1', returnByValue: true } }));
        setTimeout(() => res(false), 2000);
      });
      if (ok) { ws = probe; pending = probePending; return }
      probe.close();
    } catch { /* 尝试下一个 target */ }
  }
  throw new Error('no live dev page target');
};
await connect();
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
const clickPill = async (kind) => evalJs(`
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const pill = drawer.querySelector("[data-task-pill='${kind}']");
  if (!pill) return { clicked: false };
  pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { clicked: true, text: pill.textContent };
`);
const openDrawer = async () => {
  for (let i = 0; i < 5; i++) {
    const st = await evalJs(`
      return { open: document.querySelector('[aria-label="笔记编辑抽屉"]')?.dataset.open === 'true' };
    `);
    if (st.value?.open) return true;
    await evalJs(`
      const node = document.querySelector('[data-graph-node]');
      if (node) node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    `);
    await wait(800);
  }
  return false;
};
const closeDrawer = async () => {
  await evalJs(`
    const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
    const btn = [...drawer.querySelectorAll('button')].find(b => b.textContent.trim() === '×');
    if (btn) btn.click();
  `);
  await wait(600);
  const st = await evalJs(`return document.querySelector('[aria-label="笔记编辑抽屉"]')?.dataset.open === 'true'`);
  return st.value !== true;
};
const pollFor = async (body, interval = 500, tries = 16) => {
  for (let i = 0; i < tries; i++) {
    await wait(interval);
    const r = await evalJs(body);
    if (r.value === true) return true;
  }
  return false;
};

await send('Page.enable', {});
await step('seed', `
  await new Promise(r => setTimeout(r, 500));
  const st = await window.workbench.startup.state();
  if (st.phase === 'choose') {
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('使用默认建议'))?.click();
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = await window.workbench.startup.state();
      if (s.phase !== 'choose') break;
    }
  }
  let note = (await window.workbench.notes.links()).nodes.find(n => n.title === 'S6 任务笔记');
  if (!note) note = await window.workbench.notes.create('S6 任务笔记', 'default', 'blank');
  window.__s6 = { noteId: note.id, events: [] };
  window.workbench.tasks.onStateChanged(card => window.__s6.events.push(card.state + ':' + card.taskId));
  const list = await window.workbench.notes.draftList();
  let discarded = 0;
  for (const d of list) { if (d.id === note.id) { await window.workbench.notes.draftDiscard(note.id, d.version); discarded++ } }
  return { noteId: note.id, discarded };
`);

// 关抽屉 → 桥接写入三条任务行 → 重开抽屉，让编辑器从磁盘加载干净 session。
await step('writeTaskLines', `
  const noteId = window.__s6.noteId;
  const cur = await window.workbench.notes.read(noteId);
  const lines = [
    '# S6 任务笔记',
    '',
    '- [ ] TODO(@longstub): 慢任务',
    '',
    '- [ ] TODO: 快任务',
    '',
    '- [ ] TODO: 驳回任务',
  ];
  const result = await window.workbench.notes.update(noteId, lines.join('\\n'), cur.revision);
  return { status: result.status, revision: result.note?.revision ?? null };
`);

// 写盘后整页刷新：应用启动时从磁盘重建 session，抽屉拿到的就是最新任务行。
// 刷新会销毁旧 target 的 WebSocket，重连后再继续。
await send('Page.reload', {});
try { ws.close() } catch { /* 旧连接可能已断 */ }
await wait(500);
await connect();
await send('Page.enable', {});
await wait(2000);
await step('afterReload', `
  await new Promise(r => setTimeout(r, 500));
  window.__s6 = window.__s6 ?? { noteId: (await window.workbench.notes.links()).nodes.find(n => n.title === 'S6 任务笔记')?.id, events: [] };
  window.workbench.tasks.onStateChanged(card => window.__s6.events.push(card.state + ':' + card.taskId));
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  return { noteId: window.__s6.noteId, drawerOpenInitially: drawer?.dataset.open };
`);
results.drawerReopened = await openDrawer();
await wait(500);
await step('todoPills', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const pills = [...drawer.querySelectorAll("[data-task-pill='todo']")];
  return {
    count: pills.length,
    texts: pills.map(p => p.textContent),
    dirty: drawer.textContent.includes('未保存修改')
  };
`);

// 1) 慢任务：交办 → DOING → 图谱呼吸灯/徽标 → 停止回退。
await evalJs(`
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const pill = [...drawer.querySelectorAll("[data-task-pill='todo']")].find(p => p.textContent.includes('longstub'));
  if (pill) pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
`);
await wait(800);
await step('doingState', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const raw = (await window.workbench.notes.read(window.__s6.noteId)).content;
  return {
    doingPill: !!drawer.querySelector("[data-task-pill='doing']"),
    stopPill: !!drawer.querySelector("[data-task-pill='stop']"),
    lineDoing: /DOING #t-[0-9a-z]{4,12}/.test(raw),
    pulse: document.querySelector('[data-graph-node] rect[data-pulse]')?.dataset.pulse ?? null,
    badge: document.querySelector('.relationship-card-status')?.textContent ?? null
  };
`);
await clickPill('stop');
results.stopDiskReverted = await pollFor(`
  const raw = (await window.workbench.notes.read(window.__s6.noteId)).content;
  return !raw.includes('DOING #');
`, 600, 10);
await step('stopRevert', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const raw = (await window.workbench.notes.read(window.__s6.noteId)).content;
  return {
    todoPillBack: !!drawer.querySelector("[data-task-pill='todo']"),
    doingGone: !drawer.querySelector("[data-task-pill='doing']"),
    // 回退把整个任务标记替换为 TODO，括号 agent 标签一并去掉（已记录为简化项）。
    lineReverted: raw.includes('TODO: 慢任务') && !/DOING #t-/.test(raw)
  };
`);

// 2) 快任务：交办（dsh=stub-ok 秒完成）→ PENDING → 采纳落盘。
await evalJs(`
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const pill = [...drawer.querySelectorAll("[data-task-pill='todo']")].find(p => p.closest('[data-editor-role]')?.textContent.includes('快任务'));
  if (pill) pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
`);
results.pendingSeen = await pollFor(`
  return !!document.querySelector("[data-task-pill='pending']");
`);
await step('pendingState', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  return {
    pendingPill: !!drawer.querySelector("[data-task-pill='pending']"),
    panel: !!drawer.querySelector("[data-task-panel='PENDING']"),
    logPreview: drawer.querySelector('[data-task-log]')?.textContent.slice(0, 30) ?? null,
    adoptBtn: !!drawer.querySelector("[data-task-pill='adopt']"),
    rejectBtn: !!drawer.querySelector("[data-task-pill='reject']"),
    pulse: document.querySelector('[data-graph-node] rect[data-pulse]')?.dataset.pulse ?? null,
    badge: document.querySelector('.relationship-card-status')?.textContent ?? null
  };
`);
await step('adoptToDisk', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const adopt = drawer.querySelector("[data-task-pill='adopt']");
  if (!adopt) return { clicked: false };
  adopt.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  const raw = (await window.workbench.notes.read(window.__s6.noteId)).content;
  return {
    clicked: true,
    lineDone: /DONE #t-[0-9a-z-]+:[ \t]*快任务/.test(raw),
    quoteSaved: raw.includes('> S5 STUB RUN') && raw.includes('> PROMPT:--profile'),
    pendingGone: !drawer.querySelector("[data-task-pill='pending']"),
    donePill: !!drawer.querySelector("[data-task-pill='done']"),
    panelGone: !drawer.querySelector("[data-task-panel='PENDING']"),
    cleanSession: !drawer.textContent.includes('未保存修改') && !drawer.textContent.includes('磁盘版本已变化')
  };
`);

// 3) 驳回任务：交办 → PENDING → 驳回回退（无 DONE、无输出引用）。
await evalJs(`
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const pill = [...drawer.querySelectorAll("[data-task-pill='todo']")].find(p => p.closest('[data-editor-role]')?.textContent.includes('驳回任务'));
  if (pill) pill.dispatchEvent(new MouseEvent('click', { bubbles: true }));
`);
results.rejectPollSawPending = await pollFor(`
  return !!document.querySelector("[data-task-pill='pending']");
`);
await step('rejectRevert', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const reject = drawer.querySelector("[data-task-pill='reject']");
  if (!reject) return { clicked: false };
  reject.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise(r => setTimeout(r, 1200));
  const raw = (await window.workbench.notes.read(window.__s6.noteId)).content;
  return {
    clicked: true,
    lineReverted: raw.includes('TODO: 驳回任务'),
    todoPillBack: !!drawer.querySelector("[data-task-pill='todo']"),
    noQuoteForRejected: !raw.includes('> PROMPT:驳回任务')
  };
`);
await step('finalState', `
  const drawer = document.querySelector('[aria-label="笔记编辑抽屉"]');
  const raw = (await window.workbench.notes.read(window.__s6.noteId)).content;
  const events = window.__s6.events;
  return {
    doingPillGone: !drawer.querySelector("[data-task-pill='doing']"),
    pendingPillGone: !drawer.querySelector("[data-task-pill='pending']"),
    doneCount: raw.split('DONE #t-').length - 1,
    rawHasQuote: raw.includes('> S5 STUB RUN'),
    eventFlow: events
  };
`);

writeFileSync(new URL('./s6-e2e-result.json', import.meta.url), JSON.stringify(results, null, 2));
console.log('DONE — results written to s6-e2e-result.json');
ws.close();
