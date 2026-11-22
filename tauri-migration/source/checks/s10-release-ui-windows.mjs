import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const source = resolve(import.meta.dirname, '..')
const executable = resolve(process.argv[2] ?? join(source, 'src-tauri', 'target', 'debug', 'plate-workbench.exe'))
const packaged = process.argv.includes('--packaged')
const temp = await realpath(tmpdir())
const sandbox = await mkdtemp(join(temp, 'plate-s10-release-ui-'))
const workspace = join(sandbox, '隔离笔记')
const codexHome = join(sandbox, 'codex')
const claudeHome = join(sandbox, 'claude')
const codex = join(codexHome, 'sessions')
const claude = join(claudeHome, 'projects', 'fixture')
const custom = join(sandbox, 'custom')
const noteTag = 'S10MOUNTNOTE'
const logTag = 'S10MOUNTLOG'
const notes = {
  seed: { title: '合成 · 估值任务种子', marker: 'SeedBudget128' },
  search: { title: '合成 · 检索附件', marker: 'SearchProof256' },
  extra: { title: '合成 · 跨分区审阅附件', marker: 'ExtraCross512' },
  removed: { title: '合成 · 已移除笔记', marker: 'RemovedNote1024' },
}
const records = [
  { source: 'Codex CLI', title: '合成 Codex 会话', answer: 'CODEX-TRACE-81' },
  { source: 'Claude Code', title: '合成 Claude 会话', answer: 'CLAUDE-TRACE-82' },
  { source: '自定义', title: '合成自定义会话', answer: 'CUSTOM-TRACE-83' },
  { source: '自定义', title: '合成已移除会话', answer: 'REMOVED-TRACE-84' },
]
const promptText = '比较授权附件中的合成估值与审阅数据，输出三条检查结论。'
const taskTitle = '合成任务 · 检查六项引用'
const response = '引用验证通过。\n\n1. 种子笔记和跨分区附件可用。\n2. 三类 Agent 会话均已挂载。\n3. 已移除的引用不在授权范围内。'
const providerName = '本机回环 · 合成 UI 验收'
const key = 's10-ui-fixture-' + randomUUID()
const jsonl = entries => entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
const talk = (record, role) => role === 'user' ? record.title + ' ' + logTag : record.answer + ' ' + logTag
for (const path of [join(workspace, 'projects'), codex, claude, custom]) await mkdir(path, { recursive: true })
await writeFile(join(workspace, 'plate-workbench.json'), '{"version":"0.6.0-s10.1"}')
await writeFile(join(codex, 'rollout-synthetic.jsonl'), jsonl([
  { type: 'session_meta', payload: { cwd: workspace } },
  ...['user', 'assistant'].map(role => ({ type: 'response_item', payload: {
    type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: talk(records[0], role) }],
  } })),
]))
await writeFile(join(claude, 'synthetic.jsonl'), jsonl(['user', 'assistant'].map(role => ({
  type: role, cwd: workspace, message: { role, content: talk(records[1], role) },
}))))
for (const [i, record] of records.slice(2).entries()) {
  await writeFile(join(custom, 'synthetic-' + i + '.jsonl'), jsonl(['user', 'assistant'].map(role => ({
    role, content: talk(record, role),
  }))))
}

