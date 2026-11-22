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
const sandbox = await mkdtemp(join(temp, 'plate-s10-m4-'))
const workspace = join(sandbox, 'workspace')
const notes = join(workspace, 'projects', 'default')
const logs = join(sandbox, 'logs')
const seeds = { anchor: randomUUID(), linked: randomUUID(), private: randomUUID() }
const linkedFile = join(notes, seeds.linked + '.md')
const before = '# 关联长期记忆\n\n整理前的合成事实。\n'
const after = '# 关联长期记忆\n\n整理后经审阅的事实。\n'
const fixture = '日志内容合成验收'
const synthesis = '模型整理后供人工复核的结论。'
const key = 'fixture-m4-' + randomUUID()
for (const dir of [notes, logs]) await mkdir(dir, { recursive: true })
await writeFile(join(workspace, 'plate-workbench.json'), '{"version":"0.5.0-s9.6"}')
await writeFile(join(notes, seeds.anchor + '.md'), '# 种子笔记甲\n\n- [[' + seeds.linked + '|关联长期记忆]]\n- [[' + seeds.private + '|私有笔记]]\n')
await writeFile(linkedFile, before)
await writeFile(join(notes, seeds.private + '.md'), '# 私有笔记\n\nPRIVATE_CONTENT_MARKER\n')
await writeFile(join(logs, 'fixture.jsonl'), JSON.stringify({ role: 'user', content: fixture }) + '\n')
const skillPath = join(sandbox, 'SKILL.md')
await writeFile(skillPath, '---\nname: S10 汇总技能\n---\n基于授权来源汇总并提出差异。\n')

let forwardTools
const allowTools = new Promise(done => { forwardTools = done })
let checkedContext = false, checkedReview = false, checkedDream = false
function send(target, data) { target.write('data: ' + JSON.stringify(data) + '\n\n') }
const backend = createServer(async (request, response) => {
  if (request.headers.authorization !== 'Bearer ' + key || request.url !== '/v1/chat/completions') {
    response.writeHead(401).end()
    return
  }
  let raw = ''
  for await (const buffer of request) raw += buffer
  const input = JSON.parse(raw)
  const taskContext = input.messages[0]?.content ?? ''
  const toolContent = input.messages.find(message => message.role === 'tool')
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (taskContext.includes('待用户审阅的 Markdown')) {
    checkedDream = !input.tools && taskContext.includes('工作台任务') && !taskContext.includes('PRIVATE_CONTENT_MARKER')
    send(response, { choices: [{ delta: { content: JSON.stringify({ title: '模型固化建议', summary: synthesis }) } }] })
  } else if (toolContent) {
    checkedReview = Boolean(JSON.parse(toolContent.content).diffId)
    send(response, { choices: [{ delta: { content: '已提交笔记变更，等待审阅。' } }] })
  } else {
    checkedContext = taskContext.includes('[LOCAL_AGENT_LOGS]') && taskContext.includes(fixture)
      && taskContext.includes('关联长期记忆') && taskContext.includes('基于授权来源汇总')
      && !taskContext.includes('PRIVATE_CONTENT_MARKER')
    send(response, { choices: [{ delta: { content: '正在整理长期记忆。' } }] })
    await allowTools
    send(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'm4-tool-id', function: {
      name: 'propose_note_update', arguments: JSON.stringify({ noteId: seeds.linked, content: after, rationale: '合成笔记审阅' }),
    } }] } }] })
    send(response, { choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 50, completion_tokens: 20 } })
    response.end('data: [DONE]\n\n')
    return
  }
  send(response, { choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 55, completion_tokens: 26 } })
  response.end('data: [DONE]\n\n')
})
async function listen(socket) {
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  return socket.address().port
}
const apiPort = await listen(backend)
const debug = createServer()
const debugPort = await listen(debug)
await new Promise(done => debug.close(done))
const address = 'http://127.0.0.1:' + debugPort
async function awaitHttp(url, child) {
  for (let index = 0; index < 200; index++) {
    assert.equal(child.exitCode, null, 'child exited before ' + url)
    if (await fetch(url).then(result => result.ok, () => false)) return
    await delay(100)
  }
  throw new Error('Timeout: ' + url)
}

