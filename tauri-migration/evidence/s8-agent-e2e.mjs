import assert from 'node:assert/strict'
import { once } from 'node:events'
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const require = createRequire(new URL('../source/package.json', import.meta.url))
const { chromium } = require('playwright')
const exe = resolve(process.argv[2])
const run = await mkdtemp(join(tmpdir(), 'plate-s8-agent-'))
const evidence = resolve(process.argv[3] ?? run)
const workspace = join(run, 'workspace')
const settings = join(run, 'agent-settings')
const profile = join(run, 'webview')
const codexHome = join(run, 'codex-home')
const dshApp = join(run, 'DeepSeek Harness')
const dshBin = join(dshApp, 'resources', 'runtime', 'cli', 'bin')
for (const path of [evidence, workspace, settings, profile, codexHome, dshBin]) {
  await mkdir(path, { recursive: true })
}
await copyFile(join(process.env.SystemRoot, 'System32', 'where.exe'), join(dshApp, 'DeepSeek Harness.exe'))

const results = { executable: exe, isolatedWorkspace: workspace, checks: [] }
const record = (name, evidence = true) => {
  results.checks.push({ name, evidence })
  console.log('PASS', name, JSON.stringify(evidence))
}
const store = join(run, 'invocations.jsonl')
const fixture = join(run, 'fixture.cjs')
const fakeKey = 's8-isolated-synthetic-value'
await writeFile(fixture, `
const [kind, ...argv] = process.argv.slice(2)
if (argv[0] === '--version') { console.log(kind + ' 1.25.3'); process.exit(0) }
process.stdin.setEncoding('utf8')
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  require('node:fs').appendFileSync(${JSON.stringify(store)}, JSON.stringify({
    kind, argv, input, baseUrl: process.env.DEEPSEEK_BASE_URL,
    fakeKeyReceived: process.env.DEEPSEEK_API_KEY === ${JSON.stringify(fakeKey)},
  }) + '\\n')
  console.log('S8 isolated result ' + kind)
  if (kind === 'dsh') console.error(process.env.DEEPSEEK_API_KEY)
})
`)
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(PLATE_AGENT_|DEEPSEEK_|DSH_|CODEX_HOME$)/i.test(name)))
Object.assign(env, {
  CODEX_HOME: codexHome,
  PLATE_AGENT_SETTINGS_DIR: settings, PLATE_WORKSPACE_ROOT: workspace, WEBVIEW2_USER_DATA_FOLDER: profile,
})
for (const kind of ['codex', 'claude', 'dsh', 'gemini', 'zcode', 'minimax-code', 'custom', 'opencode']) {
  const shim = join(kind === 'dsh' ? dshBin : run, kind + '.cmd')
  await writeFile(shim, `@echo off\r\n"${process.execPath}" "${fixture}" ${kind} %*\r\n`)
  env['PLATE_AGENT_' + kind.toUpperCase()] = shim
}
await writeFile(join(settings, 'agent-settings.json'), JSON.stringify({ defaultAgent: 'claude' }))
await writeFile(join(codexHome, 'models_cache.json'), JSON.stringify({ models: [
  { slug: 'gpt-6.2-sol' }, { slug: 'gpt-fixture-local', api_key: fakeKey },
] }))

let child
let browser
let page
const active = () => page.evaluate(() => window.workbench.agentPlugins.active())
const snapshot = () => page.evaluate(() => window.workbench.agentPlugins.list())

async function until(fn, title, timeout = 10000) {
  const limit = Date.now() + timeout
  do {
    const value = await fn()
    if (value) return value
    await sleep(75)
  } while (Date.now() < limit)
  throw new Error('Timed out: ' + title)
}

