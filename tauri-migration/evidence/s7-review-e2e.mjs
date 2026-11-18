import assert from 'node:assert/strict'
import { tmpdir } from "node:os"
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
const run = await mkdtemp(join(tmpdir(), "plate-s7-run-"))
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
  "  if (prompt === 'ROOT-LONG' || /FOLLOW-LONG(?:-RESTART)?$/.test(prompt)) {",
  "    let i = 0; setInterval(() => console.log('tick ' + i++), 125); return",
  "  }",
  "  if (prompt.endsWith('FOLLOW-FAIL & | %')) process.exit(3)",
  "  console.log(prompt.endsWith('FOLLOW-FINAL') ? '最终结论99' : prompt.endsWith('FOLLOW-GOOD') ? '修订值88' : '上一轮保留值77')",
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


const accepted = async () => readFile(join(root,'accepted.jsonl'),'utf8')
  .then(raw => raw.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)), () => [])
const state = (note, wanted) => taskState(note.id, 'codex', wanted)
const type = kind => drawer().locator('[data-task-pill=' + JSON.stringify(kind) + ']')
async function fixture(title, task) {
  const next = await call(async ({title,task}) => {
    const api = window.workbench.notes
    const created = await api.create(title, 'default', 'blank')
    return (await api.update(created.id, '# '+title+'\n\n- [ ] TODO(@codex): '+task+'\n',created.revision)).note
  },{title,task})
  await graphNode(next.id).waitFor()
  await openFixture(next)
  return next
}
async function openFixture(note) {
  await openNote(note.id)
  await waitFor(() => drawer().getByRole('textbox',{name:'笔记标题'}).inputValue().then(x=>x===note.title), 'open target note')
}
async function dispatch(note,task,wanted) {
  await pill('todo',task).click()
  return state(note,wanted)
}
async function waitSent(text) {
  return waitFor(async () => (await accepted()).findLast(value=>value.endsWith(text)), 'dispatch '+text)
}
async function restart() {
  const exited = once(child,'exit')
  assert.ok(child.kill())
  await exited
  await open()
}
async function followWith(text) {
  await drawer().locator('[data-task-panel=PENDING] textarea').fill(text)
  await type('follow').click()
}
async function restored(note, prior, error) {
  const card = await waitFor(async () => (await call(id=>window.workbench.tasks.listByNote(id),note.id))
    .find(row=>row.state==='PENDING'&&row.errorMsg?.includes(error)), 'restored '+error)
  assert.equal(card.outputDraft,prior.outputDraft)
  assert.equal(card.promptText,prior.promptText)
}
try {
  await open()
  const fresh = await fixture('重启恢复', 'ROOT-LONG')
  const started = await dispatch(fresh,'ROOT-LONG','DOING')
  await waitSent('ROOT-LONG')
  const prior = await accepted()
  await restart()
  const errored = await state(fresh,'ERROR')
  assert.equal(errored.taskId,started.taskId)
  assert.match(errored.errorMsg,/中断/)
  assert.deepEqual(await accepted(),prior)
  await openFixture(fresh)
  await type('retry').click()
  await waitFor(async () => (await readNote(fresh.id)).content.includes('TODO(@codex): ROOT-LONG'),'restore interrupted first round')
  passed('P1-1 startup reconciles first round without resending')
  const first = await dispatch(fresh,'ROOT-LONG','DOING')
  const stopped = await call(id=>window.workbench.tasks.stop(id),first.taskId)
  assert.equal(stopped.state,'TODO')
  assert.match((await readNote(fresh.id)).content,/DOING #t-/)
  await drawer().getByRole('button',{name:'恢复待办',exact:true}).click()
  await waitFor(async ()=>(await readNote(fresh.id)).content.includes('TODO(@codex): ROOT-LONG'),'reconcile TODO marker')
  passed('P1-2 existing TODO restores its Markdown marker')
  const review = await fixture('完成率与追问', 'REVIEW-SAMPLE')
  const rejected = await dispatch(review,'REVIEW-SAMPLE','PENDING')
  await type('reject').click()
  await waitFor(async ()=>(await readNote(review.id)).content.includes('TODO(@codex): REVIEW-SAMPLE'),'reject then redo')
  const saved = await dispatch(review,'REVIEW-SAMPLE','PENDING')
  assert.notEqual(rejected.taskId,saved.taskId)
  assert.match(saved.outputDraft,/上一轮保留值77/)
  await followWith('第一行\nFOLLOW-FAIL & | %')
  const failedPrompt = await waitSent('FOLLOW-FAIL & | %')
  assert.match(failedPrompt,/上一轮保留值77/)
  await restored(review,saved,'进程退出码 3')
  await followWith('FOLLOW-LONG')
  await waitSent('FOLLOW-LONG')
  await type('stop').first().click()
  await restored(review,saved,'已停止追加')
  assert.match((await readNote(review.id)).content,/DOING #t-/)
  await followWith('FOLLOW-LONG-RESTART')
  await waitSent('FOLLOW-LONG-RESTART')
  const sent = await accepted()
  await restart()
  await restored(review,saved,'中断')
  assert.deepEqual(await accepted(),sent)
  await openFixture(review)
  await followWith('FOLLOW-GOOD')
  assert.match(await waitSent('FOLLOW-GOOD'),/上一轮保留值77/)
  const waitReview = text => waitFor(async ()=>(await call(id=>window.workbench.tasks.listByNote(id),review.id))
    .find(row=>row.state==='PENDING'&&row.outputDraft.includes(text)),text)
  await waitReview('修订值88')
  await followWith('FOLLOW-FINAL')
  const last = await waitSent('FOLLOW-FINAL')
  assert.match(last,/修订值88/)
  assert.match(last,/FOLLOW-GOOD/)
  assert.ok(!last.includes('FOLLOW-FAIL'))
  await waitReview('最终结论99')
  passed('P1-5 follow-up carries prior output and history; stop, failure and restart restore it')
  await type('adopt').click()
  const summary = await waitFor(async () => {
    const value = await call(id=>window.workbench.tasks.summaryByNotes().then(rows=>rows[id]),review.id)
    return value?.done===1&&value.todo===0&&value
  },'completion badge denominator')
  assert.match((await readNote(review.id)).content,/> 最终结论99/)
  passed('P1-3 rejected runs excluded from graph counts',summary)
  const edit = await readNote(review.id)
  assert.ok(edit.path.toLowerCase().startsWith(root.toLowerCase()+'\\'))
  await writeFile(edit.path,edit.content+'\n外部编辑器实际写盘\n')
  const notice = () => drawer().getByText(/检测到文件在外部发生变更/)
  await notice().waitFor()
  await drawer().getByRole('button',{name:'读取磁盘版本',exact:true}).click()
  await notice().waitFor({state:'hidden'})
  await unsavedTitle('本机保存无外部提示')
  await drawer().getByRole('button',{name:'保存',exact:true}).click()
  await waitFor(async ()=>(await readNote(review.id)).title==='本机保存无外部提示','save')
  await sleep(550)
  assert.equal(await notice().count(),0)
  const other = join(run,'workspace-2')
  await mkdir(other)
  assert.equal((await call(path=>window.workbench.startup.submit(path),other)).path,other)
  await page.reload()
  await page.getByRole('region',{name:'笔记关系图'}).waitFor()
  const watched = await fixture('新工作区监听','SECOND-WORKSPACE')
  assert.ok(watched.path.toLowerCase().startsWith(other.toLowerCase()+'\\'))
  await writeFile(watched.path,watched.content+'\n新工作区外部写盘\n')
  await notice().waitFor()
  passed('P2-1 selected file notification, self-save filtering and watcher rebind')
  await button('关闭编辑抽屉').click()
  await button('新建分区').click()
  const dialog = page.getByRole('dialog',{name:'新建项目',exact:true})
  await dialog.getByRole('textbox',{name:'项目名称'}).fill('画布选中的项目')
  await dialog.getByRole('button',{name:'创建项目',exact:true}).click()
  await dialog.waitFor({state:'hidden'})
  const project = await call(async ()=>(await window.workbench.notes.projects()).find(p=>p.name==='画布选中的项目'))
  const canvas = page.locator('svg[aria-label="笔记节点"]')
  const box = await canvas.boundingBox()
  assert.ok(box)
  await canvas.dispatchEvent('dblclick',{clientX:box.x+40,clientY:box.y+40})
  const node = await waitFor(async ()=>(await call(()=>window.workbench.notes.links())).nodes.find(row=>row.title==='新笔记'),'graph create')
  assert.equal(node.projectId,project.id)
  passed('P2-2 graph note is in the selected partition')
  results.status='pass'
} catch (error) {
  results.status='fail'
  results.error=String(error.stack ?? error)
  console.error(results.error)
  if (page) await page.screenshot({path:join(run,'failure.png'),timeout:2500}).catch(()=>{})
  process.exitCode=1
} finally {
  await writeFile(join(run,'result.json'),JSON.stringify(results,null,2))
  await close()
  console.log('Evidence:',join(run,'result.json'))
}
