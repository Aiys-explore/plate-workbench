// S6 行内任务胶囊：状态归 SQLite（task_runs），行内 DOM 胶囊实时渲染，
// 终态（采纳）才由编辑器事务改写 Markdown。
import { useEffect, useState } from 'react'
import type { TaskRunCard } from '../../shared/ipc'
import { scanTaskLines, type TaskTodo } from '../../shared/task-markdown'
import type { EditorSurface } from './editor/surface'
import './styles/task-capsules.css'

export function useTaskCards(noteId: string): TaskRunCard[] {
  const [cards, setCards] = useState<TaskRunCard[]>([])
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.workbench.tasks.listByNote(noteId).then(rows => {
        if (alive) setCards(rows)
      }, () => { /* 桥接失败时保留上一次快照 */ })
    }
    load()
    const off = window.workbench.tasks.onStateChanged(card => {
      if (!alive || card.noteId !== noteId) return
      setCards(old => {
        const next = old.filter(entry => entry.taskId !== card.taskId)
        next.push(card)
        return next
      })
    })
    return () => { alive = false; off() }
  }, [noteId])
  return cards
}

export interface InlineTaskActions {
  start(todo: TaskTodo, selectedAgent?: string): void
  chooseAgent(todo: TaskTodo): void
  openAgentSettings(): void
  stop(card: TaskRunCard): void
  adopt(card: TaskRunCard): void
  follow(card: TaskRunCard, instruction: string): void
  reject(card: TaskRunCard): void
  restore(card: TaskRunCard): void
  recover(taskId: string): void
  togglePanel(taskId: string): void
  submitFollow(taskId: string): void
  followDraft(taskId: string, value: string): void
}