async function open() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(accept => server.close(accept))
  const endpoint = 'http://127.0.0.1:' + port
  child = spawn(exe, [], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], cwd: run,
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  })
  let diagnostics = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-3000) })
  await until(() => {
    if (child.exitCode !== null) throw new Error('Plate exited before CDP: ' + child.exitCode + ' ' + diagnostics)
    return fetch(endpoint + '/json/version').then(response => response.ok, () => false)
  }, 'isolated WebView startup', 18000)
  browser = await chromium.connectOverCDP(endpoint)
  page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(6000)
  await page.waitForFunction(() => !!window.workbench)
  const state = await page.evaluate(() => window.workbench.startup.state())
  assert.equal(state.path ?? state.suggested, workspace, 'isolate note writes')
  const enter = page.getByRole('button', { name: '打开笔记', exact: true })
  if (await enter.isVisible()) await enter.click()
  await page.getByRole('region', { name: '笔记关系图' }).waitFor()
}

async function close() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit').then(() => true)
  if (page) void page.evaluate(() => window.workbench.startup.exit()).catch(() => {})
  if (!await Promise.race([exited, sleep(3000, false)])) {
    child.kill()
    await exited
  }
  await browser?.close()
}

const center = () => page.getByRole('dialog', { name: '使用 / Agent' })
const row = id => center().locator('[data-plugin-id=' + JSON.stringify(id) + ']')
const catalog = id => center().locator('[data-catalog-id=' + JSON.stringify(id) + ']')
const drawer = () => page.getByRole('complementary', { name: '笔记编辑抽屉' }).or(page.locator('[aria-label="笔记编辑抽屉"]'))
const editor = () => drawer().locator('[data-editor-host=render]')

async function openCenter() {
  await page.getByRole('button', { name: /^Agent 设置/ }).first().click()
  await center().waitFor()
  await row('codex').waitFor()
  await until(() => center().getByRole('button', { name: '刷新探测' }).isEnabled(), 'probe settled')
}

async function showCatalog() {
  const control = center().getByRole('button', { name: /安装其他 Agent/ })
  if (await control.getAttribute('aria-expanded') === 'false') await control.click()
}

async function note(title, body) {
  const item = await page.evaluate(async ({ title, body }) => {
    const target = await window.workbench.notes.create(title, 'default', 'blank')
    const saved = await window.workbench.notes.update(target.id, '# ' + title + '\n\n' + body + '\n', target.revision)
    if (saved.status !== 'saved') throw new Error(saved.status)
    return saved.note
  }, { title, body })
  const node = page.locator('[data-graph-node=' + JSON.stringify(item.id) + ']')
  await node.waitFor()
  await node.dispatchEvent('dblclick', { detail: 2 })
  const continueSaving = page.getByRole('button', { name: '保存并继续', exact: true })
  await drawer().getByRole('textbox', { name: '笔记标题', exact: true }).or(continueSaving).first().waitFor()
  if (await continueSaving.isVisible()) await continueSaving.click()
  await editor().waitFor()
  await until(async () => drawer().locator('[data-editor-meta-title]').inputValue().then(value => value === title), 'note loaded: ' + title)
  return item
}

async function history() {
  const bytes = await readFile(store, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return ''
  })
  return bytes.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function runCard(item) {
  return until(async () => (await page.evaluate(id => window.workbench.tasks.listByNote(id), item.id))
    .find(card => ['PENDING', 'ERROR'].includes(card.state)), 'task result')
}

