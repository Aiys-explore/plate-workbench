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
  start(todo: TaskTodo): void
  stop(card: TaskRunCard): void
  adopt(card: TaskRunCard): void
  follow(card: TaskRunCard, instruction: string): void
  reject(card: TaskRunCard): void
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

function makePanel(doc: Document, card: TaskRunCard, actions: InlineTaskActions, followDraft: string) {
  const panel = doc.createElement('div')
  panel.dataset.taskPanel = card.state
  const log = doc.createElement('pre')
  log.dataset.taskLog = ''
  log.textContent = (card.state === 'PENDING' ? card.outputDraft : card.logTail) || '（暂无输出）'
  panel.append(log)
  if (card.state === 'DOING') {
    panel.append(makeButton(doc, '■ 停止', 'stop', () => actions.stop(card)))
  }
  if (card.state === 'PENDING') {
    const adopt = makeButton(doc, '✓ 采纳并完成', 'adopt', () => actions.adopt(card))
    const reject = makeButton(doc, '✕ 驳回重做', 'reject', () => actions.reject(card))
    const row = doc.createElement('div')
    row.dataset.taskFollowRow = ''
    const input = doc.createElement('input')
    input.type = 'text'
    input.placeholder = '追加修改意见…'
    input.value = followDraft
    input.dataset.taskFollowInput = card.taskId
    input.addEventListener('input', () => actions.followDraft(card.taskId, input.value))
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault()
        actions.follow(card, input.value)
      }
    })
    const send = makeButton(doc, '✎ 追加并续跑', 'follow', () => actions.follow(card, input.value))
    row.append(input, send)
    panel.append(adopt, row, reject)
  }
  return panel
}

/**
 * 依据 scanTaskLines 结果把胶囊挂到对应块元素上。幂等：每次调用先清理旧节点。
 */
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
  for (const old of [...root.querySelectorAll('[data-task-pill],[data-task-panel]')]) old.remove()
  const { raw, projection } = editor.session
  const scan = scanTaskLines(raw)
  const boxes = [...root.querySelectorAll<HTMLElement>('[data-editor-role=task], [data-editor-role=paragraph]')]
  const boxForLine = (line: number) => {
    const from = projection.lines[line - 1]
    const to = projection.lines[line] ?? raw.length
    return boxes.find(box => Number(box.dataset.p10From) >= from && Number(box.dataset.p10From) < to)
  }
  const markerIds = new Set(scan.markers.map(marker => marker.taskId))
  const lineHasMarker = new Set(scan.markers.map(marker => marker.line))

  for (const marker of scan.markers) {
    const card = cards.find(entry => entry.taskId === marker.taskId)
    if (!card) continue
    const box = boxForLine(marker.line)
    if (!box) continue
    const state = card.state === 'PENDING' || card.state === 'DONE' ? card.state : 'DOING'
    const pill = state === 'DOING'
      ? makeButton(doc, `⟳ DOING · ${clock(card)}`, 'doing', () => actions.togglePanel(card.taskId))
      : state === 'PENDING'
        ? makeButton(doc, '👁 PENDING · 待审阅', 'pending', () => actions.togglePanel(card.taskId))
        : makeButton(doc, '✓ DONE', 'done', () => {})
    if (state === 'DOING') {
      const stop = makeButton(doc, '■ 停止', 'stop', () => actions.stop(card))
      pill.dataset.taskGroup = ''
      const group = doc.createElement('span')
      group.dataset.taskPillGroup = ''
      group.contentEditable = 'false'
      group.append(pill, stop)
      box.append(group)
    } else {
      pill.contentEditable = 'false'
      box.append(pill)
    }
    if (state === 'PENDING' || logOpen === marker.taskId) {
      box.after(makePanel(doc, card, actions, followDrafts.get(marker.taskId) ?? ''))
    }
  }

  for (const todo of scan.todos) {
    if (lineHasMarker.has(todo.line)) continue
    const box = boxForLine(todo.line)
    if (!box) continue
    const group = doc.createElement('span')
    group.dataset.taskPillGroup = ''
    group.contentEditable = 'false'
    const label = todo.agent ? `▷ 交办 · ${todo.agent}` : '▷ TODO · 交办'
    group.append(makeButton(doc, `[ ${label} ]`, 'todo', () => actions.start(todo)))
    box.append(group)
  }
}

