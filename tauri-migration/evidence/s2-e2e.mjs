// S2 端到端验收：在 Tauri WebView 内驱动 window.workbench（桥接层 → Rust → SQLite → 磁盘）。
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
const step = async (name, body) => { results[name] = await evalJs(body); };

await evalJs(`window.__s2 = {}`);

await step('startupState', `return window.workbench.startup.state()`);
await step('startupSubmit', `
  const s = await window.workbench.startup.state();
  const token = s.suggested ?? s.candidate?.path;
  window.__s2.root = token;
  return await window.workbench.startup.submit(token);
`);
await step('createNoteA', `
  const a = await window.workbench.notes.create('S2 验收笔记', 'default', 'plan');
  window.__s2.a = a;
  return { id: a.id, title: a.title, project: a.projectId, contentHead: a.content.slice(0, 40), revision: a.revision.slice(0, 12) };
`);
await step('createNoteB', `
  const b = await window.workbench.notes.create('S2 下游笔记', 'default', 'blank');
  window.__s2.b = b;
  return { id: b.id, title: b.title };
`);
await step('connectNodes', `
  const linked = await window.workbench.graphLayout.connectNodes(window.__s2.a.id, window.__s2.b.id);
  return { hasLinkLine: linked.content.includes('- [[S2 下游笔记]]') };
`);
await step('links', `
  const idx = await window.workbench.notes.links();
  return { nodes: idx.nodes.length, edges: idx.edges.map(e => e.source.slice(0, 8) + '->' + e.target.slice(0, 8)),
    bindings: idx.bindings.map(x => x.ref + ':' + (x.target ? 'resolved' : 'null')) };
`);
await step('updateSave', `
  const fresh = await window.workbench.notes.read(window.__s2.a.id);
  const r = await window.workbench.notes.update(fresh.id, fresh.content + '\\n\\n新增段落', fresh.revision);
  return { status: r.status, title: r.status === 'saved' ? r.note.title : null };
`);
await step('draftWrite', `
  const fresh = await window.workbench.notes.read(window.__s2.a.id);
  const ok = await window.workbench.notes.draftWrite(fresh.id, '草稿内容（S2 验收）', fresh.revision);
  return { ok };
`);
await step('draftList', `
  const l = await window.workbench.notes.draftList();
  window.__s2.draft = l[0];
  return { count: l.length, source: l[0]?.source, version: l[0]?.version?.slice(0, 8) };
`);
await step('draftRestore', `
  const r = await window.workbench.notes.draftRestore(window.__s2.a.id);
  return { status: r.status, contentHead: r.status === 'restored' || r.status === 'preview' ? r.content.slice(0, 20) : null };
`);
await step('draftDiscard', `
  const r = await window.workbench.notes.draftDiscard(window.__s2.a.id, window.__s2.draft?.version);
  return { discarded: r };
`);
await step('draftListAfterDiscard', `
  const l = await window.workbench.notes.draftList();
  return { count: l.length };
`);
await step('search', `
  const s = await window.workbench.notes.search({ query: '验收' });
  return { count: s.length, first: s[0] ? { title: s[0].note.title, field: s[0].match?.field, match: s[0].match?.match } : null };
`);
await step('tags', `return window.workbench.notes.tags()`);
await step('projects', `
  const p = await window.workbench.notes.projects();
  return p.map(x => x.id + ':' + x.name);
`);
await step('list', `
  const l = await window.workbench.notes.list({});
  return l.map(x => x.title);
`);
await step('graphSave', `
  await window.workbench.graphLayout.saveBatch([{ noteId: window.__s2.a.id, x: 120, y: 240, pinned: true, parentNoteId: null }]);
  return 'saved';
`);
await step('graphGetAll', `
  const all = await window.workbench.graphLayout.getAll();
  return all[window.__s2.a.id];
`);
await step('graphReset', `
  await window.workbench.graphLayout.resetAll();
  const all = await window.workbench.graphLayout.getAll();
  return { entriesAfterReset: Object.keys(all).length };
`);
await step('dbTables', `return window.__TAURI_INTERNALS__.invoke('db_tables')`);
await step('appInfo', `return window.workbench.getAppInfo()`);

console.log(JSON.stringify(results, null, 2));
ws.close();
process.exit(0);
