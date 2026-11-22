import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { access, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const [oldArg, installerArg, tempArg, sourceArg] = process.argv.slice(2)
assert.ok(oldArg && installerArg && tempArg, 'Pass published S10.1 EXE, S11 installer and release staging directory')
const oldExecutable = await realpath(oldArg)
const s11Installer = await realpath(installerArg)
const temp = await realpath(tempArg)
assert.equal(dirname(temp).toLowerCase(), (await realpath(process.env.TEMP)).toLowerCase())
assert.match(basename(temp), /^plate-s11-release-[a-f0-9]+$/)
assert.equal(basename(oldExecutable), 'plate-workbench-s10.exe')
assert.ok(oldExecutable.toLowerCase().startsWith(temp.toLowerCase() + '\\'))
assert.equal(basename(s11Installer), 'Plate-S11-0.7.0-s11-Setup-x64.exe')
assert.ok(s11Installer.toLowerCase().startsWith(temp.toLowerCase() + '\\'))

const local = await realpath(process.env.LOCALAPPDATA)
const s10Name = 'Plate Workbench S10 Preview'
const s11Name = 'Plate Workbench S11 Preview'
const s10SettingsDir = join(local, 'local.plate.workbench.s10-preview')
const s11SettingsDir = join(local, 'local.plate.workbench.s11-preview')
const s10Install = join(local, s10Name)
const s11Install = join(local, s11Name)
const oldRegistration = join(s10SettingsDir, 'workspace.json')
const realWorkspace = await realpath(JSON.parse(await readFile(oldRegistration, 'utf8')))
const migrationRoot = join(temp, 'migration')
const copy = join(migrationRoot, 'S10.1 笔记副本_日本語')
const fixture = join(migrationRoot, '正式 S10.1 创建的合成库')
let fixtureProvider, fixtureBackend
const sibling = join(migrationRoot, 'S10.1 并行验证空库')
const marker = 'plate-workbench.json'
const newExecutable = join(s11Install, 'plate-workbench-s11.exe')
const dbFile = root => join(root, 'index.sqlite')
const exists = path => access(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false
  throw error
})
const sha256 = value => createHash('sha256').update(value).digest('hex')
const fileHash = async path => sha256(await readFile(path))
const linesHash = collection => sha256(JSON.stringify(collection))
const output = { passed: false, sourceKind: sourceArg === '--fixture' ? 'published-s10.1-fixture' : 'existing-library', checks: [], copyTables: {}, markdownFiles: 0 }
let installed = false
const running = new Set()

async function collectFiles(root, directory = root) {
  const files = []
  for (const name of await readdir(directory)) {
    const location = join(directory, name)
    const info = await lstat(location)
    const canonical = await realpath(location)
    assert.ok(!info.isSymbolicLink() && canonical.toLowerCase() === location.toLowerCase(), 'Workspace contains a linked path')
    if (info.isDirectory()) files.push(...await collectFiles(root, location))
    else if (info.isFile()) files.push([relative(root, location), await fileHash(location)])
  }
  return files.sort(([a], [b]) => a.localeCompare(b))
}

async function originalState() {
  const paths = [oldRegistration, dbFile(realWorkspace), dbFile(realWorkspace) + '-wal',
    join(realWorkspace, marker), join(s10Install, 'plate-workbench-s10.exe'), join(s10Install, 'uninstall.exe')]
  return {
    files: await Promise.all(paths.map(async path => await exists(path) ? fileHash(path) : null)),
    projects: linesHash(await collectFiles(join(realWorkspace, 'projects'))),
    registry: (await registry(s10Name)).text,
  }
}

function withDb(root, run) {
  const db = new DatabaseSync(dbFile(root), { readOnly: true })
  try { return run(db) }
  finally { db.close() }
}

