import { Fragment, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Note } from '../../shared/ipc'
import { plateTitle } from '../../shared/plate-title'
import { EditorSession, boxes, imagePath, safeLink, visible, type Bookmark } from './editor/session'
import { EditorSurface } from './editor/surface'
import type { Box } from './editor/projection'

const commonTools = ['undo','redo','strong','em','heading','list','quote','link','more'] as const
const narrowTools = commonTools.filter(id=>id!=='list' && id!=='quote' && id!=='link')
const tools = [
  ['undo', '撤销', '↶'], ['redo', '重做', '↷'], ['strong', '加粗', 'B'], ['em', '斜体', 'I'],
  ['heading', '标题', '正文'], ['link', '链接', '↗'], ['image', '图片', '▧'], ['table', '表格', '▦'],
  ['list', '无序列表', '≡'], ['ordered', '有序列表', '1.'], ['task', '任务列表', '☑'], ['quote', '引用', '❞'],
  ['code', '代码', '</>'], ['more', '更多', '⋯']
] as const
type Tool = typeof tools[number][0]
type Field = { name: string; initial: string; multiline?: boolean }
type Form = { title: string; fields: Field[]; validate?: (values:string[])=>Record<number,string>; submit: (values: string[]) => boolean; alternate?: { title: string; run: () => boolean } }
type Menu = { anchor: HTMLElement; mark: Bookmark; detail?: string; choices: { label: string; run: () => void; disabled?: boolean; reason?:string }[] }

import { arrangeTaskCapsules, useTaskCards, type InlineTaskActions } from './task-capsules'
import { openAgentSettings, TaskAgentDialog } from './agent-settings-dialog'
import { handleTaskAutocompleteKey, TaskAutocomplete, TaskCaretHint, useDiscoveredAgents, useTaskAutocomplete } from './task-autocomplete'
import { scanTaskLines, outputQuote, type TaskTodo } from '../../shared/task-markdown'
import { TaskActions } from './p11'
import type { TaskInfo } from '../../shared/p11'

type Props = {
  session: EditorSession; note: Note; readOnly: boolean; surface: RefObject<EditorSurface | null>
  changed: (raw: string) => void; save: () => void; remove: () => void
  wiki: (ref: string, anchor: HTMLElement) => void
  commitTaskEdit: (version: number, from: number, to: number, insert: string) => Promise<boolean>
  status: ReactNode; children: ReactNode
}