let modelError, receivedContext, retrievedNotes, retrievedLogs
function sse(res, delta, reason = null) {
  res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: reason }] }) + '\n\n')
}
const backend = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions')
    assert.equal(req.headers.authorization, 'Bearer ' + key)
    let body = ''
    for await (const part of req) body += part
    const request = JSON.parse(body)
    const results = request.messages.filter(message => message.role === 'tool')
    if (results.length === 0) {
      receivedContext = request.messages.map(message => message.content ?? '').join('\n')
      for (const marker of [promptText, notes.seed.marker, ...records.slice(0, 3).map(record => record.answer)]) {
        assert.ok(receivedContext.includes(marker), 'missing initial context: ' + marker)
      }
      assert.ok(!receivedContext.includes(records[3].answer))
      assert.ok(!receivedContext.includes(notes.removed.marker))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, { tool_calls: [
        { index: 0, id: 'notes-scope', type: 'function', function: { name: 'search_notes', arguments: JSON.stringify({ query: noteTag }) } },
        { index: 1, id: 'logs-scope', type: 'function', function: { name: 'search_agent_logs', arguments: JSON.stringify({ query: logTag }) } },
      ] })
      sse(res, {}, 'tool_calls')
    } else {
      retrievedNotes = JSON.parse(results.find(message => message.tool_call_id === 'notes-scope').content).notes
      retrievedLogs = JSON.parse(results.find(message => message.tool_call_id === 'logs-scope').content).sessions
      const expected = [notes.seed, notes.search, notes.extra]
      assert.deepEqual(retrievedNotes.map(note => note.title).sort(), expected.map(note => note.title).sort())
      for (const note of expected) assert.ok(retrievedNotes.find(item => item.title === note.title).excerpt.includes(note.marker))
      const logOutput = JSON.stringify(retrievedLogs)
      for (const record of records.slice(0, 3)) assert.ok(logOutput.includes(record.title), 'missing authorized log: ' + record.title)
      assert.equal(retrievedLogs.length, 3)
      assert.ok(!logOutput.includes(records[3].title))
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, { content: response.slice(0, 16) })
      sse(res, { content: response.slice(16) }, 'stop')
    }
    res.end('data: [DONE]\n\n')
  } catch (error) {
    modelError = error
    console.error('Loopback fixture assertion:', error.message)
    if (!res.headersSent) res.writeHead(400)
    res.end()
  }
})
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}
const apiPort = await listen(backend)
const reservation = createServer()
const port = await listen(reservation)
await new Promise(done => reservation.close(done))
const address = 'http://127.0.0.1:' + port

async function ready(url, process) {
  for (let i = 0; i < 200; i++) {
    assert.equal(process.exitCode, null)
    if (await fetch(url).then(res => res.ok, () => false)) return
    await delay(100)
  }
  throw new Error('Fixture server startup timeout: ' + url)
}
async function stop(process, graceful) {
  if (!process || process.exitCode !== null) return
  const exit = once(process, 'exit')
  if (graceful) void graceful().catch(() => {})
  else process.kill()
  if (!await Promise.race([exit.then(() => true), delay(3000, false, { ref: false })])) {
    process.kill()
    await exit
  }
}

