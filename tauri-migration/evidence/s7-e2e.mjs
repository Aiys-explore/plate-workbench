import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../source/package.json', import.meta.url))
const { chromium } = require('playwright')
const exe = resolve(process.argv[2] ?? join(here, '../source/src-tauri/target/release/plate-workbench.exe'))
const run = await mkdtemp(join(here, 'run-'))
const root = join(run, 'workspace')
await mkdir(root)
const profile = join(run, 'webview')
const worker = join(run, 'fixture.cjs')
const shim = join(run, 'fixture.cmd')
await writeFile(shim, '@echo off\r\nnode "%~dp0fixture.cjs" %*\r\n')
await writeFile(worker, [
  "const fs = require('node:fs')",
  "let prompt = ''",
  "process.stdin.setEncoding('utf8')",
  "process.stdin.on('data', part => { prompt += part })",
  "process.stdin.on('end', () => {",
  "  fs.appendFileSync('accepted.jsonl', JSON.stringify(prompt) + '\\n')",
  "  if (prompt.includes('长任务保持运行')) {",
  "    let i = 0; setInterval(() => console.log('tick ' + i++), 125); return",
  "  }",
  "  console.log(Array.from({length:54},(_,i)=>'结论第'+(i+1)+'行').join('\\n'))",
  "  console.error('日志不会被采纳为结论')",
  "})"
].join('\n'))
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^PLATE_AGENT_/i.test(key)) delete env[key]
const results = { candidate: exe, workspace: root, passed: [] }
let child, page
function passed(name, proof = true) {
  results.passed.push({ name, proof })
  console.log(name, JSON.stringify(proof))
}
async function waitFor(predicate, label, budget = 8000) {
  const until = Date.now() + budget
  do {
    const result = await predicate()
    if (result) return result
    await sleep(75)
  } while (Date.now() < until)
  throw new Error('Timed out: ' + label)
}
async function open() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(accept => server.close(accept))
  const endpoint = 'http://127.0.0.1:' + port
  child = spawn(exe, [], { windowsHide: true, stdio: 'ignore', cwd: run, env: {
    ...env, PLATE_WORKSPACE_ROOT: root, PLATE_AGENT_CODEX: shim, PLATE_AGENT_CLAUDE: shim,
    WEBVIEW2_USER_DATA_FOLDER: profile, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  } })
  await waitFor(() => fetch(endpoint + '/json/version').then(r => r.ok, () => false), 'WebView2 startup', 15000)
  const browser = await chromium.connectOverCDP(endpoint)
  page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(8500)
  await page.waitForFunction(() => !!window.workbench)
  const startup = await page.evaluate(() => window.workbench.startup.state())
  assert.equal(startup.path ?? startup.suggested, root, 'verify isolated target before any write')
  const enter = page.getByRole('button', { name: '打开笔记', exact: true })
  if (await enter.isVisible()) await enter.click()
  await page.getByRole('region', { name: '笔记关系图' }).waitFor()
}
async function close() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit').then(() => true)
  if (page) void page.evaluate(() => window.workbench.startup.exit()).catch(() => {})
  if (!await Promise.race([exited, sleep(3200, false)])) {
    child.kill()
    await exited
  }
}
const button = label => page.getByRole('button', { name: label, exact: true })
const drawer = () => page.locator('[aria-label="笔记编辑抽屉"]')
const graphNode = id => page.locator('[data-graph-node=' + JSON.stringify(id) + ']')
const pill = (kind, text) => drawer().locator('[data-editor-role=task], [data-editor-role=paragraph]')
  .filter({ hasText: text }).locator('[data-task-pill=' + JSON.stringify(kind) + ']').last()
const call = (body, value) => page.evaluate(body, value)
async function openNote(id) {
  await graphNode(id).dispatchEvent('click', { detail: 1 })
  await waitFor(() => drawer().getAttribute('data-open').then(v => v === 'true'), 'open editor')
  await drawer().locator('[data-editor-host=render]').waitFor()
}
async function unsavedTitle(title) {
  await page.getByRole('textbox', { name: '笔记标题', exact: true }).fill(title)
  await drawer().locator('[data-editor-status-item][data-state=dirty]').waitFor()
}
async function taskState(noteId, agentId, state) {
  return waitFor(() => call(async ({ noteId, agentId, state }) =>
    (await window.workbench.tasks.listByNote(noteId)).find(t => t.agentId === agentId && t.state === state),
    { noteId, agentId, state }), agentId + ':' + state)
}
async function readNote(id) { return call(id => window.workbench.notes.read(id), id) }