export function NoteEditor(props: Props) {
  const { session, surface, readOnly, note } = props
  const [composingTitle, setComposingTitle] = useState<string>()
  const commitTitle = (title: string) => surface.current?.outsideEdit(() => session.changeTitle(title))
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const pointerMark = useRef<Bookmark | undefined>(undefined)
  const current = useRef(props)
  current.current = props
  const [epoch, redraw] = useReducer(n => n + 1, 0)
  const taskCards = useTaskCards(note.id)
  const agentProfiles = useDiscoveredAgents()
  const autocomplete = useTaskAutocomplete(surface, agentProfiles, readOnly, session.version, session.selection.head, session.composing)
  const [choosingAgent, setChoosingAgent] = useState<{ todo: TaskTodo; dispatch: boolean; version: number }>()
  const open = useRef(new Set<string>())
  const logOpen = useRef<string | null>(null)
  const followDrafts = useRef(new Map<string, string>())
  const taskBusy = useRef(false)
  const taskRun = (action: () => Promise<void>) => {
    if (taskBusy.current || current.current.readOnly || session.composing) return
    taskBusy.current = true
    setIssue('')
    void action().catch(error => setIssue(String(error))).finally(() => { taskBusy.current = false })
  }
  const applyTaskEdit = (from: number, to: number, insert: string) =>
    current.current.commitTaskEdit(session.version, from, to, insert)
  const findTask = (taskId: string) => scanTaskLines(session.raw).markers.find(marker => marker.taskId === taskId)
  const resetTask = async (taskId: string, agent: string) => {
    const marker = findTask(taskId)
    if (marker) await applyTaskEdit(marker.from, marker.to, agent ? 'TODO(@' + agent + ')' : 'TODO')
  }
  const taskAction = useMemo<InlineTaskActions>(() => ({
    chooseAgent: todo => setChoosingAgent({ todo, dispatch: false, version: session.version }),
    start: (todo: TaskTodo, selectedAgent?: string) => taskRun(async () => {
      const version = session.version
      const live = scanTaskLines(session.raw).todos.find(row => row.from === todo.from && row.to === todo.to &&
        row.content === todo.content && row.agent === todo.agent)
      if (!live?.content) throw new Error('请输入完整的任务内容')
      const agent = await window.workbench.agentPlugins.resolveTarget(selectedAgent || live.agent || undefined)
      if (!agent) { setChoosingAgent({ todo: live, dispatch: true, version }); return }
      const taskId = 't-' + crypto.randomUUID().replaceAll('-', '').slice(0, 12)
      if (!await current.current.commitTaskEdit(version, todo.from, todo.to, 'DOING #' + taskId)) return
      try {
        await window.workbench.tasks.start({ noteId: note.id, taskId, promptText: todo.content, agentSelector: agent })
      } catch (error) {
        // Verify state before rolling back: an interrupted receipt may follow a real start.
        const runs = await window.workbench.tasks.listByNote(note.id)
        if (!runs.some(run => run.taskId === taskId)) await resetTask(taskId, todo.agent)
        throw error
      }
    }),
    stop: card => taskRun(async () => {
      const stopped = await window.workbench.tasks.stop(card.taskId)
      if (stopped.state === 'TODO') await resetTask(card.taskId, card.agentId)
    }),
    adopt: card => taskRun(async () => {
      const marker = findTask(card.taskId)
      if (!marker) throw new Error('任务行已不在正文中')
      if (marker.state !== 'DONE') {
        const { raw } = session
        const newline = raw.includes('\r\n') ? '\r\n' : '\n'
        const end = marker.contextEnd
        const rest = raw.slice(marker.to, end)
        const quote = outputQuote(card.outputDraft, newline)
        if (!await applyTaskEdit(marker.from, end, 'DONE #' + card.taskId + rest + (quote ? newline + newline + quote : ''))) return
      }
      await window.workbench.tasks.markDone(card.taskId)
    }),
    follow: (card, instruction) => taskRun(async () => {
      if (!instruction.trim()) { setIssue('请输入修改意见'); return }
      if (findTask(card.taskId)?.state === 'DONE') throw new Error('请先完成采纳状态同步')
      await window.workbench.tasks.followUp(card.taskId, instruction.trim())
      followDrafts.current.delete(card.taskId)
    }),
    reject: card => taskRun(async () => {
      if (findTask(card.taskId)?.state === 'DONE') throw new Error('请先完成采纳状态同步')
      await window.workbench.tasks.reject(card.taskId)
      await resetTask(card.taskId, card.agentId)
    }),
    restore: card => taskRun(async () => {
      if (findTask(card.taskId)?.state === 'DONE') throw new Error('请先完成采纳状态同步')
      await resetTask(card.taskId, card.agentId)
    }),
    recover: taskId => taskRun(async () => {
      const runs = await window.workbench.tasks.listByNote(note.id)
      if (runs.some(run => run.taskId === taskId)) throw new Error('已找到这次运行，请核对状态')
      await resetTask(taskId, '')
    }),
    openAgentSettings,
    togglePanel: taskId => { logOpen.current = logOpen.current === taskId ? null : taskId; redraw() },
    submitFollow: taskId => { /* Enter 输入框直接走 follow */ void taskId },
    followDraft: (taskId, value) => { followDrafts.current.set(taskId, value) },
  }), [note.id, session, surface])
  useLayoutEffect(() => {
    const e = surface.current
    if (!e) return
    arrangeTaskCapsules(e, taskCards, taskAction, logOpen.current, followDrafts.current, agentProfiles)
  // The editor surface mounts below. Its render hook bumps epoch.
  }, [taskCards, epoch, taskAction, surface, agentProfiles])
  const [narrow, setNarrow] = useState(false)
  const [issue, setIssue] = useState('')
  const [menu, setMenu] = useState<Menu>()
  const [form, setForm] = useState<Form>()
  const [propertyErrors,setPropertyErrors]=useState<Record<number,string>>({})
  const [tablePicker, setTablePicker] = useState<Bookmark>()
  const [formMark, setFormMark] = useState<Bookmark>()
  const [info, setInfo] = useState(false)
  const [find, setFind] = useState(false)
  const [query, setQuery] = useState('')
  const [findOffset, setFindOffset] = useState(-1)
  const [findStatus, setFindStatus] = useState('')
  const findMark = useRef<Bookmark | undefined>(undefined)
  const findInput = useRef<HTMLInputElement>(null)
  const [wideTable, setWideTable] = useState(false)
  const [control, setControl] = useState<Tool>('undo')
  const [tooltip, setTooltip] = useState<{ label: string; anchor: HTMLElement }>()
  const reasonId = "editor-tool-reason"
  const tooltipTimer = useRef<number | undefined>(undefined)
  const [rawList, setRawList] = useState(false)
  const [tableRemoval, setTableRemoval] = useState<{ title: string; run: () => boolean; mark: Bookmark }>()

  useLayoutEffect(() => {
    let raw = session.raw
    let revision = session.baseRevision
    const editor = new EditorSurface(host.current!, session, {
      changed: () => {
        const changed = raw !== session.raw
        const adopted = revision !== session.baseRevision && !session.dirty
        raw = session.raw
        revision = session.baseRevision
        if (changed && !adopted) current.current.changed(raw)
        redraw()
      },
      selection: redraw,
      afterRender: redraw,
      rejected: setIssue,
      wiki: (target, anchor) => current.current.wiki(target.ref, anchor),
      inspect: (node, anchor) => inspect(node, anchor),
      link: target => fields('link', editor.captureBookmark(), target),
      save: () => current.current.save()
    })
    editor.setScroller(scroller.current!)
    surface.current = editor
    const resize = new ResizeObserver(redraw)
    resize.observe(host.current!)
    redraw()
    return () => { resize.disconnect(); editor.destroy(); surface.current = null }
  }, [session, surface])
  useLayoutEffect(() => { surface.current?.setReadOnly(readOnly) }, [readOnly, session, surface])
  useEffect(() => {
    const element = host.current?.closest('[data-editor-surface]')
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setNarrow(entry.contentRect.width < 560)
      setWideTable(entry.contentRect.width >= 840)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => { setMenu(undefined); setForm(undefined); setTablePicker(undefined); setIssue(''); setRawList(false); setFind(false) }, [session])
  useEffect(() => { if (readOnly) setMenu(undefined) }, [readOnly])
  useEffect(() => () => window.clearTimeout(tooltipTimer.current), [])

  function clearTooltip() { window.clearTimeout(tooltipTimer.current); setTooltip(undefined) }
  function showTooltip(label: string, anchor: HTMLElement) {
    clearTooltip()
    tooltipTimer.current = window.setTimeout(() => {
      if (anchor.isConnected) setTooltip({ label, anchor })
    }, 500)
  }

  function apply(action: () => unknown) {
    const result = surface.current?.command(action) ?? false
    redraw()
    if (result) surface.current?.focus()
    return result
  }
  function start(next: Form, mark: Bookmark) {
    setIssue(''); setPropertyErrors({}); setMenu(undefined); setFormMark(mark); setForm(next)
  }
  function propertyError(action:()=>unknown) {
    try{action();return ''}catch(error){return error instanceof Error ? error.message : String(error)}
  }
  function fields(kind: 'link' | 'image' | 'table' | 'code' | 'raw', mark: Bookmark, target?: Box) {
    if (kind === 'link') start({ title: '链接属性', fields: [
      { name: '显示文字', initial: target ? visible(target) : session.selectedText(mark) },
      { name: '链接地址', initial: target?.attrs?.url ?? '' }
    ], validate:([text,url])=>{
      const errors:Record<number,string>={}
      if(!text.trim() || /[\r\n]/.test(text)) errors[0]='链接文字必须是单行非空文字。'
      const invalid=propertyError(()=>safeLink(url));if(invalid)errors[1]=invalid
      return errors
    }, submit: ([text, url]) => apply(() => session.link({ text, url, target }, mark)),
    alternate: target && { title: '取消链接', run: () => apply(() => session.link({ remove: true, target }, mark)) } }, mark)
    if (kind === 'image') start({ title: '图片属性', fields: [
      { name: '替代文字（留空为装饰图）', initial: target?.attrs?.alt ?? target?.label ?? '' },
      { name: '相对路径或 HTTP/HTTPS 地址', initial: target?.attrs?.url ?? '' },
      { name: '标题', initial: target?.attrs?.title ?? '' }
    ], validate:([alt,address,title])=>{
      const errors:Record<number,string>={}
      if(/[\r\n]/.test(alt)) errors[0]='替代文字需为一行。'
      const invalid=propertyError(()=>imagePath(address));if(invalid)errors[1]=invalid
      if(/[\x00-\x1f\x7f]/.test(title)) errors[2]='标题不可包含控制字符。'
      return errors
    }, submit: ([alt, address, title]) => apply(() => session.image({ alt, address, title, target }, mark)),
    alternate: target && { title: '移除图片引用', run: () => window.confirm('移除这处图片引用？') &&
      apply(() => session.image({ target, remove: true, confirmed: true }, mark)) } }, mark)
    if (kind === 'table') { setIssue(''); setTablePicker(mark) }
    if (kind === 'code' && target) start({ title: '代码语言', fields: [{ name: '语言', initial: target.label ?? '' }],
      validate: ([language]) => /^[\w+#.-]{0,32}$/.test(language) && !/^agent$/i.test(language)
        ? {} as Record<number,string> : {0:'代码语言无效或为保留名称'},
      submit: ([language]) => apply(() => { session.resolve(mark); session.language(target, language) }) }, mark)
    if (kind === 'raw' && target) start({ title: '编辑局部原文', fields: [{ name: 'Markdown 原文', multiline: true,
      initial: session.raw.slice(target.from, target.to) }], submit: ([raw]) => apply(() => session.rawBlock(target, raw, mark)) }, mark)
  }
  function inspect(node: Box, anchor: HTMLElement) {
    const mark = surface.current!.captureBookmark()
    if (node.role === 'image') {
      let local = false
      try { local = imagePath(node.attrs?.url ?? '').kind === 'local' } catch { /* the property form can repair the address */ }
      setMenu({ anchor, mark, detail: node.attrs?.url, choices: [
        { label: '图片属性', run: () => fields('image', mark, node) },
        { label: '读取本地图片', disabled: !local, run: () => {
          void window.workbench.notes.bitmap(note.id, node.attrs?.url ?? '').then(encoded => {
            session.resolve(mark)
            surface.current?.showBitmap(node, anchor, encoded)
          }).catch(error => {
            if (anchor.isConnected) anchor.dataset.state = 'error'
            setIssue(error instanceof Error ? error.message : String(error))
          })
        } }
      ] })
    }
    else if (node.kind === 'protected') fields('raw', mark, node)
    else if (node.role === 'link') {
      let address = ''
      try { address = safeLink(node.attrs?.url ?? '') } catch { /* unsafe links remain editable */ }
      setMenu({ anchor, mark, detail: address || '此链接地址不可外开', choices: [
        { label: '编辑链接', run: () => fields('link', mark, node) },
        { label: '打开链接', disabled: !address, run: () => {
          surface.current?.openLink(node, url => {
            void window.workbench.notes.openLink(url).then(() => anchor.focus(), error => setIssue(String(error)))
          })
        } }
      ] })
    }
  }
  function command(id: Tool, mark: Bookmark, anchor: HTMLElement) {
    const reason=toolReason(id,mark)
    if (reason) {setIssue(reason);anchor.focus({preventScroll:true});return}
    if (id === 'undo' || id === 'redo') apply(() => session[id]())
    else if (id === 'strong' || id === 'em') apply(() => session.format(id, mark))
    else if (id === 'link' || id === 'image' || id === 'table') {
      const target = [...boxes(session.projection.root)].find(n => n.role === id &&
        n.from <= Math.min(mark.anchor,mark.head) && n.to >= Math.max(mark.anchor,mark.head))
      fields(id, mark, target)
    } else if (id === 'heading') {
      setMenu({ anchor, mark, choices: Array.from({ length: 7 }, (_, level) => {
        const reason=session.toolReason(id,mark,level)
        return { label: level ? 'H' + level : '正文', disabled:!!reason, reason,
          run: () => { apply(() => session.heading(level, mark)) } }
      }) })
    } else if (id === 'more') {
      const extra = tools.filter(([id])=>!shown.some(([visible])=>visible===id)).map(([id, label]) => {
        const reason=toolReason(id,mark)
        return {label,disabled:!!reason,reason,run:()=>command(id,mark,anchor)}
      })
      setMenu({ anchor, mark, choices: [...extra,
        { label: '查找', run: () => {findMark.current=mark;setFind(true)} },
        { label: '编辑 Markdown 原文', run: () => { apply(() => session.switchMode('source')) } },
        { label: '路径', run: () => setInfo(true) }
      ] })
    } else if (id === 'code') {
      const target = [...boxes(session.projection.root)].find(n => n.role === 'code' &&
        n.from <= Math.min(mark.anchor,mark.head) && n.to >= Math.max(mark.anchor,mark.head))
      if (target) fields('code', mark, target)
      else apply(() => session.changeBlock(id, mark))
    } else apply(() => session.changeBlock(id, mark))
  }
  function nextMatch(backward = false) {
    if (!query) return
    const matches = surface.current?.findMatches(query) ?? []
    if (!matches.length) { setFindStatus('未找到文本'); return }
    const index = findOffset < 0 && backward ? matches.length - 1
      : (findOffset + (backward ? -1 : 1) + matches.length) % matches.length
    matches[index]()
    setFindOffset(index)
    setFindStatus(`第 ${index + 1} 处，共 ${matches.length} 处`)
  }
  function closeFind() {
    setFind(false)
    setFindOffset(-1)
    setFindStatus('')
    const mark = findMark.current
    if (mark) surface.current?.restoreBookmark(mark)
    findMark.current = undefined
  }
  useEffect(() => () => { CSS.highlights.delete('note-find') }, [query, find, session, session.version])
  const shown = (narrow ? narrowTools : commonTools).map(id=>tools.find(tool=>tool[0]===id)!)
  const activeTool = shown.some(([id]) => id === control) ? control : 'more'
  function toolReason(id:Tool,mark=session.mark()) {
    return readOnly ? '编辑会话已暂停或正在保存' : session.toolReason(id,mark)
  }
  const heading = session.headingLevel
  const tableCell = session.mode === 'render' ? session.activeTable() : undefined
  function currentTableAction(action: Parameters<EditorSession['tableEdit']>[1], title: string) {
    if (!tableCell) return
    const editor=surface.current!
    const mark = editor.captureBookmark()
    const position=editor.tablePosition()
    const commit = () => surface.current?.tableCommand(() => { session.resolve(mark); session.tableEdit(tableCell.table, action) },position) ?? false
    if (action.confirmed) setTableRemoval({ title, run: commit, mark })
    else commit()
  }
  function tableActions(anchor: HTMLElement) {
    if (!tableCell) return
    const { table, row, column, columns } = tableCell
    const editor=surface.current!
    const mark = editor.captureBookmark()
    const position=editor.tablePosition()
    const run = (title: string, action: Parameters<EditorSession['tableEdit']>[1], disabled = false) => ({
      label: title, disabled,
      run: () => {
        const commit = () => surface.current?.tableCommand(() => { session.resolve(mark); session.tableEdit(table, action) },position) ?? false
        if (action.confirmed) setTableRemoval({ title, run: commit, mark })
        else commit()
      }
    })
    const mayAddRow = table.children.length < 20 && columns <= 8
    const mayAddColumn = columns < 8 && table.children.length <= 20
    setMenu({ anchor, mark, choices: [
      run('在当前行前插入', { type: 'insertRow', index: row }, !row || !mayAddRow),
      run('在当前行后插入', { type: 'insertRow', index: row + 1 }, !mayAddRow),
      run('删除当前行', { type: 'deleteRow', index: row, confirmed: true }, table.children.length < 2),
      run('在当前列前插入', { type: 'insertCol', index: column }, !mayAddColumn),
      run('在当前列后插入', { type: 'insertCol', index: column + 1 }, !mayAddColumn),
      run('删除当前列', { type: 'deleteCol', index: column, confirmed: true }, columns < 2),
      run('将当前行设为表头', { type: 'header', index: row }, !row),
      ...([['默认对齐',''],['左对齐','left'],['居中','center'],['右对齐','right']] as const)
        .map(([label, align]) => run(label, { type: 'align', index: column, align })),
      run('删除表格', { type: 'remove', index: 0, confirmed: true })
    ] })
  }

  return <section data-editor-surface onKeyDown={event => {
    if (handleTaskAutocompleteKey(event, autocomplete)) return
    if (event.key === 'Escape' && tooltip) clearTooltip()
    const target = event.target as HTMLElement
    if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && !event.shiftKey &&
      event.key.toLowerCase() === 'f' && (host.current?.contains(target) || findInput.current === target)) {
      event.preventDefault()
      event.stopPropagation()
      if (find) findInput.current?.focus()
      else { findMark.current = surface.current?.captureBookmark(); setFind(true) }
    }
  }}>
    <div data-editor-meta>
      <input type="text" data-editor-meta-title aria-label="笔记标题" placeholder="未命名笔记" maxLength={240}
        value={composingTitle ?? plateTitle(session.raw)?.title ?? note.title} readOnly={readOnly}
        onCompositionStart={event => setComposingTitle(event.currentTarget.value)}
        onCompositionEnd={event => { setComposingTitle(undefined); commitTitle(event.currentTarget.value) }}
        onChange={event => {
          if (composingTitle !== undefined || (event.nativeEvent as InputEvent).isComposing) setComposingTitle(event.currentTarget.value)
          else commitTitle(event.currentTarget.value)
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing && composingTitle === undefined) {
            event.preventDefault(); surface.current?.focus()
          }
        }}/>
      <div data-editor-meta-actions>
        <button type="button" className="button-primary" disabled={readOnly || !session.dirty} onClick={props.save}>保存</button>
        <button type="button" disabled={readOnly} onClick={props.remove}>删除</button>
      </div>
    </div>
    {session.mode === 'source' ? <div data-editor-toolbar><button type="button" disabled={readOnly}
      onClick={() => apply(() => { surface.current?.captureBookmark(); session.switchMode('render') })}>返回渲染编辑</button><button type="button" onClick={()=>setInfo(true)}>路径</button></div> :
      <div data-editor-toolbar role="toolbar" aria-label="Markdown 格式" ref={toolbar} onKeyDown={event => {
        if (!(event.target instanceof Element) || !event.target.closest('[data-editor-tool]')) return
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const index = shown.findIndex(([id]) => id === activeTool)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + shown.length) % shown.length
        ;(toolbar.current?.querySelectorAll<HTMLElement>('[data-editor-tool]')[next])?.focus()
      }}>
        {shown.map(([id, label, icon]) => {
          const reason=toolReason(id)
          const disabled=!!reason
          return <Fragment key={id}>
          {['strong','list','link'].includes(id) && <span className="plate-toolbar-divider" aria-hidden="true" />}
          <button type="button" data-editor-tool={id} data-editor-tool-heading={id === 'heading' ? '' : undefined}
            aria-label={label} aria-disabled={disabled} aria-describedby={reason && id===activeTool ? reasonId : undefined} title={reason || undefined} tabIndex={id === activeTool ? 0 : -1}
            aria-pressed={id === 'strong' || id === 'em' ? session.formatState(id) : undefined}
            onFocus={event => { setControl(id); showTooltip(label, event.currentTarget) }} onBlur={clearTooltip}
            onPointerEnter={event => showTooltip(label, event.currentTarget)} onPointerLeave={clearTooltip}
            onPointerDown={() => { pointerMark.current = surface.current?.captureBookmark() }}
            onClick={event => {
              const mark = (event.detail ? pointerMark.current : undefined) ?? surface.current?.captureBookmark()
              clearTooltip()
              pointerMark.current = undefined
              if (mark) command(id, mark, event.currentTarget)
            }}>{id === 'heading' && heading ? 'H' + heading : icon}</button>
          </Fragment>
        })}
        <button type="button" disabled={readOnly} onClick={() => apply(() => session.appendTask())}>＋ 任务</button>
      </div>}
    {session.mode==='render' && toolReason(activeTool) && <small className="editor-tool-reason" id={reasonId}>{toolReason(activeTool)}</small>}
    {find && <form className="editor-find" onSubmit={event => { event.preventDefault(); nextMatch() }} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.key === 'Process') return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind() }
      if (event.key === 'Enter' && event.shiftKey) { event.preventDefault(); nextMatch(true) }
    }}><input ref={findInput} aria-label="查找正文" autoFocus value={query}
      onChange={event => { setQuery(event.target.value); setFindOffset(-1); setFindStatus('') }} />
      <button type="button" onClick={() => nextMatch(true)}>上一处</button><button type="submit">下一处</button>
      <button type="button" onClick={closeFind}>关闭查找</button>
      <small role="status">{findStatus}</small></form>}
    <div data-editor-scroller ref={scroller}>
      <div data-editor-canvas>
        {issue && !form && <p role="alert" data-editor-notice data-tone="error">{issue}</p>}
        {choosingAgent && <TaskAgentDialog onClose={() => setChoosingAgent(undefined)} select={agent => {
          setChoosingAgent(undefined)
          const { todo, dispatch, version } = choosingAgent
          if (session.version !== version || readOnly || session.composing) return
          if (dispatch) {
            taskAction.start(todo, agent)
            return
          }
          const insert = 'TODO(@' + agent + ')'
          surface.current?.applyAutocomplete({ from: todo.from, to: todo.to, insert, caret: todo.from + insert.length })
        }}/>}
        {tableCell && <div data-editor-table-tools>
          {wideTable && <>
            <label>行 <select aria-label="当前表格行" value={tableCell.row} disabled={readOnly}
              onChange={event => { session.selectTableCell(tableCell.table,Number(event.target.value),tableCell.column); surface.current?.restoreSelection(); redraw() }}>
              {tableCell.table.children.map((_, index) => <option key={index} value={index}>{index + 1}{index === 0 ? '（表头）' : ''}</option>)}
            </select></label>
            <label>列 <select aria-label="当前表格列" value={tableCell.column} disabled={readOnly}
              onChange={event => { session.selectTableCell(tableCell.table,tableCell.row,Number(event.target.value)); surface.current?.restoreSelection(); redraw() }}>
              {Array.from({length:tableCell.columns},(_,index) => <option key={index} value={index}>{index + 1}</option>)}
            </select></label>
            <label>对齐 <select aria-label="当前列对齐" disabled={readOnly}
              value={(tableCell.table.children[0].kind === 'box' && (tableCell.table.children[0].children[tableCell.column] as Box).attrs?.align) || ''}
              onChange={event => currentTableAction({type:'align',index:tableCell.column,
                align:event.target.value as '' | 'left' | 'center' | 'right'},'对齐')}>
              <option value="">默认</option><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
            </select></label>
            <button type="button" disabled={readOnly || tableCell.row === 0}
              onClick={() => currentTableAction({type:'header',index:tableCell.row},'设为表头')}>设为表头</button>
          </>}
          <button type="button" disabled={readOnly} onClick={event => tableActions(event.currentTarget)}>表格操作</button>
        </div>}
        <div data-editor-surface-host ref={host} />
        <TaskCaretHint state={autocomplete} />
        <TaskAutocomplete state={autocomplete} surface={surface} />
        {session.mode === 'render' && session.projection.protected.some(node => node.role !== 'plate-title') && <>
          <button type="button" aria-expanded={rawList} onClick={() => setRawList(!rawList)}>原文保护</button>
          {rawList && <ul>{session.projection.protected.filter(node => node.role !== 'plate-title').map(node => <li key={node.from}>
            <button type="button" disabled={readOnly} onClick={() => fields('raw', surface.current!.captureBookmark(), node)}>{node.role} · {node.from}</button>
          </li>)}</ul>}
        </>}
        {props.children}
      </div>
    </div>
    <div data-editor-status role="status">{props.status}</div>
    {tooltip && !form && !menu && <span data-editor-tooltip role="tooltip" style={{ position: 'fixed',
      left: Math.min(tooltip.anchor.getBoundingClientRect().left, innerWidth - 120),
      top: tooltip.anchor.getBoundingClientRect().bottom + 4 }}>{tooltip.label}</span>}
    {menu && <EditorMenu menu={menu} close={() => setMenu(undefined)} />}
    {form && <EditorDialog title={form.title} close={() => {
      setForm(undefined); setIssue(''); requestAnimationFrame(() => formMark && surface.current?.restoreBookmark(formMark))
    }}><form onKeyDown={event=>{
      if(event.nativeEvent.isComposing || event.keyCode===229) {
        if(event.key==='Enter' || event.key==='Escape') event.preventDefault()
      }
    }} onSubmit={event => {
      event.preventDefault()
      const dialog = event.currentTarget
      const data = new FormData(dialog)
      const values=form.fields.map((_, i) => String(data.get(String(i)) ?? ''))
      const errors=form.validate?.(values) ?? {}
      setPropertyErrors(errors)
      const first=Object.keys(errors)[0]
      if (first!==undefined) {setIssue('');dialog.querySelector<HTMLElement>('#editor-property-'+first)?.focus();return}
      if (form.submit(values)) {
        setForm(undefined); requestAnimationFrame(() => surface.current?.focus())
      } else requestAnimationFrame(()=>dialog.querySelector<HTMLElement>('[data-editor-dialog-error]')?.focus())
    }}>
      {form.fields.map((field, i) => {
        const props={id:'editor-property-'+i,name:String(i),defaultValue:field.initial,
          'aria-invalid':!!propertyErrors[i],'aria-describedby':propertyErrors[i]?'editor-property-error-'+i:undefined,
          onChange:()=>setPropertyErrors(old=>{const next={...old};delete next[i];return next})}
        return <div key={field.name} data-editor-dialog-field><label htmlFor={props.id}>{field.name}</label>
          {field.multiline ? <textarea {...props} /> : <input {...props} />}
          {propertyErrors[i] && <p role="alert" data-editor-dialog-error id={'editor-property-error-'+i}>{propertyErrors[i]}</p>}</div>
      })}
      {issue && <p role="alert" tabIndex={-1} data-editor-dialog-error>{issue}</p>}
      <footer data-editor-dialog-footer>
        {form.alternate && <button type="button" onClick={() => {
          if (form.alternate?.run()) { setForm(undefined); requestAnimationFrame(() => surface.current?.focus()) }
        }}>{form.alternate.title}</button>}
        <button type="submit">应用</button>
      </footer>
    </form></EditorDialog>}
    {info && <EditorDialog title="完整路径" close={() => setInfo(false)}><p className="editor-full-path">{note.path}</p></EditorDialog>}
    {tablePicker && <TablePicker issue={issue} close={() => {
      setTablePicker(undefined); setIssue(''); requestAnimationFrame(() => surface.current?.restoreBookmark(tablePicker))
    }} insert={(column, row) => {
      if (apply(() => session.table(column, row, tablePicker))) {
        setTablePicker(undefined); requestAnimationFrame(() => surface.current?.focus())
      }
    }}/>}
    {tableRemoval && <EditorDialog title={tableRemoval.title} confirm close={() => {
      setTableRemoval(undefined)
      requestAnimationFrame(() => surface.current?.restoreBookmark(tableRemoval.mark))
    }}>
      <button type="button" onClick={() => { if (tableRemoval.run()) {setTableRemoval(undefined);requestAnimationFrame(()=>surface.current?.focus())} }}>确认</button>
      {issue && <p role="alert">{issue}</p>}
    </EditorDialog>}
  </section>
}

