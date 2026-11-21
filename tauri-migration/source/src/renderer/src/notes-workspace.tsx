import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { DEFAULT_PROJECT, type DraftRecovery, type DraftSummary, type LinkIndex, type Note, type NoteSummary, type NoteTemplate, type ProjectSummary } from '../../shared/ipc'
import { linkCatalog, resolveLink } from '../../shared/link-resolution'
import { EditorDialog, NoteEditor } from './note-editor'
import { EditorSession } from './editor/session'
import type { EditorSurface } from './editor/surface'
import { commandLayer, focus, target, usePaletteOwner, type Source } from './palette-registry'
import { QuickNodePopover } from './quick-node-popover'
import { PlateWordmark } from './plate-wordmark'
import { RelationshipGraph } from './relationship-graph'
import { noteRelations } from './relation-directions'
import { NOTE_DRAWER_WIDTH_MAX, NOTE_DRAWER_WIDTH_MIN, useWorkbench } from './store'

const errorText = (error: unknown) => {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  if (/database or disk is full|磁盘空间不足|磁盘已满/i.test(message)) return '磁盘空间不足，无法完成写入。释放空间后重试。'
  return message
}
const DRAFT_DELAY_MS = 700
const fileName = (path: string) => path.split(/[\\/]/).at(-1)


