import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const [oldExecutable, newInstaller, isolatedDirectory] = process.argv.slice(2).map(arg => resolve(arg))
assert.ok(oldExecutable && newInstaller && isolatedDirectory, 'Pass S9.6 executable, S10 installer, and test directory')
assert.equal(basename(oldExecutable), 'plate-workbench.exe')
assert.equal(basename(newInstaller), 'Plate-S10-0.6.0-s10.0-Setup-x64.exe')
const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const installPath = join(process.env.LOCALAPPDATA, config.productName)
const settingsPath = join(process.env.LOCALAPPDATA, config.identifier)
assert.equal(config.identifier, 'local.plate.workbench.s10-preview')
assert.equal(config.productName, 'Plate Workbench S10 Preview')
const exists = async path => access(path).then(() => true, () => false)
assert.equal(await exists(installPath), false, 'S10 install directory already exists')
assert.equal(await exists(settingsPath), false, 'S10 application profile already exists')
const installExecutable = join(installPath, config.mainBinaryName + '.exe')
const oldRoot = join(isolatedDirectory, 'S9.6 合成旧库')
const compatRoot = join(isolatedDirectory, 'S10 旧库副本_日本語_한글')
const freshRoot = join(isolatedDirectory, 'S10 空白库')
for (const root of [oldRoot, compatRoot, freshRoot]) assert.equal(await exists(root), false)
await mkdir(oldRoot, { recursive: true })
await mkdir(freshRoot)
const output = { version: config.version, checks: [], rechecked: false, setupSha256: '', binarySha256: '' }
const good = (name, evidence = true) => {
  output.checks.push({ name, evidence })
  console.log('PASS', name)
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase()
const hash = async path => sha256(await readFile(path))
const file = root => join(root, 'index.sqlite')
const snapshot = async (root, paths) => await Promise.all(paths.map(name => hash(join(root, name))))
const oldArtifactHash = '8A0471A8927D7EFB39F131CED0E1B6F5846BFBF80BE4C786EB4E4DFA6455361C'
assert.equal(await hash(oldExecutable), oldArtifactHash)
output.setupSha256 = await hash(newInstaller)

function sql(root, query, ...values) {
  const db = new DatabaseSync(file(root), { readOnly: true })
  try { return db.prepare(query).all(...values) }
  finally { db.close() }
}

async function randomPort() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(done => socket.close(done))
  return port
}

const cleanedEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(PLATE_|WEBVIEW2_|CODEX_HOME$|DSH_|DEEPSEEK_)/i.test(key)))
const running = new Set()