function TablePicker({ close, insert, issue }: { close: () => void; insert: (cols: number, rows: number) => void; issue: string }) {
  const grid = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const focus = (index: number) => grid.current?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
  const label = (i: number) => `${i % 8 + 1}列 ${Math.floor(i / 8) + 1}行（含表头）`
  return <EditorDialog title="插入表格" close={close} kind="table">
    <p role="status">{label(active)}</p>
    <div className="editor-table-picker" ref={grid} role="grid" aria-label="表格行列" onKeyDown={event => {
      const step: Record<string, number> = { ArrowUp: -8, ArrowDown: 8, ArrowLeft: -1, ArrowRight: 1 }
      if (!(event.key in step)) return
      event.preventDefault()
      if (event.key === 'ArrowLeft' && active % 8 === 0 || event.key === 'ArrowRight' && active % 8 === 7) return
      focus(Math.max(0, Math.min(159, active + step[event.key])))
    }}>
      {Array.from({ length: 20 }, (_, row) => <div role="row" key={row}>
        {Array.from({ length: 8 }, (_, column) => {
          const index = row * 8 + column
          return <button key={column} type="button" role="gridcell" data-editor-initial={index === 0 ? '' : undefined}
            tabIndex={index === active ? 0 : -1} aria-label={label(index)}
            aria-selected={row <= Math.floor(active / 8) && column <= active % 8}
            onFocus={() => setActive(index)} onPointerEnter={() => setActive(index)} onClick={() => insert(column + 1, row + 1)}/>
        })}
      </div>)}
    </div>
    {issue && <p data-editor-dialog-error role="alert">{issue}</p>}
  </EditorDialog>
}