export function NotesWorkspace({ hudRight, brainOpen, onBrainOpenChange }: {
  hudRight: ReactNode
  brainOpen: boolean
  onBrainOpenChange: (open: boolean) => void
}) {
  const drawerWidth = useWorkbench((state) => state.noteDrawerWidth)
  const setDrawerWidthStored = useWorkbench((state) => state.setNoteDrawerWidth)
  const api = window.workbench.notes
  const [index, setIndex] = useState<LinkIndex>({ nodes: [], edges: [], bindings: [] })
  const items = index.nodes
  const [indexState,setIndexState] = useState<{busy:boolean; error?:string}>({busy:true})
  const requestIndex = useRef<()=>void>(()=>{})
  const [workspaceStatus, setWorkspaceStatus] = useState<'pending' | 'ready' | 'failed'>('pending')
  const workspaceReady = useRef(false)
  const refreshWorkspace = useRef<() => Promise<void>>(async () => {})
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [project, setProject] = useState('')
  const [tag, setTag] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [focusId, setFocusId] = useState<string>()
  const searchOrigin = useRef<Source>(undefined)
  const searchButton = useRef<HTMLButtonElement>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [draft, setDraft] = useState('')
  const [recoveries, setRecoveries] = useState<DraftSummary[]>([])
  const [recoveryPreview, setRecoveryPreview] = useState<Extract<DraftRecovery, { status: 'preview' }>>()
  const [leave, setLeave] = useState<{ choose: (allowed: 'save' | 'discard' | 'stay') => void }>()
  const [confirmDiscard, setConfirmDiscard] = useState<DraftSummary>()
  const draftVersion = useRef<string | undefined>(undefined)
  const persistedDraft = useRef<{identity: object; content: string}>(undefined)
  const [draftState, setDraftState] = useState<'pending' | 'written' | 'unavailable' | 'failed'>('pending')
  const draftTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftGeneration = useRef(0)
  const editorIdentity = useRef<object>({})
  const recoveryOpener = useRef<HTMLElement | null>(null)
  const [session, setSession] = useState<EditorSession>()
  const liveSession = useRef<EditorSession | undefined>(undefined)
  const surface = useRef<EditorSurface | null>(null)
  const graphHandle = useRef<ReturnType<EditorSession['suspend']> | undefined>(undefined)
  const drawerResize = useRef<{ pointer: number; startWidth: number; startX: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [externalPath, setExternalPath] = useState('')
  const [conflict, setConflict] = useState<{ copy: Note; originalExists: boolean }>()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [linkPrompt, setLinkPrompt] = useState<string>()
  const linkAnchor = useRef<Element | null>(null)
  const promptFocus = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const focusAfterOperation = useRef<() => void>(undefined)
  const selection = useRef<string | null>(null)
  const selectedPath = useRef<string | undefined>(undefined)
  const draftWritePending = useRef<Promise<boolean> | undefined>(undefined)
  const cleanDiscard = useRef<{identity: object} | undefined>(undefined)
  const [projectForm, setProjectForm] = useState<{ name: string; restore: () => void }>()
  const [deleting, setDeleting] = useState<{ note: Note; restore: () => void }>()
  const [dialogError, setDialogError] = useState('')
  const dirty = note !== null && draft !== note.content
  const external = externalPath === note?.path
  const catalog = useMemo(() => linkCatalog(items), [items])
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const activeId = note?.id
  const tags = useMemo(() => [...new Set(items.flatMap(item => item.tags ?? []))].sort((a, b) => a.localeCompare(b, 'zh-CN')), [items])
  const visible = useMemo(() => items.filter(item => (!project || item.projectId === project) &&
    (!tag || item.tags?.includes(tag))), [items, project, tag])
  const visibleEdges = useMemo(() => {
    const ids = new Set(visible.map(item => item.id))
    return index.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target))
  }, [visible, index.edges])
  const searchFilters = useMemo(() => ({ projectId: project || undefined, tags: tag ? [tag] : undefined }), [project, tag])
  const writableProject = projects.find(item => item.id === project && item.archivedAt === null)?.id ?? DEFAULT_PROJECT
  const { upstream, downstream, self, bindings } = useMemo(() => {
    return { ...noteRelations(index.edges,catalog.byId,activeId), bindings: new Map(index.bindings.filter((b) => b.source === activeId)
      .map((b) => [b.ref, b.target])) }
  }, [index, catalog, activeId])
  const removedLink=linkPrompt!==undefined&&(index.removedRefs?.includes(linkPrompt) ||
    index.removedRefs?.includes(bindings.get(linkPrompt)??''))
  const prompt = linkPrompt === undefined ? undefined : resolveLink(catalog, linkPrompt, bindings.get(linkPrompt))

  const shortIds = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { id } of items) counts.set(id.slice(0, 8), (counts.get(id.slice(0, 8)) ?? 0) + 1)
    return counts
  }, [items])
  const label = (n: NoteSummary) => {
    const prefix = n.id.slice(0, 8)
    const project = n.projectId === DEFAULT_PROJECT ? '未归属' : projectNames.get(n.projectId) ?? n.projectId
    return `${n.title} · ${project} · ${(shortIds.get(prefix) ?? 0) > 1 ? n.id : prefix}`
  }

  function cancelDraftTimer() {
    clearTimeout(draftTimer.current)
    draftGeneration.current++
  }

  function changeDraft(value: string) {
    cancelDraftTimer()
    setDraftState('pending')
    setDraft(value)
    if (note && value === note.content && !pendingRecovery) {
      const identity=editorIdentity.current
      const generation=draftGeneration.current
      const receipt={identity}
      cleanDiscard.current=receipt
      void discardCurrent(generation).catch((failure) => {
        if(editorIdentity.current===identity && draftGeneration.current===generation)setError(errorText(failure))
      }).finally(()=>{if(cleanDiscard.current===receipt)cleanDiscard.current=undefined})
    }
  }

  function show(next: Note | null, recovered?: string, version?: string, prepared?: EditorSession) {
    const editor = prepared ?? (next ? verifyEditable(next, recovered) : undefined)
    cancelDraftTimer()
    editorIdentity.current={}
    draftVersion.current = version
    persistedDraft.current = recovered === undefined ? undefined : {identity:editorIdentity.current,content:recovered}
    setDraftState(recovered === undefined ? 'pending' : 'written')
    selection.current = next?.id ?? null
    selectedPath.current = next?.path
    setNote(next)
    setDraft(recovered ?? next?.content ?? '')
    liveSession.current = editor
    setSession(editor)
    graphHandle.current = undefined
    setExternalPath('')
    setLinkPrompt(undefined)
    if (next) localStorage.setItem('notes:last-open', next.id)
    else localStorage.removeItem('notes:last-open')
  }

  function verifyEditable(next: Note, recovered?: string) {
    return new EditorSession(next.id, next.revision, next.content, undefined, recovered)
  }

  // 关系图是常驻主舞台：抽屉关闭时挂起编辑会话，打开时恢复。
  useEffect(() => {
    if (drawerOpen) {
      if (session && graphHandle.current) { session.resume(graphHandle.current); graphHandle.current = undefined }
    } else if (session && !graphHandle.current && !busy) {
      surface.current?.suspendForGraph()
      graphHandle.current = session.suspend(session.noteId)
    }
  }, [drawerOpen, session, busy])

  useEffect(() => {
    let active = true
    let sequence = 0, indexSequence=0
    async function refreshIndex(explicit=false) {
      const request=++indexSequence
      if (explicit) setIndexState({busy:true})
      try {
        const next=await api.links()
        if (!active || request!==indexSequence) return
        setIndex(next); setIndexState({busy:false})
        return next
      } catch (failure) {
        if (active && request===indexSequence) setIndexState({busy:false,error:errorText(failure)})
      }
    }
    requestIndex.current=()=>void refreshIndex(true)
    let pending: ReturnType<typeof setTimeout> | undefined
    let externalTimer: ReturnType<typeof setTimeout> | undefined
    let externalSequence = 0
    const pathKey = (path: string) => navigator.platform.startsWith('Win')
      ? path.replaceAll('/', '\\').toLowerCase() : path
    function checkExternal(path: string) {
      clearTimeout(externalTimer)
      const expected = ++externalSequence
      const identity = editorIdentity.current
      const id = selection.current
      const selected = selectedPath.current
      if (!id || !selected) return
      const current = () => active && expected === externalSequence &&
        editorIdentity.current === identity && selection.current === id
      async function check(id: string, selected: string) {
        if (!current()) return
        if (inFlight.current) {
          externalTimer = setTimeout(() => void check(id, selected), 100)
          return
        }
        const disk = await api.read(id).then(note => note.revision, () => undefined)
        if (!current()) return
        if (inFlight.current) {
          externalTimer = setTimeout(() => void check(id, selected), 100)
          return
        }
        setExternalPath(disk !== liveSession.current?.baseRevision ? selected : '')
      }
      if (pathKey(path) === pathKey(selected)) void check(id, selected)
    }
    async function refresh(initial = false, propagate = false) {
      const request = ++sequence
      workspaceReady.current = false
      setWorkspaceStatus('pending')
      try {
        const [index, projects, stored] = await Promise.all([refreshIndex(), api.projects(), api.draftList()])
        if (!active) return
        if (request !== sequence) return
        if (initial) setRecoveries(stored)
        else setRecoveries((previous) => {
          return stored.filter(({ id }) => id !== selection.current || previous.some((entry) => entry.id === id))
        })
        const rows = index?.nodes ?? []
        setProjects(projects)
        if (!index) throw new Error('笔记关系索引未能刷新')
        if (initial && rows.length && !selection.current && !inFlight.current) {
          const last = localStorage.getItem('notes:last-open')
          const archived = new Set(projects.filter((project) => project.archivedAt !== null).map((project) => project.id))
          const target = rows.find((row) => row.id === last) ??
            rows.find((row) => row.kind === 'note' && !archived.has(row.projectId)) ??
            rows.find((row) => !archived.has(row.projectId))
          if (target) {
            const next = await api.read(target.id)
            if (active && request === sequence && !selection.current && !inFlight.current) show(next)
          }
        }
        if (active && request === sequence) { workspaceReady.current = true; setWorkspaceStatus('ready') }
      } catch (failure) {
        if (active && request === sequence) {
          setWorkspaceStatus('failed')
          setError(errorText(failure))
          if (propagate) throw failure
        }
      }
    }
    refreshWorkspace.current = () => refresh(false, true)
    const unsubscribe = api.onChanged((path, external) => {
      if (external && selectedPath.current && pathKey(selectedPath.current) === pathKey(path)) checkExternal(path)
      workspaceReady.current = false
      setWorkspaceStatus('pending')
      if (pending === undefined) pending = setTimeout(() => { pending = undefined; void refresh() }, 0)
    })
    void refresh(true)
    return () => { active = false; workspaceReady.current = false; clearTimeout(pending); clearTimeout(externalTimer); unsubscribe() }
  }, [api])

  useEffect(() => {
    if (!note || busy || !dirty) return
    const generation = draftGeneration.current
    const identity = editorIdentity.current
    if (draftState === 'written') return
    if (cleanDiscard.current?.identity!==identity && persistedDraft.current?.identity===identity && persistedDraft.current.content===draft) {
      setDraftState('written')
      return
    }
    draftTimer.current = setTimeout(() => {
      const version = crypto.randomUUID()
      const previous = draftWritePending.current
      const write = (async()=>{
        await previous?.catch(()=>false)
        if (editorIdentity.current!==identity || draftGeneration.current!==generation) return false
        const written=await api.draftWrite(note.id, draft, note.revision, version)
        if (written && editorIdentity.current===identity) {
          draftVersion.current=version
          persistedDraft.current={identity,content:draft}
        }
        return written
      })()
      draftWritePending.current = write
      void write.then((written) => {
        if (editorIdentity.current===identity && draftGeneration.current === generation) setDraftState(written ? 'written' : 'unavailable')
      }, (failure) => {
        if (editorIdentity.current===identity && draftGeneration.current === generation) {
          setDraftState('failed')
          setError(errorText(failure))
        }
      }).finally(() => { if (draftWritePending.current === write) draftWritePending.current = undefined })
    }, DRAFT_DELAY_MS)
    return () => clearTimeout(draftTimer.current)
  // Changes to the status report completion of this effect; they must not start another write.
  }, [api, note, draft, dirty, busy])

  useEffect(() => {
    function confirmClose(event: BeforeUnloadEvent) {
      if (dirty || inFlight.current) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', confirmClose)
    return () => window.removeEventListener('beforeunload', confirmClose)
  }, [dirty])

  useLayoutEffect(() => {
    if (busy || leave || !focusAfterOperation.current) return
    const focus = focusAfterOperation.current
    focusAfterOperation.current = undefined
    focus()
  })

  async function run(action: () => Promise<void>, failureFocus?:()=>void) {
    if (inFlight.current) return
    inFlight.current = true
    cancelDraftTimer()
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await draftWritePending.current?.catch(() => false)
      await action()
    } catch (failure) {
      setError(errorText(failure))
      focusAfterOperation.current = failureFocus ?? (() => surface.current?.focus())
    }
    finally { inFlight.current = false; setBusy(false) }
  }

  const pendingRecovery = recoveries.some(({ id }) => id === note?.id)
  const removeRecovery = (id: string) => setRecoveries((previous) => previous.filter((entry) => entry.id !== id))
  const discardCurrent = async (generation?:number) => {
    const identity=editorIdentity.current
    await draftWritePending.current?.catch(() => false)
    if (editorIdentity.current!==identity || (generation!==undefined && draftGeneration.current!==generation)) return
    const version = draftVersion.current
    if (note && version) {
      const discarded = await api.draftDiscard(note.id, version)
      if (!discarded && (await api.draftList()).some(item => item.id === note.id)) throw new Error('草稿已变化，请重新核对')
      if (editorIdentity.current===identity && draftVersion.current === version) {
        draftVersion.current = undefined
        persistedDraft.current = undefined
      }
    }
  }

  function recover(id: string) {
    recoveryOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null
    void run(async () => {
      const result = await api.draftRestore(id)
      if (result.status === 'missing') { removeRecovery(id); setMessage('草稿已不可恢复'); return }
      if (result.status === 'preview') { setRecoveryPreview(result); return }
      const choice = await chooseLeave()
      if (choice === 'stay') return
      const next = await api.read(result.note.id)
      const latest = await api.draftRestore(id)
      if (next.path !== result.note.path || next.revision !== result.note.revision || latest.status !== 'restored' || latest.version !== result.version) {
        throw new Error('磁盘版本或草稿已变化，请重新核对')
      }
      const prepared = verifyEditable(next, result.content)
      await finishLeave(choice)
      removeRecovery(id)
      setDrawerOpen(true)
      setConflict(undefined)
      show(next, result.content, result.version, prepared)
      setMessage('已恢复草稿')
    })
  }

  function discardRecovery({ id, version }: DraftSummary) {
    void run(async () => {
      if (!await api.draftDiscard(id, version)) throw new Error('草稿已变化，请重新核对')
      setRecoveryPreview(undefined)
      removeRecovery(id)
      setMessage('草稿已丢弃')
    })
  }

  async function chooseLeave(): Promise<'save' | 'discard' | 'stay'> {
    if (session?.composing) return 'stay'
    if (!dirty) return 'discard'
    const mark = surface.current?.captureBookmark(Infinity)
    return new Promise(resolve => setLeave({ choose: (choice) => {
      setLeave(undefined)
      if (choice === 'stay') focusAfterOperation.current = () => {if (mark) surface.current?.restoreBookmark(mark)}
      resolve(choice)
    } }))
  }

  async function finishLeave(choice: 'save' | 'discard') {
    if (choice === 'save') await saveCurrent(false)
    // Reverting to the disk text already dispatched a conditional discard. A
    // clean note may leave without a second request for that same old version.
    else if (dirty || cleanDiscard.current?.identity!==editorIdentity.current) await discardCurrent()
  }

  function select(id: string, origin?: HTMLElement) {
    const trigger=origin??document.activeElement
    const focusSource=()=>{
      if (trigger instanceof HTMLElement && trigger.isConnected && trigger.getClientRects().length) trigger.focus({preventScroll:true})
      else document.querySelector<HTMLElement>('.relations-canvas')?.focus({preventScroll:true})
    }
    if (inFlight.current) return
    if (id === note?.id) {
      closeLinkPrompt()
      setDrawerOpen(true)
      return
    }
    void run(async () => {
      const choice = await chooseLeave()
      if (choice === 'stay') {
        if (linkPrompt!==undefined) focusAfterOperation.current = focusSource
        return
      }
      const next = await api.read(id, true)
      const prepared = verifyEditable(next)
      await finishLeave(choice)
      show(next, undefined, undefined, prepared)
      setDrawerOpen(true)
      setConflict(undefined)
      focusAfterOperation.current = () => document.querySelector<HTMLElement>('[data-editor-meta-title]')?.focus()
    },focusSource)
  }

  function openSearch(source?: Source) {
    const origin = document.activeElement
    searchOrigin.current = source ?? {
      element: origin instanceof HTMLElement ? origin : null,
      restore: () => {
        if (origin instanceof SVGElement && origin.isConnected) origin.focus({ preventScroll: true })
        else if (!(origin instanceof HTMLElement && focus(origin))) focus(searchButton.current)
      },
    }
    setSearchOpen(true)
  }

  function closeSearch(restore = true) {
    setSearchOpen(false)
    if (restore) requestAnimationFrame(() => searchOrigin.current?.restore())
  }

  function locateNode(id: string) {
    closeSearch(false)
    setFocusId(undefined)
    requestAnimationFrame(() => setFocusId(id))
  }

  function closeNoteDrawer() {
    if (!drawerOpen) return
    setDrawerOpen(false)
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-label="关系图画布"]')?.focus({preventScroll:true}))
  }

  function openNoteDrawer() {
    if (drawerOpen || !note || inFlight.current) return
    setDrawerOpen(true)
  }

  function closeLinkPrompt() {
    if (linkPrompt === undefined) return
    setLinkPrompt(undefined)
    if (linkAnchor.current instanceof HTMLElement && linkAnchor.current.isConnected) linkAnchor.current.focus()
  }

  function activateLink(ref: string, anchor: Element) {
    if (inFlight.current) return
    linkAnchor.current = anchor
    setLinkPrompt(ref)
    requestAnimationFrame(()=>promptFocus.current?.focus())
  }
  useEffect(() => { if (linkPrompt !== undefined) promptFocus.current?.focus() }, [linkPrompt])

  function newNote(template: NoteTemplate, _source?: Source, partition = writableProject) {
    if (inFlight.current || session?.composing) return
    void run(async () => {
      const choice = await chooseLeave()
      if (choice === 'stay') return
      if (choice === 'save') await finishLeave(choice)
      const next = await api.create('', partition, template)
      const prepared = verifyEditable(next)
      if (choice === 'discard') await finishLeave(choice)
      show(next, undefined, undefined, prepared)
      setDrawerOpen(true)
      setConflict(undefined)
      setMessage('笔记已新建')
      focusAfterOperation.current = () => document.querySelector<HTMLInputElement>('[data-editor-meta-title]')?.focus()
    })
  }

  function newProject(source?: Source) {
    const origin = document.activeElement
    setDialogError('')
    setProjectForm({ name: '', restore: source?.restore ?? (() => {
      if (origin instanceof HTMLElement) focus(origin)
    }) })
  }
  function closeProject() {
    if (inFlight.current) return
    setProjectForm(undefined)
    if (projectForm) requestAnimationFrame(projectForm.restore)
  }
  function createProject() {
    if (!projectForm || !projectForm.name.trim() || inFlight.current) return
    const { name, restore } = projectForm
    void run(async () => {
      try {
        const next = await api.createProject(name.trim())
        setProjects(previous => [...previous.filter(p => p.id !== next.id), next])
        setProject(next.id)
        setProjectForm(undefined)
        requestAnimationFrame(restore)
        await refreshWorkspace.current()
      } catch (reason) { setDialogError(errorText(reason)) }
    })
  }
  useEffect(() => {
    const handle = (event: Event) => {
      const id = (event as CustomEvent<{ noteId: string }>).detail?.noteId
      if (typeof id === 'string' && id && !inFlight.current) select(id)
    }
    window.addEventListener('collab-open-note', handle)
    return () => window.removeEventListener('collab-open-note', handle)
  })
  const unavailable = session?.composing ? '请先结束输入法组合' : busy || inFlight.current
    ? '正在处理笔记，请稍候' : undefined
  const mayAct = () => workspaceReady.current && !inFlight.current && !session?.composing && selection.current === (note?.id ?? null)
  const projectUnavailable = unavailable ?? (pendingRecovery ? '请先核对当前笔记的草稿' : undefined)
  const bookIdentity = editorIdentity.current
  const objectVersion = [note?.id, session?.baseRevision, session?.version].join(':')
  usePaletteOwner('workspace', {
    workspace: workspaceStatus,
    composing: () => !!session?.composing,
    source: element => {
      if (!element?.closest('.notes-editor')) return
      const editing = surface.current
      const version = session?.version
      const mark = element.closest('[data-editor-host]') ? editing?.captureBookmark(Infinity) : undefined
      return () => {
        if (bookIdentity !== editorIdentity.current) return false
        if (mark && editing && surface.current === editing && version === session?.version &&
          element.getClientRects().length && !element.closest('[hidden]')) {
          editing.restoreBookmark(mark)
          if (document.activeElement === element) return true
        }
        return focus(element) || focus(target('.note-editor-body:not([hidden]) [data-editor-host]').element())
      }
    },
    actions: {
      'm51.note.new': { reason: unavailable, basis: objectVersion, allowed: mayAct,
        run: source => { newNote('blank', source); return target('[data-editor-meta-title]') } },
      'm51.note.search': { allowed: () => workspaceReady.current, run: source => { openSearch(source); return target('.plate-node-search input') } },
      'm51.note.graph': { allowed: () => workspaceReady.current, run: () => { closeNoteDrawer(); return target('.relations-canvas') } },
      'm51.project.new': { reason: projectUnavailable, basis: objectVersion, allowed: mayAct,
        run: source => { newProject(source); return target('dialog[data-kind=project-create][open] input') } }
    }
  })

  useEffect(() => {
    function key(event: globalThis.KeyboardEvent) {
      if (document.querySelector('.home-document-host[hidden]')) return
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key === 'Process' || event.keyCode===229 ||
          !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || !['k','n'].includes(event.key.toLowerCase())) return
      if (commandLayer() || document.querySelector('dialog[open]:not(.notes-drawer),[role=menu]') || inFlight.current || session?.composing) return
      event.preventDefault()
      if (event.key.toLowerCase() === 'k') openSearch()
      else newNote('blank')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [session, writableProject])

  function save() {
    if (!note || !session || !dirty || pendingRecovery || session.locked || inFlight.current) return
    void run(async () => { await saveCurrent(true) })
  }

  async function commitTaskEdit(version: number, from: number, to: number, insert: string) {
    const editor = surface.current
    if (!note || !session || !editor?.canPatch || !api.updateStrict || inFlight.current ||
        pendingRecovery || external || session.version !== version || note.revision !== session.baseRevision) {
      throw new Error('请先核对当前笔记或结束编辑，再试一次')
    }
    const { raw, baseRevision } = session
    const next = raw.slice(0, from) + insert + raw.slice(to)
    let committed = false
    editor.setResultLock(true)
    try {
      await run(async () => {
        let versionToDiscard: string | undefined
        if (session.dirty) {
          versionToDiscard = crypto.randomUUID()
          if (!await api.draftWrite(note.id, raw, baseRevision, versionToDiscard)) {
            throw new Error('无法保全当前草稿，任务未提交')
          }
          draftVersion.current = versionToDiscard
          persistedDraft.current = { identity: editorIdentity.current, content: raw }
          setDraftState('written')
        }
        const result = await api.updateStrict!(note.id, next, baseRevision)
        if (result.status !== 'saved') throw new Error('笔记版本已变化，任务未提交')
        const updated = editor.outsideEdit(() => {
          session.adoptResult(baseRevision, version, result.note, from, to, insert, true)
          return true
        })
        if (!updated) throw new Error('无法同步编辑器，请读取磁盘版本')
        setNote(result.note)
        setDraft(result.note.content)
        setExternalPath('')
        setConflict(undefined)
        committed = true
        if (versionToDiscard && await api.draftDiscard(note.id, versionToDiscard)) {
          draftVersion.current = undefined
          persistedDraft.current = undefined
        }
      })
    } finally { editor.setResultLock(false) }
    return committed
  }

  async function saveCurrent(showConflict: boolean) {
    if (!note || !session) return
    const resume = graphHandle.current
    if (resume) session.resume(resume)
    try {
      const ticket = session.beginSave()
      if (!ticket) return
      try {
        const version = crypto.randomUUID()
        if (!await api.draftWrite(note.id, ticket.raw, ticket.baseRevision, version)) throw new Error('无法保全当前草稿')
        draftVersion.current = version
        persistedDraft.current={identity:editorIdentity.current,content:ticket.raw}
        const result = await api.update(note.id, ticket.raw, ticket.baseRevision, version)
        draftVersion.current = undefined
        persistedDraft.current = undefined
        if (result.status === 'saved') {
          session.finishSave(ticket, { ok: true, revision: result.note.revision })
          setNote(result.note)
          setExternalPath('')
          setConflict(undefined)
          setMessage('已保存到 Markdown 文件')
        } else if (showConflict) {
          show(result.current ?? result.copy)
          setConflict({ copy: result.copy, originalExists: result.current !== null })
        } else {
          show(result.current ?? result.copy)
          setConflict({ copy: result.copy, originalExists: result.current !== null })
          setMessage('草稿已保存为冲突副本')
        }
        return result
      } finally {
        session.finishSave(ticket, { ok: false })
      }
    } finally {
      if (resume && graphHandle.current === resume) graphHandle.current = session.suspend(session.noteId)
    }
  }

  function reload() {
    if (!note) return
    void run(async () => {
      const choice = await chooseLeave()
      if (choice === 'stay') return
      let next = await api.read(note.id)
      let prepared = verifyEditable(next)
      if (choice === 'save') {
        const saved = await saveCurrent(false)
        if (saved?.status === 'saved') { next = saved.note; prepared = verifyEditable(next) }
      } else await finishLeave(choice)
      show(next, undefined, undefined, prepared)
      setMessage('已读取磁盘版本')
      setConflict(undefined)
    })
  }

  function remove() {
    if (note && !session?.composing) askDelete(note)
  }
  function askDelete(target: NoteSummary) {
    const opener = document.activeElement
    const restore = () => {
      if (!(opener instanceof HTMLElement && focus(opener))) {
        focus(document.querySelector<HTMLElement>('.notes-tree, .plate-sidebar-toggle'))
      }
    }
    void run(async () => {
      setDialogError('')
      if (recoveries.some(d => d.id === target.id) || note?.id === target.id && dirty) {
        throw new Error('请先保存或处理这篇笔记的草稿，再移除笔记')
      }
      setDeleting({ note: target.id === note?.id ? note : await api.read(target.id), restore })
    }, restore)
  }
  function closeDelete() {
    if (inFlight.current) return
    setDeleting(undefined)
    if (deleting) requestAnimationFrame(deleting.restore)
  }
  function deleteNote() {
    if (!deleting) return
    const { note: target, restore } = deleting
    void run(async () => {
      try {
        if ((await api.draftList()).some(d => d.id === target.id)) throw new Error('这篇笔记有本地草稿，请先处理草稿')
        if (await api.delete(target.id, target.revision) !== 'deleted') {
          throw new Error('笔记版本已变化，请取消并重新打开确认窗口')
        }
        if (selection.current === target.id) { show(null); setDrawerOpen(false) }
        setDeleting(undefined)
        requestAnimationFrame(restore)
        await refreshWorkspace.current()
      } catch (reason) { setDialogError(errorText(reason)) }
    })
  }
  function saveShortcut(event: KeyboardEvent) {
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      save()
    }
  }

  const hudLeft = <>
    <PlateWordmark />
    <button type="button" ref={searchButton} className="plate-map-search-entry" aria-haspopup="dialog"
      title="搜索或跳转 (Ctrl+K)" onClick={() => openSearch()}>⌕ 搜索 <kbd>Ctrl+K</kbd></button>
    <select aria-label="导图分区" value={project} onChange={event => setProject(event.target.value)}>
      <option value="">全部导图</option>
      {projects.filter(item => item.archivedAt === null).map(item =>
        <option key={item.id} value={item.id}>{item.id === DEFAULT_PROJECT ? '未归属' : item.name}</option>)}
    </select>
    {tags.length > 0 && <select aria-label="筛选标签" value={tag} onChange={event => setTag(event.target.value)}>
      <option value="">全部标签</option>
      {tags.map(label => <option key={label}>{label}</option>)}
    </select>}
    <button type="button" aria-label="新建分区" title="新建分区" onClick={() => newProject()}>＋</button>
    {recoveries.length > 0 && <button type="button" onClick={() => setDrawerOpen(true)}>草稿 {recoveries.length}</button>}
  </>
  return <>
    {searchOpen && <QuickNodePopover visible={visible} filters={searchFilters} label={label}
      locate={locateNode} close={() => closeSearch()} searchAll={() => { setProject(''); setTag('') }}/>}
    <main className="pane editor notes-editor notes-stage" aria-label="编辑区" onKeyDown={saveShortcut}>
      <RelationshipGraph nodes={visible} edges={visibleEdges} selected={activeId} focusId={focusId} hudLeft={hudLeft} hudRight={hudRight}
        brainOpen={brainOpen} onBrainOpenChange={onBrainOpenChange}
        revealOutside={id => { setProject(''); setTag(''); locateNode(id) }}
        activeProject={writableProject} projectFilter={project || undefined}
        projectLabel={projects.find(item => item.id === writableProject)?.name ?? '默认'} label={label} open={(id, origin) => select(id, origin)}
        close={closeNoteDrawer} editorOpen={drawerOpen} rightInset={drawerOpen ? drawerWidth + 16 : 0}
        canChange={id => !inFlight.current && !recoveries.some(draft => draft.id === id) &&
          (id !== note?.id || !dirty && !session?.composing && !external)}
        noteUpdated={next => {
          if (next.id === selection.current && next.id === note?.id && !session?.dirty &&
              !session?.composing && next.revision !== session?.baseRevision) show(next)
        }}
        state={indexState} reload={()=>requestIndex.current()} />
      <aside className={drawerOpen ? 'note-drawer open' : 'note-drawer'} data-open={drawerOpen}
        aria-label="笔记编辑抽屉" aria-hidden={!drawerOpen || undefined} inert={!drawerOpen}
        style={{ '--note-drawer-width': drawerWidth + 'px' } as CSSProperties}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return
          if (leave || recoveryPreview || confirmDiscard || deleting || projectForm) return
          event.preventDefault()
          closeNoteDrawer()
        }}>
        <div className="note-drawer-resize" role="separator" aria-label="调整抽屉宽度" aria-orientation="vertical"
          tabIndex={drawerOpen ? 0 : -1} aria-valuemin={NOTE_DRAWER_WIDTH_MIN} aria-valuemax={NOTE_DRAWER_WIDTH_MAX}
          aria-valuenow={drawerWidth}
          onPointerDown={event => {
            if (!drawerOpen || event.button !== 0 || !event.isPrimary) return
            drawerResize.current = { pointer: event.pointerId, startWidth: drawerWidth, startX: event.clientX }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => {
            const state = drawerResize.current
            if (!state || state.pointer !== event.pointerId) return
            setDrawerWidthStored(state.startWidth + (state.startX - event.clientX))
          }}
          onPointerUp={event => { if (drawerResize.current?.pointer === event.pointerId) drawerResize.current = null }}
          onLostPointerCapture={event => { if (drawerResize.current?.pointer === event.pointerId) drawerResize.current = null }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'ArrowLeft') setDrawerWidthStored(drawerWidth + 16)
            else if (event.key === 'ArrowRight') setDrawerWidthStored(drawerWidth - 16)
            else return
            event.preventDefault()
          }} />
        <div className="note-drawer-heading">
          <h2 id="editor-title">笔记</h2>
          <div className="note-actions">
            <button type="button" className="icon-button" aria-label="关闭编辑抽屉" onClick={closeNoteDrawer}>×</button>
          </div>
        </div>
        <div className="note-drawer-body">
      {recoveries.length > 0 && <section className="note-notice draft-recovery" aria-label="草稿恢复">
        <strong>发现未保存的本地草稿</strong>
        <ul>{recoveries.map((entry) => <li key={entry.id} data-draft-id={entry.id}>
          <span>{entry.title} · {entry.id} · {new Date(entry.writtenAt).toLocaleString('zh-CN')}</span>
          <small>{draftSourceText[entry.source]}</small>
          <button type="button" disabled={busy} onClick={() => recover(entry.id)}>{entry.source === 'unchanged' ? '恢复草稿' : '核对草稿'}</button>
          <button type="button" disabled={busy} onClick={() => setConfirmDiscard(entry)}>丢弃草稿</button>
        </li>)}</ul>
      </section>}
      {recoveryPreview && <RecoveryPreview value={recoveryPreview} opener={recoveryOpener.current} busy={busy} error={error} close={() => {
        setRecoveryPreview(undefined)
      setError('')
      }} save={() => {
        void run(async () => {
          const choice = await chooseLeave()
          if (choice === 'stay') return
          if (choice === 'save') await finishLeave(choice)
          const { id, version } = recoveryPreview.draft
          const copy = await api.draftSaveCopy(id, version, {source:recoveryPreview.draft.source,diskRevision:recoveryPreview.diskRevision})
          if (choice === 'discard') await finishLeave(choice)
          removeRecovery(id)
          setRecoveryPreview(undefined)
          setDrawerOpen(true)
          show(copy)
          setMessage('已另存草稿副本')
        },()=>document.querySelector<HTMLElement>('dialog[aria-label="核对草稿"] [role=alert]')?.focus())
      }} />}
      {conflict && <div role="alert" className="note-notice conflict-notice">
        <strong>保存冲突</strong>
        <p>{conflict.originalExists ? '已保留外部编辑的原文件。' : '原文件已在磁盘上移除。'}本次草稿已另存为：</p>
        <code title={conflict.copy.path}>{fileName(conflict.copy.path)}</code>
        {note?.id !== conflict.copy.id && <button type="button" disabled={busy} onClick={() => select(conflict.copy.id)}>打开冲突副本</button>}
      </div>}
      {external && <div className="note-notice" role="status">
        检测到文件在外部发生变更。{dirty ? '保存会保留两个版本。' : '可读取最新版本。'}
        <button type="button" disabled={busy} onClick={reload}>读取磁盘版本</button>
      </div>}
      {error && !recoveryPreview && <div role="alert" className="note-notice">{error}</div>}
      {prompt && <div className="note-notice wiki-prompt" role="region" aria-label="笔记引用跳转" tabIndex={-1}
        ref={promptFocus} onKeyDown={(event) => { if (event.key === 'Escape') closeLinkPrompt() }}>
        <strong role="status">{prompt.status === 'missing' ? removedLink ? '引用已失效：'+linkPrompt : `未找到笔记：${linkPrompt}`
          : prompt.status === 'ambiguous' ? `「${linkPrompt}」需要指定目标` : '已找到引用的笔记'}</strong>
        <button type="button" onClick={closeLinkPrompt}>关闭提示</button>
        {prompt.status === 'ambiguous' && <div className="wiki-candidates">
          {prompt.candidates.map((candidate) => <button key={candidate.id} type="button" disabled={busy}
            data-wiki-candidate={candidate.id} onClick={() => select(candidate.id)}>{label(candidate)}</button>)}
          <small>本次选择只打开笔记。若要固定链接，请把目标换成该笔记的完整 UUID。</small>
          <ul>{prompt.candidates.map((candidate) => <li key={candidate.id}>
            <button type="button" disabled={busy} onClick={() => select(candidate.id)}>{candidate.title}</button>
            <small>{candidate.path}</small><code>{candidate.id}</code></li>)}</ul>
        </div>}
        {prompt.status === 'resolved' && <button type="button" disabled={busy}
          onClick={() => select(prompt.note.id)}>{label(prompt.note)}</button>}
      </div>}
      <div className="note-editor-body">
      {note && session ? <NoteEditor session={session} note={note} surface={surface} readOnly={busy || pendingRecovery}
        changed={changeDraft} save={save} remove={remove} wiki={activateLink} commitTaskEdit={commitTaskEdit}
        status={<>
          {dirty && <span data-draft-state={draftState}>{draftState === 'written' ? '草稿已写入本地' : draftState === 'failed' ? '草稿写入失败' :
            draftState === 'unavailable' ? '本地草稿不可用' : '等待写入草稿'}</span>}
          <span data-editor-status-item data-state={busy ? 'saving' : conflict ? 'conflict' : error && dirty ? 'failed' : dirty ? 'dirty' : 'saved'}>
            {busy ? '正在处理…' : error && dirty ? '修改尚未保存' : external ? '磁盘版本已变更' :
              dirty ? '有未保存修改' : conflict ? '草稿已保存为冲突副本' : message || '已同步磁盘'}</span>
        </>}>
        <details data-editor-related open={downstream.length > 0 || undefined}>
          <summary>上游资料 {upstream.length} · 下游去向{' '}
            {downstream.length > 0 ? <span className="plate-links-badge">{downstream.length}</span> : '0'} · 保存后刷新
          </summary>
          <div>
            {([['上游资料', upstream, 'outgoing'], ['下游去向', downstream, 'incoming']] as const).map(([name, notes, direction]) =>
              <section key={direction} aria-label={name} data-link-direction={direction}>
                <strong>{name}</strong>
                {notes.length ? <ul>{notes.map((n) => <li key={n.id}>
                  <button type="button" disabled={busy} data-linked-note={n.id} onClick={() => select(n.id)}>{label(n)}</button>
                </li>)}</ul> : <p>暂无</p>}
              </section>)}
            {self && <p>这篇笔记引用了自己。</p>}
          </div>
        </details>
      </NoteEditor> : <p className="note-empty">{message || '在关系图中选择一个节点，或新建笔记开始编辑。'}</p>}
      </div>
        </div>
      </aside>
    </main>
    {projectForm && <EditorDialog title="新建项目" kind="project-create" close={closeProject}>
      <form onSubmit={event => { event.preventDefault(); createProject() }}>
        <label>项目名称<input required maxLength={100} value={projectForm.name} disabled={busy}
          onChange={event => { setDialogError(''); setProjectForm({ ...projectForm, name: event.currentTarget.value }) }} /></label>
        {dialogError && <p role="alert">{dialogError}</p>}
        <button type="submit" disabled={busy || !projectForm.name.trim()}>创建项目</button>
      </form>
    </EditorDialog>}
    {deleting && <EditorDialog title="移除笔记" confirm close={closeDelete}>
      <p>移除「{deleting.note.title}」及其 Markdown 文件？</p>
      {dialogError && <p role="alert">{dialogError}</p>}
      <button type="button" disabled={busy || !!dialogError} onClick={deleteNote}>确认移除</button>
    </EditorDialog>}
    {confirmDiscard && <EditorDialog title="丢弃草稿" confirm close={() => setConfirmDiscard(undefined)}>
      <p>丢弃「{confirmDiscard.title}」的本地草稿？</p>
      <button type="button" onClick={() => { discardRecovery(confirmDiscard); setConfirmDiscard(undefined) }}>确认丢弃</button>
    </EditorDialog>}
    {leave && <EditorDialog title="有未保存的修改" confirm cancelLabel="留在此页" close={() => leave.choose('stay')}>
      <p>继续前，请选择如何处理当前笔记的修改。</p>
      <div data-editor-dialog-footer>
        <button type="button" onClick={() => leave.choose('save')}>保存并继续</button>
        <button type="button" onClick={() => leave.choose('discard')}>放弃并继续</button>
      </div>
    </EditorDialog>}
  </>
}