let app, browser, page, server, providerId, passed = false
const errors = []
try {
  server = spawn(process.execPath, [join(source, 'node_modules', 'vite', 'bin', 'vite.js'), '--strictPort'],
    { cwd: source, stdio: 'inherit', windowsHide: true })
  await awaitHttp('http://127.0.0.1:5173', server)
  app = spawn(resolve(process.argv[2] ?? join(source, 'src-tauri', 'target', 'debug', 'plate-workbench.exe')), [], {
    cwd: sandbox, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, PLATE_WORKSPACE_ROOT: workspace, PLATE_AGENT_SETTINGS_DIR: join(sandbox, 'agent-settings'),
      WEBVIEW2_USER_DATA_FOLDER: join(sandbox, 'webview'), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + debugPort },
  })
  await awaitHttp(address + '/json/version', app)
  browser = await chromium.connectOverCDP(address)
  page = browser.contexts()[0].pages()[0]
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.setDefaultTimeout(12_000)
  const rail = page.getByRole('navigation', { name: '主导航' })
  const button = name => page.getByRole('button', { name, exact: true })
  await rail.waitFor()
  assert.equal(Math.round((await rail.boundingBox()).width), 56)
  assert.equal(Math.round((await page.locator('.s10-header').boundingBox()).height), 44)
  assert.equal(await rail.getByRole('button').count(), 5)
  assert.equal((await rail.innerText()).trim(), '')
  assert.equal(await page.locator('.s10-composer-footer').getByRole('button').count(), 5)
  assert.equal(await page.getByRole('complementary', { name: '暂存审阅' }).count(), 0)
  const prompt = page.getByRole('textbox', { name: '任务内容' })
  const composer = page.locator('.composer-island')
  const panel = page.locator('.floating-popover')
  const empty = page.getByRole('heading', { name: '从一个任务或一份资料开始' })
  await empty.waitFor()
  assert.equal(await page.locator('.s10-starters button').count(), 3)
  assert.deepEqual(await prompt.evaluate(node => {
    const css = getComputedStyle(node)
    return [css.borderTopWidth, css.resize, css.backgroundColor, css.minHeight, css.maxHeight,
      getComputedStyle(node, '::placeholder').color]
  }), ['0px', 'none', 'rgba(0, 0, 0, 0)', '52px', '180px', 'rgb(156, 163, 175)'])
  assert.equal(await composer.evaluate(node => getComputedStyle(node).borderRadius), '20px')
  await button('整理本机排错记录并沉淀笔记').click()
  assert.match(await prompt.inputValue(), /排错记录/)
  assert.equal(await prompt.evaluate(node => node === document.activeElement), true)
  await prompt.press('Shift+Enter')
  assert.match(await prompt.inputValue(), /\n/)
  const originalHeight = (await prompt.boundingBox()).height
  await prompt.fill(Array.from({ length: 20 }, (_, i) => '第 ' + i + ' 行').join('\n'))
  assert.ok((await prompt.boundingBox()).height > originalHeight)
  assert.equal(Math.round((await prompt.boundingBox()).height), 180)
  await prompt.fill('')
  const position = await composer.boundingBox()
  for (const name of ['模型与引擎', '引用笔记', '引用记录', '任务权限']) {
    const trigger = button(name)
    await trigger.click()
    await panel.waitFor()
    await panel.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
    assert.deepEqual(await composer.boundingBox(), position, name + ' moved the composer')
    assert.equal(await panel.evaluate(node => getComputedStyle(node).borderRadius), '14px')
    assert.ok(Math.abs((await panel.boundingBox()).y + (await panel.boundingBox()).height - position.y + 10) <= 1)
    if (name === '模型与引擎') {
      const cli = panel.getByRole('button', { name: /本机 CLI/ }).first()
      await cli.click()
      assert.equal(await cli.getAttribute('aria-pressed'), 'true')
      assert.ok(await cli.evaluate(node => node.clientHeight >= node.querySelector('span').offsetHeight + 10))
      assert.deepEqual(await composer.boundingBox(), position, 'engine change moved the composer')
      await panel.getByRole('button', { name: /使用工作台角色配置/ }).click()
      if (process.env.PLATE_S10_EVIDENCE) {
        await mkdir(process.env.PLATE_S10_EVIDENCE, { recursive: true })
        await page.mouse.move(650, 90)
        await page.screenshot({ path: join(process.env.PLATE_S10_EVIDENCE, 'model-popover.png') })
      }
      await trigger.focus()
      await page.keyboard.press('Escape')
    } else {
      await empty.click()
    }
    await panel.waitFor({ state: 'hidden' })
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
  }
  assert.equal(await page.locator('button[title]').count(), 0)
  await rail.getByRole('button', { name: '工作台' }).hover()
  const tooltip = page.locator('.plate-action-tooltip')
  await tooltip.waitFor()
  assert.match(await tooltip.textContent(), /工作台/)
  assert.equal(await tooltip.evaluate(node => getComputedStyle(node).borderRadius), '8px')
  assert.ok((await tooltip.boundingBox()).x > (await rail.boundingBox()).width)
  await page.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'hidden' })
  if (process.env.PLATE_S10_EVIDENCE) {
    await page.screenshot({ path: join(process.env.PLATE_S10_EVIDENCE, 'empty-workbench.png') })
  }
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  await page.setViewportSize({ width: 860, height: 600 })
  await prompt.fill('合成输入\n'.repeat(30))
  const compact = await composer.boundingBox()
  await button('任务权限').focus()
  await page.keyboard.press('Enter')
  await panel.waitFor()
  await panel.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
  assert.deepEqual(await composer.boundingBox(), compact)
  assert.ok((await panel.boundingBox()).y >= 44, 'permission menu must stay below the header')
  assert.equal(await panel.locator('textarea').evaluate(node => node === document.activeElement), true)
  await page.keyboard.press('Escape')
  await panel.waitFor({ state: 'hidden' })
  assert.equal(await button('任务权限').evaluate(node => node === document.activeElement), true)
  await prompt.fill('')
  await page.setViewportSize(viewport)
  async function toggleTheme(theme) {
    await button('命令面板').click()
    await page.getByRole('combobox', { name: '查找命令' }).fill('切换明暗主题')
    await page.getByRole('option', { name: /切换明暗主题/ }).click()
    await page.locator('html.theme-' + theme).waitFor()
  }
  await toggleTheme('dark')
  assert.equal(await composer.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(18, 18, 21)')
  if (process.env.PLATE_S10_EVIDENCE) {
    await page.screenshot({ path: join(process.env.PLATE_S10_EVIDENCE, 'dark-workbench.png') })
  }
  await toggleTheme('light')
  await button('命令面板').click()
  await page.locator('dialog[data-element="M51.palette"][open]').waitFor()
  await page.keyboard.press('Escape')
  await page.locator('dialog[data-element="M51.palette"][open]').waitFor({ state: 'hidden' })
  await page.keyboard.press('Control+4')
  await page.getByRole('heading', { name: '技能库' }).waitFor()

  providerId = await page.evaluate(async ({ baseUrl, apiKey }) => {
    return (await window.workbench.providers.upsert({ name: 'M4 local fixture', kind: 'openai_compatible',
      baseUrl, defaultModel: 'fixture', roles: ['workbench_chat','brain_consolidator'],
      inputPricePer1m: 1, outputPricePer1m: 1, enabled: true, apiKey })).id
  }, { baseUrl: 'http://127.0.0.1:' + apiPort + '/v1', apiKey: key })
  await button('技能更多操作').click()
  const importedFile = page.waitForEvent('filechooser')
  await button('导入 SKILL.md').click()
  await (await importedFile).setFiles(skillPath)
  await page.getByText(/已读取技能文件/).waitFor()
  assert.equal(await page.getByLabel('技能名称').inputValue(), 'S10 汇总技能')
  await page.getByLabel('可使用已获任务授权的模型连接').check()
  await button('保存技能').click()
  await page.getByText('技能已保存。').waitFor()
  await button('在工作台试用').click()
  await page.getByRole('list', { name: '任务引用' }).getByText('S10 汇总技能').waitFor()

  await rail.getByRole('button', { name: '大脑视图' }).click()
  await page.getByLabel('任务使用大脑上下文').click()
  await page.waitForFunction(() => document.querySelector('.brain-context-control input[type=checkbox]')?.checked)
  assert.equal(await page.locator('.brain-hud-actions').getByRole('button').count(), 3)
  assert.equal((await page.locator('.brain-hud-actions').innerText()).trim(),'')
  const vitalityBefore = await page.evaluate(id => window.workbench.brain.metadata().then(items => items[id]), seeds.linked)
  await rail.getByRole('button', { name: '模型与权限' }).click()
  await button('本机记录来源').click()
  await page.getByLabel('扫描 Claude Code 和 Codex 默认目录').uncheck()
  await page.getByLabel('自定义目录').fill(logs)
  await button('保存本机偏好').click()
  await page.getByText('本机偏好已保存。').waitFor()

  await rail.getByRole('button', { name: '资料与记录' }).click()
  await button('本机 Agent 记录').click()
  await button('扫描记录').click()
  await page.getByText('扫描 1 个文件，更新 1 个会话，导入 1 条消息。').waitFor()
  const row = page.locator('.s10-row').filter({ hasText: fixture })
  assert.equal(await row.locator('.s10-row-actions').evaluate(node => getComputedStyle(node).opacity), '0')
  await row.getByRole('button', { name: '引用到工作台' }).focus()
  await page.waitForFunction(() => getComputedStyle(document.activeElement.closest('.s10-row-actions')).opacity === '1')
  await page.getByRole('heading', { name: '本机 Agent 记录' }).hover()
  await row.hover()
  await row.getByRole('button', { name: '引用到工作台' }).click()
  await page.getByRole('list', { name: '任务引用' }).getByText(fixture).waitFor()
  await page.getByLabel('任务内容').fill('把会话摘要与笔记整理成待审阅变更。')
  await button('引用笔记').click()
  await page.locator('.s10-composer').getByLabel('种子笔记', { exact: true }).selectOption(seeds.anchor)
  await page.locator('.s10-composer').getByLabel('其他授权笔记', { exact: true }).selectOption(seeds.linked)
  await button('任务权限').click()
  await page.getByLabel('允许连接所选模型服务并提交任务上下文').check()
  await button('任务权限').click()
  if (process.env.PLATE_S10_EVIDENCE) {
    await mkdir(process.env.PLATE_S10_EVIDENCE, { recursive: true })
    await page.screenshot({ path: join(process.env.PLATE_S10_EVIDENCE, 'composer.png') })
  }
  await prompt.press('Enter')
  await empty.waitFor({ state: 'hidden' })
  await page.getByRole('list', { name: '激活的长期记忆' }).getByText('关联长期记忆').waitFor()
  assert.equal(await page.getByRole('list', { name: '激活的长期记忆' }).getByText('私有笔记').count(), 0)
  await page.getByLabel('Agent 输出').getByText('正在整理长期记忆。').waitFor()
  assert.equal(await readFile(linkedFile, 'utf8'), before)
  forwardTools()
  await button('暂存审阅').click()
  await page.getByLabel('变更对比').getByText(/整理后经审阅的事实/).waitFor()
  assert.equal(await readFile(linkedFile, 'utf8'), before)
  assert.ok(checkedContext && checkedReview)
  if (process.env.PLATE_S10_EVIDENCE) {
    await mkdir(process.env.PLATE_S10_EVIDENCE, { recursive: true })
    await page.screenshot({ path: join(process.env.PLATE_S10_EVIDENCE, 'workbench-review.png') })
  }
  await button('审阅并应用').click()
  await page.getByRole('complementary', { name: '暂存审阅' }).getByText(/已应用/).waitFor()
  assert.equal(await readFile(linkedFile, 'utf8'), after)
  const vitalityAfter = await page.evaluate(id => window.workbench.brain.metadata().then(items => items[id]), seeds.linked)
  assert.notEqual(vitalityAfter.vitality, vitalityBefore.vitality)
  assert.ok(vitalityAfter.vitality >= 0.05 && vitalityAfter.vitality <= 1)
  assert.equal(vitalityAfter.version, vitalityBefore.version + 1)
  const history = await page.evaluate(id => window.workbench.brain.history(id), seeds.linked)
  assert.equal(history.evolutions[0].summary, '合成笔记审阅')
  const [skill] = await page.evaluate(() => window.workbench.brain.skills())
  assert.equal(skill.usageCount, 1)
  assert.equal(skill.successCount, 1)

  await rail.getByRole('button', { name: '大脑视图' }).click()
  await page.getByRole('complementary', { name: '海马体 · 短期闪念' }).getByText(/工作台任务/).waitFor()
  if (process.env.PLATE_S10_EVIDENCE) await page.screenshot({ path: join(process.env.PLATE_S10_EVIDENCE, 'brain-hud.png') })
  await button('做梦整理').click()
  const dialog = page.getByRole('dialog', { name: '固化闪念' })
  await dialog.getByRole('button', { name: '用模型整理所选闪念' }).click()
  await dialog.getByLabel('审阅排版和正文').waitFor()
  assert.equal(await dialog.getByLabel('审阅排版和正文').inputValue(), synthesis)
  assert.ok(checkedDream)
  await dialog.getByRole('button', { name: '确认固化' }).click()
  await dialog.waitFor({ state: 'hidden' })
  const dreamed = await page.evaluate(async () => {
    const note = (await window.workbench.notes.list()).find(item => item.title === '模型固化建议')
    return note ? window.workbench.notes.read(note.id) : undefined
  })
  assert.ok(dreamed?.content.includes(synthesis))
  const flash = page.getByRole('textbox', { name: '输入海马体闪念' })
  assert.equal(await flash.getAttribute('placeholder'), '输入学习闪念，按 Enter 存入海马体…')
  await flash.fill('内联捕获 · 合成闪念')
  await flash.press('Enter')
  await page.getByRole('complementary', { name: '海马体 · 短期闪念' }).getByText('内联捕获 · 合成闪念').waitFor()
  await page.waitForFunction(() => document.querySelector('.brain-capture-inline textarea')?.value === '')

  await rail.getByRole('button', { name: '资料与记录' }).click()
  await button('本地笔记库').click()
  const id = await page.evaluate(async () => (await window.workbench.notes.create('S10 UI 合成空白笔记', 'default')).id)
  const blankNode = page.locator('[data-graph-node="' + id + '"]')
  await blankNode.waitFor()
  await blankNode.focus()
  await blankNode.press('Shift+Enter')
  const title = page.getByRole('textbox', { name: '笔记标题' })
  const body = page.locator('[data-editor-host="render"]')
  const emptyBody = page.locator('[data-editor-blank=true]')
  await title.waitFor()
  assert.equal(await title.getAttribute('placeholder'), '输入笔记标题…')
  await emptyBody.waitFor()
  await title.fill('')
  assert.equal(await title.inputValue(), '')
  await title.fill('验收标题')
  await body.focus()
  await page.keyboard.insertText('合成 Markdown 正文')
  await emptyBody.waitFor({ state: 'hidden' })
  await button('保存').click()
  await page.waitForFunction(async id => (await window.workbench.notes.read(id)).content.includes('合成 Markdown 正文'), id)
  await button('关闭编辑抽屉').click()
  await page.locator('.plate-map-search-entry').click()
  const search = page.getByRole('dialog', { name: '搜索或跳转' })
  await search.getByRole('searchbox').fill('验收标题')
  const noteAttach = search.getByRole('button', { name: '引用到工作台：验收标题' })
  await noteAttach.waitFor()
  const noteRow = noteAttach.locator('xpath=ancestor::li')
  assert.equal(await noteRow.locator('.s10-row-actions').evaluate(node => getComputedStyle(node).opacity), '0')
  await noteRow.hover()
  await noteAttach.click()
  const noteChips = page.getByRole('list', { name: '任务引用' })
  await noteChips.getByText('验收标题', { exact: true }).waitFor()
  await noteChips.getByRole('button', { name: '移除引用 验收标题' }).click()
  await noteChips.getByText('验收标题', { exact: true }).waitFor({ state: 'hidden' })
  assert.deepEqual(errors, [])
  passed = true
  console.log('PASS S10 M4: UI dimensions, icon/keyboard interactions, local log attribution, scoped memory activation, reviewed note/vitality/evolution, episode/skill counters and model-assisted consolidation.')
} finally {
  forwardTools()
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
  if (passed && dirname(sandbox) === temp && basename(sandbox).startsWith('plate-s10-m4-')) {
    await rm(sandbox, { recursive: true, force: true, maxRetries: 3 })
  } else { console.error('Smoke fixture:', sandbox) }
}
