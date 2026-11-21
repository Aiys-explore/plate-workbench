import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const source = resolve(import.meta.dirname, '..')
const temp = await realpath(tmpdir())
const sandbox = await mkdtemp(join(temp, 'plate-s10-m3-'))
const workspace = join(sandbox, 'workspace')
const granted = join(sandbox, 'authorized')
const target = join(granted, 'change.txt')
const denied = join(sandbox, 'private-sample.txt')
const cli = join(sandbox, 'fixture.exe')
const cliSource = join(sandbox, 'fixture.rs')
const key = 'plate-test-' + randomUUID()
const initial = 'before\n'
const apiOutput = 'after API review\n'
const cliOutput = 'after CLI review\n'

await mkdir(join(workspace, 'projects'), { recursive: true })
await mkdir(granted)
await writeFile(join(workspace, 'plate-workbench.json'), '{"version":"0.5.0-s9.6"}')
await writeFile(target, initial)
await writeFile(denied, 'synthetic private marker\n')
await writeFile(cliSource, [
  'use std::io::{Read,Write};',
  'fn main() {',
  'if std::env::args().any(|arg| arg=="--version") { println!("codex fixture 1.0"); return; }',
  'let mut prompt=String::new(); std::io::stdin().read_to_string(&mut prompt).unwrap();',
  'assert!(prompt.contains("fixture task"));',
  'assert!(std::fs::read_to_string(' + JSON.stringify(denied) + ').is_err(),"isolated CLI read outside container");',
  'assert!(std::fs::write(' + JSON.stringify(target) + ', "forbidden").is_err(),"isolated CLI wrote to user dir");',
  'assert!(std::process::Command::new("cmd.exe").args(["/C","exit","0"]).status().is_err(),"unexpected child launch");',
  'println!("sandbox output 1"); std::io::stdout().flush().unwrap();',
  'std::thread::sleep(std::time::Duration::from_millis(350));',
  'println!("sandbox output 2");',
  'println!("{}", ' + JSON.stringify('<plate-diffs>' + JSON.stringify([{ path: target, content: cliOutput,
    rationale: 'synthetic CLI request' }]) + '</plate-diffs>') + ');',
  '}',
].join('\n'))
const compiler = spawn('rustc.exe', [cliSource, '-o', cli], { cwd: sandbox, windowsHide: true, stdio: 'inherit' })
assert.equal((await once(compiler, 'exit'))[0], 0)

const send = (res, data) => res.write('data: ' + JSON.stringify(data) + '\r\n\r\n')
let calls = 0, verifiedTools = false
const backend = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + key || request.url !== '/v1/chat/completions') {
    response.writeHead(401).end()
    return
  }
  let raw = ''
  for await (const buffer of request) raw += buffer
  const input = JSON.parse(raw)
  calls++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (calls === 1) {
    send(response, { choices: [{ delta: { content: '正在准备提议。' } }] })
    await delay(300)
    const checks = [{ name: 'read_workspace_file', args: { path: denied } },
      { name: 'propose_file_write', args: { path: target, content: apiOutput, rationale: '合成验收' } }]
    for (const [index, item] of checks.entries()) {
      const args = JSON.stringify(item.args)
      send(response, { choices: [{ delta: { tool_calls: [{ index, id: 'call-' + index,
        function: { name: item.name, arguments: args.slice(0, 5) } }] } }] })
      send(response, { choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(5) } }] } }] })
    }
    send(response, { choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 35, completion_tokens: 21 } })
  } else {
    const tools = input.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
    verifiedTools = Boolean(tools[0]?.error && tools[1]?.diffId && await readFile(target, 'utf8') === initial)
    send(response, { choices: [{ delta: { content: '等待审阅。' } }] })
    send(response, { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 45, completion_tokens: 8 } })
  }
  response.end('data: [DONE]\r\n\r\n')
})

async function listen(socket) {
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  return socket.address().port
}
const apiPort = await listen(backend)
const debugSocket = createServer()
const debugPort = await listen(debugSocket)
await new Promise(done => debugSocket.close(done))
const address = 'http://127.0.0.1:' + debugPort
async function awaitHttp(url, child) {
  for (let index = 0; index < 200; index++) {
    assert.equal(child.exitCode, null, 'child exited before ' + url)
    if (await fetch(url).then(result => result.ok, () => false)) return
    await delay(100)
  }
  throw new Error('Timeout: ' + url)
}

