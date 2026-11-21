import assert from 'node:assert/strict'
import { once } from 'node:events'
import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const source = resolve(import.meta.dirname, '..')
const temp = await realpath(tmpdir())
const sandbox = await mkdtemp(join(temp, 'plate-s10-m2-'))
const workspace = join(sandbox, 'workspace')
const sessionDir = join(sandbox, 'codex', 'sessions')
const claudeDir = join(sandbox, 'claude', 'projects', 'sample')
const customDir = join(sandbox, 'custom')
const codex = join(sessionDir, 'rollout-fixture.jsonl')
const encode = item => JSON.stringify(item) + '\n'
const user = '研究本机日志验收'
const answer = 'FTS 识别跨记录验收样本'
const claude = { type: 'user', cwd: workspace, message: { role: 'user', content: 'Claude fixtures' } }

async function awaitHttp(url, child) {
  for (let index = 0; index < 160; index++) {
    assert.equal(child.exitCode, null, 'child exited before ' + url)
    if (await fetch(url).then(result => result.ok, () => false)) return
    await delay(100)
  }
  throw new Error('Timeout: ' + url)
}

const portSocket = createServer().listen(0, '127.0.0.1')
await once(portSocket, 'listening')
const port = portSocket.address().port
await new Promise(done => portSocket.close(done))
const address = 'http://127.0.0.1:' + port
for (const path of [join(workspace, 'projects'), sessionDir, claudeDir, customDir]) {
  await mkdir(path, { recursive: true })
}
await writeFile(join(workspace, 'plate-workbench.json'), '{"version":"0.5.0-s9.6"}')
await writeFile(codex, encode({ type: 'session_meta', payload: { cwd: workspace } })
  + encode({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: user }] } }))
await writeFile(join(claudeDir, 'fixture.jsonl'), encode(claude))
await writeFile(join(customDir, 'fixture.jsonl'), encode({ role: 'user', content: 'Custom fixture' }))

let server, app, browser, page, passed = false
const errors = []
try {
  server = spawn(process.execPath, [join(source, 'node_modules', 'vite', 'bin', 'vite.js'), '--strictPort'], {
    cwd: source, stdio: 'inherit', windowsHide: true,
  })
  await awaitHttp('http://127.0.0.1:5173', server)
  app = spawn(resolve(process.argv[2] ?? join(source, 'src-tauri', 'target', 'debug', 'plate-workbench.exe')), [], {
    cwd: sandbox, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PLATE_WORKSPACE_ROOT: workspace,
      PLATE_AGENT_SETTINGS_DIR: join(sandbox, 'agent-settings'),
      CODEX_HOME: join(sandbox, 'codex'), CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
      WEBVIEW2_USER_DATA_FOLDER: join(sandbox, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port },
  })
  await awaitHttp(address + '/json/version', app)
  browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.setDefaultTimeout(12_000)
  const nav = page.getByRole('navigation', { name: '主导航' })
  const logs = async () => {
    await nav.getByRole('button', { name: '资料与记录' }).click()
    await page.getByRole('button', { name: '本机 Agent 记录' }).click()
  }
  await logs()
  await page.getByLabel('自定义目录').fill(customDir)
  await page.getByRole('button', { name: '扫描记录' }).click()
  await page.getByText('扫描 3 个文件，更新 3 个会话，导入 3 条消息。').waitFor()
  await appendFile(codex, encode({ type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: answer }] } }))
  await page.getByRole('button', { name: '扫描记录' }).click()
  await page.getByText('扫描 3 个文件，更新 1 个会话，导入 1 条消息。').waitFor()
  await page.getByRole('button', { name: '扫描记录' }).click()
  await page.getByText('扫描 3 个文件，更新 0 个会话，导入 0 条消息。').waitFor()
  await page.getByLabel('搜索消息').fill('跨记录')
  await page.getByRole('button', { name: '搜索会话' }).click()
  await page.getByRole('button', { name: /研究本机日志验收/ }).click()
  await page.getByRole('button', { name: /研究本机日志验收/ }).hover()
  await page.locator('.s10-log-messages').getByText(answer, { exact: true }).waitFor()
  await page.getByRole('button', { name: '送入海马体' }).click()
  await page.getByText('会话摘要已送入海马体。').waitFor()
  await nav.getByRole('button', { name: '大脑视图' }).click()
  await page.getByRole('complementary', { name: '海马体 · 短期闪念' }).getByText(/FTS 识别跨记录验收样本/).waitFor()

  await logs()
  await page.getByRole('button', { name: /研究本机日志验收/ }).click()
  await page.getByRole('button', { name: /研究本机日志验收/ }).hover()
  await page.locator('.s10-row').filter({ hasText: user }).getByRole('button', { name: '引用到工作台' }).click()
  await page.getByRole('list', { name: '任务引用' }).getByText(user).waitFor()
  assert.deepEqual(errors, [])
  passed = true
  console.log('PASS S10 M2: Claude Code, Codex CLI, custom JSONL, incremental import, CJK FTS, EpisodicLane and workbench attachment.')
} finally {
  if (app?.exitCode === null) {
    const exit = once(app, 'exit')
    void page?.evaluate(() => window.workbench.startup.exit()).catch(() => {})
    if (!await Promise.race([exit.then(() => true), delay(3000, false)])) {
      app.kill()
      await exit
    }
  }
  await browser?.close()
  if (server?.exitCode === null) {
    const exit = once(server, 'exit')
    server.kill()
    await exit
  }
  if (passed && dirname(sandbox) === temp && basename(sandbox).startsWith('plate-s10-m2-')) {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 })
  } else {
    console.error('Smoke fixture:', sandbox)
  }
}