function snapshot(root, legacy = undefined) {
  return withDb(root, db => {
    assert.ok(db.prepare('PRAGMA integrity_check').all().every(row => Object.values(row)[0] === 'ok'), 'SQLite integrity check failed')
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'SQLite foreign keys failed')
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const source = legacy ? Object.keys(legacy).map(name => ({name})) : tables
    return Object.fromEntries(source.map(({name}) => {
      assert.match(name, /^[a-zA-Z0-9_]+$/, 'Unexpected table name in versioned Plate schema')
      const ignored = name === 'note' ? new Set(['path', 'vitality_score', 'is_dormant', 'updated_at'])
        : name === 'note_draft' ? new Set(['path']) : new Set()
      const columns = legacy ? legacy[name].columns : db.prepare(`PRAGMA table_info("${name}")`).all()
        .map(row => row.name).filter(column => !ignored.has(column))
      for (const column of columns) assert.match(column, /^[a-zA-Z0-9_]+$/)
      const statement = db.prepare(`SELECT ${columns.map(column => '"' + column + '"').join(',')} FROM "${name}"`)
      statement.setReadBigInts(true)
      const rows = statement.all().map(row => JSON.stringify(columns.map(column => {
        const value = row[column]
        return typeof value === 'bigint' ? {integer:value.toString()} : value
      }))).sort()
      return [name, { columns, rows: rows.length, hash: linesHash(rows) }]
    }))
  })
}
function compareSnapshot(actual, baseline, phase) {
  assert.equal(Object.keys(actual).length, Object.keys(baseline).length, phase + ' table count')
  for (const name of Object.keys(baseline)) {
    assert.equal(actual[name].rows, baseline[name].rows, phase + ' row count: ' + name)
    assert.ok(actual[name].hash === baseline[name].hash, phase + ' values differ: ' + name)
  }
}