try {
  await open()
  assert.equal((await snapshot()).defaultAgent, 'claude', 'legacy default migrates to priority')
  await openCenter()
  assert.match(await row('codex').innerText(), /CLI 1\.25\.3/)
  assert.match(await row('codex').innerText(), /已接入/)
  assert.equal(await row('codex').getByRole('combobox').locator('option[value="gpt-fixture-local"]').count(), 1)
  assert.equal(await row('codex').locator('svg').count() > 0, true)
  assert.match(await row('dsh').innerText(), /待配置.*缺少 DeepSeek API Key/s)
  assert.match(await row('dsh').innerText(), /App \d+\.\d+\.\d+\.\d+/)
  await showCatalog()
  assert.match(await catalog('gemini').innerText(), /本机已检测到 CLI/)
  assert.ok(!(await active()).some(agent => agent.id === 'gemini'))
  await page.screenshot({ path: join(evidence, 'agent-center-light.png') })
  record('AC-M1 rows, detected CLI version, local model metadata, presence distinct from installation')

  const claude = row('claude').getByRole('switch')
  await claude.click()
  await until(async () => !(await active()).some(agent => agent.id === 'claude'), 'Claude disabled')
  await center().getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 设置 · ' + (await active()).length, exact: true }).waitFor()
  const blocked = await note('停用拦截样本', '- [ ] TODO(@claude): 不应发送')
  await editor().locator('[data-task-pill=todo]').click()
  await drawer().getByText(/该 Agent 插件未启用/).waitFor()
  assert.equal((await page.evaluate(id => window.workbench.notes.read(id), blocked.id)).content, blocked.content)
  assert.deepEqual(await page.evaluate(id => window.workbench.tasks.listByNote(id), blocked.id), [])
  const directBlock = await page.evaluate(async id => {
    try {
      await window.workbench.tasks.start({ taskId: 't-fixture01', noteId: id, promptText: '禁止', agentSelector: 'claude' })
      return false
    } catch (error) { return String(error) }
  }, blocked.id)
  assert.match(directBlock, /该 Agent 插件未启用/)
  const unready = await page.evaluate(async id => {
    try {
      await window.workbench.tasks.start({ taskId: 't-unready', noteId: id, promptText: '禁止', agentSelector: 'dsh' })
      return false
    } catch (error) { return String(error) }
  }, blocked.id)
  assert.match(unready, /缺少 DeepSeek API Key/)
  assert.deepEqual(await page.evaluate(id => window.workbench.tasks.listByNote(id), blocked.id), [])
  await editor().locator('[data-task-pill=agent]').click()
  const choices = page.getByRole('dialog', { name: /交给哪个 Agent/ })
  await choices.getByRole('button', { name: /Codex/ }).waitFor()
  assert.equal(await choices.getByRole('button', { name: /Claude/ }).count(), 0)
  await choices.getByRole('button', { name: '关闭', exact: true }).click()
  await note('补全样本', 'x')
  await editor().getByText('x', { exact: true }).evaluate(element => {
    const editor = element.closest('[contenteditable]')
    editor.focus()
    document.getSelection().collapse(element.firstChild, 1)
  })
  await page.keyboard.press('Backspace')
  await page.keyboard.type('tod')
  const autocomplete = page.getByRole('listbox', { name: 'TODO 自动补全' })
  await autocomplete.getByRole('option', { name: /Codex/ }).waitFor()
  assert.equal(await autocomplete.getByRole('option', { name: /Claude/ }).count(), 0)
  await page.keyboard.press('Escape')
  await drawer().getByRole('button', { name: '保存', exact: true }).click()
  assert.deepEqual(await history(), [])
  record('AC-M2 disabled CLI absent from autocomplete and picker, marker preserved, backend rejected')

  await openCenter()
  await row('claude').getByRole('button', { name: /详情/ }).click()
  await row('claude').getByRole('button', { name: '卸载插件' }).click()
  await center().getByRole('button', { name: '确认卸载' }).click()
  await row('claude').waitFor({ state: 'detached' })
  await showCatalog()
  assert.match(await catalog('claude').innerText(), /本机已检测到 CLI/)
  await catalog('claude').getByRole('button', { name: '安装插件' }).click()
  await until(async () => (await active()).some(agent => agent.id === 'claude'), 'Claude reinstalled')
  await until(async () => (await row('claude').innerText()).includes('1.25.3'), 'installation probe version')
  assert.equal(await row('claude').getByRole('switch').getAttribute('aria-checked'), 'true')
  await row('codex').getByRole('combobox').selectOption('gpt-6.2-sol')
  await until(async () => (await active()).some(agent => agent.id === 'codex' && agent.model === 'gpt-6.2-sol'), 'model committed')

  await row('dsh').getByRole('button', { name: /详情/ }).click()
  await row('dsh').getByLabel('DeepSeek API Key').fill(fakeKey)
  await row('dsh').getByLabel('Base URL').fill('http://127.0.0.1:9578/v1')
  await row('dsh').getByRole('button', { name: '保存连接设置' }).click()
  await until(async () => (await snapshot()).installed.find(item => item.id === 'dsh')?.deepseekKey === 'saved', 'encrypted key reference')
  assert.equal(await row('dsh').getByLabel('DeepSeek API Key').inputValue(), '')
  assert.ok(!(await readFile(join(settings, 'agent-settings.json'), 'utf8')).includes(fakeKey))
  await row('dsh').getByRole('button', { name: /收起/ }).click()
  await until(() => center().getByRole('button', { name: '刷新探测' }).isEnabled(), 'settings saved')
  record('AC-M3 uninstall and reinstall, live activation, DeepSeek key protected and UI cleared')

  const installed = (await snapshot()).installed
  if (installed[0].id === 'codex') {
    await row('claude').locator('.plate-agent-grip').dragTo(row('codex').locator('.plate-agent-grip'))
    await until(async () => (await snapshot()).defaultAgent === 'claude', 'drag priority changed')
  }
  await row('codex').locator('.plate-agent-grip').dragTo(center().locator('[data-plugin-id]').first().locator('.plate-agent-grip'))
  await until(async () => (await snapshot()).defaultAgent === 'codex', 'Codex dragged to first')
  await center().getByRole('button', { name: '关闭', exact: true }).click()
  const run = await note('模型分派样本', '- [ ] TODO: 隔离任务与模型校验')
  await editor().locator('[data-task-pill=agent]').click()
  await choices.getByRole('button', { name: /Codex.*gpt-6\.2-sol/ }).waitFor()
  await choices.getByRole('button', { name: /Claude Code/ }).waitFor()
  await choices.getByRole('button', { name: '关闭', exact: true }).click()
  await editor().locator('[data-task-pill=todo]').click()
  const card = await runCard(run)
  assert.equal(card.state, 'PENDING', JSON.stringify(card.errorMsg))
  assert.equal(card.agentId, 'codex')
  const invocation = (await history()).at(-1)
  assert.deepEqual(invocation.argv, ['exec', '--skip-git-repo-check', '-m', 'gpt-6.2-sol', '-'])
  assert.equal(invocation.input, '隔离任务与模型校验')
  record('AC-M4 drag default and Codex subprocess argv / stdin', invocation.argv)

  const dsh = await note('DeepSeek 样本', '- [ ] TODO(@dsh): 合成请求')
  await editor().locator('[data-task-pill=todo]').click()
  const dshCard = await runCard(dsh)
  assert.equal(dshCard.state, 'PENDING')
  const dshInvocation = (await history()).at(-1)
  assert.equal(dshInvocation.fakeKeyReceived, true)
  assert.equal(dshInvocation.baseUrl, 'http://127.0.0.1:9578/v1')
  assert.ok(dshCard.logTail.includes('[已隐藏密钥]') && !dshCard.logTail.includes(fakeKey))
  const manifest = { id: 'custom-fixture', name: '自定义验收', executable: env.PLATE_AGENT_CUSTOM,
    args: ['--plain', '{model}', '--', 'positional'], modelFlag: '--model', models: ['test-model'] }
  assert.equal((await page.evaluate(json => window.workbench.agentPlugins.importManifest(json), JSON.stringify(manifest)))
    .installed.find(item => item.id === manifest.id).enabled, false)
  assert.ok(!(await active()).some(item => item.id === manifest.id))
  await page.evaluate(id => window.workbench.agentPlugins.update({ id, enabled: true, selectedModel: 'test-model' }), manifest.id)
  const custom = await note('自定义样本', '- [ ] TODO(@custom-fixture): 保留输入的 & | %')
  await editor().locator('[data-task-pill=todo]').click()
  assert.equal((await runCard(custom)).state, 'PENDING')
  assert.deepEqual((await history()).at(-1).argv, ['--plain', '--model', 'test-model', '--', 'positional'])
  assert.equal((await history()).at(-1).input, '保留输入的 & | %')
  record('DeepSeek URL/secret and explicitly enabled custom manifest use isolated stdin')

  await page.getByRole('button', { name: '切换至深色主题' }).click()
  await openCenter()
  for (const id of ['gemini', 'zcode', 'minimax-code']) {
    await page.evaluate(id => window.workbench.agentPlugins.install(id), id)
  }
  const showMore = center().getByRole('button', { name: /显示其余 2 个/ })
  await showMore.waitFor()
  await showMore.click()
  assert.equal(await center().locator('[data-plugin-id]').count(), 7)
  assert.ok(!(await active()).some(item => item.id === 'gemini'))
  await center().getByRole('button', { name: '管理', exact: true }).click()
  assert.equal(await center().getByRole('checkbox').count(), 7)
  await center().getByRole('button', { name: '管理', exact: true }).click()
  record('Installed-row expansion and batch management keep unconfigured catalog entries out of dispatch')
  await page.screenshot({ path: join(evidence, 'agent-center-dark.png') })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 620, height: 700, deviceScaleFactor: 1, mobile: false,
  })
  const sizes = await center().evaluate(dialog => ({
    viewport: innerWidth, width: dialog.getBoundingClientRect().width,
    scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
  }))
  assert.ok(sizes.width < sizes.viewport && sizes.scrollWidth <= sizes.clientWidth + 1, JSON.stringify(sizes))
  await page.screenshot({ path: join(evidence, 'agent-center-narrow.png') })
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.detach()
  record('Light, dark and 620 px layout', sizes)

  await close()
  await open()
  assert.equal((await snapshot()).defaultAgent, 'codex')
  assert.equal((await active()).find(item => item.id === 'codex')?.model, 'gpt-6.2-sol')
  assert.equal((await snapshot()).installed.find(item => item.id === 'dsh')?.deepseekKey, 'saved')
  assert.equal((await history()).length, 3)
  record('Restart retains plugin state and dispatch history without replay')
  await page.evaluate(() => window.workbench.agentPlugins.install('opencode'))
  await page.evaluate(() => window.workbench.agentPlugins.update({ id: 'opencode', enabled: true }))
  const openCode = await note('OpenCode 管道样本', 'stdin 验收')
  const prompt = '第一行 中文\r\n第二行 & | % ! " < > ^ 😀\n'.repeat(500)
  await page.evaluate(({ noteId, promptText }) => window.workbench.tasks.start({
    noteId, taskId: 't-opencode', promptText, agentSelector: 'opencode',
  }), { noteId: openCode.id, promptText: prompt })
  assert.equal((await runCard(openCode)).state, 'PENDING')
  const piped = (await history()).at(-1)
  assert.equal(piped.kind, 'opencode')
  assert.deepEqual(piped.argv, ['run'])
  assert.equal(piped.input, prompt)
  record('OpenCode .cmd preserves exact multiline UTF-8 beyond CMD argv limit', { bytes: Buffer.byteLength(prompt) })
  await page.evaluate(() => window.workbench.agentPlugins.saveDeepSeek({ clear: true, baseUrl: '' }))
  const blockedFollow = await page.evaluate(async taskId => {
    try { await window.workbench.tasks.followUp(taskId, '重新执行'); return false }
    catch (error) { return String(error) }
  }, dshCard.taskId)
  assert.match(blockedFollow, /缺少 DeepSeek API Key/)
  assert.equal((await runCard(dsh)).state, 'PENDING')
  assert.equal((await history()).length, 4)
  record('Explicit start and follow-up share readiness checks and preserve the review on rejection')
  results.status = 'PASS'
} catch (error) {
  results.status = 'FAIL'
  results.error = String(error.stack ?? error)
  if (page) await page.screenshot({ path: join(evidence, 'failure.png'), timeout: 2500 }).catch(() => {})
  throw error
} finally {
  await writeFile(join(evidence, 'results.json'), JSON.stringify(results, null, 2))
  await close()
}