async function open(executable, profile, workspace) {
  const port = await randomPort()
  const entry = { child: undefined, browser: undefined, page: undefined, errors: [] }
  running.add(entry)
  const env = { ...cleanedEnvironment, PLATE_AGENT_SETTINGS_DIR: join(isolatedDirectory, profile + '-agents'),
    WEBVIEW2_USER_DATA_FOLDER: join(isolatedDirectory, profile + '-webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port }
  if (workspace) env.PLATE_WORKSPACE_ROOT = workspace
  entry.child = spawn(executable, [], { cwd: dirname(executable), env, windowsHide: true, stdio: 'ignore' })
  const addr = 'http://127.0.0.1:' + port
  const deadline = Date.now() + 20_000
  do {
    assert.equal(entry.child.exitCode, null, 'app quit before WebView was ready')
    const ready = await fetch(addr + '/json/version').then(res => res.ok, () => false)
    if (ready) break
    await delay(80)
  } while (Date.now() < deadline)
  entry.browser = await chromium.connectOverCDP(addr, { timeout: 7000 })
  const context = entry.browser.contexts()[0]
  entry.page = context.pages()[0] ?? await context.waitForEvent('page')
  entry.page.on('pageerror', error => entry.errors.push(error.message))
  entry.page.on('console', message => { if (message.type() === 'error') entry.errors.push(message.text()) })
  entry.page.setDefaultTimeout(8000)
  await entry.page.waitForFunction(() => Boolean(window.workbench?.startup))
  return entry
}

async function close(entry) {
  if (!entry) return
  if (entry.child?.exitCode === null && !entry.child.signalCode) {
    const exit = once(entry.child, 'exit')
    void entry.page?.evaluate(() => window.workbench.startup.exit()).catch(() => {})
    if (!await Promise.race([exit.then(() => true), delay(3000, false)])) {
      entry.child.kill()
      await exit
    }
  }
  await entry.browser?.close()
  running.delete(entry)
}

async function installer(executable) {
  const child = spawn(executable, ['/S'], { cwd: dirname(executable), stdio: 'ignore', windowsHide: true })
  const exit = await Promise.race([once(child, 'exit').then(([code]) => code), delay(120_000, null, { ref: false })])
  assert.equal(exit, 0, 'installer exit code')
}

async function registry() {
  const name = config.productName
  const path = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + name
  return await new Promise((done, reject) => {
    const child = spawn('reg.exe', ['query', path], { windowsHide: true })
    let value = ''
    child.stdout.setEncoding('utf8').on('data', data => { value += data })
    child.on('error', reject)
    child.on('close', code => done({ code, value }))
  })
}

async function readStartup(entry) { return entry.page.evaluate(() => window.workbench.startup.state()) }
let activeOld, activeNew
try {
  const old = await open(oldExecutable, 's9', oldRoot)
  assert.equal((await readStartup(old)).phase, 'choose')
  const seed = await old.page.evaluate(async root => {
    const api = window.workbench
    const started = await api.startup.submit(root)
    const project = await api.notes.createProject('合成验收分区')
    const first = await api.notes.create('S9 合成笔记 Alpha', project.id)
    const second = await api.notes.create('S9 合成笔记 Beta', project.id)
    const markdown = '# S9 合成笔记 Alpha\n\n旧库正文。关联 [[' + second.id + '|Beta]]。\n'
    const saved = await api.notes.updateStrict(first.id, markdown, first.revision)
    const draft = await api.notes.draftWrite(second.id, '# 旧版未保存草稿\n\n合成正文。', second.revision, 's10-fixture-draft')
    const episode = await api.brain.capture(project.id, '合成旧库海马体事件')
    const skill = await api.brain.saveSkill({ title: '合成旧版技能', tags: ['合成'], system_prompt: '仅处理合成内容。' })
    await api.graphLayout.saveBatch([{ noteId: first.id, x: 137, y: 251, pinned: true }])
    return { started, first, second, saved, draft, project, episode, skill, markdown,
      version: (await api.getAppInfo()).version }
  }, oldRoot)
  assert.equal(seed.started.phase, 'ready')
  assert.equal(seed.version, '0.5.0-s9.6')
  assert.equal(seed.draft, true)
  assert.equal(seed.saved.status, 'saved')
  await close(old)
  const projectFiles = [seed.first.id, seed.second.id].map(id => join('projects', seed.project.id, id + '.md'))
  const oldMarkdown = await snapshot(oldRoot, projectFiles)
  assert.equal(sql(oldRoot, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'harness_runs'")[0].n, 0)
  const oldDatabase = new DatabaseSync(file(oldRoot))
  try {
    const checkpoint = oldDatabase.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    assert.equal(checkpoint.busy, 0)
    assert.equal(checkpoint.log, checkpoint.checkpointed)
  } finally {
    oldDatabase.close()
  }
  const runtimeFiles = new Set(['.plate-runtime.lock', 'index.sqlite-wal', 'index.sqlite-shm'])
  await cp(oldRoot, compatRoot, { recursive: true, errorOnExist: true, force: false,
    filter: path => !runtimeFiles.has(basename(path)) })
  good('Published S9.6 created the legacy fixture; SQLite and Markdown copied after exit')

  activeOld = await open(oldExecutable, 's9', oldRoot)
  assert.equal((await readStartup(activeOld)).path, oldRoot)
  assert.equal((await registry()).code, 1, 'S10 uninstall entry already exists')
  await installer(newInstaller)
  assert.equal(await exists(installExecutable), true)
  const uninstall = await registry()
  assert.equal(uninstall.code, 0, 'S10 HKCU uninstall entry missing')
  assert.match(uninstall.value, /DisplayVersion\s+REG_SZ\s+0\.6\.0-s10\.0/)
  assert.match(uninstall.value, /DisplayName\s+REG_SZ\s+Plate Workbench S10 Preview/)
  assert.equal((await activeOld.page.evaluate(() => window.workbench.getAppInfo())).version, '0.5.0-s9.6')
  assert.equal(await activeOld.page.evaluate(id => window.workbench.notes.read(id).then(note => note.content), seed.first.id), seed.markdown)
  const binary = await readFile(installExecutable)
  assert.equal(binary.readUInt16LE(binary.readUInt32LE(0x3C) + 4), 0x8664, 'installed PE must be x64')
  output.binarySha256 = sha256(binary)
  good('NSIS package installed per user, x64 PE and version registered, S9.6 process remained usable')

  activeNew = await open(installExecutable, 's10')
  const suggested = await readStartup(activeNew)
  assert.equal(suggested.phase, 'choose')
  assert.equal(basename(suggested.suggested), 'Plate Workbench S10 Preview')
  assert.equal(await exists(suggested.suggested), false)
  assert.equal(await exists(join(settingsPath, 'workspace.json')), false)
  assert.equal((await activeNew.page.evaluate(() => window.workbench.getAppInfo())).version, config.version)
  assert.equal(await activeNew.page.evaluate(root => window.workbench.startup.submit(root).then(state => state.path), freshRoot), freshRoot)
  await activeNew.page.reload()
  const rail = activeNew.page.getByRole('navigation', { name: '主导航' })
  await rail.waitFor()
  assert.equal(Math.round((await rail.boundingBox()).width), 52)
  assert.equal(await rail.getByRole('button').count(), 5)
  await rail.getByRole('button', { name: '模型与权限' }).click()
  await activeNew.page.getByRole('heading', { name: 'API 模型服务商', exact: true }).waitFor()
  await rail.getByRole('button', { name: '工作台' }).click()
  await activeNew.page.getByRole('textbox', { name: '任务内容' }).waitFor()
  await activeNew.page.evaluate(() => document.fonts.ready.then(() => undefined))
  assert.deepEqual(activeNew.errors, [])
  await activeNew.page.screenshot({ path: join(isolatedDirectory, 'installed-s10.png') })
  await close(activeNew)
  activeNew = await open(installExecutable, 's10')
  await activeNew.page.getByRole('navigation', { name: '主导航' }).waitFor()
  assert.equal((await readStartup(activeNew)).path, freshRoot)
  assert.equal(await exists(file(freshRoot)), true)
  assert.deepEqual(activeNew.errors, [])
  good('Installed S10 proposes its own folder, opens a fresh synthetic library, renders the workbench, and restores its registration after restart')

  const migration = await activeNew.page.evaluate(root => window.workbench.startup.submit(root), compatRoot)
  assert.equal(migration.path, compatRoot)
  await activeNew.page.reload()
  await activeNew.page.getByRole('navigation', { name: '主导航' }).waitFor()
  const info = await activeNew.page.evaluate(async ids => {
    const app = window.workbench
    return {
      first: await app.notes.read(ids.first),
      second: await app.notes.read(ids.second),
      notes: await app.notes.list({ projectId: ids.project }),
      projects: await app.notes.projects(),
      links: await app.notes.links(), events: await app.brain.events(ids.project),
      skills: await app.brain.skills(), layouts: await app.graphLayout.getAll(), drafts: await app.notes.draftList(),
    }
  }, { first: seed.first.id, second: seed.second.id, project: seed.project.id })
  assert.equal(info.first.content, seed.markdown)
  assert.equal(info.second.content, seed.second.content)
  assert.equal(info.notes.length, 2)
  assert.ok(info.projects.some(project => project.id === seed.project.id && project.name === seed.project.name))
  assert.ok(info.links.edges.some(edge => edge.source === seed.first.id && edge.target === seed.second.id))
  assert.deepEqual(
    [info.layouts[seed.first.id].x, info.layouts[seed.first.id].y, info.layouts[seed.first.id].pinned],
    [137, 251, true],
  )
  assert.ok(info.events.some(event => event.id === seed.episode && event.rawText === '合成旧库海马体事件'))
  assert.ok(info.skills.some(skill => skill.id === seed.skill && skill.allowNetwork === false))
  assert.ok(info.drafts.some(draft => draft.id === seed.second.id || draft.noteId === seed.second.id))
  assert.deepEqual(await snapshot(compatRoot, projectFiles), oldMarkdown)
  assert.deepEqual(await snapshot(oldRoot, projectFiles), oldMarkdown)
  const count = sql(compatRoot, "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('llm_providers','external_agent_sessions','harness_runs','staged_diffs')")[0].n
  assert.equal(count, 4)
  assert.equal(sql(oldRoot, "SELECT count(*) AS n FROM sqlite_master WHERE name = 'harness_runs'")[0].n, 0)
  assert.equal(sql(compatRoot, 'SELECT count(*) AS n FROM pragma_integrity_check WHERE integrity_check != ?', 'ok')[0].n, 0)
  assert.equal(sql(compatRoot, 'SELECT count(*) AS n FROM pragma_foreign_key_check')[0].n, 0)
  await activeNew.page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '大脑视图' }).click()
  await activeNew.page.getByRole('complementary', { name: '海马体 · 短期闪念' }).getByText('合成旧库海马体事件').waitFor()
  await activeNew.page.screenshot({ path: join(isolatedDirectory, 'installed-legacy-brain.png') })
  assert.deepEqual(activeNew.errors, [])
  await close(activeNew)
  activeNew = await open(installExecutable, 's10')
  await activeNew.page.getByRole('navigation', { name: '主导航' }).waitFor()
  assert.equal((await readStartup(activeNew)).path, compatRoot)
  good('S10 preserved legacy Markdown hashes, projects, links, graph positions, draft, episodic events and skills; SQLite integrity and foreign keys passed')
  assert.equal(await hash(oldExecutable), oldArtifactHash)
  output.rechecked = true
} finally {
  for (const entry of [...running]) await close(entry)
  await writeFile(join(isolatedDirectory, 'installed-verification.json'), JSON.stringify(output, null, 2))
}