async function cloneWorkspace(source) {
  const sourceProjects = join(source, 'projects')
  const before = await collectFiles(sourceProjects)
  assert.ok(before.some(([name]) => name.endsWith('.md')), 'The registered S10 workspace has no Markdown notes')
  await mkdir(copy, { recursive: true })
  await cp(sourceProjects, join(copy, 'projects'), { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
  await cp(join(source, marker), join(copy, marker), { errorOnExist: true, force: false })
  const sourceDb = new DatabaseSync(dbFile(source), { readOnly: true })
  try { await backup(sourceDb, dbFile(copy)) }
  finally { sourceDb.close() }
  assert.ok(linesHash(await collectFiles(join(copy, 'projects'))) === linesHash(before), 'Copy Markdown differs from original')
  assert.ok(linesHash(await collectFiles(sourceProjects)) === linesHash(before), 'Original Markdown changed during snapshot')
  const legacy = snapshot(source)
  compareSnapshot(snapshot(copy), legacy, 'Online backup')
  assert.ok(!legacy.brain_spaces, 'Registered source already uses the S11 schema')
  output.markdownFiles = before.filter(([name]) => name.endsWith('.md')).length
  output.copyTables = Object.fromEntries(Object.entries(legacy).map(([name, table]) => [name, table.rows]))
  output.checks.push('Read-only SQLite online backup included WAL contents and matched original business rows and Markdown')
}

async function registry(name) {
  const path = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + name
  const child = spawn('reg.exe', ['query', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let text = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { text += chunk })
  const [code] = await once(child, 'close')
  return { code, text }
}
async function runInstaller(executable) {
  const child = spawn(executable, ['/S'], { cwd: dirname(executable), windowsHide: true, stdio: 'ignore' })
  const exited = await Promise.race([once(child, 'exit').then(([code]) => ({code})), delay(120_000, undefined, { ref: false })])
  if (!exited) { child.kill(); throw Error('Installer timeout') }
  assert.equal(exited.code, 0, 'Installer did not exit successfully')
}
async function reservePort() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

async function open(executable, name, workspace = undefined) {
  const port = await reservePort()
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(PLATE_|WEBVIEW2_|CODEX_HOME$|CLAUDE_CONFIG_DIR$|DSH_|DEEPSEEK_)/i.test(key)))
  Object.assign(env, { PLATE_AGENT_SETTINGS_DIR: join(migrationRoot, name + '-agents'),
    WEBVIEW2_USER_DATA_FOLDER: join(migrationRoot, name + '-webview'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port })
  if (workspace) env.PLATE_WORKSPACE_ROOT = workspace
  const child = spawn(executable, [], {cwd: dirname(executable), env, windowsHide: true, stdio: 'ignore'})
  const app = { child, errors:[] }
  running.add(app)
  const address = 'http://127.0.0.1:' + port
  for (let retry = 0; retry < 200; retry++) {
    assert.equal(child.exitCode, null, 'Application exited before WebView readiness')
    if (await fetch(address + '/json/version').then(response => response.ok, () => false)) break
    await delay(100)
  }
  app.browser = await chromium.connectOverCDP(address,{timeout:8000})
  const context = app.browser.contexts()[0]
  app.page = context.pages()[0] ?? await context.waitForEvent('page')
  app.page.on('pageerror', () => app.errors.push('pageerror'))
  app.page.on('console', message => { if (message.type() === 'error') app.errors.push('console error') })
  app.page.setDefaultTimeout(12_000)
  await app.page.waitForFunction(() => Boolean(window.workbench?.startup))
  return app
}
async function close(app) {
  if (!app) return
  if (app.child.exitCode === null && app.child.signalCode === null) {
    const exited = once(app.child, 'exit')
    if (app.page) void app.page.evaluate(() => window.workbench.startup.exit()).catch(() => {})
    else app.child.kill()
    if (!await Promise.race([exited.then(() => true),delay(3000,false,{ref:false})])) {
      app.child.kill()
      await exited
    }
  }
  await app.browser?.close().catch(() => {})
  running.delete(app)
}
async function createOldFixture() {
  const logDir = join(migrationRoot, 'fixture-logs')
  await mkdir(logDir, {recursive:true})
  await writeFile(join(logDir,'sample.jsonl'), [
    {role:'user', content:'合成办公输入'},
    {role:'assistant', content:'合成办公结论'},
  ].map(item=>JSON.stringify(item)).join('\n') + '\n')
  const app = await open(oldExecutable,'old-fixture',fixture)
  assert.equal(await version(app),'0.6.0-s10.1')
  const notes = await app.page.evaluate(async ({root,logDir}) => {
    const api = window.workbench
    if ((await api.startup.submit(root)).phase !== 'ready') throw Error('S10.1 fixture did not open')
    const project = await api.notes.createProject('S10.1 合成分区')
    const first = await api.notes.create('工作准备 · 日本語',project.id)
    const second = await api.notes.create('草稿与标签 · 한글',project.id)
    const content = '# 工作准备 · 日本語\n\n合成正文。[[' + second.id + '|关联]] 与 #验收\n'
    const saved = await api.notes.updateStrict(first.id,content,first.revision)
    if (saved.status !== 'saved') throw Error('S10.1 fixture note did not save')
    const draft = await api.notes.draftWrite(second.id,'# 有待复核的草稿\n\n仅供合成验收。',second.revision,'s11-migration-fixture')
    if (!draft) throw Error('S10.1 fixture draft did not save')
    await api.graphLayout.saveBatch([{noteId:first.id,x:123,y:221,pinned:true}])
    await api.brain.capture(project.id,'合成的待审阅候选记忆')
    const skillId = await api.brain.saveWorkbenchSkill({input:{title:'办公回执样本',tags:['验收'],system_prompt:'保留来源。'},
      allowShell:false,allowNetwork:true})
    await api.agentLogs.scan({includeDefaults:false,customDirectory:logDir})
    const logs = await api.agentLogs.list(0)
    return { noteId:first.id, skillId, logId:logs[0]?.id }
  }, {root:fixture, logDir})
  assert.ok(notes.logId,'S10.1 did not import the fixture log')
  const key = 's10-fixture-' + randomUUID()
  const backend = fixtureBackend = createHttpServer(async (request,response) => {
    try {
      assert.equal(request.headers.authorization,'Bearer '+key)
      if (request.url==='/v1/models') return response.writeHead(200,{'content-type':'application/json'}).end('{"data":[]}')
      assert.equal(request.url,'/v1/chat/completions')
      let raw = ''
      for await(const chunk of request) raw+=chunk
      const messages=JSON.parse(raw).messages
      const calls=messages.some(message=>message.role==='tool')
      const delta=calls ? {content:'合成任务完成。'} : {tool_calls:[{index:0,id:'migration-note',type:'function',function:{
        name:'propose_note_update',arguments:JSON.stringify({noteId:notes.noteId,content:'# 审阅中的合成提案\n\n暂存内容。',rationale:'保留待审阅记录'}),
      }}]}
      response.writeHead(200,{'content-type':'text/event-stream'})
      response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:calls?'stop':'tool_calls'}],
        usage:{prompt_tokens:25,completion_tokens:15}})+'\n\ndata: [DONE]\n\n')
    } catch {
      response.writeHead(500).end()
    }
  }).listen(0,'127.0.0.1')
  await once(backend,'listening')
  try {
    fixtureProvider=(await app.page.evaluate(input=>window.workbench.providers.upsert(input), {
      name:'迁移合成服务',kind:'openai_compatible',baseUrl:'http://127.0.0.1:'+backend.address().port+'/v1',
      defaultModel:'fixture',roles:['workbench_chat'],inputPricePer1m:0,outputPricePer1m:0,enabled:true,apiKey:key,
    })).id
    await app.page.evaluate(id=>window.workbench.providers.test(id),fixtureProvider)
    const runId=await app.page.evaluate(({notes,providerId})=>window.workbench.harness.start({
      title:'迁移合成任务',prompt:'为合成笔记生成一条待审阅变更。',backendKind:'api_key',backendId:providerId,
      seedNoteId:notes.noteId,skillId:notes.skillId,attachedLogSessionIds:[notes.logId],
      permissions:{readableNoteIds:[notes.noteId],readableLogSessionIds:[notes.logId],writableDirs:[],
        allowNetwork:true,allowBrainNotePropose:true,maxSteps:4,maxBudgetUsd:0.25},
    }), {notes,providerId:fixtureProvider})
    let status
    for (let retry=0; retry<150; retry++) {
      status=await app.page.evaluate(async id=>(await window.workbench.harness.list()).find(run=>run.id===id)?.status,runId)
      if (status && status!=='running') break
      await delay(100)
    }
    assert.equal(status,'review_ready')
    assert.equal((await app.page.evaluate(id=>window.workbench.harness.diffs(id),runId)).length,1)
  } finally {
    await close(app)
  }
  output.checks.push('Published S10.1 created notes, links, a draft, layout, candidate, skill, provider, agent log and pending shadow diff')
  return fixture
}