const clock = (card: TaskRunCard) => {
  if (!card.startedAt) return '00:00'
  const ms = (card.endedAt ?? Date.now()) - card.startedAt
  const s = Math.max(0, Math.floor(ms / 1000))
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(Math.floor(s / 60))}:${two(s % 60)}`
}

function makeButton(doc: Document, label: string, kind: string, onClick: (event: MouseEvent) => void) {
  const button = doc.createElement('button')
  button.type = 'button'
  button.dataset.taskPill = kind
  button.textContent = label
  button.addEventListener('click', onClick)
  button.addEventListener('mousedown', event => event.preventDefault())
  return button
}

function makePanel(doc: Document, current: () => TaskRunCard, actions: InlineTaskActions, followDraft: string) {
  const card = current()
  const panel = doc.createElement('div')
  panel.dataset.taskPanel = card.state
  panel.dataset.taskId = card.taskId
  panel.dataset.p10Slot = ''
  panel.contentEditable = 'false'
  const notice = doc.createElement('p')
  notice.dataset.taskNotice = ''
  notice.hidden = true
  notice.setAttribute('role', 'status')
  panel.append(notice)
  const log = doc.createElement('pre')
  log.dataset.taskLog = ''
  log.textContent = (card.state === 'PENDING' ? card.outputDraft : card.logTail) || '（暂无输出）'
  panel.append(log)
  if (card.state === 'DOING') {
    panel.append(makeButton(doc, '■ 停止', 'stop', () => actions.stop(current())))
  }
  if (card.state === 'PENDING') {
    const adopt = makeButton(doc, '✓ 采纳并完成', 'adopt', () => actions.adopt(current()))
    const reject = makeButton(doc, '✕ 驳回重做', 'reject', () => actions.reject(current()))
    const row = doc.createElement('div')
    row.dataset.taskFollowRow = ''
    const input = doc.createElement('textarea')
    input.rows = 2
    input.placeholder = '追加修改意见…'
    input.setAttribute('aria-label', '追加修改意见')
    input.value = followDraft
    input.dataset.taskFollowInput = card.taskId
    // This is a native text field inside the editor, with a separate undo and IME lifecycle.
    for (const type of ['beforeinput', 'compositionstart', 'compositionend', 'cut', 'copy', 'paste']) {
      input.addEventListener(type, event => event.stopPropagation())
    }
    input.addEventListener('input', () => actions.followDraft(card.taskId, input.value))
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        event.stopPropagation()
        actions.follow(current(), input.value)
      }
    })
    const send = makeButton(doc, '✎ 追加并续跑', 'follow', () => actions.follow(current(), input.value))
    row.append(input, send)
    panel.append(adopt, row, reject)
  }
  return panel
}

const panelCards = new WeakMap<HTMLElement, { card: TaskRunCard }>()
const missingDeepSeekKey = (card: TaskRunCard) => card.agentId === 'dsh' &&
  (card.logTail.includes('MISSING_CREDENTIAL') || card.errorMsg?.includes('DeepSeek Harness 缺少 API Key'))

export function arrangeTaskCapsules(
  editor: EditorSurface,
  cards: TaskRunCard[],
  actions: InlineTaskActions,
  logOpen: string | null,
  followDrafts: Map<string, string>,
) {
  if (editor.session.composing) return
  const doc = editor.host.ownerDocument
  const root = editor.host.querySelector<HTMLElement>('[data-editor-host=render]')
  if (!root) return
  const groups = new Map([...root.querySelectorAll<HTMLElement>('[data-task-capsule]')].map(el => [el.dataset.taskCapsule!, el]))
  const panels = new Map([...root.querySelectorAll<HTMLElement>('[data-task-panel][data-task-id]')].map(el => [el.dataset.taskId!, el]))
  const { raw, projection } = editor.session
  const scan = scanTaskLines(raw)
  const boxes = [...root.querySelectorAll<HTMLElement>('[data-editor-role=task], [data-editor-role=paragraph]')]
  const boxForLine = (line: number) => {
    const from = projection.lines[line - 1]
    const to = projection.lines[line] ?? raw.length + 1
    return boxes.find(box => Number(box.dataset.p10From) >= from && Number(box.dataset.p10From) < to)
  }
  const byId = new Map(cards.map(card => [card.taskId, card]))
  function slot(key: string, box: HTMLElement) {
    let group = groups.get(key)
    groups.delete(key)
    if (!group) {
      group = doc.createElement('span')
      group.dataset.taskCapsule = key
      group.dataset.taskPillGroup = ''
      group.dataset.p10Slot = ''
      group.contentEditable = 'false'
    }
    if (group.parentElement !== box) box.append(group)
    return group
  }

  for (const marker of scan.markers) {
    const card = byId.get(marker.taskId)
    const box = boxForLine(marker.line)
    if (!box) continue
    const state = card?.state ?? (marker.state === 'DONE' ? 'DONE' : 'UNKNOWN')
    const group = slot(marker.taskId, box)
    if (group.dataset.state !== state) {
      group.dataset.state = state
      const toggle = () => actions.togglePanel(marker.taskId)
      const labels = { DOING: '⟳ DOING', PENDING: '👁 待审阅', DONE: '✓ DONE',
        ERROR: '执行失败 · 查看', TODO: '恢复待办', UNKNOWN: '待核对 · 恢复待办' }
      const click = () => {
        if (card?.state === 'TODO') actions.restore(card)
        else if (state === 'UNKNOWN') actions.recover(marker.taskId)
        else toggle()
      }
      const pill = makeButton(doc, labels[state], state.toLowerCase(), click)
      if (state === 'DONE') pill.disabled = true
      group.replaceChildren(pill)
      if (card && state === 'DOING') group.append(makeButton(doc, '■ 停止', 'stop', () => actions.stop(card)))
    }
    if (card && state === 'ERROR') {
      if (!group.querySelector('[data-task-pill=retry]')) {
        group.append(makeButton(doc, '恢复待办', 'retry', () => actions.reject(card)))
      }
      if (missingDeepSeekKey(card) && !group.querySelector('[data-task-pill=settings]')) {
        group.append(makeButton(doc, '配置 DeepSeek', 'settings', actions.openAgentSettings))
      }
    }
    if (card && state === 'DOING') {
      const pill = group.firstElementChild!
      const label = `⟳ DOING · ${clock(card)}`
      if (pill.textContent !== label) pill.textContent = label
    }
    if (card && (state === 'PENDING' || logOpen === marker.taskId)) {
      let panel = panels.get(marker.taskId)
      if (panel?.dataset.taskPanel !== state || !panelCards.has(panel)) {
        panel?.remove()
        const live = { card }
        panel = makePanel(doc, () => live.card, actions, followDrafts.get(marker.taskId) ?? '')
        panelCards.set(panel, live)
      }
      panels.delete(marker.taskId)
      panelCards.get(panel)!.card = card
      const log = panel.querySelector('[data-task-log]')!
      const notice = panel.querySelector<HTMLElement>('[data-task-notice]')!
      const warning = state === 'PENDING' || state === 'ERROR' ? card.errorMsg ?? '' : ''
      if (notice.textContent !== warning) notice.textContent = warning
      notice.hidden = !warning
      const text = (state === 'PENDING' ? card.outputDraft : card.logTail || card.errorMsg) || '（暂无输出）'
      if (log.textContent !== text) log.textContent = text
      if (box.nextElementSibling !== panel) box.after(panel)
    }
  }

  for (const todo of scan.todos) {
    const box = boxForLine(todo.line)
    if (!box) continue
    const group = slot('todo:' + todo.from, box)
    const label = todo.agent ? `▷ 交办 · ${todo.agent}` : '▷ TODO · 交办'
    const signature = JSON.stringify(todo)
    if (group.dataset.signature !== signature) {
      group.dataset.signature = signature
      group.replaceChildren(makeButton(doc, `[ ${label} ]`, 'todo', () => actions.start(todo)),
        makeButton(doc, '选择 Agent', 'select-agent', () => actions.chooseAgent(todo)))
    }
  }
  for (const group of groups.values()) group.remove()
  for (const panel of panels.values()) panel.remove()
}

