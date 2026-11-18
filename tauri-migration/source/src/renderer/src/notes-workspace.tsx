import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { DEFAULT_PROJECT, type DraftRecovery, type DraftSummary, type LinkIndex, type Note, type NoteSummary, type NoteTemplate, type ProjectSummary } from '../../shared/ipc'
import { linkCatalog, resolveLink } from '../../shared/link-resolution'
import { EditorDialog, NoteEditor } from './note-editor'
import { EditorSession } from './editor/session'
import type { EditorSurface } from './editor/surface'
import { P12 } from './p12'
import type { Scope } from '../../shared/p12'
import { commandLayer, focus, target, usePaletteOwner, type Source } from './palette-registry'
import { NotesTree } from './notes-tree'
import { RelationshipGraph } from './relationship-graph'
import { noteRelations } from './relation-directions'
import { NOTE_DRAWER_WIDTH_MAX, NOTE_DRAWER_WIDTH_MIN, useWorkbench } from './store'

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
const DRAFT_DELAY_MS = 700
const fileName = (path: string) => path.split(/[\\/]/).at(-1)

import type { Subject } from '../../shared/p11'
import { openP11, type BindingGuard } from './p11'

export function NotesWorkspace({ agentCounts, sidebarBottom, notesDrawer, sidebarSplitter, bindingGuard, searchNotes }: {
  searchNotes: (source?: Source) => void
  bindingGuard: RefObject<BindingGuard|undefined>
  agentCounts?: React.ReactNode
  sidebarBottom?: React.ReactNode
  sidebarSplitter?: React.ReactNode
  notesDrawer?: { open: boolean; dialog: RefObject<HTMLDialogElement | null>; close: (restoreFocus?: boolean) => void }
}) {
  const sidebarCollapsed = useWorkbench((state) => state.sidebarCollapsed)
  const toggleSidebar = useWorkbench((state) => state.toggleSidebar)
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
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('')
  const [tags, setTags] = useState<string[]>([])
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
  const surface = useRef<EditorSurface | null>(null)
  const graphHandle = useRef<ReturnType<EditorSession['suspend']> | undefined>(undefined)
  const drawerResize = useRef<{ pointer: number; startWidth: number; startX: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [externalPath, setExternalPath] = useState('')
  const [conflict, setConflict] = useState<{ copy: Note; originalExists: boolean }>()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [searchReturn,setSearchReturn]=useState(false)
  const [returnToSearch, setReturnToSearch] = useState(false)
  useEffect(() => {
    if (!returnToSearch || (notesDrawer && !notesDrawer.open) || (!notesDrawer && sidebarCollapsed)) return
    window.dispatchEvent(new Event('return-notes-search'))
    setReturnToSearch(false)
  }, [returnToSearch, notesDrawer?.open, sidebarCollapsed])
  useEffect(()=>{
    const clear=()=>setSearchReturn(false)
    window.addEventListener('clear-search-return',clear)
    return()=>window.removeEventListener('clear-search-return',clear)
  },[])
  const [linkPrompt, setLinkPrompt] = useState<string>()
  const linkAnchor = useRef<Element | null>(null)
  const promptFocus = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const focusAfterOperation = useRef<() => void>(undefined)
  const selection = useRef<string | null>(null)
  const selectedPath = useRef<string | undefined>(undefined)
  const draftWritePending = useRef<Promise<boolean> | undefined>(undefined)
  const cleanDiscard = useRef<{identity: object} | undefined>(undefined)
  const [exporting,setExporting]=useState<{scope:Scope|null;restore:()=>void}>()
  const closeExport=()=>{setExporting(undefined);if(exporting)requestAnimationFrame(exporting.restore)}
  const dirty = note !== null && draft !== note.content
  const external = externalPath === note?.path
  const catalog = useMemo(() => linkCatalog(items), [items])
  const projectNames = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const activeId = note?.id
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
      if (external && selectedPath.current === path) setExternalPath(path)
      workspaceReady.current = false
      setWorkspaceStatus('pending')
      if (pending === undefined) pending = setTimeout(() => { pending = undefined; void refresh() }, 0)
    })
    void refresh(true)
    return () => { active = false; workspaceReady.current = false; clearTimeout(pending); unsubscribe() }
  }, [api])

  useEffect(()=>{
    const apply=(event:Event)=>{
      const removed=(event as CustomEvent<Subject>).detail
      if(!note)return
      if(removed.kind==='note' && removed.id===note.id){show(null);return}
      const noteId=removed.kind==='task'?removed.task.noteId:removed.kind==='project'&&note.projectId===removed.id?note.id:null
      if(noteId!==note.id)return
      const identity=editorIdentity.current
      void api.read(noteId).then(next=>{
        if(editorIdentity.current===identity)show(next,undefined,undefined,verifyEditable(next))
      },e=>setError(errorText(e)))
    }
    window.addEventListener('p11-removed',apply)
    return()=>window.removeEventListener('p11-removed',apply)
  },[note,api])

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

  function select(id: string, result=false, origin?:HTMLElement) {
    const trigger=origin??document.activeElement
    const focusSource=()=>{
      if (trigger instanceof HTMLElement && trigger.isConnected && trigger.getClientRects().length) trigger.focus({preventScroll:true})
      else document.querySelector<HTMLElement>('.relations-list summary, .notes-tree')?.focus({preventScroll:true})
    }
    if (inFlight.current) return
    if (id === note?.id) {
      if (result) setSearchReturn(true)
      closeLinkPrompt()
      setDrawerOpen(true)
      if (notesDrawer?.open) notesDrawer.close(false)
      return
    }
    void run(async () => {
      const choice = await chooseLeave()
      if (choice === 'stay') {
        if (result || linkPrompt!==undefined) focusAfterOperation.current = focusSource
        return
      }
      const next = await api.read(id)
      const prepared = verifyEditable(next)
      await finishLeave(choice)
      show(next, undefined, undefined, prepared)
      setDrawerOpen(true)
      setSearchReturn(result)
      setConflict(undefined)
      if (notesDrawer?.open) notesDrawer.close(false)
      focusAfterOperation.current = () => document.querySelector<HTMLElement>('[data-editor-meta-title]')?.focus()
    },focusSource)
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

  function newNote(template: NoteTemplate, _source?: Source, partition = DEFAULT_PROJECT) {
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
      if (notesDrawer?.open) notesDrawer.close(false)
      focusAfterOperation.current = () => document.querySelector<HTMLInputElement>('[data-editor-meta-title]')?.focus()
    })
  }

  const projectsChanged=async()=>{await refreshWorkspace.current()}
  function newProject(source?: Source) {
    openP11({kind:'project',saved:projectsChanged,createNote:(name,id,template)=>newProjectNote(name,id,template)}, source?.element, source?.restore)
  }
  function projectAction(id:string,action:'edit'|'archive'|'impact',source?: Source){
    if(action==='impact')openP11({kind:'impact',subject:{kind:'project',id}})
    else openP11({kind:'project',id,op:action,saved:projectsChanged},source?.element,source?.restore)
  }
  async function newProjectNote(name:string,id:string,template:NoteTemplate){
    if(inFlight.current || session?.composing)return false
    inFlight.current=true;setBusy(true)
    try{
      await draftWritePending.current?.catch(()=>false)
      const choice=await chooseLeave()
      if(choice==='stay')return false
      if(choice==='save')await finishLeave(choice)
      const next=await api.create(name,id,template)
      const prepared=verifyEditable(next)
      if(choice==='discard')await finishLeave(choice)
      show(next,undefined,undefined,prepared)
      setDrawerOpen(true);setConflict(undefined);setMessage('笔记已新建')
      if(notesDrawer?.open)notesDrawer.close()
      return true
    }finally{inFlight.current=false;setBusy(false)}
  }

  useLayoutEffect(()=>{
    bindingGuard.current=async ids=>{
      if(!note || !ids.includes(note.id))return 'ready'
      if(session?.composing || inFlight.current || external || pendingRecovery)throw new Error('请先核对当前编辑器的草稿或磁盘版本')
      if(!dirty && !draftWritePending.current && !cleanDiscard.current)return 'ready'
      inFlight.current=true;setBusy(true);cancelDraftTimer()
      try{
        await draftWritePending.current?.catch(()=>false)
        const choice=await chooseLeave()
        if(choice==='stay')return 'stay'
        await finishLeave(choice)
        if(choice==='discard'){
          const disk=await api.read(note.id)
          show(disk,undefined,undefined,verifyEditable(disk))
        }
        return 'again'
      }finally{inFlight.current=false;setBusy(false)}
    }
    return()=>{bindingGuard.current=undefined}
  })

  const exportScope = (scope: Scope | null, restore: () => void) => {
    if (!session?.composing) setExporting({ scope, restore })
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
      'm51.project.new': { reason: projectUnavailable, basis: objectVersion, allowed: mayAct,
        run: source => { newProject(source); return target('.p11-native[open] #p11-heading') } },
      'm51.export.history': { reason: unavailable, basis: objectVersion, allowed: mayAct,
        run: source => { exportScope(null, source.restore); return target('.p12-native-dialog[open] #p12-heading') } }
    }
  })

  useEffect(() => {
    function key(event: globalThis.KeyboardEvent) {
      if (document.querySelector('.home-document-host[hidden]')) return
      if (event.defaultPrevented || event.repeat || event.isComposing || event.key === 'Process' || event.keyCode===229 ||
          !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'n') return
      if (commandLayer() || document.querySelector('dialog[open]:not(.notes-drawer),[role=menu]') || inFlight.current || session?.composing) return
      event.preventDefault()
      newNote('blank')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [session])

  function save() {
    if (!note || !session || !dirty || pendingRecovery || session.locked || inFlight.current) return
    void run(async () => { await saveCurrent(true) })
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
    openP11({kind:'impact',subject:{kind:'note',id:target.id}})
  }
  function saveShortcut(event: KeyboardEvent) {
    if (!event.defaultPrevented && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      save()
    }
  }

  const sidebar = (
    <aside className="pane sidebar notes-sidebar" aria-label="笔记栏">
      {notesDrawer ? <button type="button" className="icon-button pane-toggle" aria-label="关闭笔记栏" onClick={() => notesDrawer.close()}>×</button> :
        <button type="button" className="icon-button pane-toggle" aria-label={sidebarCollapsed ? '展开笔记栏' : '折叠笔记栏'}
        title={sidebarCollapsed ? '展开笔记栏' : '折叠笔记栏'} aria-expanded={!sidebarCollapsed}
        aria-controls="sidebar-content" onClick={toggleSidebar}>{sidebarCollapsed ? '›' : '‹'}</button>}
      <div id="sidebar-content" className="pane-content" hidden={!notesDrawer && sidebarCollapsed}>
      <div className="pane-heading notes-heading">
        <h2 id="sidebar-title">笔记</h2>
      </div>
      <div className="sidebar-scroll">
      <NotesTree items={items} projects={projects} selected={note?.id} busy={busy} filters={{query,setQuery,project,setProject,tags,setTags}}
        open={select} newNote={(template, partition) => newNote(template, undefined, partition)} newProject={newProject} remove={askDelete} projectAction={projectAction}
        exportScope={exportScope} searchNotes={searchNotes} paletteMayAct={mayAct} projectUnavailable={projectUnavailable} paletteVersion={objectVersion} /></div>
      {agentCounts}
      {sidebarBottom}
      </div>
    </aside>
  )
  return <>
    {exporting&&<P12 scope={exporting.scope} dirtyId={dirty?note?.id:undefined} unknownDraft={draftState==='failed'||draftState==='unavailable'} close={closeExport}
      processDraft={()=>{setExporting(undefined);notesDrawer?.close();requestAnimationFrame(()=>{
        if(dirty)surface.current?.focus();else document.querySelector<HTMLElement>('.draft-recovery button')?.focus()
      })}}/>}
    {notesDrawer ? <dialog ref={notesDrawer.open ? notesDrawer.dialog : undefined} className="workbench-drawer notes-drawer" aria-label="笔记栏"
      onCancel={event => { event.preventDefault(); notesDrawer.close() }}
      onClick={event => { if (event.target === event.currentTarget) notesDrawer.close() }}>{sidebar}</dialog> : sidebar}
    {sidebarSplitter}
    <main className="pane editor notes-editor notes-stage" aria-label="编辑区" onKeyDown={saveShortcut}>
      <RelationshipGraph nodes={items} edges={index.edges} selected={activeId}
        label={label} open={(id,origin)=>select(id,false,origin)}
        close={closeNoteDrawer} editorOpen={drawerOpen} rightInset={drawerOpen ? drawerWidth + 16 : 0}
        state={indexState} reload={()=>requestIndex.current()} />
      <aside className={drawerOpen ? 'note-drawer open' : 'note-drawer'} data-open={drawerOpen}
        aria-label="笔记编辑抽屉" aria-hidden={!drawerOpen || undefined} inert={!drawerOpen}
        style={{ '--note-drawer-width': drawerWidth + 'px' } as CSSProperties}
        onKeyDown={event => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return
          if (leave || recoveryPreview || confirmDiscard || exporting) return
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
            {searchReturn && <button type="button" onClick={()=>{
              if (notesDrawer && !notesDrawer.open) window.dispatchEvent(new Event('open-notes-drawer'))
              else if (!notesDrawer && sidebarCollapsed) toggleSidebar()
              setReturnToSearch(true)
            }}>返回搜索结果</button>}
            <button type="button" onClick={e=>{
              const opener=e.currentTarget
              exportScope(null,()=>opener.focus())
            }}>导出记录</button>
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
        changed={changeDraft} save={save} remove={remove} wiki={activateLink}
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