let server, app, browser, page, providerId, passed = false
const errors = []
try {
  server = spawn(process.execPath, [join(source, 'node_modules', 'vite', 'bin', 'vite.js'), '--strictPort'], {
    cwd: source, stdio: 'inherit', windowsHide: true,
  })
  await awaitHttp('http://127.0.0.1:5173', server)
  app = spawn(resolve(process.argv[2] ?? join(source, 'src-tauri', 'target', 'debug', 'plate-workbench.exe')), [], {
    cwd: sandbox, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PLATE_WORKSPACE_ROOT: workspace,
      PLATE_AGENT_SETTINGS_DIR: join(sandbox, 'agent-settings'), PLATE_AGENT_CODEX: cli,
      WEBVIEW2_USER_DATA_FOLDER: join(sandbox, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort },
  })
  await awaitHttp(address + '/json/version', app)
  browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.setDefaultTimeout(12_000)
  const nav = page.getByRole('navigation', { name: '主导航' })
  await nav.waitFor()
  providerId = await page.evaluate(async ({ baseUrl, apiKey }) => {
    const service = await window.workbench.providers.upsert({
      name: 'M3 SSE Fixture', kind: 'openai_compatible', baseUrl,
      defaultModel: 'fixture-model', roles: ['workbench_chat'],
      inputPricePer1m: 1, outputPricePer1m: 2, enabled: true, apiKey,
    })
    return service.id
  }, { baseUrl: 'http://127.0.0.1:' + apiPort + '/v1', apiKey: key })
  await page.evaluate(async () => { await window.workbench.agentPlugins.install('codex') })
  await nav.getByRole('button', { name: '资料与记录' }).click()
  await nav.getByRole('button', { name: /工作台/ }).click()

  await page.getByRole('button', { name: '模型与引擎' }).click()
  await page.getByLabel('任务标题').fill('API 打开与暂存')
  await page.getByLabel('任务内容').fill('Create a staged change in the approved directory.')
  await page.getByRole('button', { name: '任务权限' }).click()
  await page.getByLabel(/授权文件目录/).fill(granted)
  await page.getByLabel('允许连接所选模型服务并提交任务上下文').check()
  await page.getByRole('button', { name: '开始任务' }).click()
  await page.getByLabel('Agent 输出').getByText(/正在准备提议/).waitFor()
  const diff = page.getByRole('complementary', { name: '暂存审阅' })
  await page.getByRole('button', { name: '暂存审阅' }).click()
  await diff.getByText(/change.txt.*待审阅/).waitFor()
  await diff.getByText(/after API review/).waitFor()
  assert.ok(verifiedTools)
  assert.equal(await readFile(target, 'utf8'), initial)
  await diff.getByRole('button', { name: '审阅并应用' }).click()
  await diff.getByText(/change.txt.*已应用/).waitFor()
  assert.equal(await readFile(target, 'utf8'), apiOutput)
  console.log('PASS S10 M3 API SSE, denied read, pending diff, and explicit approval.')

  const native = await page.evaluate(async ({ granted }) => {
    const id = await window.workbench.harness.start({
      title: 'CLI AppContainer', prompt: 'fixture task', backendKind: 'local_cli', backendId: 'codex',
      attachedLogSessionIds: [], permissions: {
        writableDirs: [granted], allowShell: false, allowNetwork: false, maxSteps: 4,
      },
    })
    for (let attempt = 0; attempt < 125; attempt++) {
      const events = await window.workbench.harness.events(id)
      const terminal = events.find(event => event.kind === 'run_status_changed' && event.status !== 'running')
      if (terminal) return { id, events, terminal }
      await new Promise(done => setTimeout(done, 80))
    }
    return { id, events: await window.workbench.harness.events(id), terminal: null }
  }, { granted })
  assert.equal(native.terminal?.status, 'review_ready', JSON.stringify(native.events))
  assert.match(native.events.filter(event => event.kind === 'token_delta').map(event => event.delta).join(''), /sandbox output 1.*sandbox output 2/s)
  assert.equal(await readFile(target, 'utf8'), apiOutput)
  const [proposal] = await page.evaluate(id => window.workbench.harness.diffs(id), native.id)
  assert.equal(proposal.status, 'pending')
  await writeFile(target, 'external edit\n')
  await assert.rejects(page.evaluate(id => window.workbench.harness.resolve(id, true), proposal.id), /目标在暂存后已变化/)
  assert.equal(await readFile(target, 'utf8'), 'external edit\n')
  await writeFile(target, apiOutput)
  await page.evaluate(id => window.workbench.harness.resolve(id, true), proposal.id)
  assert.equal(await readFile(target, 'utf8'), cliOutput)
  assert.equal(await readFile(denied, 'utf8'), 'synthetic private marker\n')
  assert.deepEqual(errors, [])
  passed = true
  console.log('PASS S10 M3 private read, direct write and child process denied inside native isolated CLI; staged write applied only after review.')
} finally {
  if (providerId && page && !page.isClosed()) await page.evaluate(id => window.workbench.providers.remove(id), providerId).catch(() => {})
  if (app?.exitCode === null) {
    const exit = once(app, 'exit')
    void page?.evaluate(() => window.workbench.startup.exit()).catch(() => {})
    if (!await Promise.race([exit.then(() => true), delay(3000, false)])) { app.kill(); await exit }
  }
  await browser?.close()
  if (server?.exitCode === null) {
    const exit = once(server, 'exit')
    server.kill()
    await exit
  }
  backend.close()
  if (passed && dirname(sandbox) === temp && basename(sandbox).startsWith('plate-s10-m3-')) {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 })
  } else { console.error('Smoke fixture:', sandbox) }
}
