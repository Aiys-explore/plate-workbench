import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { chromium } from 'playwright'

const source = resolve(import.meta.dirname, '..')
const exe = resolve(process.argv[2] ?? join(source, 'src-tauri', 'target', 'debug', 'plate-workbench.exe'))
const temp = await realpath(tmpdir())
const sandbox = await mkdtemp(join(temp, 'plate-s10-m1-'))
const workspace = join(sandbox, 'workspace')
const key = 'plate-fixture-' + randomUUID()
await mkdir(join(workspace, 'projects'), { recursive: true })
await writeFile(join(workspace, 'plate-workbench.json'), '{"version":"0.5.0-s9.6"}')

let probePassed = false
const api = createServer((request, response) => {
  probePassed = request.url === '/v1/models' && request.headers.authorization === 'Bearer ' + key
  response.writeHead(probePassed ? 200 : 401, { 'content-type': 'application/json' }).end('{"data":[]}')
})
async function listen(server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server.address().port
}

const apiPort = await listen(api)
async function untilReady(address, process, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    assert.equal(process.exitCode, null, 'process exited before ' + address)
    if (await fetch(address).then(res => res.ok, () => false)) return
    await delay(90)
  }
  throw new Error('Timed out waiting for ' + address)
}

let vite, app, browser, page, id
const errors = []
async function stopApp() {
  if (app && app.exitCode === null && !app.signalCode) {
    const exit = once(app, 'exit')
    void page?.evaluate(() => window.workbench.startup.exit()).catch(() => {})
    if (!await Promise.race([exit.then(() => true), delay(3000, false)])) {
      app.kill()
      await exit
    }
  }
  await browser?.close()
  app = browser = page = undefined
}

async function startApp() {
  const server = createServer()
  const port = await listen(server)
  await new Promise(done => server.close(done))
  const address = 'http://127.0.0.1:' + port
  app = spawn(exe, [], {
    windowsHide: true, cwd: sandbox, stdio: 'inherit',
    env: { ...process.env, PLATE_WORKSPACE_ROOT: workspace,
      PLATE_AGENT_SETTINGS_DIR: join(sandbox, 'agent-settings'),
      WEBVIEW2_USER_DATA_FOLDER: join(sandbox, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  })
  await untilReady(address + '/json/version', app)
  browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.setDefaultTimeout(8000)
  await page.getByRole('navigation', { name: '主导航' }).waitFor()
  assert.equal(await page.evaluate(async () => (await window.workbench.startup.state()).path), workspace)
}

let passed = false
try {
  vite = spawn(process.execPath, [join(source, 'node_modules', 'vite', 'bin', 'vite.js'), '--strictPort'], {
    cwd: source, windowsHide: true, stdio: 'inherit',
  })
  await untilReady('http://127.0.0.1:5173', vite)
  await startApp()
  const settings = () => page.getByRole('navigation').getByRole('button', { name: '模型与权限' })
  await settings().click()
  await page.getByLabel('类型').selectOption('openai_compatible')
  await page.getByLabel('名称', { exact: true }).fill('S10 测试服务')
  await page.getByLabel('服务地址').fill('http://127.0.0.1:' + apiPort + '/v1')
  await page.getByLabel('默认模型').fill('fixture-model')
  await page.getByLabel('API Key', { exact: true }).fill(key)
  await page.getByRole('button', { name: '保存服务商' }).click()
  await page.getByText('服务商已保存', { exact: true }).waitFor()
  const [provider] = await page.evaluate(() => window.workbench.providers.list())
  id = provider.id
  assert.equal(provider.keyHint, '…' + key.slice(-4))
  await page.getByRole('button', { name: '测试已保存配置' }).click()
  await page.getByText('已连通保存的模型服务', { exact: true }).waitFor()
  assert.ok(probePassed)
  await page.getByRole('navigation').getByRole('button', { name: '大脑视图' }).click()
  await page.locator('[data-brain-open="true"]').waitFor()
  await page.getByRole('navigation').getByRole('button', { name: '资料与记录' }).click()
  await page.locator('[data-brain-open="false"]').waitFor()

  await stopApp()
  const dbPath = join(workspace, 'index.sqlite')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    assert.equal(db.prepare('SELECT key_hint FROM llm_providers').get().key_hint, provider.keyHint)
    assert.equal(db.prepare("SELECT count(*) FROM sqlite_master WHERE name='external_agent_messages_fts'").get()['count(*)'], 1)
  } finally { db.close() }
  assert.equal((await readFile(dbPath)).includes(Buffer.from(key)), false)

  await startApp()
  await settings().click()
  await page.getByRole('button', { name: /S10 测试服务/ }).click()
  await page.getByText('已保存 ' + provider.keyHint + '。留空沿用。').waitFor()
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
  await page.getByLabel('默认模型').fill('fixture-edited')
  await page.getByRole('button', { name: '保存服务商' }).click()
  await page.getByText('服务商已保存', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.workbench.providers.list()))[0].defaultModel, 'fixture-edited')
  await page.getByRole('button', { name: '删除服务商' }).click()
  await page.getByRole('button', { name: '确认删除' }).click()
  await page.getByText('服务商已删除', { exact: true }).waitFor()
  id = undefined
  assert.deepEqual(errors, [])
  passed = true
  console.log('PASS S10 M1: Windows WebView, provider CRUD and restart, masked credential, localhost authentication, Brain and Library navigation, empty console errors.')
} finally {
  if (id && page && !page.isClosed()) await page.evaluate(id => window.workbench.providers.remove(id), id).catch(() => {})
  await stopApp()
  if (vite?.exitCode === null) {
    const exit = once(vite, 'exit')
    vite.kill()
    await exit
  }
  api.close()
  if (passed && dirname(sandbox) === temp && basename(sandbox).startsWith('plate-s10-m1-')) {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 })
  } else {
    console.error('Smoke fixture:', sandbox)
  }
}
