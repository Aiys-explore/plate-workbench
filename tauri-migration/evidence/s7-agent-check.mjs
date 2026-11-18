import assert from 'node:assert/strict'
import { tmpdir } from "node:os"
import { createServer } from 'node:http'
import { createServer as createPort } from 'node:net'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, realpath, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const here = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(new URL('../source/package.json', import.meta.url))('playwright')
const exe = resolve(process.argv[2] ?? join(here, '../source/src-tauri/target/release/plate-workbench.exe'))
const dsh = await realpath(process.argv[3] ?? join(process.env.LOCALAPPDATA,
  'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'))
const run = await mkdtemp(join(tmpdir(), "plate-s7-agent-check-"))
const workspace = join(run, 'workspace')
const settingsDir = join(run, 'settings')
const bin = join(run, 'bin')
await mkdir(bin)
await writeFile(join(bin, 'codex.cmd'), '@echo off\r\nnode "%~dp0fixture.js"\r\n')
await writeFile(join(bin, 'fixture.js'), 'process.stdin.setEncoding("utf8"); process.stdin.on("data", (input) => process.stdout.write("Codex fixture: " + input));')
const key = 'plate-test-' + randomUUID()
const receipt = 'DSH saved key receipt'
const task = 'Plate S7.1 中文正文'
const evidence = { candidate: exe, passed: [] }
const expectedHttp = []
const endpoint = createServer(async (request, response) => {
  if (request.method !== 'POST') return response.writeHead(200, { 'content-type': 'application/json' })
    .end('{"object":"list","data":[]}')
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const authorized = [request.headers['x-api-key'], request.headers.authorization].some(header =>
    header === key || header === 'Bearer ' + key)
  const input = Buffer.concat(chunks).toString('utf8')
  const hasTask = input.includes(task)
  expectedHttp.push({ authorized, hasTask, route: request.url })
  if (!authorized || !hasTask) return response.writeHead(401).end()
  const body = JSON.parse(input)
  const id = 'msg-' + randomUUID()
  const events = [
    { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: body.model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: receipt + ' ' + key } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
    .end(events.map(event => 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n').join(''))
})
endpoint.listen(0, '127.0.0.1')
await once(endpoint, 'listening')

const env = { ...process.env }
for (const name of Object.keys(env)) if (/^(PLATE_|DSH_|DEEPSEEK_|CODEX_|OPENAI_|ANTHROPIC_|AWS_|AZURE_|.*PROXY$|ELECTRON_RUN_AS_NODE)/i.test(name)) delete env[name]
env.Path = [bin, dirname(dsh), env.Path ?? env.PATH ?? ''].join(';')
delete env.PATH
Object.assign(env, {
  DSH_HOME: join(run, 'dsh-home'), DSH_NO_TELEMETRY: '1',
  APPDATA: join(run, 'roaming'), LOCALAPPDATA: join(run, 'local'), CODEX_HOME: join(run, 'codex-home'),
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + endpoint.address().port + '/v1',
  PLATE_WORKSPACE_ROOT: workspace, PLATE_AGENT_SETTINGS_DIR: settingsDir,
  WEBVIEW2_USER_DATA_FOLDER: join(run, 'webview'),
})

let child, page
async function wait(test, budget = 15000) {
  const deadline = Date.now() + budget
  do {
    const value = await test()
    if (value) return value
    await sleep(90)
  } while (Date.now() < deadline)
  throw Error('Timed out: ' + String(test))
}
async function launch() {
  const probe = createPort().listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(done => probe.close(done))
  const address = 'http://127.0.0.1:' + port
  child = spawn(exe, [], { cwd: run, env: {
    ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  }, stdio: 'ignore' })
  await wait(() => fetch(address + '/json/version').then(result => result.ok, () => false))
  const browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(12000)
  await page.waitForFunction(() => !!window.workbench)
  const state = await page.evaluate(() => window.workbench.startup.state())
  assert.equal(state.suggested ?? state.path, workspace)
  if (state.phase === 'choose') await page.getByRole('button', { name: '打开笔记', exact: true }).click()
  await page.getByRole('region', { name: '笔记关系图' }).waitFor()
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit').then(() => true)
  void page?.evaluate(() => window.workbench.startup.exit()).catch(() => {})
  if (!await Promise.race([exited, sleep(2200, false)])) { child.kill(); await exited }
}
const cardList = id => page.evaluate(noteId => window.workbench.tasks.listByNote(noteId), id)
const cardState = (id, state) => wait(async () => (await cardList(id)).find(card => card.state === state), 40000)
const pill = kind => page.locator('button[data-task-pill=' + kind + ']')
const settingsButton = () => page.locator('.topbar').getByRole('button', { name: 'Agent 设置', exact: true })
const settingsDialog = () => page.getByRole('dialog', { name: 'Agent 设置' })
async function openNote(note) {
  const node = page.locator('[data-graph-node=' + JSON.stringify(note.id) + ']')
  await node.waitFor()
  await node.dispatchEvent('click', { detail: 1 })
  await pill('todo').waitFor()
}
async function makeNote(title) {
  const note = await page.evaluate(async ({ title, task }) => {
    const api = window.workbench.notes
    const draft = await api.create(title, 'default', 'blank')
    return (await api.update(draft.id, '# ' + title + '\n\n- [ ] TODO: ' + task + '\n', draft.revision)).note
  }, { title, task })
  await openNote(note)
  return note
}
try {
  const binary = await readFile(exe)
  const header = binary.readUInt32LE(0x3c)
  assert.equal(binary.readUInt32LE(header), 0x4550)
  assert.equal(binary.readUInt16LE(header + 4 + 20 + 68), 2)
  evidence.passed.push('Windows GUI subsystem PE verified')
  await launch()
  const initial = await page.evaluate(() => window.workbench.agentSettings.get())
  assert.deepEqual(initial, { defaultAgent: null, deepseekKey: 'unset' })
  const found = await page.evaluate(() => window.workbench.agents.discover('dsh'))
  assert.equal(await realpath(found[0]), dsh)
  const note = await makeNote('首次选择')
  await pill('todo').click()
  const picker = page.getByRole('dialog', { name: '交给哪个 Agent？' })
  await picker.getByRole('button', { name: 'DeepSeek Harness', exact: true }).waitFor()
  assert.equal((await cardList(note.id)).length, 0)
  evidence.passed.push('untagged task opens chooser, and creates no run before selection')
  await picker.getByRole('button', { name: 'DeepSeek Harness', exact: true }).click()
  const failed = await cardState(note.id, 'ERROR')
  assert.match(failed.errorMsg, /缺少 API Key/)
  assert.equal(expectedHttp.length, 0)
  await pill('settings').click()
  const settings = settingsDialog()
  await settings.getByLabel('默认 Agent').selectOption('codex')
  await settings.getByLabel('DeepSeek API Key').fill(key)
  await settings.getByRole('button', { name: '保存设置' }).click()
  await settings.getByText('Agent 设置已保存', { exact: true }).waitFor()
  assert.equal(await settings.getByLabel('DeepSeek API Key').inputValue(), '')
  assert.equal((await readFile(join(settingsDir, 'agent-settings.json'), 'utf8')).includes(key), false)
  assert.equal((await page.evaluate(() => JSON.stringify(window.localStorage))).includes(key), false)
  await stop()

  await launch()
  const saved = await page.evaluate(() => window.workbench.agentSettings.get())
  assert.deepEqual(saved, { defaultAgent: 'codex', deepseekKey: 'saved' })
  evidence.passed.push('real DSH missing credential links to settings; Windows-encrypted key survives restart and is write-only')
  const codexNote = await makeNote('默认 Codex')
  await pill('todo').click()
  const codexCard = await cardState(codexNote.id, 'PENDING')
  assert.equal(codexCard.agentId, 'codex')
  assert.match(codexCard.outputDraft, /Codex fixture/)
  assert.equal(expectedHttp.length, 0)
  evidence.passed.push('saved Codex default works without a new chooser')

  const dshNote = await makeNote('单次切换到 DeepSeek')
  await pill('select-agent').click()
  await page.getByRole('dialog', { name: '交给哪个 Agent？' })
    .getByRole('button', { name: 'DeepSeek Harness', exact: true }).click()
  const dshCard = await cardState(dshNote.id, 'PENDING')
  assert.equal(dshCard.agentId, 'dsh')
  assert.ok(dshCard.outputDraft.includes(receipt))
  assert.ok(!JSON.stringify(dshCard).includes(key))
  assert.ok(expectedHttp.some(entry => entry.authorized && entry.hasTask))
  assert.equal((await page.evaluate(() => window.workbench.agentSettings.get())).defaultAgent, 'codex')
  evidence.passed.push('per-task override reaches real DSH with stored key and redacts the echoed secret')

  await settingsButton().click()
  const reopened = settingsDialog()
  await reopened.getByLabel('保存时移除已存密钥').check()
  await reopened.getByRole('button', { name: '保存设置' }).click()
  await reopened.getByText('Agent 设置已保存', { exact: true }).waitFor()
  const cleared = await page.evaluate(() => window.workbench.agentSettings.get())
  assert.deepEqual(cleared, { defaultAgent: 'codex', deepseekKey: 'unset' })
  evidence.passed.push('topbar settings can remove stored key independently of default Agent')
  evidence.status = 'pass'
} catch (error) {
  evidence.status = 'fail'
  evidence.error = String(error.stack ?? error).replaceAll(key, '[已隐藏密钥]')
  if (page) {
    try {
      const description = await page.locator('body').innerText()
      evidence.ui = description.replaceAll(key, '[已隐藏密钥]').slice(-4000)
    } catch { /* Candidate may already have exited. */ }
  }
  process.exitCode = 1
} finally {
  await stop()
  endpoint.closeAllConnections()
  await new Promise(done => endpoint.close(done))
  await writeFile(join(run, 'result.json'), JSON.stringify({ ...evidence, requests: expectedHttp }, null, 2))
  console.log(evidence.status + ' · ' + join(run, 'result.json'))
}