const evidence = process.env.PLATE_S10_EVIDENCE
const shots = []
async function capture(name, page) {
  if (!evidence) return
  await mkdir(evidence, { recursive: true })
  await page.mouse.move(10, 4)
  await page.screenshot({ path: join(evidence, name), animations: 'disabled' })
  shots.push(name)
}
let vite, app, browser, page, passed = false
const errors = []
try {
  if (!packaged) {
    vite = spawn(process.execPath, [join(source, 'node_modules', 'vite', 'bin', 'vite.js'), '--strictPort'],
      { cwd: source, windowsHide: true, stdio: 'inherit' })
    await ready('http://127.0.0.1:5173', vite)
  }
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(PLATE_|WEBVIEW2_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|DSH_|DEEPSEEK_)/i.test(key)))
  app = spawn(executable, [], { cwd: sandbox, windowsHide: true, stdio: 'inherit', env: {
    ...env, PLATE_WORKSPACE_ROOT: workspace, PLATE_AGENT_SETTINGS_DIR: join(sandbox, 'agents'),
    CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome,
    WEBVIEW2_USER_DATA_FOLDER: join(sandbox, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
  } })
  await ready(address + '/json/version', app)
  browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(12_000)
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const rail = page.getByRole('navigation', { name: '主导航' })
  const nav = name => rail.getByRole('button', { name, exact: true }).click()
  const button = name => page.getByRole('button', { name, exact: true })
  const composer = page.getByRole('form', { name: '任务输入' })
  const prompt = composer.getByLabel('任务内容')
  const noteRefs = composer.getByRole('list', { name: '任务引用' })
  const menu = page.locator('.s10-composer-panel')
  await rail.waitFor()
  assert.equal(await page.evaluate(() => window.workbench.getAppInfo().then(info => info.version)), '0.6.0-s10.1')
  assert.equal(await page.evaluate(() => window.workbench.startup.state().then(state => state.path)), workspace)

  await nav('模型与权限')
  await page.getByLabel('名称', { exact: true }).fill(providerName)
  await page.getByRole('combobox', { name: /类型/ }).selectOption('openai_compatible')
  await page.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:' + apiPort + '/v1')
  await page.getByLabel('默认模型', { exact: true }).fill('fixture-model')
  await page.getByLabel('API Key', { exact: true }).fill(key)
  await button('保存服务商').click()
  await page.getByRole('complementary', { name: '模型服务商列表' }).getByText(providerName).waitFor()
  await nav('资料与记录')
  await button('本地笔记库').click()

  async function createNote(note) {
    const existing = await page.evaluate(() => window.workbench.notes.list().then(items => items.map(item => item.id)))
    await button('新建主节点').click()
    const added = await page.waitForFunction(async existing => {
      const all = await window.workbench.notes.list()
      return all.find(item => !existing.includes(item.id))?.id
    }, existing)
    const id = await added.jsonValue()
    assert.ok(id)
    const node = page.locator('[data-graph-node="' + id + '"]')
    await node.focus()
    await node.press('Shift+Enter')
    const title = page.getByRole('textbox', { name: '笔记标题' })
    const editor = page.locator('[data-editor-host="render"]')
    await title.fill(note.title)
    await editor.focus()
    await page.keyboard.insertText(noteTag + ' ' + note.marker + ' · 本地合成正文')
    await button('保存').click()
    await page.waitForFunction(async ({ id, title, marker }) => {
      const note = await window.workbench.notes.read(id)
      return note.title === title && note.content.includes(marker)
    }, { id, title: note.title, marker: note.marker })
    await button('关闭编辑抽屉').click()
    return id
  }
  const searchId = await createNote(notes.search)
  const seedId = await createNote(notes.seed)
  const removedId = await createNote(notes.removed)
  await button('新建分区').click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目' })
  await projectDialog.getByRole('textbox').fill('合成跨分区')
  await projectDialog.getByRole('button', { name: '创建项目' }).click()
  await projectDialog.waitFor({ state: 'hidden' })
  const filter = page.getByLabel('导图分区')
  await filter.selectOption({ label: '合成跨分区' })
  const extraId = await createNote(notes.extra)
  const extraProject = await page.evaluate(id => window.workbench.notes.read(id).then(note => note.projectId), extraId)
  assert.notEqual(extraProject, 'default')
  await filter.selectOption('')
  await nav('大脑视图')
  const remember = page.getByLabel('任务使用大脑上下文')
  if (!await remember.isChecked()) await remember.click()
  await page.waitForFunction(() => document.querySelector('.brain-context-control input')?.checked)
  await nav('资料与记录')
  await button('本地笔记库').click()
  await page.locator('.plate-map-search-entry').click()
  const search = page.getByRole('dialog', { name: '搜索或跳转' })
  await search.getByRole('searchbox').fill('检索附件')
  const notePicker = search.getByRole('button', { name: '引用到工作台：' + notes.search.title })
  await notePicker.locator('xpath=ancestor::li').hover()
  await notePicker.click()
  await noteRefs.getByText(notes.search.title, { exact: true }).waitFor()
  await prompt.fill(promptText)
  await button('引用笔记').click()
  await menu.getByLabel('种子笔记', { exact: true }).selectOption(seedId)
  await menu.getByLabel('其他授权笔记', { exact: true }).selectOption([searchId, extraId, removedId])
  await noteRefs.getByRole('button', { name: '移除引用 ' + notes.removed.title, exact: true }).click()
  await noteRefs.getByText(notes.removed.title, { exact: true }).waitFor({ state: 'hidden' })

  await button('模型与引擎').click()
  const model = menu.getByRole('button', { name: /本机回环/ })
  await model.click()
  await menu.getByText('任务设置', { exact: true }).click()
  await menu.getByLabel('任务标题').fill(taskTitle)
  await page.keyboard.press('Escape')
  await button('任务权限').click()
  await menu.getByLabel('允许连接所选模型服务并提交任务上下文').check()
  assert.equal(await menu.getByLabel('允许读取全部笔记').isChecked(), false)

  await button('引用记录').click()
  await menu.getByRole('button', { name: '打开资料与记录' }).click()
  await page.getByLabel('自定义目录').fill(custom)
  await button('扫描记录').click()
  await page.getByText('扫描 4 个文件，更新 4 个会话，导入 8 条消息。').waitFor()
  const recordRow = title => page.locator('.s10-logs .s10-row').filter({ hasText: title })

  async function attachFromLibrary(record) {
    const row = recordRow(record.title)
    await row.getByRole('button', { name: new RegExp(record.title) }).click()
    await page.locator('.s10-log-messages').getByText(record.answer, { exact: false }).waitFor()
    await row.getByText(record.source + ' · 2 条', { exact: true }).waitFor()
    await row.hover()
    await row.getByRole('button', { name: '引用到工作台' }).click()
    await noteRefs.getByText(record.title + ' ' + logTag, { exact: true }).waitFor()
  }

  await attachFromLibrary(records[0])
  await nav('资料与记录')
  await button('本机 Agent 记录').click()
  await attachFromLibrary(records[1])
  for (const record of records.slice(2)) {
    await button('引用记录').click()
    await menu.getByRole('button', { name: record.title + ' ' + logTag, exact: true }).click()
    await noteRefs.getByText(record.title + ' ' + logTag, { exact: true }).waitFor()
  }
  await noteRefs.getByRole('button', { name: '移除引用 ' + records[3].title + ' ' + logTag, exact: true }).click()
  assert.equal(await noteRefs.locator('li').count(), 6)
  for (const note of [notes.seed, notes.search, notes.extra]) await noteRefs.getByText(note.title, { exact: true }).waitFor()
  assert.equal(await prompt.inputValue(), promptText)

  async function checkAnchor() {
    const trigger = button('模型与引擎')
    assert.ok(await noteRefs.evaluate(list => {
      const bounds = list.getBoundingClientRect()
      return [...list.children].every(chip => {
        const rect = chip.getBoundingClientRect()
        return rect.y >= bounds.y - 1 && rect.bottom <= bounds.bottom + 1
      })
    }), 'all six attachments must be fully visible')
    const previous = await composer.boundingBox()
    await trigger.click()
    await menu.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)))
    const [anchor, panel, form] = await Promise.all([trigger.boundingBox(), menu.boundingBox(), composer.boundingBox()])
    assert.deepEqual(form, previous)
    assert.ok(Math.abs(panel.x - anchor.x) <= 1, 'model menu aligns with the clicked button')
    assert.ok(Math.abs(panel.y + panel.height - anchor.y + 8) <= 1, 'model menu opens 8px above the clicked button')
    assert.ok(panel.y >= 44, 'model menu stays within the canvas')
    assert.equal(await menu.getByRole('button', { name: /本机回环/ }).getAttribute('aria-pressed'), 'true')
  }

  await checkAnchor()
  await capture('loaded-model-anchor.png', page)
  await prompt.click({ position: { x: 3, y: 5 } })
  await menu.waitFor({ state: 'hidden' })
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 860, height: 600 })
  await checkAnchor()
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
  await page.setViewportSize(viewport)
  await capture('loaded-six-attachments.png', page)

  try {
    await prompt.press('Enter')
    await page.getByLabel('Agent 输出').getByText(/引用验证通过/).waitFor()
  } catch (error) { throw modelError ?? error }
  assert.equal(modelError, undefined)
  assert.ok(receivedContext && retrievedNotes?.length === 3 && retrievedLogs?.length === 3)
  await page.getByRole('heading', { name: '从一个任务或一份资料开始' }).waitFor({ state: 'hidden' })
  await page.getByText('引用 3 个会话', { exact: false }).waitFor()
  await page.getByText(taskTitle, { exact: true }).first().waitFor()
  await page.locator('.s10-timeline summary').click()
  await page.locator('.s10-timeline').getByText(/search_notes/).waitFor()
  await page.locator('.s10-timeline').getByText(/search_agent_logs/).waitFor()
  await capture('loaded-task-result.png', page)
  assert.deepEqual(errors, [])
  const result = { version: '0.6.0-s10.1', packaged, notesCreated: 4, notesAuthorized: 3, logsImported: 4, logsAuthorized: 3,
    firstCallSeedAndLogsVerified: true, removedReferencesExcluded: true, allSixChipsVisible: true,
    modelAnchorPx: 8, testedViewportWidths: [viewport.width, 860],
    rendererErrors: errors.length, screenshots: shots }
  if (evidence) await writeFile(join(evidence, 'loaded-ui-verification.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('PASS S10.1 populated UI:', JSON.stringify(result))
  passed = true
} finally {
  if (page && !page.isClosed()) {
    await page.evaluate(async name => {
      const providers = await window.workbench.providers.list()
      const fixture = providers.find(provider => provider.name === name)
      if (fixture) await window.workbench.providers.remove(fixture.id)
    }, providerName).catch(() => {})
  }
  await stop(app, page && !page.isClosed() ? () => page.evaluate(() => window.workbench.startup.exit()) : undefined)
  await browser?.close()
  await stop(vite)
  backend.close()
  if (passed && dirname(sandbox) === temp && basename(sandbox).startsWith('plate-s10-release-ui-')) {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 })
  } else console.error('Isolated fixture:', sandbox)
}
