import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../source/package.json', import.meta.url))
const { chromium } = require('playwright')
const exe = resolve(process.argv[2] ?? join(here, '../source/src-tauri/target/release/plate-workbench.exe'))
const run = await mkdtemp(join(tmpdir(), 'plate-s8-run-'))
const root = join(run, 'workspace')
await mkdir(root)
const profile = join(run, 'webview')

const agentFixture = join(run, 'agent-fixture.cjs')
await writeFile(agentFixture, [
  "process.stdin.setEncoding('utf8')",
  "let body = ''",
  "process.stdin.on('data', part => { body += part })",
  "process.stdin.on('end', () => console.log('S8 stub response'))",
].join('\n'))
const agentShim = join(run, 'codex.cmd')
await writeFile(agentShim, `@echo off\r\nnode "${agentFixture.replace(/"/g, '""')}" %*\r\n`)

const claudeShim = join(run, "claude.cmd")
await writeFile(claudeShim, await (await import("node:fs/promises")).readFile(agentShim))
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^PLATE_AGENT_/i.test(key)) delete env[key]
env.PLATE_AGENT_CODEX = agentShim
env.PLATE_AGENT_CLAUDE = claudeShim
const pathEnv = Object.keys(env).find(key => /^path$/i.test(key)) ?? "Path"
env[pathEnv] = run + ";" + (env[pathEnv] ?? "")
env.PLATE_AGENT_SETTINGS_DIR = join(run, "agent-settings")

const results = { candidate: exe, workspace: root, passed: [] }
let child
let page

function passed(name, proof = true) {
  results.passed.push({ name, proof })
  console.log(name, JSON.stringify(proof))
}

async function waitFor(predicate, label, budget = 10000) {
  const until = Date.now() + budget
  do {
    const result = await predicate()
    if (result) return result
    await sleep(75)
  } while (Date.now() < until)
  throw new Error('Timed out: ' + label)
}

async function open() {
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise(accept => server.close(accept))
  const endpoint = 'http://127.0.0.1:' + port
  child = spawn(exe, [], {
    windowsHide: true,
    stdio: 'ignore',
    cwd: run,
    env: {
      ...env,
      PLATE_WORKSPACE_ROOT: root,
      WEBVIEW2_USER_DATA_FOLDER: profile,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port,
    },
  })
  await waitFor(() => fetch(endpoint + '/json/version').then(request => request.ok, () => false), 'WebView2 startup', 15000)
  const browser = await chromium.connectOverCDP(endpoint)
  page = browser.contexts()[0].pages()[0]
  page.setDefaultTimeout(10000)
  await page.waitForFunction(() => !!window.workbench)
  const startup = await page.evaluate(() => window.workbench.startup.state())
  assert.equal(startup.path ?? startup.suggested, root, 'verify isolated target before any write')
  const enter = page.getByRole('button', { name: '打开笔记', exact: true })
  if (await enter.isVisible()) await enter.click()
  await page.getByRole('region', { name: '笔记关系图' }).waitFor()
}

async function close() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit').then(() => true)
  if (page) void page.evaluate(() => window.workbench.startup.exit()).catch(() => {})
  if (!await Promise.race([exited, sleep(3200, false)])) {
    child.kill()
    await exited
  }
}

const drawer = () => page.locator('[aria-label="笔记编辑抽屉"]')
const node = id => page.locator('[data-graph-node=' + JSON.stringify(id) + ']')
const editor = () => drawer().locator('[data-editor-host=render]')

async function createNote(title, content) {
  return page.evaluate(async ({ title, content }) => {
    const created = await window.workbench.notes.create(title, 'default', 'blank')
    const result = await window.workbench.notes.update(created.id, content, created.revision)
    if (result.status !== 'saved') throw new Error('createNote save failed: ' + result.status)
    return result.note
  }, { title, content })
}

