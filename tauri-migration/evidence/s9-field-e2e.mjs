import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { randomBytes } from 'node:crypto'

const { chromium } = createRequire(new URL('../source/package.json', import.meta.url))('playwright')
const [mode, inputExe, output, openCodeEntry] = process.argv.slice(2)
assert.ok(['agents', 'picker', 'first-run', 'opencode'].includes(mode))
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
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PLATE_AGENT_|CODEX_HOME$|WEBVIEW2_|PLATE_WORKSPACE_ROOT$|CODEX_SANDBOX|CODEX_THREAD_ID$|PLATE_S9_FIELD_DEEPSEEK_KEY_FILE$|DEEPSEEK_(API_KEY|BASE_URL)$)/i.test(key)))
Object.assign(env, {
  PLATE_WORKSPACE_ROOT: notes, PLATE_AGENT_SETTINGS_DIR: agentSettings, WEBVIEW2_USER_DATA_FOLDER: profile,
})
const deepseekKeyFile = mode === 'agents' && process.env.PLATE_S9_FIELD_DEEPSEEK_KEY_FILE
if (deepseekKeyFile) env.DSH_HOME = join(run, 'deepseek-harness')
const openCodeModel = 'deepseek/deepseek-flash'
let openCodeKey
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
  const defaultSuggestion = join(process.env.USERPROFILE, 'Documents', 'Plate-Tauri-S9-试用笔记')
  const defaultWorkspaceExists = mode === 'first-run' &&
    await access(join(defaultSuggestion, 'plate-workbench.json')).then(() => true, () => false)
  const testDefaultSuggestion = mode === 'first-run' && !defaultWorkspaceExists
  const expectedSuggestion = testDefaultSuggestion ? defaultSuggestion : notes
  if (testDefaultSuggestion) delete appEnv.PLATE_WORKSPACE_ROOT
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
    record(testDefaultSuggestion ? 'default startup suggestion uses a new S9 workspace'
      : 'first launch uses an isolated workspace with an existing S9 workspace present', 'PASS', {
      defaultSuggestionTested: testDefaultSuggestion, showsChooser: true,
    })
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
async function openCodePreflight() {
  assert.ok(openCodeEntry, 'Specify the absolute path to the npm-generated opencode.cmd')
  assert.equal(basename(openCodeEntry).toLowerCase(), 'opencode.cmd')
  await access(openCodeEntry)
  const keyFile = process.env.PLATE_S9_FIELD_DEEPSEEK_KEY_FILE
  assert.ok(keyFile, 'Set PLATE_S9_FIELD_DEEPSEEK_KEY_FILE')
  openCodeKey = (await readFile(keyFile, 'utf8')).trim()
  assert.ok(openCodeKey && !/\s/.test(openCodeKey), 'Unexpected DeepSeek key file format')

  for (const name of Object.keys(env)) {
    if (/^OPENCODE_/i.test(name)) delete env[name]
  }
  const configDir = join(run, 'opencode-config')
  const probeDir = join(run, 'opencode-probe')
  await mkdir(configDir)
  await mkdir(probeDir)
  Object.assign(env, {
    PLATE_AGENT_OPENCODE: resolve(openCodeEntry),
    XDG_CONFIG_HOME: join(run, 'config'),
    XDG_DATA_HOME: join(run, 'data'),
    XDG_CACHE_HOME: join(run, 'cache'),
    XDG_STATE_HOME: join(run, 'state'),
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG: join(configDir, 'opencode.json'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    DEEPSEEK_API_KEY: openCodeKey,
  })
  await writeFile(env.OPENCODE_CONFIG, JSON.stringify({
    enabled_providers: ['deepseek'],
    autoupdate: false,
    share: 'disabled',
    permission: { '*': 'deny' },
    provider: {
      deepseek: {
        options: { baseURL: 'https://api.deepseek.com/v1' },
        models: { 'deepseek-flash': { name: 'DeepSeek Flash' } },
      },
    },
  }))
  const invoke = (args, input = '') => new Promise((resolve, reject) => {
    const command = `"${env.PLATE_AGENT_OPENCODE}" ${args.join(' ')}`
    const child = execFile(process.env.ComSpec, ['/d', '/s', '/c', `"${command}"`], {
      cwd: probeDir, env, windowsHide: true, windowsVerbatimArguments: true, timeout: 90_000,
    }, (error, stdout, stderr) => {
      if (error?.killed) reject(new Error('OpenCode preflight timed out'))
      else resolve({ code: error?.code ?? 0, stdout, stderr })
    })
    child.on('error', () => reject(new Error('OpenCode could not launch')))
    child.stdin.on('error', () => {})
    child.stdin.end(input, 'utf8')
  })
  const version = await invoke(['--version'])
  const cliVersion = version.stdout.trim().match(/^\d+\.\d+\.\d+(?:[-.][0-9a-z.-]+)?$/i)?.[0]
  assert.ok(version.code === 0 && cliVersion, 'OpenCode version probe failed')
  result.openCode = { cliVersion, entry: basename(openCodeEntry), model: openCodeModel }
  const probe = 'PLATE-OPEN-CODE-' + randomBytes(5).toString('hex')
  const response = await invoke(['run', '--model', openCodeModel, '--format', 'json'],
    '仅原样回复这一行，不要调用工具：' + probe + '\n')
  const events = response.stdout.split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const returned = events.filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('').trim()
  const connected = response.code === 0 && returned === probe && !events.some(event => event.type === 'error')
  record('OpenCode DeepSeek API preflight', connected ? 'PASS' : 'FAIL', {
    ...result.openCode, exactReply: returned === probe,
    diagnostic: connected ? undefined : safeDiagnostic({ logTail: response.stdout + response.stderr }),
  })
  assert.ok(connected, 'OpenCode did not complete the DeepSeek API preflight')
}
async function openCodeTask() {
  const model = openCodeModel
  const plugin = await page.evaluate(async ({ executable, model }) => {
    const api = window.workbench.agentPlugins
    const snapshot = await api.list(true)
    if (!snapshot.installed.some(item => item.id === 'opencode')) await api.install('opencode')
    const updated = await api.update({ id: 'opencode', enabled: true, customExecutable: executable, selectedModel: model })
    const item = updated.installed.find(item => item.id === 'opencode')
    return { status: item?.status, selectedModel: item?.selectedModel, exactExecutable: item?.executable === executable }
  }, { executable: env.PLATE_AGENT_OPENCODE, model })
  assert.deepEqual(plugin, { status: 'connected', selectedModel: model, exactExecutable: true })

  const operands = Array.from(randomBytes(2), (byte, index) => 200 + byte + index * 500)
  const marker = '甲&乙|丙%' + randomBytes(4).toString('hex')
  const lines = [
    '只根据本次标准输入中的关联笔记「合成来源」作答。不读取文件，不调用工具。',
    '第一行写「总和：」后面加两个整数的总和。',
    '第二行写「标记：' + marker + '」，保留 & | % 原样。',
    '第三行写「来源：」后面加提供整数的合成来源笔记 note_id，从 GLOBAL_SOURCE_OF_TRUTH 抄写 UUID。只输出所要求的三行。',
  ]
  const seeded = await page.evaluate(async ({ operands, lines }) => {
    const wb = window.workbench
    const source = await wb.notes.create('合成来源', 'default', 'blank')
    const saved = await wb.notes.update(source.id, source.content +
      '本次验收的两个整数是 ' + operands[0] + ' 和 ' + operands[1] + '。\n', source.revision)
    if (saved.status !== 'saved') throw new Error('Could not save source fixture')
    await wb.brain.setContext(true)
    const note = await wb.notes.create('OpenCode 多行中文现场验收', 'default', 'blank')
    const body = [note.content, '- [[' + source.id + '|合成来源]]',
      '- [ ] TODO(@opencode): ' + lines.join('\n  ')].join('\n\n') + '\n'
    const updated = await wb.notes.update(note.id, body, note.revision)
    if (updated.status !== 'saved') throw new Error('Could not save task fixture')
    window.__s9FieldWaves = []
    wb.brain.onActivation(wave => window.__s9FieldWaves.push(wave))
    return { noteId: note.id, sourceId: source.id }
  }, { operands, lines })
  const expected = ['总和：' + (operands[0] + operands[1]), '标记：' + marker, '来源：' + seeded.sourceId]
  await page.locator('[data-graph-node="' + seeded.noteId + '"]').dispatchEvent('dblclick', { detail: 2 })
  const editor = page.locator('[data-editor-host=render]')
  const dispatch = editor.locator('[data-task-capsule][data-task-agent="opencode"] [data-task-pill=todo]')
  await dispatch.waitFor({ state: 'visible' })
  await dispatch.dispatchEvent('click')
  const task = async () => (await page.evaluate(id => window.workbench.tasks.listByNote(id), seeded.noteId))
    .find(card => card.agentId === 'opencode')
  const card = await poll(async () => {
    const value = await task()
    return ['PENDING', 'ERROR'].includes(value?.state) ? value : null
  }, 'OpenCode task completion', 140_000)
  const actual = card.outputDraft.trim().split(/\r?\n/).map(line => line.trim())
  const activatedSource = await page.evaluate(({ taskId, sourceId }) =>
    window.__s9FieldWaves.some(wave => wave.runId === taskId && wave.activatedNoteIds.includes(sourceId)),
  { taskId: card.taskId, sourceId: seeded.sourceId })
  const promptLines = card.promptText.split(/\r?\n/).map(line => line.trim())
  const details = {
    state: card.state, durationMs: card.durationMs, promptLinesPreserved: promptLines.length === lines.length &&
      lines.every((line, index) => promptLines[index] === line),
    outputLines: actual.length, exactSum: actual[0] === expected[0], exactMarker: actual[1] === expected[1],
    exactSource: actual[2] === expected[2], activatedSource,
  }
  const passed = card.state === 'PENDING' && actual.length === 3 && details.promptLinesPreserved &&
    details.exactSum && details.exactMarker && details.exactSource && activatedSource
  record('S9.2 OpenCode multiline Chinese task', passed ? 'PASS' : 'FAIL', {
    ...details, diagnostic: passed ? undefined : safeDiagnostic(card),
  })
  assert.ok(passed, 'OpenCode task did not produce the expected three-line receipt')
  const panel = editor.locator('[data-task-panel][data-task-id="' + card.taskId + '"]')
  const adopt = panel.locator('[data-task-pill=adopt]')
  await adopt.waitFor({ state: 'visible' })
  await page.screenshot({ path: join(evidence, 'pending.png') })
  await adopt.dispatchEvent('click')
  await poll(async () => (await task())?.state === 'DONE', 'OpenCode receipt adoption')
  const markdown = await page.evaluate(async id => (await window.workbench.notes.read(id)).content, seeded.noteId)
  assert.ok(markdown.includes('DONE #' + card.taskId))
  assert.ok(markdown.replace(/\r\n/g, '\n').includes(expected.map(line => '> ' + line).join('\n')))
  record('S9.2 OpenCode receipt adoption', 'PASS', { state: 'DONE', exactMarkdownReceipt: true, receipt: expected })
  await page.screenshot({ path: join(evidence, 'adopted.png') })
}
async function agents() {
  if (deepseekKeyFile) {
    let saved = false
    try {
      const key = (await readFile(deepseekKeyFile, 'utf8')).trim()
      if (!key || /\s/.test(key)) throw new Error('Unexpected DeepSeek key file format')
      saved = await page.evaluate(async value => {
        try {
          await window.workbench.agentPlugins.saveDeepSeek({ key: value, clear: false, baseUrl: '' })
          return true
        } catch { return false }
      }, key)
    } catch { throw new Error('Unable to load the isolated DeepSeek credential') }
    assert.ok(saved, 'Unable to save the isolated DeepSeek credential')
    await page.evaluate(() => window.workbench.agentPlugins.list(true))
    result.deepseekCredentialConfigured = true
  }
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
      ...ready.map(id => '- [ ] TODO(@' + id + '): 根据关联笔记「合成来源」中的两个整数计算总和。输出一行：S9-FIELD-' +
        nonce + ' <总和> 来源: <提供两个整数的笔记 note_id>。将尖括号占位符替换为实际值，从 GLOBAL_SOURCE_OF_TRUTH 抄写来源 UUID。仅使用本次标准输入，不读取文件，不调用工具，不执行命令。'),
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
    const receipt = card.outputDraft.split(/\r?\n/).map(line => line.trim())
      .find(line => line.startsWith(answer + ' '))
    const citedId = receipt?.slice(answer.length).trim().match(/^来源\s*[:：]\s*([0-9a-f-]{36})$/i)?.[1]
    const exactSourceCitation = citedId?.toLowerCase() === seeded.sourceId.toLowerCase()
    const associated = await page.evaluate(({ taskId, sourceId }) =>
      window.__s9FieldWaves.some(w => w.runId === taskId && w.activatedNoteIds.includes(sourceId)),
    { taskId: card.taskId, sourceId: seeded.sourceId })
    const status = card.state === 'PENDING' && !!receipt && exactSourceCitation && associated ? 'PASS' : 'FAIL'
    return { plugin, card, receipt, status, details: {
      state: card.state, exactDerivedAnswer: !!receipt, exactSourceCitation, activatedSource: associated,
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
      assert.ok(markdown.includes('DONE #' + adopted.taskId))
      assert.ok(markdown.split(/\r?\n/).some(line => line.trim() === '> ' + entry.receipt),
        'Adopted Markdown did not preserve the cited receipt')
      record(entry.plugin.id + ' adoption', 'PASS', { markdownAndSqlite: true, sourceCitationPreserved: true })
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
  if (mode === 'opencode') await openCodePreflight()
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
  if (mode === 'opencode') await openCodeTask()
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
  const diagnostic = String(error).split('\n').slice(0, 12).join('\n')
  result.error = openCodeKey ? diagnostic.replaceAll(openCodeKey, '[redacted]') : diagnostic
  if (page && mode !== 'opencode') await page.screenshot({ path: join(evidence, 'failure.png'), timeout: 2_500 }).catch(() => {})
  console.log('FAIL', result.error)
  process.exitCode = 1
} finally {
  if (result.deepseekCredentialConfigured && page) {
    result.deepseekCredentialCleared = await page.evaluate(async () => {
      await window.workbench.agentPlugins.saveDeepSeek({ clear: true, baseUrl: '' })
      const plugins = await window.workbench.agentPlugins.list()
      return plugins.installed.find(plugin => plugin.id === 'dsh')?.deepseekKey === 'unset'
    }).catch(() => false)
    if (!result.deepseekCredentialCleared) {
      result.status = 'FAIL'
      process.exitCode = 1
    }
  }
  if (mode === 'opencode') delete result.run
  const serialized = JSON.stringify(result, null, 2)
  await writeFile(join(evidence, 'results.json'), openCodeKey ? serialized.replaceAll(openCodeKey, '[redacted]') : serialized)
  await shutdown()
}
