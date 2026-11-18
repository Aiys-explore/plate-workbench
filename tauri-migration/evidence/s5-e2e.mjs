// S5 端到端验收：Agent 引擎发现 + 任务状态机（隔离 stub，不触真实账号）。
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
  const note = await window.workbench.notes.create('S5 任务笔记', 'default', 'blank');
  window.__s5 = { noteId: note.id, events: [] };
  window.workbench.tasks.onStateChanged(card => window.__s5.events.push(card));
  return { noteId: note.id };
`);
await step('discover', `
  const tauri = window.__TAURI_INTERNALS__;
  const found = await tauri.invoke('agents_discover');
  window.__s5.found = found;
  return found.map(a => a.type + ':' + (a.executable || '').split('\\\\').pop());
`);
await step('startOk', `
  const card = await window.workbench.tasks.start({
    noteId: window.__s5.noteId, taskId: 's5-ok-1', promptText: '测试任务：输出回执', agentSelector: 'teststub'
  });
  return { state: card.state, agentId: card.agentId, promptHead: card.promptText.slice(0, 12) };
`);
await wait(2500);
await step('okFinished', `
  const cards = await window.workbench.tasks.listByNote(window.__s5.noteId);
  const card = cards.find(c => c.taskId === 's5-ok-1');
  return { state: card?.state, pendingKind: card?.pendingKind,
    outputHasPrompt: (card?.outputDraft ?? '').includes('PROMPT:测试任务'),
    logHas: (card?.logTail ?? '').includes('S5 STUB RUN'),
    events: window.__s5.events.length };
`);
await step('startFail', `
  const card = await window.workbench.tasks.start({
    noteId: window.__s5.noteId, taskId: 's5-fail-1', promptText: '失败任务', agentSelector: 'failstub'
  });
  return { state: card.state };
`);
await wait(2500);
await step('failFinished', `
  const cards = await window.workbench.tasks.listByNote(window.__s5.noteId);
  const card = cards.find(c => c.taskId === 's5-fail-1');
  return { state: card?.state, errorMsg: card?.errorMsg };
`);
await step('startLongThenStop', `
  const card = await window.workbench.tasks.start({
    noteId: window.__s5.noteId, taskId: 's5-long-1', promptText: '长任务', agentSelector: 'longstub'
  });
  await new Promise(r => setTimeout(r, 1200));
  const stopped = await window.workbench.tasks.stop('s5-long-1');
  return { started: card.state, stopped: stopped.state, msg: stopped.errorMsg };
`);
await step('followUpMarkDoneReject', `
  const follow = await window.workbench.tasks.followUp('s5-ok-1', '追加核对第一段');
  const done = await window.workbench.tasks.markDone('s5-ok-1');
  const rejected = await window.workbench.tasks.reject('s5-fail-1');
  return { followPromptHasAdd: follow.promptText.includes('追加核对第一段'), done: done.state, rejected: rejected.state };
`);
await step('summary', `
  return await window.workbench.tasks.summaryByNotes();
`);
await step('missingAgent', `
  try {
    await window.workbench.tasks.start({ noteId: window.__s5.noteId, taskId: 's5-miss-1', promptText: 'x', agentSelector: 'nosuchagent' });
    return { rejected: false };
  } catch (e) {
    return { rejected: true, msg: String(e).slice(0, 60) };
  }
`);
const fs = await import('fs');
fs.writeFileSync(process.env.S5_EVIDENCE ?? 's5-e2e-result.json', JSON.stringify(results, null, 2));
const fails = Object.entries(results).filter(([, v]) => v && v.ok === false);
console.log('FAILS:', fails.map(([k, v]) => k + ':' + (v.error ?? 'ok-false')).join('; ') || 'none');
process.exit(fails.length ? 1 : 0);

