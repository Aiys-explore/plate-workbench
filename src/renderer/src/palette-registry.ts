import { createContext, useContext, useLayoutEffect, useRef } from 'react'
import type { NoteIndexState } from '../../shared/note-index'

export const commands = [
  ['m51.note.new', '新建笔记', '打开空白笔记表单', ['new note'], true],
  ['m51.note.search', '搜索笔记', '聚焦笔记标题和正文搜索', ['find search'], true],
  ['m51.note.graph', '打开关系图', '查看上游资料和下游去向', ['graph'], true],
  ['m51.project.new', '新建项目', '打开新建项目表单', ['new project'], true],
  ['m51.project.edit', '编辑选中项目', '打开选中项目的编辑表单', ['edit project'], true],
  ['m51.export.history', '打开导出记录', '查看 Markdown 导出记录', ['export history'], true],
  ['m51.export.project', '导出选中项目…', '打开选中项目的导出准备窗口', ['export project'], true],
  ['m51.agent.show', '显示 Agent 面板', '查看 Agent 面板或当前会话', ['agent sessions 会话 绑定'], false],
  ['m51.theme.toggle', '切换明暗主题', '切换工作台配色', ['theme'], false],
  ['m51.settings.open', '打开 Agent 设置', '查看 Agent 运行时设置', ['settings'], false],
  ['m51.help.open', '打开帮助', '查看帮助和快捷键', ['help shortcuts 快捷键'], false],
] as const
export type CommandId = typeof commands[number][0]
export type Source = { element: HTMLElement | null; restore: () => void }
export type Target = { element: () => HTMLElement | null }
type Action = {
  reason?: string
  basis?: string
  project?: { id: string; revision?: number }
  allowed?: () => boolean
  run: (source: Source) => Target | void
}
type Owner = {
  actions?: Partial<Record<CommandId, Action>>
  source?: (element: HTMLElement | null) => (() => boolean) | undefined
  composing?: () => boolean
  index?: { state?: NoteIndexState; error: boolean }
  drawer?: boolean
  workspace?: 'pending' | 'ready' | 'failed'
}
type OwnerRef = { current: Owner }
export const focusable = (el: HTMLElement | null | undefined): el is HTMLElement =>
  !!el?.isConnected && el !== document.body && el.getClientRects().length > 0 &&
  !el.closest('[inert],[hidden]') && getComputedStyle(el).visibility === 'visible' &&
  !el.matches(':disabled') && !!el.matches('button,input,textarea,select,summary,a[href],[tabindex],[contenteditable=true]')
export function focus(el: HTMLElement | null | undefined) {
  if (!focusable(el)) return false
  el.focus({ preventScroll: true })
  return document.activeElement === el
}
export const target = (selector: string): Target => ({
  element: () => Array.from(document.querySelectorAll<HTMLElement>(selector)).find(focusable) ?? null
})
const phaseReasons: Record<NoteIndexState['phase'], string> = {
  waiting: '笔记索引正在准备', collecting: '笔记索引正在准备', reading: '笔记索引正在准备',
  committing: '正在提交完整索引，请稍候', cancelled: '笔记索引已取消，请关闭面板后重新开始',
  failed: '笔记索引未能提交，请关闭面板后重新开始', blocked: '工作区删除结果待核对', ready: ''
}
export const indexError = '无法取得索引状态，请关闭面板后刷新状态'
export class PaletteRegistry {
  private owners = new Map<string, OwnerRef>()
  private listeners = new Set<() => void>()
  private revision = 0
  private signatures = new Map<string, string>()
  getSnapshot = () => this.revision
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify) } }
  private publish() { this.revision++; this.listeners.forEach(notify => notify()) }
  mount(name: string, owner: OwnerRef) {
    this.owners.set(name, owner)
    this.update(name, owner)
    return () => {
      if (this.owners.get(name) !== owner) return
      this.owners.delete(name)
      this.signatures.delete(name)
      this.publish()
    }
  }
  update(name: string, ref: OwnerRef) {
    if (this.owners.get(name) !== ref) return
    const { actions = {}, index, workspace, drawer } = ref.current
    const next = JSON.stringify([index, workspace, drawer, Object.entries(actions)
      .map(([id, action]) => [id, action.reason, action.basis, action.project])])
    if (this.signatures.get(name) === next) return
    this.signatures.set(name, next)
    this.publish()
  }
  get index() { return this.owners.get('layout')?.current.index }
  get preparing() { return this.owners.get('workspace')?.current.workspace !== 'ready' }
  get indexReason() {
    const index = this.index
    if (index?.error) return indexError
    const phase = index?.state?.phase ?? 'waiting'
    if (phase !== 'ready') return phaseReasons[phase]
    const workspace = this.owners.get('workspace')?.current.workspace
    if (workspace === 'failed') return '无法准备笔记工作区，请刷新工作区状态'
    return workspace !== 'ready' ? '笔记工作区正在准备' : ''
  }
  get drawerOpen() { return this.owners.get('layout')?.current.drawer ?? false }
  get composing() { return [...this.owners.values()].some(ref => ref.current.composing?.()) }
  read(id: CommandId, needsNotes: boolean) {
    for (const owner of this.owners.values()) {
      const action = owner.current.actions?.[id]
      if (action) {
        const index = needsNotes && this.index?.state
        const reason = (needsNotes && this.indexReason) || action.reason || ''
        return { owner, action, reason, run: index ? index.run : null, sequence: index ? index.sequence : null }
      }
    }
  }
  capture(fallback: () => HTMLElement | null): Source {
    const element = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const workspace = this.owners.get('workspace')
    const restore = workspace?.current.source?.(element)
    return { element, restore: () => {
      if (restore && this.owners.get('workspace') === workspace && restore()) return
      if (!element?.closest('.notes-editor') && focus(element)) return
      focus(fallback())
    } }
  }
}
export const RegistryContext = createContext<PaletteRegistry | null>(null)
export function usePaletteOwner(name: string, owner: Owner) {
  const registry = useContext(RegistryContext)!
  const ref = useRef(owner)
  useLayoutEffect(() => { ref.current = owner; registry.update(name, ref) })
  useLayoutEffect(() => registry.mount(name, ref), [name, registry])
}
export const commandLayer = () => !!document.querySelector('dialog[data-element="M51.palette"][open]')