function EditorMenu({ menu, close }: { menu: Menu; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    const place = () => {
      const rect = menu.anchor.getBoundingClientRect()
      if (!menu.anchor.isConnected || rect.bottom < 56 || rect.top > innerHeight - 32) { close(); return }
      el.style.left = Math.max(8, Math.min(rect.left, innerWidth - el.offsetWidth - 8)) + 'px'
      el.style.top = Math.max(64, Math.min(rect.bottom + 4 + el.offsetHeight > innerHeight - 40 ? rect.top - el.offsetHeight - 4 : rect.bottom + 4,
        innerHeight - el.offsetHeight - 40)) + 'px'
    }
    place()
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !el.contains(event.target)) close() }
    window.addEventListener('pointerdown', outside)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('pointerdown', outside); window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true) }
  }, [menu])
  return <div ref={ref} data-editor-float role="menu" onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      menu.anchor.focus(); close(); if (event.key === 'Escape') event.preventDefault(); return
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus()
  }}>{menu.detail && <p className="editor-float-detail">{menu.detail}</p>}{menu.choices.map(choice => <button key={choice.label} tabIndex={-1} role="menuitem" data-editor-float-item type="button" disabled={choice.disabled}
    aria-description={choice.reason} title={choice.reason} onClick={() => { close(); choice.run() }}>{choice.label}</button>)}</div>
}

