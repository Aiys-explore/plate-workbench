import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AppInfo } from '../../shared/ipc'
import { UpdateControls } from './update-controls'

const prefix = 'P13.modal.body.'
const sections = [
  ['offline', '离线使用'], ['keys', '快捷键'], ['version', '版本与安装'], ['logs', '本机日志']
] as const

// Windows bindings audited against Layout, NotesWorkspace and EditorSurface.
// These are descriptions only; Help registers no workbench commands.
const shortcuts: ReadonlyArray<readonly [string, string]> = [
  ['Ctrl+K', '搜索标题或正文，然后定位导图节点'],
  ['N', '在画布中创建主节点'],
  ['Tab', '在所选节点下派生子节点'],
  ['Enter', '在子节点下方创建同级节点。选中主节点时打开笔记'],
  ['Shift+Enter', '打开所选节点的笔记'],
  ['C', '折叠或展开所选节点的子分支'],
  ['S', '在画布中切换四种视觉风格'],
  ['Ctrl+N', '在当前分区新建并编辑笔记'],
  ['Ctrl+S', '保存当前笔记（在当前可保存的笔记编辑区）'],
  ['Ctrl+Z', '撤销（当前可编辑笔记，有撤销记录时）'],
  ['Ctrl+Y', '重做（当前可编辑笔记，有重做记录时）'],
  ['Ctrl+Enter', '打开当前笔记引用（引用链接有焦点时）'],
  ['↑ / ↓', '在 TODO 或 @ 补全菜单中选择，Enter 或 Tab 确认'],
  ['Tab / Shift+Tab', '前往下一个或上一个控件（帮助弹窗内循环）'],
  ['Esc', '关闭帮助，回到打开帮助的位置（输入法组合优先）']
]

type Version = { state: 'loading' } | { state: 'ready'; info: AppInfo } | { state: 'failed'; reason: string }