async function openNote(id) {
  await node(id).dispatchEvent('dblclick', { detail: 2 })
  await waitFor(() => drawer().getAttribute('data-open').then(value => value === 'true'), 'open editor')
  await editor().waitFor()
}

async function focusFixture(text) {
  const block = editor().locator("[data-editor-role=paragraph]").filter({ hasText: text }).last()
  await block.evaluate(async (element, expected) => {
    element.closest('[contenteditable]').focus()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let leaf
    while ((leaf = walker.nextNode()) && !leaf.textContent.includes(expected)) { }
    if (!leaf) throw new Error('Fixture text not found: ' + expected)
    const offset = leaf.textContent.indexOf(expected) + expected.length
    document.getSelection().collapse(leaf, offset)
    await new Promise(requestAnimationFrame)
  }, text)
}
async function saveCurrent() {
  await drawer().getByRole("button", { name: "保存", exact: true }).click()
}
async function layout(id) {
  return page.evaluate(id => window.workbench.graphLayout.getAll().then(all => all[id]), id)
}

try {
  await open()

  const layoutNote = await createNote('布局验收', '# 布局验收\n正文包含搜索锚点\n')
  await node(layoutNote.id).waitFor()

  await page.locator('.plate-map-hud--left').waitFor()
  await page.locator('.plate-map-hud--right').waitFor()
  await page.locator('.plate-map-hud--dock').waitFor()
  await page.locator('.relations-canvas').waitFor()
  await page.locator('.relations-list').waitFor({ state: 'detached' })
  await page.locator('.plate-map-hud--left [alt="[plate]"]').waitFor()
  const canvasBox = await page.locator('.relations-canvas').boundingBox()
  assert.ok(canvasBox)
  assert.equal(Math.round(canvasBox.width), await page.evaluate(() => innerWidth))
  assert.equal(Math.round(canvasBox.height), await page.evaluate(() => innerHeight))
  assert.equal(await page.locator('.plate-map-shell .notes-sidebar, .plate-map-shell .notes-tree').count(), 0)
  await page.locator('.plate-map-hud--dock button', { hasText: '新建主节点' }).click()
  const rootNode = await waitFor(async () => (await page.evaluate(() => window.workbench.notes.list()))
    .find(note => note.title === '新笔记'), 'create root via dock')
  await node(rootNode.id).waitFor()

  await page.keyboard.press('Control+K')
  const search = page.getByRole('dialog', { name: '搜索或跳转' })
  await search.waitFor()
  await search.getByLabel('搜索笔记标题或正文').fill('搜索锚点')
  await search.getByRole('button', { name: '布局验收' }).click()
  await search.waitFor({ state: 'hidden' })
  await waitFor(() => node(layoutNote.id).getAttribute('data-selected').then(value => value === 'true'), 'search locates node')
  passed('AC-1 full-screen map HUD and Ctrl+K search', { width: canvasBox.width, height: canvasBox.height })

  await node(layoutNote.id).focus()
  await page.keyboard.press('Tab')
  const childNote = await waitFor(async () =>
    (await page.evaluate(async parent => {
      const all = await window.workbench.graphLayout.getAll()
      return Object.entries(all).find(([, entry]) => entry.parentNoteId === parent)
    }, layoutNote.id))?.[0], 'create child node')
  await node(childNote).waitFor()
  const [, parentX] = /translate\(([^ ]+)/.exec(await node(layoutNote.id).getAttribute('transform'))
  assert.ok((await layout(childNote)).x > Number(parentX), 'child is right of parent')
  await node(childNote).focus()
  await page.keyboard.press('Enter')
  const siblingNote = await waitFor(async () =>
    (await page.evaluate(async ({ child }) => {
      const all = await window.workbench.graphLayout.getAll()
      return Object.entries(all).find(([id, entry]) => id !== child && entry.parentNoteId === all[child].parentNoteId)
    }, { child: childNote }))?.[0], 'create sibling node')
  const childLayout = await layout(childNote)
  const siblingLayout = await layout(siblingNote)
  assert.equal(siblingLayout.x, childLayout.x, 'sibling x equals child x')
  assert.ok(siblingLayout.y > childLayout.y, 'sibling is below child')
  await node(layoutNote.id).locator('.relationship-collapse').click()
  await waitFor(async () => (await layout(layoutNote.id)).collapsed === true, 'collapse persisted')
  assert.equal(await node(childNote).count() + await node(siblingNote).count(), 0, 'children hidden after collapse')
  await close()
  await open()
  await node(layoutNote.id).waitFor()
  await page.waitForSelector('[data-collapsed=true]')
  assert.equal(await node(childNote).count() + await node(siblingNote).count(), 0, 'collapse survives restart')
  await node(layoutNote.id).focus()
  await page.keyboard.press('c')
  await waitFor(async () => (await layout(layoutNote.id)).collapsed === false, 'expand persisted')
  await node(childNote).waitFor()
  await node(siblingNote).waitFor()
  const beforeDoubleClick = await page.evaluate(() => window.workbench.notes.list().then(notes => notes.length))
  await node(layoutNote.id).dblclick()
  await drawer().waitFor({ state: 'visible' })
  assert.equal(await drawer().getByRole('textbox', { name: '笔记标题' }).inputValue(), '布局验收')
  assert.equal(await page.evaluate(() => window.workbench.notes.list().then(notes => notes.length)), beforeDoubleClick)
  await drawer().getByRole('button', { name: '关闭编辑抽屉' }).click()
  await drawer().waitFor({ state: 'hidden' })
  passed('AC-2 Tab child, Enter sibling, collapse and expand', {
    child: childNote,
    sibling: siblingNote,
    childX: childLayout.x,
    childY: childLayout.y,
    siblingX: siblingLayout.x,
    siblingY: siblingLayout.y,
  })

  const themeButton = page.locator('.plate-map-hud--right button[aria-label="切换至深色主题"]')
  if (await themeButton.count()) await themeButton.click()
  await page.locator('.theme-dark').waitFor()
  const darkStyles = await page.evaluate(() => {
    const shell = document.querySelector('.shell')
    const kbd = document.querySelector('.plate-map-hud--left kbd')
    return {
      bodyFont: getComputedStyle(shell).fontSize,
      codeFont: getComputedStyle(kbd).fontFamily,
      background: getComputedStyle(shell).backgroundColor,
      accent: getComputedStyle(shell).getPropertyValue('--color-accent-primary').trim(),
      markdownBody: getComputedStyle(document.documentElement).getPropertyValue('--font-size-markdown-body').trim(),
    }
  })
  assert.equal(darkStyles.bodyFont, '13.5px')
  assert.equal(darkStyles.markdownBody, '14px')
  assert.ok(darkStyles.codeFont.includes('JetBrains Mono'))
  assert.equal(darkStyles.background, 'rgb(9, 9, 11)')
  assert.equal(darkStyles.accent, '#6366f1')
  const styleBefore = await page.evaluate(() => {
    const graph = document.querySelector('.relations')
    return {
      style: graph.dataset.flowStyle,
      accent: getComputedStyle(graph).getPropertyValue('--rf-sheet').trim(),
    }
  })
  assert.equal(styleBefore.style, 'editorial')
  assert.equal(styleBefore.accent, '#25221e')
  for (const [expected, title, sheet] of [['classic', '经典', '#202227'], ['signal', '信号流', '#0b1823'], ['blueprint', '蓝图', '#102c43']]) {
    await page.locator('.plate-map-hud--right button', { hasText: '视觉风格' }).click()
    await page.locator('#relationship-styles button', { hasText: title }).click()
    await waitFor(() => page.evaluate(() => document.querySelector('.relations').dataset.flowStyle), expected)
    const next = await page.evaluate(() => ({
      style: document.querySelector('.relations').dataset.flowStyle,
      accent: getComputedStyle(document.querySelector('.relations')).getPropertyValue('--rf-sheet').trim(),
    }))
    assert.equal(next.style, expected)
    assert.equal(next.accent, sheet)
    await page.locator('.plate-map-hud--right button', { hasText: '视觉风格' }).click()
    await page.locator('#relationship-styles button', { hasText: '编辑风格' }).click()
    await waitFor(() => page.evaluate(() => document.querySelector('.relations').dataset.flowStyle), 'editorial')
  }
  passed('AC-3 typography, dark tokens and four graph styles', darkStyles)

  const direct = await createNote("补全验收", "# 补全验收\n\nx\n")
  await node(direct.id).waitFor()
  await openNote(direct.id)
  await focusFixture("x")
  await page.keyboard.press("Backspace")
  await page.evaluate(() => {
    let inputTime
    document.addEventListener('beforeinput', event => {
      if (event.data === 'd') inputTime = performance.now()
    }, { capture: true })
    const observer = new MutationObserver(() => {
      if (inputTime !== undefined && document.querySelector('[data-task-autocomplete-query="tod"]')) {
        document.documentElement.dataset.s8AutocompleteMs = String(performance.now() - inputTime)
        observer.disconnect()
      }
    })
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-task-autocomplete-query'] })
  })
  await page.keyboard.type("tod", { delay: 15 })
  const autocomplete = page.locator("[data-task-autocomplete]")
  await autocomplete.waitFor()
  const completionMs = Number(await page.locator('html').getAttribute('data-s8-autocomplete-ms') ?? NaN)
  assert.ok(completionMs >= 0 && completionMs <= 100, 'TODO menu appears within 100ms')
  assert.equal(await autocomplete.getByRole("option", { name: /Codex/ }).count(), 1)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await autocomplete.waitFor({ state: "hidden" })
  await page.keyboard.insertText("任务标题")
  await saveCurrent()
  await waitFor(async () => (await page.evaluate(id => window.workbench.notes.read(id), direct.id))
    .content.includes("- [ ] TODO(@codex): 任务标题"), "save direct TODO autocomplete")
  const mention = await createNote("行内选 Agent", "# 行内选 Agent\n\nTODO x\n")
  await node(mention.id).waitFor()
  await openNote(mention.id)
  await focusFixture("TODO x")
  await page.keyboard.press("Backspace")
  await page.keyboard.type("@cl", { delay: 25 })
  await page.locator('[data-task-autocomplete-query="cl"]').getByRole("option", { name: /Claude/ }).waitFor()
  assert.equal(await autocomplete.getByRole('option').count(), 1)
  await page.keyboard.press("Enter")
  await page.keyboard.insertText("追问标题")
  await saveCurrent()
  await waitFor(async () => (await page.evaluate(id => window.workbench.notes.read(id), mention.id))
    .content.includes("TODO(@claude): 追问标题"), "save @ autocomplete")
  const ime = await createNote("组合输入验收", "# 组合输入验收\n\nx\n")
  await node(ime.id).waitFor()
  await openNote(ime.id)
  await focusFixture("x")
  await page.keyboard.press("Backspace")
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: 'tod', selectionStart: 3, selectionEnd: 3 })
  assert.equal(await autocomplete.count(), 0, 'composition text must not show TODO suggestions')
  await cdp.send('Input.insertText', { text: '待审阅的正文' })
  await cdp.detach()
  await saveCurrent()
  await waitFor(async () => (await page.evaluate(id => window.workbench.notes.read(id), ime.id))
    .content.includes('待审阅的正文'), 'save composed Chinese text')
  passed("AC-4 direct TODO and inline @ autocomplete via real keyboard", { completionMs })

  const taskNote = await createNote("上下文验收", "# 上下文验收\n\n- [ ] TODO(@claude): 任务标题\n  - 子项一\n  - 子项二\n")
  await node(taskNote.id).waitFor()
  await openNote(taskNote.id)
  const taskLine = drawer().locator("[data-task-line-state=todo][data-task-agent=claude]")
  await taskLine.waitFor()
  assert.equal(await drawer().locator("[data-task-context-of=claude]").count(), 2)
  const context = await page.evaluate(() => {
    const task = document.querySelector('[aria-label="笔记编辑抽屉"] [data-task-line-state=todo][data-task-agent="claude"]')
    const child = document.querySelector('[aria-label="笔记编辑抽屉"] [data-task-context-of="claude"]')
    return {
      taskBorder: getComputedStyle(task).borderLeftColor,
      width: getComputedStyle(task).borderLeftWidth,
      childBorder: getComputedStyle(child).borderLeftColor,
      agent: task.querySelector('[data-task-pill="agent"]')?.textContent,
      action: task.querySelector('[data-task-pill="todo"]')?.textContent,
    }
  })
  assert.equal(context.width, '3px')
  assert.equal(context.childBorder, context.taskBorder)
  assert.match(context.agent, /Claude/)
  assert.equal(context.action, '▷ 交办')
  passed('AC-5 colored Claude context and pill', context)

  for (const address of ['file:///C:/Windows', 'javascript:void(0)', 'https://name:example@example.com/']) {
    const rejected = await page.evaluate(url => window.workbench.notes.openLink(url).then(() => false, () => true), address)
    assert.equal(rejected, true, 'links using disallowed scheme or credentials are rejected')
  }
  passed('AC-6 external links reject disallowed scheme and embedded credentials')
  const route = '/s8-external-link/' + randomUUID()
  let browserNavigation
  const linkServer = createHttpServer((request, response) => {
    if (request.url !== route) { response.writeHead(404).end(); return }
    browserNavigation = {
      browser: /Edg\//.test(request.headers['user-agent'] ?? '') ? 'Edge' : 'system browser',
      navigation: request.headers['sec-fetch-mode'] === 'navigate',
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end('<title>Plate S8 外链验收</title><p>Plate S8 外链跳转成功</p>')
  })
  try {
    linkServer.listen(0, '127.0.0.1')
    await once(linkServer, 'listening')
    const address = 'http://127.0.0.1:' + linkServer.address().port + route
    await page.evaluate(url => window.workbench.notes.openLink(url), address)
    await waitFor(() => browserNavigation?.navigation, 'system browser opens link', 15000)
    passed('AC-6 allowed HTTP reaches the default browser', browserNavigation)
  } finally {
    linkServer.closeAllConnections()
    await new Promise(done => linkServer.close(done))
  }

  await page.screenshot({ path: join(run, 's8-editor-dark.png') })
  await drawer().getByRole('button', { name: '关闭编辑抽屉' }).click()
  await drawer().waitFor({ state: 'hidden' })
  await page.locator('.plate-map-hud--right button[aria-label="切换至浅色主题"]').click()
  await page.screenshot({ path: join(run, 's8-map-light.png') })
  await page.getByRole('button', { name: '帮助', exact: true }).click()
  const help = page.locator('dialog[open].p13-help')
  await help.getByText('Ctrl+K', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await help.waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 900, height: 640 })
  const hud = await page.locator('.plate-map-hud').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect()
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
  }))
  assert.equal(hud.length, 3)
  assert.ok(hud.every(box => box.left >= 0 && box.right <= 900), 'compact HUD controls fit the viewport')
  assert.ok(hud[0].bottom <= hud[1].top, 'compact layout keeps top HUDs on separate lines')
  await page.screenshot({ path: join(run, 's8-map-compact.png') })
  results.status = 'pass'
} catch (error) {
  results.status = 'fail'
  results.error = String(error.stack ?? error)
  console.error(results.error)
  if (page) await page.screenshot({ path: join(run, 'failure.png'), timeout: 2500 }).catch(() => {})
  process.exitCode = 1
} finally {
  await close()
  const resultPath = join(run, 'result.json')
  await writeFile(resultPath, JSON.stringify(results, null, 2))
  console.log('Evidence:', resultPath)
}
