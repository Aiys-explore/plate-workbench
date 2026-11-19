import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

const { chromium } = createRequire(new URL('../source/package.json', import.meta.url))('playwright')
const exe = resolve(process.argv[2])
const sandbox = await mkdtemp(join(tmpdir(), 'plate-s9-'))
const evidence = resolve(process.argv[3] ?? sandbox)
const workspace = join(sandbox, 'workspace')
const database = join(workspace, 'index.sqlite')
const inputFile = join(sandbox, 'stdin.txt')
const replyFile = join(sandbox, 'reply.txt')
const ids = Object.fromEntries(['seed', 'bridge', 'fact', 'cold', 'foreign'].map((name, index) =>
  [name, '00000000-0000-4000-8000-00000000000' + (index + 1)]))
const files = Object.fromEntries(Object.entries(ids).map(([key, id]) =>
  [key, join(workspace, 'projects', key === 'foreign' ? 'other' : 'default', id + '.md')]))
const originals = {
  seed: '# 研究起点\n\n标签 #research\n\n- [[研究桥梁]]\n- [[隔离材料]]\n\n- [ ] TODO: 研究下一步 & | %\n',
  bridge: '# 研究桥梁\n\n- [[' + ids.fact + '|双跳事实]] <!-- plate-downstream -->\n\n桥接内容\n',
  fact: '# 双跳事实\n\n合成研究数值 1729\n', cold: '# 休眠样本\n\n独立节点\n',
  foreign: '# 隔离材料\n\nXX-FOREIGN-CTX-XX\n',
}
await mkdir(evidence, { recursive: true })
for (const name of ['default', 'other']) await mkdir(join(workspace, 'projects', name), { recursive: true })
await writeFile(join(workspace, 'plate-workbench.json'), '{"version":"0.4.0-s8.1"}')
for (const [key, body] of Object.entries(originals)) await writeFile(files[key], body)
function sql(fn) {
  const db = new DatabaseSync(database)
  try { return fn(db) } finally { db.close() }
}
sql(db => {
  db.exec("CREATE TABLE project(id TEXT PRIMARY KEY,name TEXT NOT NULL,root_path TEXT NOT NULL,color TEXT,archived_at INTEGER,created_at INTEGER NOT NULL);" +
    "CREATE TABLE note(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE,title TEXT NOT NULL,project_id TEXT NOT NULL REFERENCES project(id),kind TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);" +
    "CREATE TABLE note_link(source_note_id TEXT REFERENCES note(id) ON DELETE CASCADE,target_note_id TEXT REFERENCES note(id) ON DELETE CASCADE,PRIMARY KEY(source_note_id,target_note_id));" +
    "CREATE TABLE note_tag(note_id TEXT REFERENCES note(id) ON DELETE CASCADE,tag TEXT,PRIMARY KEY(note_id,tag));")
  const project = db.prepare('INSERT INTO project(id,name,root_path,created_at) VALUES(?,?,?,?)')
  for (const id of ['default', 'other']) project.run(id, id === 'default' ? '合成工作区' : '隔离项目', workspace, Date.now())
  const note = db.prepare('INSERT INTO note VALUES(?,?,?,?,?,?,?)')
  for (const [key, body] of Object.entries(originals)) {
    note.run(ids[key], files[key], body.split('\n')[0].slice(2), key === 'foreign' ? 'other' : 'default', 'normal', Date.now(), Date.now())
  }
})
const shim = join(sandbox, 'codex.cmd')
const fixture = join(sandbox, 'fixture.cjs')
await writeFile(shim, '@echo off\r\n"' + process.execPath + '" "' + fixture + '" %*\r\n')
await writeFile(fixture, [
  "if (process.argv[2] === '--version') { console.log('codex 1.0.0'); process.exit(0) }",
  "const fs = require('node:fs')",
  "process.stdin.setEncoding('utf8')",
  "let input = ''",
  "process.stdin.on('data', chunk => { input += chunk })",
  "process.stdin.on('end', () => {",
  '  fs.writeFileSync(' + JSON.stringify(inputFile) + ', input)',
  '  const reply = fs.readFileSync(' + JSON.stringify(replyFile) + ", 'utf8')",
  '  setTimeout(() => process.stdout.write(reply), 250)',
  '})',
].join('\n'))
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PLATE_AGENT_|DEEPSEEK_|DSH_)/i.test(key)))
Object.assign(env, {
  PLATE_AGENT_CODEX: shim, PLATE_AGENT_SETTINGS_DIR: join(sandbox, 'agent-settings'),
  PLATE_WORKSPACE_ROOT: workspace, WEBVIEW2_USER_DATA_FOLDER: join(sandbox, 'webview'),
})
const results = { executable: exe, isolatedWorkspace: workspace, checks: [] }
const pass = (name, details = true) => { results.checks.push({ name, details }); console.log('PASS', name, JSON.stringify(details)) }
let child, browser, page
async function until(read, title, timeout = 12_000) {
  const end = Date.now() + timeout
  do {
    const found = await read()
    if (found) return found
    await delay(65)
  } while (Date.now() < end)
  throw new Error('Timed out: ' + title)
}
async function open() {
  const socket = createServer().listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = socket.address().port
  await new Promise(done => socket.close(done))
  child = spawn(exe, [], { windowsHide: true, cwd: sandbox, stdio: 'ignore',
    env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port } })
  const address = 'http://127.0.0.1:' + port
  await until(() => {
    if (child.exitCode !== null) throw new Error('Plate 退出 ' + child.exitCode)
    return fetch(address + '/json/version').then(response => response.ok, () => false)
  }, 'WebView2')
  browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(8_000)
  await page.getByRole('region', { name: '笔记关系图' }).waitFor()
  assert.equal(await page.evaluate(async () => (await window.workbench.startup.state()).path), workspace)
}
async function close() {
  if (!child || child.exitCode !== null) return
  const exit = once(child, 'exit').then(() => true)
  void page?.evaluate(() => window.workbench.startup.exit()).catch(() => {})
  if (!await Promise.race([exit, delay(3000, false)])) { child.kill(); await exit }
  await browser?.close()
}
const noteNode = id => page.locator('[data-graph-node="' + id + '"]')
const dialog = name => page.getByRole('dialog', { name })
async function readCard(id) {
  return until(async () => (await page.evaluate(id => window.workbench.tasks.listByNote(id), ids.seed))
    .find(card => (!id || card.taskId === id) && ['PENDING', 'ERROR'].includes(card.state)), '任务回执')
}
const reply = (body, delta) => body + '\n<brain-delta>' + JSON.stringify(delta) + '</brain-delta>'
const activeClaim = () => sql(db => db.prepare('SELECT * FROM semantic_assertions WHERE note_id=? AND valid_to IS NULL').get(ids.fact))

