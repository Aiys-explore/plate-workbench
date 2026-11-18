import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { DEFAULT_PROJECT, NOTE_TEMPLATES, type NoteSummary, type NoteTemplate, type ProjectSummary, type NoteFilters, type SearchResult } from '../../shared/ipc'
import { usePaletteOwner, type Source } from './palette-registry'
import { EditorDialog } from './note-editor'

const OVERSCAN = 5
const views = { all: '全部', today: '今日', unassigned: '未归属', archive: '归档' } as const
type View = keyof typeof views
type Group = { id: string; label: string; notes: NoteSummary[] }
type Row = { key: string; group: Group; note?: NoteSummary; pos: number; size: number }
type Anchor = { id: string; offset: number }
const preferenceKey = 'sidebar.preferences.v1'
function readPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}')
    const anchors: Partial<Record<View,Anchor>> = {}
    for (const view of Object.keys(views) as View[]) {
      const anchor = value.anchors?.[view]
      if (typeof anchor?.id === 'string' && Number.isFinite(anchor.offset) && anchor.offset >= 0) anchors[view] = anchor
    }
    return { view: (Object.hasOwn(views,value.view) ? value.view : 'all') as View, anchors,
      collapsed: (Array.isArray(value.collapsed) ? value.collapsed.filter((id: unknown) => typeof id === 'string') : []) as string[] }
  } catch { return { view: 'all' as View, anchors: {}, collapsed: [] as string[] } }
}

function localDay() {
  const now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { start: +start, end: +end }
}