const draftSourceText: Record<DraftSummary['source'], string> = {
  unchanged: '恢复后可继续编辑，保存才会更新 Markdown。',
  changed: '磁盘版本已变更。核对后可另存草稿副本。',
  missing: '原文件已移除或移走。核对后可另存草稿副本。',
  unavailable: '暂时无法读取原文件。核对后可另存草稿副本。',
  'same-content': '原文件与草稿内容一致。'
}

function RecoveryPreview({ value, opener, busy, error, close, save }: {
  value: Extract<DraftRecovery, { status: 'preview' }>; opener:HTMLElement|null; busy: boolean; error: string; close: () => void; save: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const notice = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const modal = dialog.current!
    modal.showModal()
    cancel.current?.focus()
    return () => { modal.close(); requestAnimationFrame(()=>{
      if(opener?.isConnected&&opener.getClientRects().length)opener.focus()
      else document.querySelector<HTMLElement>('[data-editor-meta-title]')?.focus()
    }) }
  }, [])
  useLayoutEffect(()=>{
    if(error && !busy)notice.current?.focus()
  },[error,busy])
  return <dialog ref={dialog} aria-label="核对草稿" onCancel={(event) => { event.preventDefault(); if (!busy) close() }}>
    <h3>{value.draft.title}</h3>
    <p>{draftSourceText[value.draft.source]}</p>
    <p>{value.draft.path}</p>
      <p>预览时的磁盘版本：{value.diskRevision ? <code>{value.diskRevision}</code> : '无可用版本'}</p>
    <pre tabIndex={0} style={{ maxHeight: '40vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{value.content}</pre>
    {error && <p ref={notice} role="alert" tabIndex={-1} style={{overflowWrap:'anywhere'}}>{error}</p>}
    <button ref={cancel} type="button" disabled={busy} onClick={close}>取消</button>
    <button type="button" disabled={busy} onClick={save}>确认另存副本</button>
  </dialog>
}