try {
  await open()
  results.version = await page.evaluate(async () => (await window.workbench.getAppInfo()).version)
  const migration = sql(db => db.prepare('SELECT memory_zone,vitality_score,evolution_version FROM note').all())
  assert.equal(migration.length, 5)
  assert.ok(migration.every(note => note.memory_zone === 'semantic' && note.vitality_score === 1 && note.evolution_version === 1))
  for (const [key, original] of Object.entries(originals)) assert.equal(await readFile(files[key], 'utf8'), original)
  pass('S8 SQLite upgrade preserves Markdown and initializes five semantic nodes')

  await page.evaluate(() => {
    const brain = window.workbench.brain
    const onChanged = brain.onChanged
    window.__s9IgnoreCaptureBroadcast = true
    brain.onChanged = listener => onChanged(() => {
      if (!window.__s9IgnoreCaptureBroadcast) listener()
    })
  })
  await page.keyboard.press('Control+Shift+Space')
  const captureText = '闪念：研究桥梁有待补充依据'
  await dialog('捕获闪念').getByRole('textbox', { name: '闪念内容' }).fill(captureText)
  await page.keyboard.press('Enter')
  const captured = page.locator('.brain-episodic-card').filter({ hasText: captureText })
  await until(() => sql(db => db.prepare('SELECT id FROM episodic_events WHERE raw_text=?').get(captureText)),
    'capture committed to SQLite')
  await captured.waitFor()
  await page.evaluate(() => { window.__s9IgnoreCaptureBroadcast = false })
  pass('The first capture appears after saving even if the canvas misses the change broadcast')
  assert.equal(sql(db => db.prepare('SELECT count(*) AS n FROM note').get().n), 5)
  const probe = page.locator('.brain-probes path[d]:not([d=""])')
  const target = noteNode(ids.bridge)
  await probe.waitFor()
  assert.equal(await probe.count(), 1)
  assert.equal(await page.locator('[data-brain-probe=true]').getAttribute('data-graph-node'), ids.bridge)
  const eventId = await captured.getAttribute('data-event-id')
  const measureProbe = () => probe.evaluate((path, { eventId, targetId }) => {
    const bubble = document.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`).getBoundingClientRect()
    const card = document.querySelector(`[data-graph-node="${CSS.escape(targetId)}"] .relationship-card-ink`).getBoundingClientRect()
    const screen = distance => path.getPointAtLength(distance).matrixTransform(path.getScreenCTM())
    const start = screen(0)
    const end = screen(path.getTotalLength())
    return {
      startError: Math.hypot(start.x - bubble.right, start.y - (bubble.top + bubble.height / 2)),
      endError: Math.hypot(end.x - card.left, end.y - (card.top + card.height / 2)),
      length: path.getTotalLength(),
      animation: getComputedStyle(path).animationName,
      stroke: getComputedStyle(path).stroke,
      hitTesting: getComputedStyle(path.closest('svg')).pointerEvents,
    }
  }, { eventId, targetId: ids.bridge })
  const endpoints = await measureProbe()
  assert.ok(endpoints.length > 12 && endpoints.startError < 3 && endpoints.endError < 3, JSON.stringify(endpoints))
  assert.equal(endpoints.animation, 'brain-synaptic-flow')
  assert.notEqual(endpoints.stroke, 'none')
  assert.equal(endpoints.hitTesting, 'none')
  await page.screenshot({ path: join(evidence, 'capture-probe.png') })
  const canvas = page.locator('.relations-canvas')
  const beforeZoom = await canvas.getAttribute('data-camera')
  await page.getByRole('button', { name: '放大', exact: true }).click()
  await until(async () => (await canvas.getAttribute('data-camera')) !== beforeZoom &&
    (await canvas.getAttribute('data-camera-moving')) === null, 'canvas zoom finished')
  const zoomed = await measureProbe()
  await page.screenshot({ path: join(evidence, 'capture-probe-zoom.png') })
  assert.ok(zoomed.startError < 3 && zoomed.endError < 3, 'probe endpoints after zoom: ' + JSON.stringify(zoomed))
  await probe.waitFor({ state: 'detached', timeout: 5000 })
  assert.equal(await target.getAttribute('data-brain-probe'), null)
  pass('Capture previews an animated probe that stays attached during zoom, then clears it', { initial: endpoints, zoomed })
  await page.getByRole('button', { name: '适合画布', exact: true }).click()
  await page.evaluate(() => window.workbench.brain.capture('other', 'XX-FOREIGN-EVENT-XX'))
  pass('Global capture persists isolated episodic data without a note')

  await page.getByRole('checkbox', { name: '任务使用大脑上下文' }).click()
  await until(() => page.evaluate(async () => (await window.workbench.brain.status()).contextEnabled), 'context enabled')
  await writeFile(replyFile, reply('验收回执，合成数值 1729。', {
    suggested_links: [{ target_note_id: ids.fact, reason: '保留来源链接' }],
    note_evolutions: [{ target_note_id: ids.fact, append_insight: '第一轮补充说明', delta_summary: '补充第一轮观察' }],
    assertion_updates: [{ note_id: ids.fact, old_claim_id: null, new_claim: '初始事实 1729' }],
    suggested_skill: { title: '研究复核流程', tags: ['research'], system_prompt: '先核对链接来源，再汇总。' },
  }))
  await page.evaluate(() => {
    const tasks = window.workbench.tasks
    const start = tasks.start
    const dispatched = new Map()
    window.__s9activations = []
    tasks.start = request => {
      dispatched.set(request.taskId, performance.now())
      tasks.start = start
      return start(request)
    }
    window.workbench.brain.onActivation(wave => {
      const started = dispatched.get(wave.runId)
      if (started !== undefined) window.__s9activations.push({
        ...wave, dispatchToReceivedMs: performance.now() - started,
      })
    })
  })
  await noteNode(ids.seed).dispatchEvent('dblclick', { detail: 2 })
  const editor = page.locator('[data-editor-host=render]')
  await editor.locator('[data-task-pill=todo]').click()
  const first = await readCard()
  assert.equal(first.state, 'PENDING', first.errorMsg)
  assert.equal(first.outputDraft, '验收回执，合成数值 1729。')
  assert.ok(first.memoryDelta)
  const prompt = await readFile(inputFile, 'utf8')
  for (const text of ['[GLOBAL_SOURCE_OF_TRUTH]', '[EPISODIC_RECENT_CONTEXT]', '[PROCEDURAL_HARNESS_RULES]',
    '[ACTIVE_TASK_INSTRUCTION]', '合成研究数值 1729', '闪念：研究桥梁有待补充依据', '研究下一步 & | %']) assert.ok(prompt.includes(text), text)
  assert.ok(!prompt.includes('XX-FOREIGN-CTX-XX') && !prompt.includes('XX-FOREIGN-EVENT-XX'))
  const wave = await page.evaluate(taskId => window.__s9activations.find(item => item.runId === taskId), first.taskId)
  assert.ok(wave, 'The activation event must arrive for the dispatched task')
  assert.deepEqual(new Set(wave.activatedNoteIds), new Set([ids.bridge, ids.fact]))
  assert.equal(wave.edgePairs.length, 2)
  // This includes IPC in both directions and brackets PPR and the backend's emit.
  assert.ok(wave.pprElapsedMs >= 0 && wave.dispatchToReceivedMs >= wave.pprElapsedMs &&
    wave.dispatchToReceivedMs < 50, JSON.stringify(wave))
  assert.ok(await page.locator('.brain-edge--synaptic-flowing').count())
  pass('TODO sends four contextual sections and emits two-hop activation within the current project', wave)

  await page.getByRole('button', { name: '预览记忆提案' }).click()
  await dialog('记忆变更提案').getByText('第一轮补充说明', { exact: true }).waitFor()
  assert.equal(activeClaim(), undefined)
  assert.equal(await dialog('记忆变更提案').getByRole('button', { name: '应用记忆提案' }).count(), 0)
  await dialog('记忆变更提案').getByRole('button', { name: '关闭' }).click()
  await page.evaluate(() => {
    window.__s9Motion = []
    document.addEventListener('animationstart', event => {
      const node = event.target
      if (event.animationName === 'brain-evolution-ring' && node.matches('.brain-evolution-pulse')) {
        window.__s9Motion.push({ name: event.animationName, stroke: getComputedStyle(node).stroke })
      }
      if (event.animationName === 'brain-memory-migrate' && node.matches('.brain-memory-flight')) {
        const css = getComputedStyle(node)
        window.__s9Motion.push({ name: event.animationName, distanceX: parseFloat(css.getPropertyValue('--flight-x')) })
      }
      if (event.animationName === 'brain-crystallize') window.__s9Motion.push({ name: event.animationName })
    })
  })
  await page.evaluate(() => {
    const notes = window.workbench.notes
    const existing = notes.updateStrict
    notes.updateStrict = async () => {
      notes.updateStrict = existing
      throw new Error('database or disk is full')
    }
  })
  await editor.locator('[data-task-pill=adopt]').click()
  await page.getByText('磁盘空间不足，无法完成写入。释放空间后重试。', { exact: true }).waitFor()
  assert.equal((await readCard(first.taskId)).state, 'PENDING')
  assert.ok(!(await readFile(files.seed, 'utf8')).includes('DONE #' + first.taskId))
  pass('Disk-full message retains the pending receipt and allows adoption to be retried')
  await editor.locator('[data-task-pill=adopt]').click()
  await editor.locator('[data-task-pill=memory]').click()
  assert.equal(activeClaim(), undefined, 'Adopting the receipt alone must not apply its memory proposal')
  await dialog('记忆变更提案').getByRole('button', { name: '应用记忆提案' }).click()
  await dialog('记忆变更提案').getByText('记忆提案已应用。').waitFor()
  await dialog('记忆变更提案').getByRole('button', { name: '关闭' }).click()
  const claim = activeClaim()
  assert.equal(claim.claim_text, '初始事实 1729')
  const evolved = await readFile(files.fact, 'utf8')
  assert.match(evolved, /<!-- plate-evolution -->\r?\n第一轮补充说明\r?\n<!-- \/plate-evolution -->/)
  assert.equal(sql(db => db.prepare('SELECT delta_summary FROM memory_evolution_logs WHERE target_note_id=?')
    .get(ids.fact)).delta_summary, '补充第一轮观察\n更新事实 · 初始事实 1729')
  assert.ok(sql(db => db.prepare('SELECT 1 FROM note_link WHERE source_note_id=? AND target_note_id=?').get(ids.seed, ids.fact)))
  await page.evaluate(id => window.workbench.brain.applyDelta(id), first.taskId)
  assert.equal((await readFile(files.fact, 'utf8')).match(/第一轮补充说明/g).length, 1)
  assert.equal(await page.evaluate(async () => (await window.workbench.brain.skills()).length), 1)
  pass('Review gates changes; adoption writes assertion, Markdown, link and skill once')
  await until(() => page.evaluate(() => window.__s9Motion.some(motion =>
    motion.name === 'brain-evolution-ring' && motion.stroke === 'rgb(154, 85, 4)')), 'gold evolution ring')
  pass('A new note revision triggers the gold evolution ring')

  await writeFile(replyFile, reply('复核完成。', {
    assertion_updates: [{ note_id: ids.fact, old_claim_id: claim.id, new_claim: '修订事实 1730' }],
    note_evolutions: [{ target_note_id: ids.fact, append_insight: '第二轮更正', delta_summary: '更正测量值' }],
  }))
  const second = await page.evaluate(noteId => window.workbench.tasks.start({ noteId, taskId: 's9-second', promptText: '复核新数值' }), ids.seed)
  assert.equal((await readCard(second.taskId)).state, 'PENDING')
  const next = await readFile(inputFile, 'utf8')
  assert.ok(next.includes('研究复核流程') && next.includes('先核对链接来源') && next.includes('初始事实 1729'))
  const follow = await page.evaluate(runId => window.workbench.tasks.followUp(runId, '追加追问，保持来源'), second.taskId)
  assert.equal(follow.state, 'DOING')
  assert.equal((await readCard(second.taskId)).state, 'PENDING')
  const followed = await readFile(inputFile, 'utf8')
  assert.match(followed, /\[ACTIVE_TASK_INSTRUCTION\][\s\S]*复核新数值[\s\S]*复核完成。[\s\S]*追加追问，保持来源/)
  assert.ok(followed.includes('初始事实 1729'))
  await page.getByRole('button', { name: '关闭编辑抽屉', exact: true }).click()
  await page.evaluate(async (runId) => {
    await window.workbench.tasks.markDone(runId)
    await window.workbench.brain.applyDelta(runId)
  }, second.taskId)
  const history = await page.evaluate(id => window.workbench.brain.history(id), ids.fact)
  assert.equal(history.assertions[0].claim, '修订事实 1730')
  assert.ok(history.assertions[1].validTo)
  assert.equal(history.assertions[1].supersededById, history.assertions[0].id)
  assert.deepEqual(history.evolutions.map(entry => entry.version), [3, 2])
  const skill = (await page.evaluate(() => window.workbench.brain.skills()))[0]
  assert.equal(skill.usageCount, 2)
  assert.equal(skill.successCount, 1)
  pass('Matching skill and facts are reused on follow-up; superseded facts remain in the timeline')

  const ring = noteNode(ids.fact).locator('.brain-evolution-badge[aria-label="认知年轮 v3"] .brain-evolution-pulse')
  await ring.waitFor({ state: 'attached' })
  await ring.evaluate(node => {
    const animation = node.getAnimations()[0]
    if (animation) animation.currentTime = 210
  })
  await page.screenshot({ path: join(evidence, 'evolution-pulse.png') })
  await noteNode(ids.fact).locator('.brain-evolution-badge[aria-label="认知年轮 v3"]').dispatchEvent('click')
  await dialog(/认知年轮/).getByText('修订事实 1730', { exact: true }).waitFor()
  await dialog(/认知年轮/).getByText('历史断言').waitFor()
  await page.screenshot({ path: join(evidence, 'timeline.png') })
  await dialog(/认知年轮/).getByRole('button', { name: '关闭' }).click()

  await page.getByRole('combobox', { name: '导图分区' }).selectOption('default')
  await page.getByRole('button', { name: '做梦整理', exact: true }).click()
  await dialog('固化闪念').getByLabel('笔记标题').fill('固化的闪念')
  await dialog('固化闪念').getByRole('button', { name: '确认固化' }).click()
  await dialog('固化闪念').waitFor({ state: 'hidden' })
  const flying = page.locator('.brain-memory-flight')
  await flying.waitFor({ state: 'attached' })
  await flying.evaluate(node => {
    const animation = node.getAnimations()[0]
    if (animation) animation.currentTime = 145
  })
  await page.screenshot({ path: join(evidence, 'migration.png') })
  const consolidated = sql(db => db.prepare("SELECT * FROM episodic_events WHERE project_id='default' AND archived_at IS NOT NULL").get())
  assert.ok(consolidated.consolidated_note_id)
  assert.match(await readFile(join(workspace, 'projects', 'default', consolidated.consolidated_note_id + '.md'), 'utf8'), /研究桥梁有待补充依据/)
  assert.equal((await page.evaluate(() => window.workbench.brain.events('default'))).length, 0)
  await noteNode(consolidated.consolidated_note_id).waitFor({ state: 'attached' })
  assert.ok(!(await noteNode(consolidated.consolidated_note_id).textContent()).includes('plate-brain-write'))
  pass('Dream review consolidates a selected capture to indexed Markdown and archives the source')
  const motion = await until(() => page.evaluate(() => {
    const start = window.__s9Motion.findIndex(item => item.name === 'brain-memory-migrate')
    if (start < 0 || !window.__s9Motion.slice(start + 1).some(item => item.name === 'brain-crystallize')) return null
    return window.__s9Motion[start]
  }), 'flight into the semantic area followed by crystallization')
  assert.ok(motion.distanceX > 0, JSON.stringify(motion))
  pass('A capture flies from the episodic lane to the semantic card before crystallizing', motion)

  const vitality = page.getByRole('button', { name: '活力热力', exact: true })
  const fading = noteNode(ids.bridge)
  const fadingInk = fading.locator('.relationship-card-ink')
  await until(() => fading.evaluate(node =>
    node.dataset.brainActive === 'false' && !node.matches(':hover, :focus-within')), 'nonactivated fade sample')
  sql(db => db.prepare('UPDATE note SET last_accessed_at=?,access_count=1 WHERE id IN (?,?)')
    .run(Date.now() - 90 * 86_400_000, ids.bridge, ids.cold))
  assert.equal(await fadingInk.evaluate(node => Number(getComputedStyle(node).opacity)), 1)
  await page.screenshot({ path: join(evidence, 'vitality-before.png') })
  await fadingInk.evaluate(node => {
    const samples = []
    window.__s9FadeSamples = samples
    const start = performance.now()
    const sample = now => {
      const style = getComputedStyle(node)
      samples.push({
        elapsedMs: now - start, opacity: Number(style.opacity),
        vitality: Number(style.getPropertyValue('--node-vitality')),
        active: node.parentElement.dataset.brainActive === 'true',
        dormant: node.parentElement.dataset.brainDormant === 'true',
      })
      if (now - start < 900) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  await vitality.click()
  await until(() => fadingInk.evaluate(node => {
    const style = getComputedStyle(node)
    const vitality = Number(style.getPropertyValue('--node-vitality'))
    return vitality < 0.22 && Math.abs(Number(style.opacity) - (0.38 + 0.62 * vitality)) < 0.001
  }), 'low-vitality card reaches its final opacity')
  const fade = sql(db => db.prepare('SELECT vitality_score AS vitality, is_dormant AS dormant FROM note WHERE id=?')
    .get(ids.bridge))
  assert.equal(fade.dormant, 0)
  assert.ok(fade.vitality < 0.22)
  assert.equal(await fading.locator('.brain-dormant-dot').count(), 0)
  const fadingFrames = await page.evaluate(() => window.__s9FadeSamples)
  const finalOpacity = 0.38 + 0.62 * fade.vitality
  const intermediate = fadingFrames.filter(frame => Math.abs(frame.vitality - fade.vitality) < 0.0001 &&
    frame.opacity > finalOpacity + 0.015 && frame.opacity < 0.985)
  assert.ok(new Set(intermediate.map(frame => frame.opacity)).size >= 3,
    'Expected multiple intermediate opacity values with the recalculated vitality')
  assert.ok(fadingFrames.every(frame => !frame.active && !frame.dormant))
  assert.match(await fadingInk.textContent(), /研究桥梁/)
  await page.screenshot({ path: join(evidence, 'vitality-faded.png') })
  pass('Low-vitality non-dormant card fades through intermediate opacity values and stays a card', {
    ...fade, initialOpacity: 1, finalOpacity,
    sampledFrames: intermediate.length,
    samples: [intermediate[0], intermediate[Math.floor(intermediate.length / 2)], intermediate.at(-1)],
  })
  await page.locator('[data-graph-node="' + ids.cold + '"][data-brain-dormant=true]').waitFor({ state: 'attached' })
  const dormant = noteNode(ids.cold)
  const dot = dormant.locator('.brain-dormant-dot')
  const ink = dormant.locator('.relationship-card-ink')
  const opacity = locator => locator.evaluate(el => getComputedStyle(el).opacity)
  await until(async () => (await opacity(ink)) === '0', 'dormant card initially collapsed')
  const dotBox = await dot.boundingBox()
  assert.ok(dotBox && dotBox.width > 0 && dotBox.height > 0)
  await page.screenshot({ path: join(evidence, 'dormant-collapsed.png') })
  await dot.hover()
  await until(() => dormant.evaluate(node => node.matches(':hover') && !node.matches(':focus-within')),
    'pointer hover is applied without keyboard focus')
  await until(async () => (await opacity(ink)) === '1', 'mouse hover expands dormant card')
  assert.equal(await opacity(dot), '0')
  assert.match(await ink.textContent(), /休眠样本/)
  await page.screenshot({ path: join(evidence, 'dormant-hover.png') })
  await vitality.hover()
  await until(async () => (await opacity(ink)) === '0', 'pointer exit collapses dormant card')
  assert.equal(await opacity(dot), '1')
  pass('Hovering the dormant dot reveals its card without keyboard focus, and leaving restores the dot', {
    dotWidth: dotBox.width, dotHeight: dotBox.height,
  })
  await noteNode(ids.cold).focus()
  await until(async () => (await noteNode(ids.cold).locator('.relationship-card-ink').evaluate(node => getComputedStyle(node).opacity)) === '1', 'dormant focus expansion')
  await page.screenshot({ path: join(evidence, 'brain-light.png') })
  await page.getByRole('button', { name: '切换至深色主题' }).click()
  await page.screenshot({ path: join(evidence, 'brain-dark.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(await noteNode(ids.cold).locator('.relationship-card-ink').evaluate(el => getComputedStyle(el).transitionDuration), '0s')
  pass('Vitality decays; dormant card expands on keyboard focus and respects reduced motion')
  await page.getByRole('button', { name: '活力热力', exact: true }).click()
  await page.keyboard.press('Control+Shift+Space')
  await dialog('捕获闪念').getByRole('textbox', { name: '闪念内容' }).fill('减少动态效果验收')
  await page.keyboard.press('Enter')
  await page.locator('.brain-episodic-card').filter({ hasText: '减少动态效果验收' })
    .getByRole('button', { name: '固化', exact: true }).click()
  await dialog('固化闪念').getByLabel('保存位置').selectOption(consolidated.consolidated_note_id)
  await dialog('固化闪念').getByRole('button', { name: '确认固化' }).click()
  const highlighted = noteNode(consolidated.consolidated_note_id).and(page.locator('[data-brain-crystal=true]'))
  await highlighted.waitFor({ state: 'attached' })
  assert.equal(await highlighted.locator('.relationship-card-ink').evaluate(el => getComputedStyle(el).animationName), 'none')
  assert.equal(await page.locator('.brain-memory-flight').count(), 0)
  pass('Reduced motion consolidates into an existing note with a static highlight')

  // Simulate an interruption between the atomic Markdown rename and the SQLite acknowledgement.
  const writeId = '00000000-0000-4000-8000-000000000099'
  const marker = '<!-- plate-brain-write:' + writeId + ' -->'
  const recoveryText = '合成断点恢复内容'
  await writeFile(files.cold, (await readFile(files.cold, 'utf8')) + '\n\n' + marker + '\n' + recoveryText + '\n')
  sql(db => db.prepare('INSERT INTO brain_note_writes(id,note_id,project_id,appendix,created_at) VALUES(?,?,?,?,?)')
    .run(writeId, ids.cold, 'default', recoveryText, Date.now()))
  await close()
  await open()
  assert.equal((await readFile(files.cold, 'utf8')).split(recoveryText).length - 1, 1)
  assert.equal(await page.evaluate(async () => (await window.workbench.brain.status()).contextEnabled), true)
  assert.equal(activeClaim().claim_text, '修订事实 1730')
  assert.equal(sql(db => db.prepare('SELECT COUNT(*) AS n FROM brain_note_writes').get().n), 0)
  assert.equal((await page.evaluate(() => window.workbench.brain.skills()))[0].usageCount, 2)
  pass('Restart preserves memory history, context settings and skill counts')
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