try {
  await open()
  const version = await call(() => window.workbench.getAppInfo())
  assert.equal(version.version, '0.3.0-s7.0')
  assert.equal(await button('插件中心').count(), 0)
  assert.equal(await button('导出记录').count(), 0)
  assert.equal(await page.getByText(/加载 Agent 会话失败/).count(), 0)
  const found = await call(() => window.workbench.agents.list())
  assert.ok(Array.isArray(found) && found.some(a => a.type === 'codex'))
  for (const address of ['file:///C:/Windows', 'javascript:void(0)', 'https://name:example@example.com/']) {
    const rejected = await call(address => window.workbench.notes.openLink(address).then(() => false, () => true), address)
    assert.equal(rejected, true, address)
  }
  passed('S7-2 startup, discovery and hidden old entries', { version, agents: found.map(a => a.type) })

  const openSidebar = button('打开笔记栏')
  if (await openSidebar.isVisible()) await openSidebar.click()
  await button('新建分区').click()
  const projectForm = page.getByRole('dialog', { name: '新建项目', exact: true })
  await projectForm.getByRole('textbox', { name: '项目名称' }).fill('S7 合成项目')
  await projectForm.getByRole('button', { name: '创建项目', exact: true }).click()
  await projectForm.waitFor({ state: 'hidden' })
  const project = await call(async () => (await window.workbench.notes.projects()).find(p => p.name === 'S7 合成项目'))
  assert.ok(project)
  const taskMd = [
    '# S7 审阅试验', '', '- [ ] TODO(@codex): 核对数据',
    '  - 甲公司 42% & |', '  - 乙公司 31%', '', '- [ ] TODO(@claude): 长任务保持运行',
    '', '~~~markdown', '- [ ] TODO(@codex): 示例不发起', '~~~',
  ].join('\n')
  const seed = await call(async ({ project, taskMd }) => {
    const api = window.workbench.notes
    const review = await api.create('S7 审阅试验', project, 'blank')
    const remove = await api.create('S7 确认移除', project, 'blank')
    const sidebar = await api.create('S7 侧栏移除', project, 'blank')
    const parent = await api.create('S7 关系主线', project, 'blank')
    const saved = await api.update(review.id, taskMd, review.revision)
    return { review: review.id, remove: remove.id, sidebar: sidebar.id, parent: parent.id, saved: saved.status }
  }, { project: project.id, taskMd })
  assert.equal(seed.saved, 'saved')
  await graphNode(seed.review).waitFor({ timeout: 8000 })
  await openNote(seed.remove)
  await drawer().getByRole('button', { name: '删除', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: '移除笔记', exact: true })
  await confirm.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await readNote(seed.remove)).id, seed.remove)
  await drawer().getByRole('button', { name: '删除', exact: true }).click()
  await confirm.getByRole('button', { name: '确认移除', exact: true }).click()
  await confirm.waitFor({ state: 'hidden' })
  await graphNode(seed.remove).waitFor({ state: 'detached' })
  const sidebarRow = page.locator('[role=treeitem][data-note-id=' + JSON.stringify(seed.sidebar) + ']')
  if (!await sidebarRow.count()) {
    const group = page.getByRole('treeitem', { name: /S7 合成项目/ }).first()
    if (await group.getAttribute('aria-expanded') === 'false') await group.click()
  }
  await sidebarRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: '移除笔记…', exact: true }).click()
  await confirm.getByRole('button', { name: '确认移除', exact: true }).click()
  await confirm.waitFor({ state: 'hidden' })
  await graphNode(seed.sidebar).waitFor({ state: 'detached' })
  passed('S7-2 project creation and both deletion paths', project.id)

  await openNote(seed.review)
  await unsavedTitle('草稿标题保全')
  await pill('todo', '核对数据').click()
  const pending = await taskState(seed.review, 'codex', 'PENDING')
  assert.equal(pending.promptText, '核对数据\n  - 甲公司 42% & |\n  - 乙公司 31%')
  const scripted = await readNote(seed.review)
  assert.equal(scripted.title, '草稿标题保全')
  assert.ok(scripted.content.includes('DOING #' + pending.taskId))
  assert.ok(!scripted.content.includes('conflict'))
  assert.equal(await drawer().locator('[data-task-pill=todo]').count(), 1)
  passed('S7-3 multiline task, fenced code and dirty dispatch', pending.promptText)

  await pill('todo', '长任务保持运行').click()
  await taskState(seed.review, 'claude', 'DOING')
  const follow = drawer().locator('[data-task-follow-input=' + JSON.stringify(pending.taskId) + ']')
  await follow.fill('追问第一行\n后续行 " & | %')
  const original = await follow.elementHandle()
  await follow.evaluate(el => { el.focus(); el.setSelectionRange(2, 4) })
  await sleep(900)
  assert.equal(await original.evaluate(el => el.isConnected && document.activeElement === el &&
    el.selectionStart === 2 && el.selectionEnd === 4), true)
  await drawer().locator('[data-task-panel=PENDING] [data-task-pill=follow]').click()
  const followup = await waitFor(async () => {
    const candidate = await taskState(seed.review, 'codex', 'PENDING')
    return candidate.promptText.includes('后续行') && candidate
  }, 'completed follow-up')
  assert.ok(followup.promptText.endsWith('追问第一行\n后续行 " & | %'))
  const received = (await readFile(join(root,'accepted.jsonl'),'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.ok(received.includes(followup.promptText))
  passed('S7-3 focus and multiline follow-up', { selection: [2,4], received: followup.promptText })

  await unsavedTitle('待采纳草稿标题')
  await drawer().locator('[data-task-panel=PENDING] [data-task-pill=adopt]').click()
  await taskState(seed.review, 'codex', 'DONE')
  let savedNote = await readNote(seed.review)
  assert.equal(savedNote.title, '待采纳草稿标题')
  assert.ok(savedNote.content.includes('> 结论第54行'))
  assert.ok(!savedNote.content.includes('> 日志不会被采纳为结论'))
  await unsavedTitle('采纳后再次手动保存')
  await drawer().getByRole('button', { name: '保存', exact: true }).click()
  savedNote = await waitFor(async () => {
    const note = await readNote(seed.review)
    return note.title === '采纳后再次手动保存' && note
  }, 'save after adopt')
  assert.ok(savedNote.content.includes('DONE #' + pending.taskId))
  const conflictCopies = await call(async () => (await window.workbench.notes.links()).nodes.filter(n => n.kind === 'conflict').length)
  assert.equal(conflictCopies, 0)
  await drawer().locator('[data-task-capsule] [data-task-pill=stop]').click()
  await taskState(seed.review, 'claude', 'TODO')
  await waitFor(async () => (await readNote(seed.review)).content.includes('TODO(@claude): 长任务保持运行'), 'stop restores agent')
  passed('S7-3 adopt 54 lines, preserve agent selector, then save without a conflict copy')

  const earlier = await readNote(seed.review)
  const requests = await readFile(join(root, 'accepted.jsonl'), 'utf8')
  await unsavedTitle('冲突时保留此草稿')
  const updated = await call(note =>
    window.workbench.notes.update(note.id, note.content + '\n外部修改保留\n', note.revision), earlier)
  assert.equal(updated.status, 'saved')
  await pill('todo', '长任务保持运行').click()
  await drawer().getByText(/磁盘版本已变化，草稿已保留/).waitFor()
  assert.equal(await readFile(join(root, 'accepted.jsonl'), 'utf8'), requests)
  assert.ok((await readNote(seed.review)).content.endsWith('外部修改保留\n'))
  const drafts = await call(() => window.workbench.notes.draftList())
  assert.ok(drafts.some(draft => draft.id === seed.review && draft.source === 'changed'))
  passed('S7-3 external edit blocks dispatch and preserves draft')

  await button('关闭编辑抽屉').click()
  await waitFor(() => drawer().getAttribute('data-open').then(value => value === 'false'), 'drawer closed')
  await call(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  let last = seed.parent
  await graphNode(last).focus()
  const chain = [last]
  const positions = []
  for (let n = 0; n < 6; n++) {
    assert.equal(await call(() => document.activeElement?.getAttribute('data-graph-node')), last)
    await page.keyboard.press('Tab')
    const observed = await waitFor(() => call(async previous => {
      const focused = document.activeElement
      const id = focused?.getAttribute('data-graph-node')
      if (!id || id === previous) return null
      const previousNote = await window.workbench.notes.read(previous)
      return previousNote.content.includes('[[' + id + '|') ? { id, transform: focused.getAttribute('transform') } : null
    }, last), 'focus newly derived node', 12000)
    const prior = await readNote(last)
    assert.ok(prior.content.includes('[[' + observed.id + '|'))
    last = observed.id
    chain.push(last)
    positions.push(Number(observed.transform.match(/translate\(([\d.]+)/)[1]))
  }
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i] > positions[i-1], String(positions))
  assert.ok(positions.at(-1) > 1140)
  const final = await readNote(last)
  const rename = await call(note => window.workbench.notes.update(note.id, '# S7 重命名节点\n', note.revision), final)
  assert.equal(rename.status, 'saved')
  const indexed = await call(() => window.workbench.notes.links())
  for (let i = 1; i < chain.length; i++) {
    const parent = chain[i-1], child = chain[i]
    assert.ok(indexed.edges.some(e => e.target === parent && e.source === child))
    assert.ok(indexed.bindings.some(r => r.source === parent && r.target === child))
  }
  const firstLayout = await call(() => window.workbench.graphLayout.getAll())
  await close()
  await open()
  const restarted = await call(() => window.workbench.graphLayout.getAll())
  for (const id of chain.slice(1)) assert.deepEqual(restarted[id], firstLayout[id])
  passed('S7-4 six-level graph and rename, placement survives restart', { positions, chain })

  results.status = 'pass'
  await page.screenshot({ path: join(run, 's7-graph.png') })
} catch (error) {
  results.status = 'fail'
  results.error = String(error.stack ?? error)
  if (page) await page.screenshot({ path: join(run, 's7-failure.png'), timeout: 2500 }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(run, 'result.json'), JSON.stringify(results, null, 2))
  await close()
  console.log('Evidence:', join(run, 'result.json'))
}