function P10Tasks({noteId,revision,readOnly}:{noteId:string;revision:string;readOnly:boolean}) {
  const [rows,setRows]=useState<TaskInfo[]>([])
  const [failed,setFailed]=useState(false)
  useEffect(()=>{
    let alive=true,seq=0
    const load=()=>{
      const n=++seq
      void window.workbench.p11.tasks(noteId).then(v=>{if(alive && n===seq){setRows(v);setFailed(false)}},
        ()=>{if(alive && n===seq)setFailed(true)})
    }
    load()
    window.addEventListener('p11-changed',load)
    const timer=setInterval(load,3500)
    return()=>{alive=false;clearInterval(timer);window.removeEventListener('p11-changed',load)}
  },[noteId,revision])
  const tasks=rows.filter(t=>t.noteId===noteId)
  if(failed)return <p className="p11-note">暂时无法核对任务绑定。</p>
  if(!tasks.length || readOnly)return null
  return <section aria-label="P10 任务和会话绑定" className="p11-tasks" data-design-id="P10.binding">
    <h3>任务与会话绑定</h3>{tasks.map((task,i)=><TaskActions key={task.blockId+':'+i} task={task}/>)}
  </section>
}

export function EditorDialog({ title, close, children, confirm = false, cancelLabel = '取消', kind }: {
  title: string; close: () => void; children: ReactNode; confirm?: boolean; cancelLabel?: string; kind?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    const initial = dialog.querySelector<HTMLElement>(confirm ? '[data-editor-dialog-cancel]' : '[data-editor-initial],input,textarea') ??
      dialog.querySelector<HTMLElement>('[data-editor-dialog-cancel]')
    initial?.focus()
    return () => dialog.close()
  }, [])
  return <dialog ref={ref} data-editor-dialog data-kind={confirm ? 'confirm' : kind} aria-label={title}
    onKeyDown={event => {
      if (event.key==='Escape' && (event.nativeEvent.isComposing || event.keyCode===229 || event.repeat)) event.preventDefault()
      event.stopPropagation()
    }} onCancel={event => { event.preventDefault(); event.stopPropagation(); close() }}>
    <header data-editor-dialog-header>{title}</header>{children}
    <button data-editor-dialog-cancel type="button" onClick={close}>{cancelLabel}</button>
  </dialog>
}