export function HelpDialog({ restore, paletteBound, readAppInfo, notePath, onClose }: {
  restore?: () => void
  paletteBound: boolean
  notePath?: string
  readAppInfo: () => Promise<AppInfo>
  onClose: () => void
}) {
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const request = useRef({ generation: 0, open: false, busy: false })
  const composing = useRef(false)
  const [version, setVersion] = useState<Version>({ state: 'loading' })
  const [retried, setRetried] = useState(false)

  async function read() {
    const current = request.current
    if (!current.open || current.busy) return
    current.busy = true
    const generation = ++current.generation
    setVersion({ state: 'loading' })
    let result: Version
    try {
      const info = await readAppInfo()
      result = typeof info?.name === 'string' && info.name.trim() && typeof info?.version === 'string' && info.version.trim()
        ? { state: 'ready', info }
        : { state: 'failed', reason: '应用没有返回完整的名称和版本。' }
    } catch {
      result = { state: 'failed', reason: '读取本机应用信息时没有收到成功响应。' }
    }
    if (!current.open || current.generation !== generation) return
    current.busy = false
    setVersion(result)
  }

  function invalidate() {
    request.current.open = false
    request.current.busy = false
    request.current.generation++
  }

  useLayoutEffect(() => {
    const host = dialog.current!
    host.showModal()
    title.current?.focus({ preventScroll: true })
    request.current.open = true
    void read()
    return () => {
      invalidate()
      if (host.open) host.close()
    }
  }, [])

  function dismiss() {
    invalidate()
    dialog.current?.close()
    restore?.()
    onClose()
  }

  function key(event: KeyboardEvent<HTMLDialogElement>) {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || event.key === 'Process') return
    if (event.key === 'Escape') {
      event.preventDefault()
      dismiss()
    } else if (event.key === 'Tab') {
      const active = document.activeElement
      const start = active === title.current || active === dialog.current
      if (start || (event.shiftKey ? active === body.current : active === close.current)) {
        event.preventDefault()
        ;(event.shiftKey ? close.current : body.current)?.focus({ preventScroll: true })
      }
    }
  }

  function jump(section: string) {
    const heading = document.getElementById(`${id}-${section}`)
    const scroller = body.current
    if (!heading || !scroller) return
    heading.focus({ preventScroll: true })
    const margin = parseFloat(getComputedStyle(heading).scrollMarginTop)
    scroller.scrollTo({ top: scroller.scrollTop + heading.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top - margin, behavior: 'instant' })
  }

  return <dialog ref={dialog} className="p13-help" data-element="P13.modal" aria-labelledby={id}
    onKeyDown={key} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
    onCancel={event => { event.preventDefault() }}>
    <header className="p13-head" data-element="P13.modal.head">
      <h2 ref={title} id={id} tabIndex={-1} data-element="P13.modal.head.title">帮助</h2>
    </header>
    <div ref={body} className="p13-body" data-element="P13.modal.body" role="region" aria-label="帮助正文" tabIndex={0}>
      <nav aria-label="帮助目录" data-element={prefix+'nav'}>
        {sections.map(([section, label]) => <button key={section} type="button" className="p13-action"
          data-element={prefix+'nav.'+section} onClick={() => jump(section)}>{label}</button>)}
      </nav>
      {sections.map(([section, label]) => <section key={section} data-element={prefix+section} aria-labelledby={`${id}-${section}`}>
        <h3 id={`${id}-${section}`} tabIndex={-1} data-element={prefix+section+'.title'}>{label}</h3>
        {section === 'offline' && <>
          <p data-element={prefix+'offline.core'}>选好笔记位置后，可以断网新建、编辑、保存、搜索笔记，查看上游资料、下游去向和关系图，并恢复本机草稿。</p>
          <p data-element={prefix+'offline.optional'}>已产生的任务日志保存在本机。Agent 连接和登录由客户端或右上角「Agent 设置」管理。</p>
        </>}
        {section === 'keys' && <ul className="p13-keys">
          {(paletteBound ? [['Ctrl+P', '打开全局命令面板'], ...shortcuts] : shortcuts).map(([combo, usage]) => <li key={combo}><kbd data-element={prefix+'keys.combo'}>{combo}</kbd>
            <span data-element={prefix+'keys.usage'}>{usage}</span></li>)}
        </ul>}
        {section === 'version' && <>
          <div role="status" className="p13-version-status">
            {version.state === 'loading' && <p className="p13-note" data-element={prefix+'version.loading'}>正在读取版本</p>}
            {version.state === 'ready' && <>
              <p data-element={prefix+'version.name'}>应用：{version.info.name}</p>
              <p data-element={prefix+'version.value'}>版本：{version.info.version}</p>
            </>}
            {version.state === 'failed' && <p className="p13-error" data-element={prefix+'version.error'}>无法读取版本。{version.reason}</p>}
          </div>
          {notePath && <p>本机笔记位置：{notePath}</p>}
          {('__TAURI_INTERNALS__' in window) ? <UpdateControls /> :
            <p className="p13-note" data-element={prefix+'version.unknown'}>安装方式未提供</p>}
          {(version.state === 'failed' || retried) && <button type="button" className="p13-action"
            data-element={prefix+'version.retry'} aria-disabled={version.state === 'loading'} onClick={() => {
              setRetried(true)
              void read()
            }}>重新读取版本</button>}
        </>}
        {section === 'logs' && <>
          <p data-element={prefix+'logs.scope'}>只读取已配置的本机日志，不上传或删除。</p>
          <p className="p13-note">日志来源和读取状态尚未核实。</p>
        </>}
      </section>)}
    </div>
    <footer className="p13-tail" data-element="P13.modal.tail">
      <p className="p13-note" data-element="P13.modal.tail.hint">按 Esc 关闭帮助</p>
      <button ref={close} type="button" className="p13-action" data-element="P13.modal.tail.close" onClick={dismiss}>关闭帮助</button>
    </footer>
  </dialog>
}
