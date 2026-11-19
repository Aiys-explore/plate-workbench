import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, writeFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'

const { chromium } = createRequire(new URL('../source/package.json', import.meta.url))('playwright')
const [mode, inputExe, output] = process.argv.slice(2)
assert.ok(['agents', 'picker', 'first-run'].includes(mode))
const evidence = resolve(output)
await mkdir(evidence, { recursive: true })
const run = await mkdtemp(join(tmpdir(), 'plate-s9-field-' + mode + '-'))
let exe = resolve(inputExe)
const notes = join(run, 'workspace')
const agentSettings = join(run, 'agent-settings')
const profile = join(run, 'webview')
const result = { mode, run, checks: [], status: 'RUNNING' }
const record = (name, status, details) => {
  result.checks.push({ name, status, details })
  console.log(status, name, JSON.stringify(details))
}
let processHandle, browser, page
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PLATE_AGENT_|CODEX_HOME$|WEBVIEW2_|PLATE_WORKSPACE_ROOT$|CODEX_SANDBOX|CODEX_THREAD_ID$)/i.test(key)))
Object.assign(env, {
  PLATE_WORKSPACE_ROOT: notes, PLATE_AGENT_SETTINGS_DIR: agentSettings, WEBVIEW2_USER_DATA_FOLDER: profile,
})
async function poll(fn, description, millis = 15_000) {
  const deadline = Date.now() + millis
  do {
    const value = await fn()
    if (value) return value
    await delay(125)
  } while (Date.now() < deadline)
  throw new Error('Timed out: ' + description)
}
async function launch() {
  const portLease = createServer().listen(0, '127.0.0.1')
  await once(portLease, 'listening')
  const port = portLease.address().port
  await new Promise(done => portLease.close(done))
  const address = 'http://127.0.0.1:' + port
  const appEnv = { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }
  const expectedSuggestion = mode === 'first-run'
    ? join(process.env.USERPROFILE, 'Documents', 'Plate-Tauri-S9-试用笔记') : notes
  if (mode === 'first-run') {
    assert.equal(await access(join(expectedSuggestion, 'plate-workbench.json')).then(() => true, () => false), false,
      'will not open an existing default S9 workspace during first-run tests')
    delete appEnv.PLATE_WORKSPACE_ROOT
  }
  processHandle = spawn(exe, [], {
    cwd: run, stdio: 'ignore', windowsHide: mode !== 'picker', env: appEnv,
  })
  await poll(() => {
    if (processHandle.exitCode !== null) throw new Error('Plate exited: ' + processHandle.exitCode)
    return fetch(address + '/json/version').then(response => response.ok, () => false)
  }, 'local WebView2')
  browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(12_000)
  await page.waitForFunction(() => !!window.workbench)
  const startup = await page.evaluate(() => window.workbench.startup.state())
  assert.equal(startup.phase, 'choose')
  assert.equal(startup.suggested, expectedSuggestion)
  if (mode === 'first-run') {
    const selected = await page.evaluate(path => window.__TAURI_INTERNALS__.invoke('startup_submit', { token: path }), notes)
    assert.equal(selected.path, notes)
    await page.reload()
    record('default startup suggestion uses a new S9 workspace', 'PASS', { s9Workspace: true, showsChooser: true })
  } else {
    await page.getByRole('button', { name: '打开笔记', exact: true }).click()
  }
  await page.getByRole('region', { name: '笔记关系图' }).waitFor()
  const ready = await page.evaluate(() => window.workbench.startup.state())
  assert.equal(ready.path, notes)
  return ready
}
async function shutdown() {
  if (!processHandle || processHandle.exitCode !== null) return
  const exited = once(processHandle, 'exit').then(() => true)
  void page?.evaluate(() => window.workbench.startup.exit()).catch(() => {})
  if (!await Promise.race([exited, delay(3_000, false)])) { processHandle.kill(); await exited }
  await browser?.close()
}
const safeDiagnostic = card => {
  const content = [card.errorMsg, card.logTail, card.outputDraft].join('\n')
  if (/rate.limit|429|quota|容量|限流/i.test(content)) return 'rate-or-capacity'
  if (/ENOTFOUND|ECONN|dns|timed out|failed to connect|连接失败/i.test(content)) return 'network'
  if (/login|sign in|authenticate|unauthorized|api key|401|403|未登录|缺少.*Key/i.test(content)) return 'credential'
  if (/model.*not.*available|invalid.*model|模型.*无效/i.test(content)) return 'model'
  if (/command not found|not recognized|CLI.*失败|无法启动/i.test(content)) return 'launch'
  return card.errorMsg ? 'adapter-error' : 'no-exact-answer'
}
async function agents() {
  const plugins = await page.evaluate(() => window.workbench.agentPlugins.list(true))
  result.discovery = [...plugins.installed, ...plugins.available].filter(p => ['codex', 'claude', 'dsh', 'opencode'].includes(p.id))
    .map(({ id, installed, enabled, status, cliVersion, executable, deepseekKey }) =>
      ({ id, installed, enabled, status, cliVersion, binary: executable ? executable.split(/[\\/]/).at(-1) : null, deepseekKey }))
  const nonce = randomBytes(5).toString('hex')
  const operands = Array.from(randomBytes(2), (byte, i) => 200 + byte + i * 500)
  const answer = 'S9-FIELD-' + nonce + ' ' + (operands[0] + operands[1])
  const ready = result.discovery.filter(p => p.status === 'connected')
  const seeded = await page.evaluate(async ({ nonce, operands, ready }) => {
    const wb = window.workbench
    const source = await wb.notes.create('合成来源 ' + nonce, 'default', 'blank')
    const saved = await wb.notes.update(source.id,
      source.content + '本次验收的两个整数是 ' + operands[0] + ' 和 ' + operands[1] + '。\n', source.revision)
    if (saved.status !== 'saved') throw new Error('Could not save source')
    await wb.brain.setContext(true)
    const note = await wb.notes.create('现场验收 ' + nonce, 'default', 'blank')
    const body = [
      note.content,
      '- [[' + source.id + '|合成来源]]',
      ...ready.map(id => '- [ ] TODO(@' + id + '): 根据关联笔记「合成来源」中的两个整数计算总和。只输出一行 S9-FIELD-' +
        nonce + ' 加一个空格及计算结果（不要输出其他内容）。仅使用本次标准输入，不读取文件，不调用工具，不执行命令。'),
    ].join('\n\n') + '\n'
    const update = await wb.notes.update(note.id, body, note.revision)
    if (update.status !== 'saved') throw new Error('Could not save task note')
    return { noteId: note.id, sourceId: source.id }
  }, { nonce, operands, ready: ready.map(p => p.id) })
  await page.locator('[data-graph-node="' + seeded.noteId + '"]').dispatchEvent('dblclick', { detail: 2 })
  const editor = page.locator('[data-editor-host=render]')
  await editor.waitFor()
  await page.evaluate(() => {
    window.__s9FieldWaves = []
    window.workbench.brain.onActivation(wave => window.__s9FieldWaves.push(wave))
  })
  for (const plugin of result.discovery) {
    if (plugin.status === 'connected') continue
    if (plugin.id === 'dsh' && plugin.binary) {
      const blocked = await page.evaluate(async noteId => {
        try {
          await window.workbench.tasks.start({ noteId, taskId: 'field-dsh-blocked', agentSelector:'dsh', promptText:'只回复一行 FIELD-TEST' })
          return false
        } catch (err) { return /DeepSeek API Key/.test(String(err)) }
      }, seeded.noteId)
      record(plugin.id, 'BLOCKED', { ...plugin, missingCredentialRejected: blocked })
      continue
    }
    record(plugin.id, 'BLOCKED', plugin)
  }
  for (const plugin of ready) {
    const target = editor.locator('[data-task-capsule][data-task-agent="' + plugin.id + '"] [data-task-pill=todo]')
    await target.click()
    await poll(async () => (await page.evaluate(id => window.workbench.tasks.listByNote(id), seeded.noteId))
      .find(card => card.agentId === plugin.id), 'dispatch ' + plugin.id)
  }

  const settled = await Promise.all(ready.map(async plugin => {
    let card
    try {
      card = await poll(async () => (await page.evaluate(id => window.workbench.tasks.listByNote(id), seeded.noteId))
        .find(card => card.agentId === plugin.id && ['PENDING', 'ERROR'].includes(card.state)), plugin.id, 140_000)
    } catch {
      const running = (await page.evaluate(id => window.workbench.tasks.listByNote(id), seeded.noteId))
        .find(row => row.agentId === plugin.id && row.state === 'DOING')
      if (running) await page.evaluate(taskId => window.workbench.tasks.stop(taskId), running.taskId)
      return { plugin, status: 'FAIL', details: { reason: 'task-timeout' } }
    }
    const matches = card.outputDraft.split(/\r?\n/).some(line => line.trim() === answer)
    const associated = await page.evaluate(({ taskId, sourceId }) =>
      window.__s9FieldWaves.some(w => w.runId === taskId && w.activatedNoteIds.includes(sourceId)),
    { taskId: card.taskId, sourceId: seeded.sourceId })
    const status = card.state === 'PENDING' && matches && associated ? 'PASS' : 'FAIL'
    return { plugin, card, status, details: {
      state: card.state, exactDerivedAnswer: matches, activatedSource: associated,
      durationMs: card.durationMs, multilineReceipt: card.outputDraft.trim().split(/\r?\n/).length > 1,
      diagnostic: status === 'PASS' ? undefined : safeDiagnostic(card),
    } }
  }))
  for (const entry of settled) {
    record(entry.plugin.id, entry.status, entry.details)
  }
  for (const entry of settled.filter(row => row.status === 'PASS')) {
    try {
      await editor.locator('[data-task-panel][data-task-id="' + entry.card.taskId + '"] [data-task-pill=adopt]').click()
      const adopted = await poll(async () => (await page.evaluate(id => window.workbench.tasks.listByNote(id), seeded.noteId))
        .find(card => card.taskId === entry.card.taskId && card.state === 'DONE'), entry.plugin.id + ' adoption')
      const markdown = await page.evaluate(async id => (await window.workbench.notes.read(id)).content, seeded.noteId)
      assert.ok(markdown.includes('DONE #' + adopted.taskId) && markdown.includes('> ' + answer))
      record(entry.plugin.id + ' adoption', 'PASS', { markdownAndSqlite: true })
    } catch (err) {
      const drawer = page.locator('.note-drawer')
      const alerts = await drawer.locator('[role=alert], .editor-error').allTextContents()
      const diskFull = alerts.some(msg => /database or disk is full|磁盘空间/i.test(msg))
      record(entry.plugin.id + ' adoption', 'FAIL', { diskFull, reason: String(err).split('\n')[0] })
    }
  }
}
async function picker() {
  const fixtureDir = join(run, '中文 路径验收')
  await mkdir(fixtureDir)
  const fixture = join(fixtureDir, '测试 程序.exe')
  await copyFile(join(process.env.SystemRoot, 'System32', 'where.exe'), fixture)
  const center = page.getByRole('dialog', { name: '使用 / Agent' })
  await page.getByRole('button', { name: /^Agent 设置/ }).click()
  const row = center.locator('[data-plugin-id="codex"]')
  await row.getByRole('button', { name: /详情/ }).click()
  const browse = row.getByRole('button', { name: '浏览本机程序…' })
  const currentPath = () => page.evaluate(async () =>
    (await window.workbench.agentPlugins.list()).installed.find(plugin => plugin.id === 'codex')?.customExecutable)
  await browse.waitFor()
  console.log('PICKER_FIXTURE', JSON.stringify(fixture))
  console.log('PICKER_UI_READY')
  await poll(() => currentPath().then(value => value === fixture), 'Chinese native path selection', 900_000)
  await row.getByText(fixture, { exact: true }).waitFor()
  await page.screenshot({ path: join(evidence, 'picker-backfill.png') })
  record('native file picker Chinese path', 'PASS', { pathExactlyMatched: true, unicodeDirectory: true, unicodeFilename: true, spaces: true })

}
try {
  if (mode === 'first-run') {
    const destination = join(run, '安装目录 中文')
    const args = '/S /D=' + destination
    assert.equal(await access(agentSettings).then(() => true, () => false), false)
    assert.equal(await access(profile).then(() => true, () => false), false)
    // NSIS requires the raw /D parameter to be last, with no quotes.
    await new Promise((resolve, reject) => execFile(exe, [args], {
      windowsVerbatimArguments: true, windowsHide: true, timeout: 180_000,
    }, error => error ? reject(error) : resolve()))
    exe = join(destination, 'plate-workbench.exe')
    await access(exe)
    record('NSIS install on existing Windows host', 'PASS', { customUnicodeInstallDir: true, exe: basename(exe) })
  } else if (mode === 'picker') {
    const standalone = join(run, 'Plate-S9-Native-Field.exe')
    await copyFile(exe, standalone)
    exe = standalone
  }
  await launch()
  const info = await page.evaluate(() => window.workbench.getAppInfo())
  result.version = info.version
  if (mode === 'agents') await agents()
  if (mode === 'picker') await picker()
  if (mode === 'first-run') {
    const state = await page.evaluate(async () => ({
      status: await window.workbench.brain.status(),
      notes: (await window.workbench.notes.list()).length,
      plugins: (await window.workbench.agentPlugins.list(true)).installed.map(p => ({ id: p.id, status: p.status })),
    }))
    assert.equal(state.notes, 0)
    assert.equal(state.status.contextEnabled, false)
    await page.getByRole('button', { name: '大脑', exact: true }).click()
    await page.getByText(/全脑就绪/).waitFor()
    await page.screenshot({ path: join(evidence, 'first-run.png') })
    record('first launch with new workspace, settings and WebView2 profile', 'PASS', state)
  }
  result.status = result.checks.some(x => x.status === 'FAIL') ? 'FAIL' :
    result.checks.some(x => x.status === 'BLOCKED') ? 'PARTIAL' : 'PASS'
} catch (error) {
  result.status = 'FAIL'
  result.error = String(error).split('\n').slice(0, 12).join('\n')
  if (page) await page.screenshot({ path: join(evidence, 'failure.png'), timeout: 2_500 }).catch(() => {})
  console.log('FAIL', result.error)
  process.exitCode = 1
} finally {
  await writeFile(join(evidence, 'results.json'), JSON.stringify(result, null, 2))
  await shutdown()
}