export function NotesTree({ items, projects, selected, busy, open, newNote, newProject, remove,
  searchNotes, paletteMayAct, filters }: {
  filters: { query: string; setQuery: (value: string) => void; project: string; setProject: (value: string) => void;
    tags: string[]; setTags: React.Dispatch<React.SetStateAction<string[]>> }
  searchNotes: (source?: Source) => void
  paletteMayAct: () => boolean
  items: NoteSummary[]; projects: ProjectSummary[]; selected?: string; busy: boolean
  open: (id: string, result?:boolean) => void; newNote: (template: NoteTemplate, partition?: string) => void; newProject: () => void
  remove: (note: NoteSummary) => void
}) {
  const [initial] = useState(readPreferences)
  const [view, setView] = useState<View>(initial.view)
  const anchors = useRef<Partial<Record<View,Anchor>>>(initial.anchors)
  const pendingAnchor = useRef(true)
  const [composing, setComposing] = useState(false)
  const { query, setQuery, project, setProject, tags, setTags } = filters
  const [available, setAvailable] = useState<string[]>([])
  const [hits, setHits] = useState<{ request: object; results: SearchResult[] }>()
  const [searchError, setSearchError] = useState<{ request: object; text: string }>()
  const [tagError,setTagError] = useState('')
  const [searchAttempt, retrySearch] = useState(0)
  const [tagAttempt, retryTags] = useState(0)
  const searchInput = useRef<HTMLInputElement>(null)
  const tagHeading = useRef<HTMLLegendElement>(null)
  const [filterOpen, setFilterOpen] = useState(false)
  const [menu, setMenu] = useState<{ row: Row; x: number; y: number }>()
  const [info, setInfo] = useState<Row>()
  const menuRef = useRef<HTMLDivElement>(null)
  const currentFilters=useRef(false)
  currentFilters.current=!!(query.trim() || project || tags.length)
  const returnAnchor=useRef<{key:string;order:string[]}>(undefined)
  const rowMenuEntry=useRef<HTMLButtonElement>(null)
  const invokedByMore=useRef(false)
  const menuOrigin=()=>{
    const target=invokedByMore.current && rowMenuEntry.current?.isConnected ? rowMenuEntry.current : tree.current
    target?.focus({preventScroll:true})
  }
  function openResult(note:NoteSummary) {
    returnAnchor.current=currentFilters.current?{key:'n-'+note.id,order:rows.map(row=>row.key)}:undefined
    open(note.id,!!returnAnchor.current)
  }
  useLayoutEffect(() => { if (menu) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [menu])
  const api = window.workbench.notes
  const searchKey = JSON.stringify([query.trim(), project, tags])
  const filtering = !!(query.trim() || project || tags.length)
  const request = useMemo(()=>({}),[searchKey,items,searchAttempt,composing])
  const currentHits = hits?.request === request ? hits.results : undefined
  const currentError = searchError?.request === request ? searchError.text : '' 
  const matches = useMemo(() => new Map(currentHits?.map(({ note, match }) => [note.id, match])), [currentHits])

  useEffect(() => {
    let active = true
    void api.tags().then((values) => { if (active) { setAvailable(values); setTagError('') } }, (error) => {
      if (active) { setAvailable([]); setTagError(String(error)) }
    })
    return () => { active = false }
  }, [api, items, tagAttempt])

  useEffect(() => {
    let active = true
    if (!filtering || composing) return
    const [query, project, tags] = JSON.parse(searchKey) as [string, string, string[]]
    const filters: NoteFilters = { query, projectId: project || undefined, tags }
    const timer = window.setTimeout(() => void api.search(filters).then((results) => {
      if (active) setHits({ request, results })
    }, (error) => {
      if (active) { setHits(undefined); setSearchError({request,text:String(error)}) }
    }), query ? 120 : 0)
    return () => { active = false; clearTimeout(timer) }
  }, [api, request, filtering, searchKey, composing])
  const [day, setDay] = useState(localDay)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initial.collapsed))
  const [focused, setFocused] = useState('')
  const [scroll, setScroll] = useState(0)
  const [height, setHeight] = useState(0)
  const tree = useRef<HTMLDivElement>(null)
  const lastRows = useRef<string[]>([])
  const scrollBookmark=useRef<Anchor>(undefined)
  const filterPills=useRef<HTMLDivElement>(null)
  const normalized = filtering
  const short = useRef(matchMedia('(max-height: 560px)'))
  const scroller = () => short.current.matches ? tree.current?.closest<HTMLElement>('.sidebar-scroll') : tree.current
  const treeStart=(el:HTMLElement)=>{
    const inner=tree.current
    return !inner || inner===el ? 0 : inner.getBoundingClientRect().top-el.getBoundingClientRect().top+el.scrollTop
  }
  function syncScroll() {
    const el=scroller()
    if (!el) return
    const offset=treeStart(el)
    const top=Math.max(0,el.scrollTop-offset)
    setScroll(top)
    setHeight(Math.max(0,el.clientHeight-Math.max(0,offset-el.scrollTop)))
    const index=rowAt(top), row=rows[index]
    if (row) {
      scrollBookmark.current={id:row.key,offset:top-offsets[index]}
      if (!filtering && !pendingAnchor.current) {
        anchors.current[view]=scrollBookmark.current
        persist()
      }
    }
  }

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    function update() {
      clearTimeout(timer)
      const next = localDay()
      setDay((prev) => next.start === prev.start && next.end === prev.end ? prev : next)
      // Refresh at midnight, and catch clock/timezone changes within a minute.
      timer = setTimeout(update, Math.min(60_000, Math.max(1, next.end - Date.now())))
    }
    update()
    window.addEventListener('focus', update)
    return () => { clearTimeout(timer); window.removeEventListener('focus', update) }
  }, [])

  const groups = useMemo(() => {
    const byProject = new Map<string, Group>()
    for (const project of projects) {
      if (view === 'unassigned' || (view === 'archive') !== (project.archivedAt !== null)) continue
      byProject.set(project.id, { id: project.id, label: project.name, notes: [] })
    }
    if (view !== 'archive') byProject.set(DEFAULT_PROJECT, { id: DEFAULT_PROJECT, label: '未归属', notes: [] })
    const today = (time: number) => time >= day.start && time < day.end
    for (const note of items) {
      if (view === 'today' && !today(note.createdAt) && !today(note.updatedAt)) continue
      if (filtering && !matches.has(note.id)) continue
      byProject.get(note.projectId)?.notes.push(note)
    }
    return Array.from(byProject.values()).filter((group) => group.notes.length ||
      (!normalized && view !== 'today' && group.id !== DEFAULT_PROJECT))
  }, [items, projects, normalized, view, day, matches, filtering])

  const expanded = (id: string) => !!normalized || !collapsed.has(id)
  const rows = useMemo<Row[]>(() => {
    if (filtering) {
      const membership = new Map(groups.flatMap(group=>group.notes.map(note=>[note.id,{note,group}] as const)))
      const results = currentHits?.flatMap(({note})=>{
        const match=membership.get(note.id)
        return match ? [match] : []
      }) ?? []
      return results.map(({note,group},index)=>({key:'n-'+note.id,note,group,pos:index+1,size:results.length}))
    }
    return groups.flatMap((group, index) => [
      { key: 'p-' + group.id, group, pos: index + 1, size: groups.length },
      ...(!collapsed.has(group.id)
        ? group.notes.map((note, pos) => ({ key: 'n-' + note.id, group, note, pos: pos + 1, size: group.notes.length }))
        : [])
    ])
  }, [groups,collapsed,filtering,currentHits])

  const titleCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { title } of items) counts.set(title, (counts.get(title) ?? 0) + 1)
    return counts
  }, [items])
  const noteDetail = (note: NoteSummary) => filtering || (titleCounts.get(note.title) ?? 0) > 1 || note.kind === 'conflict'
  const rowHeights = rows.map(({ note }) => !note ? 30 : query.trim() ? 58 : noteDetail(note) ? 42 : 30)
  const offsets = [0]
  for (const rowHeight of rowHeights) offsets.push(offsets.at(-1)! + rowHeight)
  function rowAt(value: number) {
    let low = 0, high = rows.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (offsets[middle + 1] <= value) low = middle + 1
      else high = middle
    }
    return low
  }
  const focusedIndex = rows.findIndex((row) => row.key === focused)
  const selectedIndex = selected ? rows.findIndex((row) => row.note?.id === selected) : -1
  const active = focusedIndex >= 0 ? focusedIndex : selectedIndex >= 0 ? selectedIndex : 0
  const start = Math.max(0, rowAt(scroll) - OVERSCAN)
  const end = Math.min(rows.length, rowAt(scroll + height) + OVERSCAN + 1)

  useLayoutEffect(() => {
    const inner=tree.current, outer=inner?.closest<HTMLElement>('.sidebar-scroll')
    if (!inner || !outer) return
    const measure=()=>syncScroll()
    const observer = new ResizeObserver(measure)
    observer.observe(outer)
    observer.observe(inner)
    const scroll=(event:Event)=>{if(event.target===scroller())syncScroll()}
    outer.addEventListener('scroll',scroll)
    inner.addEventListener('scroll',scroll)
    short.current.addEventListener('change',measure)
    return () => {
      observer.disconnect();outer.removeEventListener('scroll',scroll);inner.removeEventListener('scroll',scroll)
      short.current.removeEventListener('change',measure)
    }
  }, [rows,view])

  function reset() {
    // A scroll event can still be queued when the next search or view starts.
    // Capture the actual live scroll position before React swaps the rows.
    if(!filtering && !pendingAnchor.current){
      const el=scroller()
      if(el){const top=Math.max(0,el.scrollTop-treeStart(el));const index=rowAt(top)
        if(rows[index])anchors.current[view]={id:rows[index].key,offset:top-offsets[index]}
      }
    }
    setFocused('')

    pendingAnchor.current = true
  }
  function persist() {
    try {
      localStorage.setItem(preferenceKey,JSON.stringify({view,collapsed:[...collapsed],anchors:anchors.current}))
    } catch { /* sidebar still works without persistent storage */ }
  }
  useLayoutEffect(() => {
    const el=scroller()
    if (!el) return
    const inset=treeStart(el)
    const previous=lastRows.current
    const keys=rows.map(r=>r.key)
    const fallback=(key:string)=>{
      const pos=previous.indexOf(key)
      return pos<0 ? undefined : [...previous.slice(pos+1),...previous.slice(0,pos).reverse()].find(k=>keys.includes(k))
    }
    if(menu && !keys.includes(menu.row.key) && (!filtering || currentHits)){
      setMenu(undefined)
      requestAnimationFrame(()=>{
        if(tree.current?.dataset.rowCount!=='0')menuOrigin()
        else searchInput.current?.focus({preventScroll:true})
      })
    }
    if (focused && !keys.includes(focused) && (!filtering || currentHits)) {
      const next=fallback(focused) ?? keys[0]
      setFocused(next ?? '')
      if (!next && document.activeElement===tree.current) searchInput.current?.focus()
    }
    if (pendingAnchor.current && (items.length || projects.length || filtering)) {
      const saved = filtering ? undefined : anchors.current[view]
      const index = rows.findIndex(row => row.key === (saved && (keys.includes(saved.id)?saved.id:fallback(saved.id))))
      el.scrollTop = saved && index >= 0 ? inset+offsets[index] + Math.min(saved.offset,rowHeights[index]-1) : 0
      setScroll(Math.max(0,el.scrollTop-inset))
      scrollBookmark.current=undefined
      pendingAnchor.current = false
      persist()
    } else if (scrollBookmark.current && keys.join('\0')!==previous.join('\0') && (!filtering || currentHits)) {
      const saved=scrollBookmark.current
      const index=keys.indexOf(keys.includes(saved.id)?saved.id : fallback(saved.id)??'')
      if (index>=0) {
        el.scrollTop=inset+offsets[index]+Math.min(saved.offset,rowHeights[index]-1)
        setScroll(Math.max(0,el.scrollTop-inset))
      }
    }
    if (!filtering || currentHits) lastRows.current=keys
  })
  useEffect(persist,[view,collapsed])

  function move(index: number, _explicit = false) {
    const el = scroller()
    const row = rows[index]
    if (!row || !el) return
    setFocused(row.key)
    const inset=treeStart(el)
    const top = inset+offsets[index], bottom = inset+offsets[index + 1]
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
    syncScroll()
  }

  const focusProject=useRef<string>(undefined)
  useEffect(()=>{
    const receive=(event:Event)=>{
      const {id,archive}=(event as CustomEvent<{id:string;archive:boolean}>).detail
      focusProject.current=id
      if(normalized || filtering){setQuery('');setProject('');setTags([])}
      if(view!==(archive?'archive':'all'))setView(archive?'archive':'all')
      else {
        const index=rows.findIndex(r=>!r.note && r.group.id===id)
        if(index>=0){focusProject.current=undefined;move(index);tree.current?.focus({preventScroll:true})}
      }
    }
    window.addEventListener('p11-focus-project',receive)
    return()=>window.removeEventListener('p11-focus-project',receive)
  })
  useLayoutEffect(()=>{
    if(!focusProject.current)return
    const index=rows.findIndex(r=>!r.note && r.group.id===focusProject.current)
    if(index>=0){focusProject.current=undefined;move(index);tree.current?.focus({preventScroll:true})}
  },[rows])
  function removeFilter(index:number, action:()=>void) {
    action();reset()
    requestAnimationFrame(()=>{
      const buttons=filterPills.current?.querySelectorAll('button')
      const target=buttons?.[index] ?? (buttons && buttons.length ? buttons[buttons.length-1] : undefined)
      ;(target ?? searchInput.current?.closest('.notes-search')?.querySelector<HTMLElement>('.notes-filter-trigger'))?.focus()
    })
  }
  const [restoreRequested,setRestoreRequested] = useState(false)
  useEffect(()=>{
    const restore=()=>setRestoreRequested(true)
    window.addEventListener('return-notes-search',restore)
    return()=>window.removeEventListener('return-notes-search',restore)
  },[])
  useLayoutEffect(()=>{
    if (!restoreRequested || filtering && !currentHits && !currentError) return
    const anchor=returnAnchor.current
    const available=new Map(rows.map((row,index)=>[row.key,index]))
    const former=anchor?.order.indexOf(anchor.key) ?? -1
    const candidates=anchor ? [anchor.key,...(former<0?[]:[
      ...anchor.order.slice(former+1),...anchor.order.slice(0,former).reverse()
    ])] : []
    const key=candidates.find(id=>available.has(id))
    const index=key===undefined?(rows.length?0:-1):available.get(key)!
    if (index>=0) { move(index);tree.current?.focus({preventScroll:true}) }
    else searchInput.current?.focus({preventScroll:true})
    setRestoreRequested(false)
  },[restoreRequested,filtering,currentHits,currentError,rows])
  useEffect(()=>{
    if(!filtering) window.dispatchEvent(new Event('clear-search-return'))
  },[filtering])
  function toggle(group: Group) {
    if (normalized) return
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (!next.delete(group.id)) next.add(group.id)
      return next
    })
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const row = rows[active]
    if (!row || event.nativeEvent.isComposing || event.keyCode===229 || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
      const anchor = document.getElementById('tree-' + row.key)?.getBoundingClientRect()
      if (anchor && !event.repeat) {invokedByMore.current=false;setMenu({ row, x: anchor.left, y: anchor.bottom })}
      event.preventDefault()
      return
    }
    switch (event.key) {
      case 'ArrowDown': move(active + 1, true); break
      case 'ArrowUp': move(active - 1, true); break
      case 'Home': move(0, true); break
      case 'End': move(rows.length - 1, true); break
      case 'ArrowRight':
        if (!row.note && row.group.notes.length) {
          if (expanded(row.group.id)) move(active + 1, true)
          else toggle(row.group)
        }
        break
      case 'ArrowLeft':
        if (row.note && !filtering) move(rows.findIndex((entry) => entry.key === 'p-' + row.group.id), true)
        else if (expanded(row.group.id) && row.group.notes.length) toggle(row.group)
        break
      case 'Enter':
        if(event.repeat)break

        if (offsets[active + 1] <= scroll || offsets[active] >= scroll + height) {
          move(active)
          break
        }
        if (!busy) {
          if (row.note) openResult(row.note)
          else if (row.group.notes.length) toggle(row.group)
        }
        break
      case 'Delete':
        if(!event.repeat && !busy && row.note) remove(row.note)
        break
      default: return
    }
    event.preventDefault()
  }


  usePaletteOwner('notes-tree', { actions: {
    'm51.note.search': { allowed: () => !!searchInput.current && paletteMayAct(),
      run: source => { searchNotes(source); return { element: () => searchInput.current } } },
  } })
  const hasNotes = groups.some((group) => group.notes.length)
  const writablePartition = projects.find(p => p.id === project && p.archivedAt === null)?.id
  return <>
    <div className="harness-partitions">
      <label htmlFor="plate-partition">分区</label>
      <select id="plate-partition" value={project} onChange={event => {
        const next = event.target.value
        setProject(next)
        const selectedGroup = projects.find(p => p.id === next)
        setView(selectedGroup && selectedGroup.archivedAt !== null ? 'archive'
          : next === DEFAULT_PROJECT ? 'unassigned' : 'all')
        reset()
      }}>
        <option value="">全部分区</option>
        <option value={DEFAULT_PROJECT}>未归属</option>
        {projects.filter(p => p.id !== DEFAULT_PROJECT).map(p => <option key={p.id} value={p.id}>
          {p.name}{p.archivedAt !== null ? '（归档）' : ''}{projects.some(other => other.id !== p.id && other.name === p.name) ? ' · ' + p.id.slice(0, 8) : ''}
        </option>)}
      </select>
      <button type="button" disabled={busy} aria-label="新建分区" title="新建分区" onClick={() => newProject()}>＋</button>
    </div>
    <div className="notes-search">
      {filterOpen && <EditorDialog title="项目与标签筛选" close={() => setFilterOpen(false)}>
        <label>搜索项目<select value={project} onChange={(event) => { setProject(event.target.value); reset() }}>
          <option value="">所有项目</option>
          <option value={DEFAULT_PROJECT}>未归属</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.archivedAt !== null ? '（归档）' : ''}
            {projects.some((other) => other.id !== p.id && other.name === p.name) ? ' · ' + p.id.slice(0, 8) : ''}</option>)}
        </select></label>
        <p>移除筛选不会修改笔记；此处暂不支持编辑笔记标签。</p>
        <fieldset><legend ref={tagHeading} tabIndex={-1}>标签（同时匹配）</legend>
          {tagError && <><p role="alert">读取标签目录失败：{tagError}</p><button type="button"
            onClick={()=>{tagHeading.current?.focus(); retryTags(n=>n+1)}}>重试标签目录</button></>}
          {Array.from(new Set([...available, ...tags])).map((tag) => <label key={tag}>
            <input type="checkbox" checked={tags.includes(tag)} disabled={!tags.includes(tag) && tags.length >= 64}
              onChange={(event) => { setTags(event.target.checked ? [...tags, tag] : tags.filter((value) => value !== tag)); reset() }} />
            #{tag}
          </label>)}
          {!tagError && !available.length && !tags.length && <small>暂无标签</small>}
        </fieldset>
        <button type="button" disabled={!project && !tags.length} onClick={() => { setProject(''); setTags([]); reset() }}>清除项目与标签</button>
      </EditorDialog>}
      <div className="notes-search-box">
        <svg aria-hidden="true" focusable="false" className="notes-search-icon" width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.4 15.4 4.1 4.1" />
        </svg>
        <input type="search" ref={searchInput} aria-label="搜索笔记标题和正文" placeholder="搜索标题和正文" value={query}
          onKeyDown={event => {
            if (event.key === 'Escape' && query && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.stopPropagation(); setQuery(''); reset()
            }
          }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onChange={(event) => { setQuery(event.target.value); reset() }} />
        {query && <button type="button" aria-label="清除搜索" onClick={event => {
          event.currentTarget.parentElement?.querySelector('input')?.focus(); setQuery(''); reset()
        }}>×</button>}
      </div>
      <button type="button" className="notes-filter-trigger" aria-label="项目与标签筛选" onClick={() => setFilterOpen(true)}>筛选{tags.length ? ` · ${tags.length}` : ''}</button>
    </div>
    {(project || tags.length>0) && <div className="notes-filter-pills" ref={filterPills} aria-label="当前筛选">
      {project && <button type="button" onClick={()=>removeFilter(0,()=>setProject(''))}
        aria-label="移除项目筛选">{projects.find(p=>p.id===project)?.name ?? (project===DEFAULT_PROJECT?'未归属':project)} ×</button>}
      {tags.map((tag,i)=><button type="button" key={tag} aria-label={'移除筛选：#'+tag}
        onClick={()=>removeFilter(i+(project?1:0),()=>setTags(old=>old.filter(t=>t!==tag)))}>#{tag} ×</button>)}
    </div>}
    <div className="note-create-panel">
      <button type="button" disabled={busy} onClick={() => newNote('blank', writablePartition)}>新建笔记</button>
    </div>
    <nav className="notes-views" aria-label="笔记视图">
      {(Object.entries(views) as [View, string][]).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={view === id} onClick={() => { if(view!==id){reset();setView(id)} }}>{label}</button>)}
    </nav>
    {view === 'today' && <p className="tree-hint">本地日期 {new Date(day.start).toLocaleDateString('zh-CN')} · 当日创建或编辑</p>}
    {view === 'archive' && <p className="tree-hint">显示已归档项目中的笔记</p>}
    {currentError && <div className="tree-hint"><p role="alert">搜索失败：{currentError}</p>
      <button type="button" onClick={()=>{searchInput.current?.focus();retrySearch(n=>n+1)}}>重试搜索</button></div>}
    {!hasNotes && <div className="tree-empty">
      <p>{normalized ? (currentError ? '搜索失败' : currentHits ? '没有匹配的笔记' : '正在搜索…') : view === 'archive' ? '暂无归档项目笔记' : '这个视图还没有笔记'}</p>
      {!normalized && view !== 'archive' && <div className="tree-templates">
        <button type="button" disabled={busy} onClick={() => newNote('blank', writablePartition)}>{NOTE_TEMPLATES.blank.label}</button>
        {(['plan', 'review', 'journal'] as const).map((id) =>
          <button key={id} type="button" disabled={busy} onClick={() => newNote(id, writablePartition)}>{NOTE_TEMPLATES[id].label}</button>)}
      </div>}
    </div>}
    <div className="notes-tree" role="tree" aria-label="笔记列表" ref={tree}
      data-row-count={rows.length} tabIndex={rows.length ? 0 : -1}
      aria-activedescendant={active >= start && active < end ? 'tree-' + rows[active]?.key : undefined}
      onFocus={(event) => {
        // A pointer press focuses the tree before click; don't scroll the target away.
        if (event.currentTarget.matches(':focus-visible') &&
          (offsets[active] < scroll || offsets[active + 1] > scroll + height)) move(active)
      }}
      onKeyDown={navigate}>
      <div className="notes-tree-space" role="presentation" style={{ height: offsets.at(-1) }}>
        {rows.slice(start, end).map((row, offset) => {
          const { key, group, note, pos, size } = row
          const index = start + offset
          const title = note?.title ?? group.label
          const match = note && matches.get(note.id)
          return <div key={key} id={'tree-' + key} role="treeitem" aria-level={note && !filtering ? 2 : 1}
            aria-posinset={pos} aria-setsize={size}
            aria-expanded={!note && group.notes.length ? expanded(group.id) : undefined}
            aria-selected={note ? selected === note.id : undefined}
            aria-current={note && selected === note.id ? 'page' : undefined}
            data-active={active === index} data-note-id={note?.id} data-project-id={group.id}
            className={note ? 'tree-row tree-note' : 'tree-row tree-project'}
            style={{ top: offsets[index], height: rowHeights[index] }} title={note?.path ?? title}
            onContextMenu={event => {
              event.preventDefault(); move(index, true); invokedByMore.current=false;setMenu({ row, x: event.clientX, y: event.clientY })
            }}
            onClick={() => {
              tree.current?.focus({ preventScroll: true })
              move(index, true)
              if (!busy && note) openResult(note)
              else if (!note && group.notes.length) toggle(group)
            }}>
            <span className={!note ? 'tree-project-title' : undefined}>
              {!note && <span className="tree-project-chevron" aria-hidden="true" data-empty={!group.notes.length}>▸</span>}
              {!note && <span className="p11-project-dot" data-color={projects.find(p=>p.id===group.id)?.color ?? 'default'} aria-hidden="true"/>}
              <span>{title}</span>
              {!note && <small>{group.notes.length}</small>}
            </span>
            {note && noteDetail(note) && !query.trim() && <small>
              {group.label + ' · ' + note.id.slice(0, 8) + (note.kind === 'conflict' ? ' · 冲突副本' : '')}
            </small>}
            {match && <small className="search-excerpt" title={match.before + match.match + match.after}>
              {match.field === 'title' ? '标题 · ' : '正文 · '}{match.before}<mark>{match.match}</mark>{match.after}
            </small>}
            {note && query.trim() && <small>{note.path}</small>}
          </div>
        })}
      </div>
    </div>
    {rows[active] && <button ref={rowMenuEntry} className="tree-more-active" type="button" aria-haspopup="menu"
      data-selected-row={rows[active].note?.id === selected || undefined}
      aria-expanded={!!menu && invokedByMore.current} aria-label={`当前行操作：${rows[active].note?.title??rows[active].group.label}`}
      onClick={event=>{
        const rect=event.currentTarget.getBoundingClientRect()
        invokedByMore.current=true;setMenu({row:rows[active],x:rect.left,y:rect.bottom})
      }}>当前行操作 ⋯</button>}
    {menu && <div ref={menuRef} role="menu" data-editor-float style={{ left: Math.max(8, Math.min(menu.x, innerWidth - 168)),
      top: Math.max(8, Math.min(menu.y, innerHeight - 132)) }} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setMenu(undefined)
    }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape' || event.key==='Tab') {
        if (event.key==='Escape') {event.preventDefault();event.stopPropagation()}
        menuOrigin();setMenu(undefined);return
      }
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return
      event.preventDefault()
      const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const at = options.indexOf(document.activeElement as HTMLButtonElement)
      options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
        (at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
    }}>
      {menu.row.note && <button type="button" role="menuitem" data-editor-float-item disabled={busy} onClick={() => { setMenu(undefined);menuOrigin();openResult(menu.row.note!) }}>打开笔记</button>}
      {!menu.row.note && <button type="button" role="menuitem" data-editor-float-item disabled={!menu.row.group.notes.length}
        title={!menu.row.group.notes.length?'空项目没有可折叠的笔记':undefined}
        onClick={()=>{toggle(menu.row.group);menuOrigin();setMenu(undefined)}}>{expanded(menu.row.group.id)?'折叠':'展开'}</button>}
      <button type="button" role="menuitem" data-editor-float-item onClick={() => { setMenu(undefined); setInfo(menu.row) }}>查看完整信息</button>
      {!menu.row.note && menu.row.group.id===DEFAULT_PROJECT && <span className="p11-note">内置未归属不可变更</span>}
      {menu.row.note && <button type="button" role="menuitem" data-editor-float-item disabled={busy}
        onClick={() => { setMenu(undefined);menuOrigin();remove(menu.row.note!) }}>移除笔记…</button>}
    </div>}
    {info && <EditorDialog title="完整信息" close={() => { setInfo(undefined); requestAnimationFrame(menuOrigin) }}>
      <p>{info.note?.title ?? info.group.label}</p>
      {info.note && <p className="editor-full-path">{info.note.path}</p>}
      {info.note && matches.get(info.note.id) && <p className="editor-full-path">{(() => {const m=matches.get(info.note.id)!;return m.before+m.match+m.after})()}</p>}
      <p>{info.note?.id ?? info.group.id}</p>
    </EditorDialog>}
  </>
}