const state = app => app.page.evaluate(() => window.workbench.startup.state())
const version = app => app.page.evaluate(async () => (await window.workbench.getAppInfo()).version)

async function verifyNotes(app) {
  // Hash note payloads inside a temporary in-memory browser result. Never write contents or identifiers to evidence.
  const visible = await app.page.evaluate(async () => {
    const summaries = await window.workbench.notes.list()
    return Promise.all(summaries.map(async row => {
      const note = await window.__TAURI_INTERNALS__.invoke('notes_read', {id:row.id,touch:false})
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(note.content))
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('')
    }))
  })
  assert.ok(visible.length > 0, 'The existing note library did not open through the app')
  return { count: visible.length, hash:linesHash(visible.sort()) }
}

assert.equal(await exists(s11Install), false, 'An S11 test installation already exists')
assert.equal(await exists(s11SettingsDir), false, 'An S11 application profile already exists')
assert.equal((await registry(s11Name)).code, 1, 'S11 uninstall entry already exists')
assert.equal(await exists(migrationRoot), false, 'Migration test directory already exists')
assert.ok(isAbsolute(realWorkspace) && !realWorkspace.toLowerCase().startsWith(temp.toLowerCase() + '\\'))
const untouched = await originalState()
try {
  await mkdir(migrationRoot)
  const source = sourceArg === '--fixture' ? await createOldFixture() : await realpath(sourceArg ?? realWorkspace)
  const sourceProjects = linesHash(await collectFiles(join(source, 'projects')))
  const sourceDatabase = await fileHash(dbFile(source))
  const sourceWalPath = dbFile(source) + '-wal'
  const sourceWal = await exists(sourceWalPath) ? await fileHash(sourceWalPath) : null
  await cloneWorkspace(source)
  if (sourceArg === '--fixture') {
    for (const table of ['note','note_link','note_draft','graph_layout','episodic_events','procedural_skills',
      'llm_providers','external_agent_sessions','external_agent_messages','harness_runs','staged_diffs']) {
      assert.ok(output.copyTables[table]>0,'Fixture did not populate '+table)
    }
  }
  const previous = await open(oldExecutable,'old',copy)
  const previousState = await state(previous)
  assert.ok(previousState.phase === 'ready' && previousState.path === copy, 'S10.1 did not use the isolation copy')
  assert.equal(await version(previous),'0.6.0-s10.1')
  await previous.page.getByRole('navigation',{name:'主导航'}).waitFor()
  const originalNotes = await verifyNotes(previous)
  assert.equal(previous.errors.length, 0, 'S10.1 rendering errors')
  await close(previous)
  const baseline = snapshot(copy)
  const oldMarkdown = linesHash(await collectFiles(join(copy, 'projects')))
  assert.ok(oldMarkdown === sourceProjects, 'S10.1 opening the copy unexpectedly changed Markdown')
  const oldActive = await open(oldExecutable,'old-sibling',sibling)
  assert.equal((await state(oldActive)).phase, 'choose')
  assert.equal((await oldActive.page.evaluate(root => window.workbench.startup.submit(root), sibling)).phase,'ready')

  await runInstaller(s11Installer)
  installed = true
  const entry = await registry(s11Name)
  assert.equal(entry.code, 0, 'S11 uninstall registry entry is missing')
  assert.match(entry.text, /DisplayVersion\s+REG_SZ\s+0\.7\.0-s11/)
  assert.match(entry.text, /DisplayName\s+REG_SZ\s+Plate Workbench S11 Preview/)
  assert.ok(entry.text.includes(s11Install), 'S11 installer used the wrong directory')
  const pe = await readFile(newExecutable)
  assert.equal(pe.readUInt16LE(pe.readUInt32LE(0x3C) + 4), 0x8664)
  output.binarySha256 = sha256(pe).toUpperCase()
  assert.equal(await version(oldActive),'0.6.0-s10.1')
  assert.equal((await state(oldActive)).phase,'ready')
  const first = await open(newExecutable, 'new')
  assert.equal(await version(first),'0.7.0-s11')
  const initial = await state(first)
  assert.equal(initial.phase,'choose')
  assert.equal(basename(initial.suggested),s11Name)
  assert.equal(await exists(join(s11SettingsDir,'workspace.json')),false)
  const opened = await first.page.evaluate(root=>window.workbench.startup.submit(root),copy)
  assert.ok(opened.phase === 'ready' && opened.path === copy, 'S11 did not use the S10.1 copy')
  await first.page.reload({waitUntil:'domcontentloaded'})
  await first.page.getByRole('navigation',{name:'主导航'}).waitFor()
  const migratedNotes = await verifyNotes(first)
  assert.deepEqual(migratedNotes,originalNotes,'Notes exposed through S10.1 and S11 differ')
  if (fixtureProvider) {
    const provider = await first.page.evaluate(async id => (await window.workbench.providers.list()).find(item=>item.id===id),fixtureProvider)
    assert.ok(provider && provider.keyHint === '', 'S11 exposed an S10 credentials hint for an unconfigured key')
    await assert.rejects(first.page.evaluate(id=>window.workbench.providers.test(id),fixtureProvider), /API Key/)
    output.checks.push('Migrated provider configuration survived while S10.1 credentials were inaccessible to S11')
  }
  const draftEntries = await first.page.evaluate(() => window.workbench.notes.draftList())
  for (const draft of draftEntries) {
    assert.ok(draft.path.toLowerCase().startsWith(copy.toLowerCase() + '\\projects\\'), 'Migrated draft points outside the isolated copy')
  }
  const scopes = await first.page.evaluate(() => window.workbench.brain.spaces())
  assert.equal(scopes.find(space=>space.id==='personal')?.isolated,true)
  assert.equal(scopes.find(space=>space.id==='personal')?.allowExport,false)
  await first.page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'大脑视图',exact:true}).click()
  await first.page.getByRole('group',{name:'脑区',exact:true}).getByRole('button',{name:'学习',exact:true}).waitFor()
  assert.equal(first.errors.length,0,'S11 first-run rendering errors')
  assert.ok(JSON.parse(await readFile(join(s11SettingsDir,'workspace.json'),'utf8')) === copy, 'S11 profile did not record the copy')
  await close(first)
  for (const [table, required] of [['note',true],['episodic_events',false],['procedural_skills',false],['harness_runs',false]]) {
    const totals = withDb(copy,db=>db.prepare(`SELECT COUNT(*) AS n, SUM(space_id='learning') AS migrated FROM ${table}`).get())
    assert.ok(!required || totals.n > 0, 'No migrated notes found')
    assert.equal(totals.migrated ?? 0, totals.n, 'Legacy space assignment failed: ' + table)
  }
  const schema = withDb(copy,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>row.name))
  for (const table of ['brain_spaces','model_profiles','prompt_versions','eval_cases','eval_runs','harness_hooks','note_space_assignments']) {
    assert.ok(schema.includes(table), 'Missing migration table: ' + table)
  }
  const versions = withDb(copy,db=>db.prepare(`SELECT COUNT(*) AS n FROM procedural_skills s
    JOIN prompt_versions v ON v.id=s.active_prompt_version_id AND v.skill_id=s.id AND v.status='production'
      AND v.system_prompt=s.system_prompt`).get().n)
  assert.equal(versions,baseline.procedural_skills.rows)
  compareSnapshot(snapshot(copy,baseline),baseline,'S11 migration')
  assert.ok(linesHash(await collectFiles(join(copy, 'projects'))) === oldMarkdown,'S11 rewrote legacy Markdown')
  output.notesRead = migratedNotes.count
  output.checks.push('Installed x64 S11 side by side while published S10.1 remained usable')
  output.checks.push('All legacy table projections, Markdown and UI note contents retained; spaces and production prompts migrated')

  const reopened = await open(newExecutable,'new')
  const registration = await state(reopened)
  assert.ok(registration.phase === 'ready' && registration.path === copy, 'S11 restart did not reopen the copy')
  assert.deepEqual(await verifyNotes(reopened),migratedNotes,'S11 restart changed note payloads')
  assert.equal(reopened.errors.length,0,'S11 restart rendering errors')
  compareSnapshot(snapshot(copy,baseline),baseline,'S11 second launch')
  assert.ok(linesHash(await collectFiles(join(copy, 'projects'))) === oldMarkdown, 'Restart changed legacy Markdown')
  output.checks.push('Second launch reopened the independent profile and the schema migration was idempotent')
  if (draftEntries.length) {
    const sourceUnchanged = linesHash(await collectFiles(join(source,'projects')))
    const chosen = draftEntries[0]
    const recovered = await reopened.page.evaluate(async ({id,version}) => {
      const api=window.workbench.notes
      const draft=await api.draftRestore(id)
      const saved=await api.draftSaveCopy(id,version)
      return {status:draft.status,path:saved.path,contentMatches:draft.content===saved.content}
    },{id:chosen.id,version:chosen.version})
    assert.ok(recovered.path.toLowerCase().startsWith(copy.toLowerCase() + '\\projects\\'), 'Saved recovery copy escaped the isolated library')
    assert.ok(recovered.contentMatches && ['restored','preview'].includes(recovered.status),'Recovered draft content changed')
    assert.ok(linesHash(await collectFiles(join(source,'projects'))) === sourceUnchanged,'Saving the recovery copy changed the source library')
    output.checks.push('Restored draft and saved a recovery note inside the migrated copy, with source files unchanged')
  }
  await close(reopened)
  await close(oldActive)
  assert.ok(await fileHash(dbFile(source)) === sourceDatabase, 'Source SQLite file changed')
  assert.ok((await exists(sourceWalPath) ? await fileHash(sourceWalPath) : null) === sourceWal, 'Source SQLite WAL changed')
  assert.ok(linesHash(await collectFiles(join(source,'projects'))) === sourceProjects, 'Source project files changed')
  output.passed = true
} catch (error) {
  console.error('Migration acceptance failed:', error.message)
  throw error
} finally {
  const cleanupErrors = []
  async function cleanup(action) {
    try { await action() }
    catch (error) { cleanupErrors.push(error) }
  }
  for (const app of running) await cleanup(() => close(app))
  if (fixtureProvider) await cleanup(async () => {
    const old = await open(oldExecutable,'old-credential-cleanup',fixture)
    try {
      // Probe only the loopback fixture to confirm S10.1 retained its key.
      await old.page.evaluate(async id => {
        try { await window.workbench.providers.test(id) }
        finally { await window.workbench.providers.remove(id) }
      },fixtureProvider)
    } finally { await close(old) }
  })
  if (fixtureBackend) await cleanup(async () => {
    fixtureBackend.closeAllConnections()
    await new Promise(done=>fixtureBackend.close(done))
  })
  await cleanup(async () => {
    if (!installed && !await exists(join(s11Install,'uninstall.exe'))) return
    const uninstaller = join(s11Install,'uninstall.exe')
    assert.ok((await realpath(uninstaller)).toLowerCase() === uninstaller.toLowerCase(), 'Uninstaller path is unexpected')
    await runInstaller(uninstaller)
    // NSIS starts a separate process when the uninstaller removes itself.
    for (let retry=0; retry<100; retry++) {
      if ((await registry(s11Name)).code===1 && !await exists(newExecutable)) break
      await delay(100)
    }
    assert.equal((await registry(s11Name)).code, 1, 'S11 test uninstall left registry state')
    assert.equal(await exists(newExecutable),false,'S11 test uninstall left its executable')
  })
  await cleanup(async () => {
    if (!await exists(s11SettingsDir)) return
    const checked = await realpath(s11SettingsDir)
    assert.equal(checked.toLowerCase(),s11SettingsDir.toLowerCase())
    assert.equal(dirname(checked).toLowerCase(),local.toLowerCase())
    await rm(checked,{recursive:true,maxRetries:10,retryDelay:200})
  })
  await cleanup(async () => {
    assert.ok(JSON.stringify(await originalState()) === JSON.stringify(untouched), 'S10 installed application, registration or original data changed')
  })
  await cleanup(async () => {
    if (!await exists(migrationRoot)) return
    const checked = await realpath(migrationRoot)
    assert.equal(checked.toLowerCase(),migrationRoot.toLowerCase())
    assert.equal(dirname(checked).toLowerCase(),temp.toLowerCase())
    await rm(checked,{recursive:true,maxRetries:12,retryDelay:250})
  })
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors,'Could not complete all S11 acceptance cleanup')
  output.checks.push('Original registration, database/WAL, Markdown, installed executable and registry unchanged; S11 test install removed')
}
await writeFile(join(temp,'migration-verification.json'),JSON.stringify(output,null,2)+'\n')
console.log(JSON.stringify(output,null,2))
