import type { BrainSkill, EpisodicEvent } from '../../shared/brain'
import { BrainHudBar, ConsolidationDialog, CorticalZonesLayer, EpisodicLane, EvolutionBadge, EvolutionTimelineModal,
  QuickCaptureBar, SkillDialog, SkillDock, useBrainWorkbench } from './brain-workbench'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import type { Note, NoteEdge, NoteSummary, RelationshipNote } from '../../shared/ipc'
import { EditorDialog } from './note-editor'
import { noteRelations } from './relation-directions'
import { frameNodes, interpolateCamera, type Camera, type Point } from './relationship-camera'
import { cardWidth, connectCards, measureCards, port, type CardBox } from './relationship-geometry'
import { IconAction } from './icon-action'
import { IconAccept, IconBrain, IconFocus, IconInfo, IconMinus, IconMotion, IconNew, IconReject, IconStyle } from './components/icons'
import './styles/relationship-fonts.css'
import './styles/relationship-flow.css'

export type NoteLabel = (note: NoteSummary) => string
const width = 1140
const columns = 5
const styles = [
  ['editorial', '编辑风格', '纸面层次与暖色标记'],
  ['classic', '经典', '安静清晰的笔记关系'],
  ['signal', '信号流', '用沿线动效突出流向'],
  ['blueprint', '蓝图', '网格与工程图线'],
] as const
type Style = typeof styles[number][0]
type MemoryMigration = { id: string; from: Point; width: number; text: string }
const styleStorage = 'plate.relationship-flow.style'
const initialStyle = () => {
  try { return styles.find(([id]) => id === localStorage.getItem(styleStorage))?.[0] ?? 'editorial' }
  catch { return 'editorial' }
}
const directions = [
  {key:'ArrowLeft',x:-8,y:0,label:'向左'}, {key:'ArrowUp',x:0,y:-8,label:'向上'},
  {key:'ArrowDown',x:0,y:8,label:'向下'}, {key:'ArrowRight',x:8,y:0,label:'向右'}
]

function layout(notes: RelationshipNote[], edges: NoteEdge[], cards: ReturnType<typeof measureCards>) {
  const ordered = [...notes].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id))
  const adjacent = new Map(ordered.map(({ id }) => [id, new Set<string>()]))
  for (const { source, target } of edges) {
    if (!adjacent.has(source) || !adjacent.has(target)) continue
    adjacent.get(source)?.add(target)
    adjacent.get(target)?.add(source)
  }
  const placed = new Set<string>()
  const order: string[] = []
  for (const { id } of [...ordered.filter((n) => adjacent.get(n.id)?.size), ...ordered]) {
    if (placed.has(id)) continue
    const queue = [id]
    placed.add(id)
    for (const id of queue) {
      order.push(id)
      for (const next of adjacent.get(id) ?? []) if (!placed.has(next)) {
        placed.add(next)
        queue.push(next)
      }
    }
  }
  const points = new Map<string, Point>()
  let y=34
  for(let start=0;start<order.length;start+=columns){
    const row=order.slice(start,start+columns)
    const h=Math.max(...row.map(id=>cards.get(id)!.height))
    row.forEach((id,i)=>points.set(id,{x:114+i*228,y:y+h/2}))
    y+=h+55
  }
  return { ordered,points,height:Math.max(320,y) }
}

export function RelationshipGraph({
  nodes, edges, selected, focusId, label, open, close, state, reload, editorOpen, rightInset,
  canChange, noteUpdated, activeProject, projectFilter, projectLabel, hudLeft, hudRight, revealOutside, brainOpen, onBrainOpenChange,
}: {
  nodes: RelationshipNote[]; edges: NoteEdge[]; selected?: string; label: NoteLabel
  focusId?: string
  open: (id: string, origin?:HTMLElement) => void; close: () => void
  editorOpen?: boolean; rightInset?: number
  state: { busy: boolean; error?: string }; reload: () => void
  canChange: (id: string) => boolean
  noteUpdated: (note: Note) => void
  activeProject: string
  projectFilter?: string
  projectLabel: string
  hudLeft?: ReactNode
  hudRight?: ReactNode
  brainOpen: boolean
  onBrainOpenChange: (open: boolean) => void
  revealOutside?: (id: string) => void
}) {
  const [brainZones, setBrainZones] = useState(true)
  const [brainVitality, setBrainVitality] = useState(false)
  const [capture, setCapture] = useState(false)
  const probeOverlay = useRef<SVGSVGElement>(null)
  const [fresh, setFresh] = useState<{ id: string; probe: string[] }>()
  const [crystal, setCrystal] = useState<string>()
  const [migration, setMigration] = useState<MemoryMigration>()
  const [flight, setFlight] = useState<(MemoryMigration & { to: Point })>()
  const [consolidation, setConsolidation] = useState<EpisodicEvent[]>()
  const [timeline, setTimeline] = useState<RelationshipNote>()
  const [skill, setSkill] = useState<BrainSkill | 'new'>()
  const [brainError, setBrainError] = useState('')
  const brain = useBrainWorkbench(projectFilter, brainOpen)
  const activeNodes = useMemo(() => new Set(brain.wave ?
    [brain.wave.seedNoteId, ...brain.wave.activatedNoteIds, ...brain.wave.edgePairs.flat()] : []), [brain.wave])
  const activeEdges = useMemo(() => new Set(brain.wave?.edgePairs.map(pair => [...pair].sort().join('|'))), [brain.wave])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.code === 'Space' &&
        !event.isComposing && !event.repeat && !document.querySelector('dialog[open]')) {
        event.preventDefault()
        onBrainOpenChange(true)
        setCapture(true)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])
  useEffect(() => {
    if (!fresh) return
    const timer = window.setTimeout(() => setFresh(undefined), 2_600)
    return () => window.clearTimeout(timer)
  }, [fresh])
  useEffect(() => {
    if (!crystal) return
    const timer = window.setTimeout(() => setCrystal(undefined), 500)
    return () => window.clearTimeout(timer)
  }, [crystal])
  const finishFlight = (id: string) => {
    setFlight(undefined)
    setCrystal(id)
  }
  useEffect(() => {
    if (!flight) return
    const timer = window.setTimeout(() => finishFlight(flight.id), 600)
    return () => window.clearTimeout(timer)
  }, [flight])
  useEffect(() => {
    if (!migration) return
    const timer = window.setTimeout(() => setMigration(undefined), 1_500)
    return () => window.clearTimeout(timer)
  }, [migration])
  useLayoutEffect(() => {
    const root = section.current
    const overlay = probeOverlay.current
    if (!root || !overlay || !fresh || !brainOpen) return
    const captureSelector = `[data-event-id="${CSS.escape(fresh.id)}"]`
    const paths = Array.from(overlay.querySelectorAll('path[data-probe-note]')).map(path => ({
      path, targetSelector: `[data-graph-node="${CSS.escape(path.getAttribute('data-probe-note')!)}"] .relationship-card-ink`,
    }))
    let frame = 0
    const followProbeTargets = () => {
      const bounds = overlay.getBoundingClientRect()
      const source = root.querySelector(captureSelector)?.getBoundingClientRect()
      const positions = paths.map(({ path, targetSelector }) => {
        const rect = root.querySelector(targetSelector)?.getBoundingClientRect()
        if (!source || !rect || rect.left <= source.right || rect.left > bounds.right ||
          rect.bottom < bounds.top || rect.top > bounds.bottom) return { path, d: '' }
        const start = { x: source.right - bounds.left, y: source.top + source.height / 2 - bounds.top }
        const end = { x: rect.left - bounds.left, y: rect.top + rect.height / 2 - bounds.top }
        const bend = (start.x + end.x) / 2
        return { path, d: `M ${start.x},${start.y} C ${bend},${start.y} ${bend},${end.y} ${end.x},${end.y}` }
      })
      for (const { path, d } of positions) {
        if (path.getAttribute('d') !== d) path.setAttribute('d', d)
      }
      // The camera transforms the graph directly, so sample the endpoints while the short preview is visible.
      frame = requestAnimationFrame(followProbeTargets)
    }
    followProbeTargets()
    return () => cancelAnimationFrame(frame)
  }, [brain.events, brainOpen, fresh])
  const runBrain = async (work: () => Promise<void>) => {
    setBrainError('')
    try { await work() } catch (error) { setBrainError(String(error)) }
  }
  const consolidate = async (ids: string[], title: string, target?: string, synthesis?: string) => {
    const root = section.current
    const bounds = root?.getBoundingClientRect()
    const visible = ids.map(id => root?.querySelector('[data-event-id="' + CSS.escape(id) + '"]'))
      .find(card => {
        const rect = card?.getBoundingClientRect()
        const lane = card?.parentElement?.getBoundingClientRect()
        return rect && lane && rect.top >= lane.top && rect.bottom <= lane.bottom
      })
    const origin = visible?.getBoundingClientRect()
    const text = visible?.querySelector('p')?.textContent ?? ''
    const id = await window.workbench.brain.consolidate(ids, title, target, synthesis)
    if (origin && bounds) {
      setMigration({ id, text, width: origin.width,
        from: { x: origin.left + origin.width / 2 - bounds.left, y: origin.top + origin.height / 2 - bounds.top } })
    } else {
      setCrystal(id)
    }
    reload()
  }

  const [scope, setScope] = useState<'nearby' | 'all'>(() => selected ? 'nearby' : 'all')
  const [anchor, setAnchor] = useState(selected)
  const [style, setStyle] = useState<Style>(initialStyle)
  const [sceneWidth, setSceneWidth] = useState(width)
  const [fontsReady,setFontsReady] = useState(false)
  useLayoutEffect(()=>{
    let active=true
    if (!document.fonts.check('600 11px "JetBrains Mono"','Plate')){
      void document.fonts.load('600 11px "JetBrains Mono"','Plate').then(()=>{if(active)setFontsReady(true)},()=>{})
    }
    return ()=>{active=false}
  },[])
  const byId = useMemo(() => new Map(nodes.map(item => [item.id, item])), [nodes])
  const center = anchor && byId.has(anchor) ? anchor : selected && byId.has(selected) ? selected : undefined
  const local = scope === 'nearby' && !!center
  const cards=useMemo(()=>measureCards(nodes),[nodes,fontsReady])
  const graph = useMemo(() => {
    const parents = new Map<string,string[]>()
    for (const {source: child, target: parent} of edges) {
      if (!byId.has(child) || !byId.has(parent) || child === parent) continue
      const upstream = parents.get(child) ?? []
      if (!upstream.includes(parent)) parents.set(child, [...upstream, parent])
    }
    const cycleNodes = new Set<string>()
    const visited = new Set<string>()
    const visit = (id:string,path:Set<string>) => {
      if (visited.has(id)) return
      if (path.has(id)) {
        for (const item of path) cycleNodes.add(item)
        cycleNodes.add(id)
        return
      }
      path.add(id)
      for (const parent of parents.get(id) ?? []) visit(parent,path)
      path.delete(id)
      visited.add(id)
    }
    for (const {id} of nodes) visit(id,new Set())

    const children = new Map<string,string[]>()
    for (const [child, upstream] of parents) {
      const parent = upstream.length === 1 ? upstream[0] : undefined
      if (!parent || cycleNodes.has(parent) || cycleNodes.has(child)) continue
      if (!children.has(parent)) children.set(parent,[])
      children.get(parent)!.push(child)
    }

    return { parents, children, cycleNodes }
  }, [byId,edges])
  const parentOf = (id: string) => {
    const parents = graph.parents.get(id)
    const parent = parents?.length === 1 ? parents[0] : undefined
    return parent && !graph.cycleNodes.has(parent) && !graph.cycleNodes.has(id) ? parent : undefined
  }
  const diagramWidth = local ? Math.max(760,Math.min(width,sceneWidth-38)) : width
  const laneXs=[diagramWidth*.2,diagramWidth*.5,diagramWidth*.8]
  const vicinity = useMemo(() => noteRelations(edges, byId, center), [edges, byId, center])
  const { ordered: layoutOrder, points, height } = useMemo(() => {
    if (!local || !center) return layout(nodes, edges,cards)
    const upstream = [...vicinity.upstream].sort((a,b)=>a.title.localeCompare(b.title,'zh-CN') || a.id.localeCompare(b.id))
    const seen = new Set(upstream.map(n=>n.id))
    const downstream = vicinity.downstream.filter(n=>!seen.has(n.id)).sort((a,b)=>a.title.localeCompare(b.title,'zh-CN') || a.id.localeCompare(b.id))
    const columnHeight=(ns:RelationshipNote[])=>ns.reduce((h,n)=>h+cards.get(n.id)!.height+19,0)
    const h=Math.max(290,80+Math.max(columnHeight(upstream),columnHeight(downstream),cards.get(center)!.height))
    const middle=(h+34)/2
    const positions = new Map<string, Point>([[center, {x:diagramWidth*.5,y:middle}]])
    const stack=(ns:RelationshipNote[],x:number)=>{
      let top=middle-(columnHeight(ns)-19)/2
      for(const n of ns){const h=cards.get(n.id)!.height;positions.set(n.id,{x,y:top+h/2});top+=h+19}
    }
    stack(upstream,diagramWidth*.2)
    stack(downstream,diagramWidth*.8)
    return { ordered: [...upstream, byId.get(center)!, ...downstream], points: positions, height: h }
  }, [nodes, edges, local, center, vicinity, byId, diagramWidth,cards])
  const [moved, setMoved] = useState<Map<string, Point>>(() => new Map())
  const movedRef = useRef(moved)
  movedRef.current = moved
  const [actionError, setActionError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const hidden = useMemo(() => {
    const result = new Set<string>()
    const stack = [...collapsed].flatMap(id => graph.children.get(id) ?? [])
    while (stack.length) {
      const node = stack.pop()!
      if (result.has(node)) continue
      result.add(node)
      stack.push(...(graph.children.get(node) ?? []))
    }
    return result
  }, [collapsed, graph.children])
  const ordered = layoutOrder.filter(note => !hidden.has(note.id))
  const deriving = useRef(false)
  const [nextFocus, setNextFocus] = useState<string>()
  const [taskSummary, setTaskSummary] = useState<Record<string, {
    todo: number; doing: number; pending: number; done: number; error: number
  }>>({})
  const activity = useMemo(() => {
    let doing = 0, pending = 0
    for (const summary of Object.values(taskSummary)) {
      doing += summary.doing
      pending += summary.pending
    }
    return { doing, pending }
  }, [taskSummary])
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.workbench.tasks.summaryByNotes().then(summary => { if (alive) setTaskSummary(summary) }, () => {})
    }
    load()
    const off = window.workbench.tasks.onStateChanged(() => { if (alive) load() })
    return () => { alive = false; off() }
  }, [])
  const linkDrag = useRef<{ id: string; pointer: number; from: Point } | null>(null)
  const [linkDraft, setLinkDraft] = useState<{ from: Point; to: Point } | null>(null)
  const [active, setActive] = useState<string>()
  const [hovered, setHovered] = useState<string>()
  const [motion, setMotion] = useState(() => {
    try { return localStorage.getItem('plate.relationship-flow.motion') === 'still' ? 'still' : 'live' }
    catch { return 'live' }
  })
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const live = motion==='live' && !reduced
  const [zoom, setZoom] = useState(1)
  const [legend, setLegend] = useState(false)
  const [details, setDetails] = useState<string>()
  const [styleOpen, setStyleOpen] = useState(false)
  const styleButton = useRef<HTMLButtonElement>(null)
  const detailsHeading = useRef<HTMLHeadingElement>(null)
  const detailOrigin = useRef<HTMLElement | SVGElement | null>(null)
  const panel = useRef<HTMLElement>(null)
  const beforeFocus = useRef<{camera:Camera; active?:string} | null>(null)
  const pendingFrame = useRef<string | undefined>(undefined)
  const lastFrame = useRef<{id:string; count:number} | undefined>(undefined)
  const [nodeAction, setNodeAction] = useState<'menu' | 'info' | 'move' | 'delete'>()
  const [moveTo,setMoveTo] = useState<Point>()
  const [undoMove,setUndoMove] = useState<{id:string; before:Point | undefined}>()
  const section = useRef<HTMLElement>(null)
  const [position,setPosition] = useState<Point>()
  const menuRef = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const dialogOrigin = useRef<Element | null>(null)
  const world = useRef<SVGGElement>(null)
  const camera = useRef<Camera>({x:0,y:0,scale:1})
  const cameraFrame = useRef(0)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const gesture = useRef<{id:number;x:number;y:number;start:Camera} | null>(null)
  const arrowId = useId()
  const [listOpen, setListOpen] = useState(() => innerWidth < 960)
  const activeNote = ordered.find(note => note.id === active)
  const detailNote = details ? byId.get(details) : undefined
  const rovingId = active ?? center ?? ordered[0]?.id
  const detailLinks = useMemo(() => noteRelations(edges, byId, details), [edges, byId, details])
  useLayoutEffect(() => { viewport.current?.focus({ preventScroll: true }) }, [])
  useLayoutEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(query.matches)
    query.addEventListener('change',change)
    return () => { query.removeEventListener('change',change); cancelAnimationFrame(cameraFrame.current); clearTimeout(clickTimer.current) }
  }, [])
  const switchStyle = (next:Style) => {
    setStyle(next)
    try { localStorage.setItem(styleStorage, next) } catch { /* preference is optional */ }
  }
  const drag = useRef<{ id: string; pointer: number; dx: number; dy: number; x: number; y: number;
    before: Point | undefined; moved: boolean } | null>(null)
  const links = useMemo(() => {
    return [...new Map(edges.filter(e=>points.has(e.source) && points.has(e.target) &&
      (!local || e.source===center || e.target===center) &&
      !hidden.has(e.source) && !hidden.has(e.target)).map(e=>[JSON.stringify([e.source,e.target]),e])).values()]
  },[points,edges,local,center,hidden])
  const highlighted = details ?? hovered ?? active ?? center
  const neighborhood = new Set(highlighted ? [highlighted] : [])
  for (const {source,target} of links) {
    if(source===highlighted)neighborhood.add(target)
    if(target===highlighted)neighborhood.add(source)
  }
  const titleCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { title } of nodes) counts.set(title, (counts.get(title) ?? 0) + 1)
    return counts
  }, [nodes])
  const geometry = useMemo(()=>{
    const placed=new Map<string,CardBox>()
    for (const [id,point] of points) {
      if (hidden.has(id)) continue
      const size=cards.get(id)!.height
      const p=(nodeAction==='move' && active===id ? moveTo : undefined) ?? moved.get(id) ?? point
      placed.set(id,{x:Math.max(cardWidth/2+8,p.x), y:Math.max(size/2+8,p.y),width:cardWidth,height:size})
    }
    let extentX = diagramWidth, extentY = height
    for (const card of placed.values()) {
      extentX = Math.max(extentX, card.x + card.width / 2 + 24)
      extentY = Math.max(extentY, card.y + card.height / 2 + 24)
    }
    return {placed, extentX, extentY, wires:connectCards(links,placed,local)}
  },[points,links,cards,nodeAction,active,moveTo,moved,diagramWidth,height,local,hidden])
  const clamp = ({x,y}:Point,id=active)=> {
    const half=((id && cards.get(id)?.height)||36)/2+8
    return {x:Math.max(cardWidth/2+8,x), y:Math.max(half,y)}
  }
  const at = (id: string) => geometry.placed.get(id)!
  const restoreMovement = ({ id, before }: {id:string; before:Point | undefined}) => {
    setMoved(previous=>{const next=new Map(previous); if (before) next.set(id,before); else next.delete(id); return next})
  }
  const point = (event: PointerEvent) => new DOMPoint(event.clientX, event.clientY)
    .matrixTransform(world.current!.getScreenCTM()!.inverse())
  function start(event: PointerEvent<SVGGElement>, id: string) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return
    clearTimeout(clickTimer.current)
    stopCamera()
    const cursor = point(event), node = at(id)
    drag.current = { id, pointer: event.pointerId, dx: node.x - cursor.x, dy: node.y - cursor.y,
      x:event.clientX,y:event.clientY,before:moved.get(id),moved:false }
    event.currentTarget.focus({preventScroll:true})
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent) {
    const session = drag.current
    if (!session || session.pointer !== event.pointerId) return
    if (!session.moved && Math.hypot(event.clientX-session.x,event.clientY-session.y) < 4) return
    session.moved = true
    const cursor = point(event)
    const next=clamp({x:cursor.x+session.dx,y:cursor.y+session.dy},session.id)
    setMoved((prev) => new Map(prev).set(session.id, next))
  }
  function stop(event: PointerEvent) {
    if (drag.current?.pointer !== event.pointerId) return
    if (drag.current.moved) {
      lastDrag.current = performance.now()
      const id = drag.current.id
      const pos = movedRef.current.get(id)
      setUndoMove({id,before:drag.current.before})
      if (pos) void window.workbench.graphLayout.saveBatch([{ noteId: id, x: pos.x, y: pos.y, pinned: true }]).catch(() => {})
    }
    drag.current = null
  }
  function cancelDrag(event?: PointerEvent) {
    const current = drag.current
    if (!current || (event && event.pointerId!==current.pointer)) return
    drag.current = null
    if (current.moved) {
      lastDrag.current = performance.now()
      restoreMovement(current)
      if (current.before) void window.workbench.graphLayout.saveBatch([{ noteId: current.id, x: current.before.x, y: current.before.y, pinned: true }]).catch(() => {})
    }
  }
  const lastDrag = useRef(-Infinity)
  useLayoutEffect(() => { cancelDrag() },[nodes,edges])
  useLayoutEffect(() => {
    let current = true
    void window.workbench.graphLayout.getAll().then(all => {
      if (!current) return
      setMoved(previous => new Map([
        ...Object.entries(all).flatMap(([id, entry]): [string, Point][] =>
          entry.pinned ? [[id, { x: entry.x, y: entry.y }]] : []),
        ...previous,
      ]))
      const initial = new Set(Object.keys(all).filter(id => all[id]!.collapsed))
      collapsedRef.current = initial
      setCollapsed(initial)
    }).catch(error => { if (current) setActionError(String(error)) })
    return () => { current = false }
  }, [])
  function paint(next:Camera) {
    camera.current=next
    world.current?.setAttribute('transform',`translate(${next.x} ${next.y}) scale(${next.scale})`)
    viewport.current?.setAttribute('data-camera',JSON.stringify(next))
  }
  function stopCamera() {
    if (cameraFrame.current) cancelAnimationFrame(cameraFrame.current)
    cameraFrame.current=0
    viewport.current?.removeAttribute('data-camera-moving')
    setZoom(camera.current.scale)
  }
  function flyTo(target:Camera, animate = live) {
    stopCamera()
    const start=camera.current
    if (!animate || document.hidden) {paint(target);setZoom(target.scale);return}
    viewport.current?.setAttribute('data-camera-moving','true')
    const begins=performance.now()
    const step=(time:number)=>{
      const progress=Math.max(0,Math.min(1,(time-begins)/420))
      if (progress<1) {
        paint(interpolateCamera(start,target,progress))
        cameraFrame.current=requestAnimationFrame(step)
      } else {paint(target);stopCamera()}
    }
    cameraFrame.current=requestAnimationFrame(step)
  }
  function fitOverview() {
    const target=viewport.current
    if (!target?.clientWidth || !target.clientHeight) return
    const w=target.clientWidth, h=target.clientHeight
    const { extentX, extentY } = geometry
    const scale=Math.min(1.12,Math.max(.08,Math.min((w-24)/extentX,(h-48)/extentY)))
    flyTo({scale,x:Math.max(12,(w-extentX*scale)/2),y:Math.max(8,(h-extentY*scale)/2-12)},false)
  }
  function setBranch(id: string, value: boolean) {
    const next = new Set(collapsedRef.current)
    if (value) next.add(id); else next.delete(id)
    collapsedRef.current = next
    setCollapsed(next)
    void window.workbench.graphLayout.setCollapsed(id,value).catch(error => {
      if (collapsedRef.current.has(id) !== value) return
      const reverted = new Set(collapsedRef.current)
      if (value) reverted.delete(id); else reverted.add(id)
      collapsedRef.current = reverted
      setCollapsed(reverted)
      setActionError(String(error))
    })
  }
  const expandNode = (id: string) => setBranch(id, false)
  const toggleCollapse = (id: string) => setBranch(id, !collapsedRef.current.has(id))
  function revealNode(id: string) {
    if (!byId.has(id)) return
    for (let parent = parentOf(id); parent; parent = parentOf(parent)) {
      if (collapsedRef.current.has(parent)) expandNode(parent)
    }
    setScope("all")
    setAnchor(undefined)
    setNextFocus(id)
  }
  function frameDetail(id:string,animate=live) {
    const target=viewport.current
    if (!target || !points.has(id)) return
    const w=target.clientWidth,h=target.clientHeight, side=panel.current?.getBoundingClientRect()
    const pane=target.getBoundingClientRect()
    const inset = rightInset && rightInset > 0 ? rightInset : 0
    const right = inset > 0 ? w - inset - 20 : side && side.width < w*.52 ? side.left-pane.left-20 : w-22
    const bottom=side && side.width >= w*.52 ? side.top-pane.top-14 : h-58
    const frame={left:22,top:18,width:Math.max(92,right-22),height:Math.max(90,bottom-18)}
    const ids=new Set([id])
    for(const {source,target} of links) {
      if(source===id)ids.add(target)
      if(target===id)ids.add(source)
    }
    const box=(key:string)=>{
      const p=at(key)
      return {x:p.x-p.width/2,y:p.y-p.height/2,width:p.width,height:p.height}
    }
    // Keep the connected context while there is room to read it. For a dense
    // neighborhood, keep the anchor and nearest context; the card has the full list.
    const nearby=[...ids].filter(key=>key!==id).map(key=>({key,d:Math.hypot(at(key).x-at(id).x,at(key).y-at(id).y)}))
      .sort((a,b)=>a.d-b.d || a.key.localeCompare(b.key))
    const boxes=[box(id)]
    for (const {key} of nearby) {
      const item=box(key)
      if (frameNodes([...boxes,item],frame,0,2.05).scale>=.64) boxes.push(item)
    }
    lastFrame.current={id,count:boxes.length}
    target.dataset.framed=String(boxes.length)
    flyTo(frameNodes(boxes,frame,0,boxes.length===1?2.05:1.8),animate)
  }
  const latestFrame = useRef(frameDetail)
  latestFrame.current=frameDetail
  useLayoutEffect(()=>{
    if (!editorOpen || !selected || !points.has(selected)) return
    if (lastFrame.current?.id === selected) return
    frameDetail(selected,false)
  // Recenter whenever the editor drawer opens for a note or the layout changes.
  },[editorOpen,selected,points])
  useLayoutEffect(()=>{
    const target=viewport.current
    if (!target || state.error) return
    if (details && points.has(details)) frameDetail(details,false)
    else fitOverview()
    setSceneWidth(target.clientWidth)
    let w=target.clientWidth,h=target.clientHeight
    const observer=new ResizeObserver(()=>{
      if(w===target.clientWidth && h===target.clientHeight)return
      w=target.clientWidth;h=target.clientHeight
      setSceneWidth(w)
      if(lastFrame.current && points.has(lastFrame.current.id)) latestFrame.current(lastFrame.current.id,false)
      else fitOverview()
    })
    observer.observe(target)
    return ()=>observer.disconnect()
  // The active frame uses the latest layout via the separate focus effect.
  },[points,state.error])
  useLayoutEffect(()=>{
    if(!details || pendingFrame.current!==details)return
    pendingFrame.current=undefined
    viewport.current?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'})
    frameDetail(details)
    detailsHeading.current?.focus({preventScroll:true})
  },[details, points])
  useLayoutEffect(()=>{
    if(!live && cameraFrame.current) {
      if(lastFrame.current)frameDetail(lastFrame.current.id,false)
      else if (restoreTarget.current) flyTo(restoreTarget.current,false)
    }
  },[live])
  const restoreTarget=useRef<Camera | undefined>(undefined)
  const changeZoom = (next: number) => {
    const target = viewport.current
    if (next === camera.current.scale || !target) return
    const from=camera.current, cx=target.clientWidth/2, cy=target.clientHeight/2
    lastFrame.current=undefined
    flyTo({scale:next,x:cx-(cx-from.x)*next/from.scale,y:cy-(cy-from.y)*next/from.scale},false)
  }
  const locate = (id: string) => {
    clearTimeout(clickTimer.current)
    if (points.has(id)) frameDetail(id)
    setActive(id)
  }
  const inspect = (id:string, origin?:HTMLElement | SVGElement) => {
    if (!points.has(id) || state.busy || state.error) return
    if (!details) {
      beforeFocus.current = {camera:{...camera.current},active}
      detailOrigin.current = origin ?? viewport.current
    }
    setHovered(undefined)
    setActive(id)
    if (details===id) {frameDetail(id);detailsHeading.current?.focus({preventScroll:true});return}
    pendingFrame.current=id
    setDetails(id)
  }
  const closeDetails = () => {
    const saved=beforeFocus.current
    const wasAt=detailOrigin.current
    beforeFocus.current = null
    lastFrame.current=undefined
    viewport.current?.removeAttribute('data-framed')
    setActive(saved?.active)
    setHovered(undefined)
    setDetails(undefined)
    if(saved){restoreTarget.current=saved.camera;flyTo(saved.camera)}
    requestAnimationFrame(()=>{
      ;(wasAt?.isConnected && wasAt.getClientRects().length ? wasAt : viewport.current)?.focus({preventScroll:true})
    })
  }
  const chooseScope = (next:'nearby'|'all', id=selected) => {
    clearTimeout(clickTimer.current)
    setScope(next); setAnchor(id); setActive(undefined); setDetails(undefined)
    setHovered(undefined)
    beforeFocus.current = null
    lastFrame.current=undefined
    viewport.current?.removeAttribute('data-framed')
    setUndoMove(undefined)
    section.current?.scrollTo(0,0)
    if (scope===next && center===id) fitOverview()
  }
  function toggleMotion() {
    const next=motion==='live'?'still':'live'
    setMotion(next)
    try {localStorage.setItem('plate.relationship-flow.motion',next)} catch { /* preference is optional */ }
  }
  const showInfo = (id:string, origin:Element) => { dialogOrigin.current=origin; setActive(id); setNodeAction('info') }
  const showMenu = (id:string, origin:Element, p?:Point) => {
    if (!section.current) return
    const box=section.current.getBoundingClientRect(), item=origin.getBoundingClientRect()
    const w=Math.min(320,box.width-16)
    setPosition({x:Math.max(box.left+8,Math.min(box.right-8-w,p?.x??item.left)),
      y:Math.max(8,Math.min(innerHeight-200,p?.y??item.bottom))})
    dialogOrigin.current=origin; setActive(id); setNodeAction('menu')
  }
  useLayoutEffect(()=>{ if (nodeAction==='menu') menuRef.current?.querySelector('button')?.focus() },[nodeAction,active])
  const moveNode = () => {
    if (!activeNote) return
    setMoveTo(at(activeNote.id)); setNodeAction('move')
  }
  const resetLayout = () => {
    setMoved(new Map()); setUndoMove(undefined)
    collapsedRef.current = new Set()
    setCollapsed(collapsedRef.current)
    void window.workbench.graphLayout.resetAll().catch(() => {})
  }
  const closeInfo = () => {
    setNodeAction(undefined)
    setMoveTo(undefined)
    requestAnimationFrame(() => {
      const origin = dialogOrigin.current
      if (origin instanceof HTMLElement && origin.isConnected && origin.getClientRects().length) origin.focus({preventScroll:true})
      else if (origin instanceof SVGElement) viewport.current?.focus({preventScroll:true})
      else first.current?.focus({preventScroll:true})
    })
  }
  function commit() {
    if (!activeNote || !moveTo || state.busy || state.error) return
    setUndoMove({id:activeNote.id,before:moved.get(activeNote.id)})
    setMoved(old=>{const next=new Map(old).set(activeNote.id,moveTo);movedRef.current=next;return next})
    void window.workbench.graphLayout.saveBatch([{ noteId: activeNote.id, x: moveTo.x, y: moveTo.y, pinned: true }]).catch(() => {})
    closeInfo()
  }
  const activate = (id:string, origin?:Element|null) => {
    if (!state.error && !state.busy) open(id,origin instanceof HTMLElement ? origin : viewport.current??undefined)
  }
  useLayoutEffect(()=>{if (nodeAction==='menu' && (!activeNote || state.error)) closeInfo()},[activeNote,nodeAction,state.error])
  useLayoutEffect(() => {
    if (!nextFocus || !geometry.placed.has(nextFocus) || state.busy || !viewport.current) return
    const node = world.current?.querySelector<SVGElement>(`[data-graph-node="${CSS.escape(nextFocus)}"]`)
    if (!node) return
    const position = at(nextFocus), current = camera.current, view = viewport.current
    const available = Math.max(100, view.clientWidth - (rightInset ?? 0))
    flyTo({ scale: current.scale, x: available / 2 - position.x * current.scale,
      y: view.clientHeight / 2 - position.y * current.scale }, false)
    setActive(nextFocus)
    node.focus({ preventScroll: true })
    setNextFocus(undefined)
  }, [nextFocus, geometry, state.busy, rightInset])
  useLayoutEffect(() => {
    if (!migration || !brainOpen || !section.current) return
    const target = world.current?.querySelector(
      '[data-graph-node="' + CSS.escape(migration.id) + '"] .relationship-card-ink')
    if (!target) return
    setMigration(undefined)
    const bounds = section.current.getBoundingClientRect()
    const rect = target.getBoundingClientRect()
    const to = { x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      to.x < 0 || to.x > bounds.width || to.y < 0 || to.y > bounds.height) {
      setCrystal(migration.id)
      return
    }
    setFlight({ ...migration, to })
  }, [brainOpen, migration, nodes])
  useEffect(() => {
    if (focusId && !state.busy) revealNode(focusId)
  }, [focusId, state.busy])
  async function createNoteAt(clientX?: number, clientY?: number) {
    if (state.busy || state.error || deriving.current || !world.current || !viewport.current) return
    const region = viewport.current.getBoundingClientRect()
    const matrix = world.current.getScreenCTM()
    if (!matrix) return
    deriving.current = true
    try {
      const pt = new DOMPoint(clientX ?? region.left + region.width / 2,
        clientY ?? region.top + region.height / 2).matrixTransform(matrix.inverse())
      const titles = new Set(nodes.map(n => n.title))
      let title = '新笔记'
      let seq = 2
      while (titles.has(title)) { title = `新笔记 ${seq++}` }
      const created = await window.workbench.notes.create(title, activeProject, 'blank')
      const { x, y } = clamp(pt)

      await window.workbench.graphLayout.saveBatch([{ noteId: created.id, x, y, pinned: true }])
      setMoved(previous => new Map(previous).set(created.id, { x, y }))
      setActionError('')
      setScope('all')
      setNextFocus(created.id)
      reload()
    } catch (e) { setActionError(String(e)) }
    finally { deriving.current = false }
  }

  async function deriveChild(id: string) {
    if (state.busy || state.error || deriving.current) return
    if (!canChange(id)) { setActionError('请先保存或处理父笔记的草稿'); return }
    deriving.current = true
    try {
      const parent = byId.get(id)
      if (!parent) return
      const titles = nodes.map(n => n.title)
      let title = `${parent.title} · 子项`
      let seq = 2
      while (titles.includes(title)) { title = `${parent.title} · 子项 ${seq++}` }
      const pos = at(id)
      let x = pos.x + cardWidth + 36
      for (const [key, card] of geometry.placed) {
        if (key !== id && Math.abs(card.y - pos.y) < (card.height + pos.height) / 2 + 12) {
          x = Math.max(x, card.x + cardWidth + 36)
        }
      }
      const child = await window.workbench.notes.create(title, parent.projectId, 'blank')
      const savedParent = await window.workbench.graphLayout.connectNodes(id, child.id, true)
      noteUpdated(savedParent)
      if (collapsedRef.current.has(id)) expandNode(id)

      await window.workbench.graphLayout.saveBatch([{ noteId: child.id, x, y: pos.y, pinned: true, parentNoteId: id }])
      setMoved(previous => new Map(previous).set(child.id, { x, y: pos.y }))
      setActionError('')
      setScope('all')
      setNextFocus(child.id)
      reload()
    } catch (e) { setActionError(String(e)) }
    finally { deriving.current = false }
  }

  async function deriveSibling(id: string) {
    if (state.busy || state.error || deriving.current) return
    const parent = parentOf(id)
    if (!parent) {
      activate(id)
      return
    }
    if (!canChange(parent)) { setActionError('请先保存或处理父笔记的草稿'); return }
    deriving.current = true
    try {
      const siblingBase = byId.get(id)!
      const titles = nodes.map(n => n.title)
      let title = `${siblingBase.title} · 同级`
      let seq = 2
      while (titles.includes(title)) { title = `${siblingBase.title} · 同级 ${seq++}` }
      const pos = at(id)
      const x = pos.x
      let y = pos.y + pos.height + 28
      for (const [key, card] of [...geometry.placed].sort((a, b) => a[1].y - b[1].y)) {
        if (key !== id && Math.abs(card.x - x) < cardWidth + 12 && Math.abs(card.y - y) < card.height + 28) {
          y = card.y + card.height + 28
        }
      }
      const sibling = await window.workbench.notes.create(title, siblingBase.projectId, 'blank')
      const savedParent = await window.workbench.graphLayout.connectNodes(parent, sibling.id, true)
      noteUpdated(savedParent)
      if (collapsedRef.current.has(parent)) expandNode(parent)

      await window.workbench.graphLayout.saveBatch([{ noteId: sibling.id, x, y, pinned: true, parentNoteId: parent }])
      setMoved(previous => new Map(previous).set(sibling.id, { x, y }))
      setActionError('')
      setScope('all')
      setNextFocus(sibling.id)
      reload()
    } catch (e) { setActionError(String(e)) }
    finally { deriving.current = false }
  }

  async function deleteNode(id: string) {
    try {
      if (!canChange(id) || (await window.workbench.notes.draftList()).some(draft => draft.id === id)) {
        throw new Error('请先处理这篇笔记的草稿')
      }
      const note = await window.workbench.notes.read(id)
      const result = await window.workbench.notes.delete(id, note.revision)
      if (result !== 'deleted') setActionError('笔记已被外部修改，请刷新后重试')
      else setActionError('')
    } catch (e) { setActionError(String(e)) }
  }

  function finishLinkDrag(clientX: number, clientY: number) {
    const ld = linkDrag.current
    linkDrag.current = null
    setLinkDraft(null)
    if (!ld) return
    const el = document.elementFromPoint(clientX, clientY)
    const nodeEl = el instanceof Element ? el.closest('[data-graph-node]') : null
    const targetId = nodeEl?.getAttribute('data-graph-node') ?? null
    if (!targetId || targetId === ld.id) return
    if (!canChange(ld.id)) { setActionError('请先保存或处理来源笔记的草稿'); return }
    void window.workbench.graphLayout.connectNodes(ld.id, targetId, true)
      .then(result => { noteUpdated(result); setActionError(''); reload() })
      .catch(e => setActionError(String(e)))
  }

  const resetControls = <><button type="button" onClick={() => {
    if(details)frameDetail(details,false)
    else {lastFrame.current=undefined;fitOverview()}
  }}>适合画布</button>
    <button type="button" onClick={resetLayout}>重置布局</button>
    <button type="button" aria-disabled={!undoMove} onClick={()=>{if (undoMove) { restoreMovement(undoMove); setUndoMove(undefined) }}}>撤销移动</button></>
  return <section ref={section} className="relations relationship-flow" data-flow-style={style} data-wide="true"
    data-motion={live?'live':'still'} data-brain-open={brainOpen} data-brain-zones={brainOpen && brainZones}
    data-brain-vitality={brainOpen && brainVitality} aria-label="笔记关系图" onKeyDown={event => {
    if (event.key.toLowerCase() === 'n' && !event.nativeEvent.isComposing && event.keyCode !== 229 && !event.repeat &&
        !nodeAction && !event.ctrlKey && !event.altKey && !event.metaKey &&
        !(event.target instanceof HTMLElement && event.target.closest('select,input,textarea,[contenteditable]'))) {
      event.preventDefault()
      void createNoteAt()
    }
    if (event.key.toLowerCase()==='s' && !event.nativeEvent.isComposing && !event.repeat &&
        !nodeAction && !event.ctrlKey && !event.altKey && !event.metaKey &&
        !(event.target instanceof HTMLElement && event.target.closest('select,input,textarea,[contenteditable]'))) {
      event.preventDefault()
      switchStyle(styles[(styles.findIndex(([id])=>id===style)+1)%styles.length]![0])
    }
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && event.keyCode!==229 && !nodeAction) {
      if(event.repeat)return
      event.stopPropagation()
      clearTimeout(clickTimer.current)
      if (styleOpen) {setStyleOpen(false);styleButton.current?.focus()}
      else if (legend) setLegend(false)
      else if (drag.current) cancelDrag()
      else if (details) closeDetails()
      else close()
    }
  }}>
    <div className="plate-map-hud plate-map-hud--left">
      {hudLeft}
      <button type="button" onClick={() => {
        const ids = Object.keys(taskSummary)
        const id = ids.find(id => taskSummary[id]?.doing) ?? ids.find(id => taskSummary[id]?.pending)
        if (id && byId.has(id)) revealNode(id)
        else if (id) revealOutside?.(id)
      }} disabled={!activity.doing && !activity.pending}>
        ⚡ {activity.doing} 进行中 · ● {activity.pending} 待审阅
      </button>
    </div>
    <div className="plate-map-hud plate-map-hud--right">
      <IconAction icon={IconMotion} label="关系图动效" active={live} aria-pressed={live} onClick={toggleMotion} disabled={reduced}/>
      <div className="relationship-style" onBlur={event=>{if(event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setStyleOpen(false)}}>
        <IconAction icon={IconStyle} label="视觉风格" ref={styleButton} aria-expanded={styleOpen}
          aria-controls={styleOpen?'relationship-styles':undefined} onClick={()=>setStyleOpen(!styleOpen)}/>
        {styleOpen && <div id="relationship-styles" className="relationship-style-pop" role="group" aria-label="视觉风格">
          <header>视觉表达 <small><kbd>S</kbd> 循环切换</small></header>
          {styles.map(([id,name,hint])=><button key={id} type="button" aria-pressed={style===id} onClick={()=>{
            switchStyle(id);setStyleOpen(false);styleButton.current?.focus()
          }}><span className="relationship-swatch" data-swatch={id} aria-hidden="true"/><span><strong>{name}</strong><small>{hint}</small></span>
            {style===id && <IconAccept size={14} strokeWidth={1.65} aria-hidden="true"/>}</button>)}
        </div>}
      </div>
      <IconAction icon={IconInfo} label="图例" aria-expanded={legend} onClick={() => setLegend(!legend)}/>
      <IconAction icon={IconBrain} label="大脑" active={brainOpen} aria-pressed={brainOpen} onClick={() => onBrainOpenChange(!brainOpen)}/>
      {hudRight}
    </div>
    {brainOpen && <>
      <BrainHudBar wave={brain.wave} notes={nodes.length} events={brain.events.length} zones={brainZones} vitality={brainVitality}
        toggleZones={() => setBrainZones(value => !value)}
        toggleVitality={() => {
          setBrainVitality(value => !value)
          if (!brainVitality) void runBrain(() => window.workbench.brain.recalculate())
        }}
        dream={() => void runBrain(async () => setConsolidation(await window.workbench.brain.dream(projectFilter)))}/>
      {brainZones && <CorticalZonesLayer/>}
      {!!fresh?.probe.length && <svg ref={probeOverlay} className="brain-probes" aria-hidden="true">
        {fresh.probe.map(id => <path key={id} data-probe-note={id} className="brain-edge--synaptic-flowing"/>)}
      </svg>}
      <EpisodicLane events={brain.events} fresh={fresh?.id} openCapture={() => setCapture(true)} consolidate={setConsolidation}/>
      {flight && <div className="brain-memory-flight" aria-hidden="true"
        style={{
          left: flight.from.x, top: flight.from.y, width: flight.width,
          '--flight-x': `${flight.to.x - flight.from.x}px`, '--flight-y': `${flight.to.y - flight.from.y}px`,
        } as CSSProperties}
        onAnimationEnd={() => finishFlight(flight.id)}>{flight.text}</div>}
      <div className="brain-context-control">
        <label title="启用后，任务会把当前项目的相关笔记、闪念与匹配技能交给选定的 Agent。">
          <input type="checkbox" checked={!!brain.status?.contextEnabled} disabled={!brain.status}
            onChange={event => {
              const enabled = event.target.checked
              void runBrain(() => window.workbench.brain.setContext(enabled))
            }}/>任务使用大脑上下文
        </label>
        {brain.status?.pendingWrites ? <p role="status">待写入 {brain.status.pendingWrites} 条 · 在「做梦整理」中重试</p> : null}
        {(brain.error || brainError) && <p role="alert">{brainError || brain.error}</p>}
      </div>
      <SkillDock skills={brain.skills} wave={brain.wave} inspect={setSkill} create={() => setSkill('new')}/>
    </>}
    {capture && <QuickCaptureBar project={activeProject} projectLabel={projectLabel} close={() => setCapture(false)}
      captured={(id, text) => {
        void brain.refresh()
        const lower = text.toLowerCase()
        setFresh({ id, probe: nodes.filter(note => note.projectId === activeProject &&
          [note.title, ...(note.tags ?? [])].some(label => label.length > 1 && lower.includes(label.toLowerCase())))
          .slice(0, 5).map(note => note.id) })
      }}/>}
    {consolidation && (consolidation.length ? <ConsolidationDialog events={consolidation} nodes={nodes}
      close={() => setConsolidation(undefined)} consolidate={consolidate}/> :
      <EditorDialog title="做梦整理" close={() => setConsolidation(undefined)} kind="brain" cancelLabel="关闭">
        <p>当前范围没有可整理的闪念。</p>
      </EditorDialog>)}
    {timeline && <EvolutionTimelineModal id={timeline.id} title={timeline.title} close={() => setTimeline(undefined)}/>}
    {skill && <SkillDialog skill={skill === 'new' ? undefined : skill} close={() => setSkill(undefined)}/>}
    <div className="plate-map-hud plate-map-hud--dock">
      <IconAction icon={IconNew} label="新建主节点" shortcut="N" onClick={() => void createNoteAt()} disabled={state.busy || !!state.error}/>
      <button type="button" onClick={() => { if (active) void deriveChild(active) }} disabled={!active || state.busy || !!state.error}>子节点 <kbd>Tab</kbd></button>
      <button type="button" onClick={() => { if (active) void deriveSibling(active) }} disabled={!active || !parentOf(active) || state.busy || !!state.error}>同级 <kbd>Enter</kbd></button>
      <button type="button" onClick={() => chooseScope(local ? 'all' : 'nearby', local ? center : active)}
        disabled={local ? !center : !active}>{local ? '全部导图' : '聚焦周边'}</button>
      <IconAction ref={first} icon={IconFocus} label="聚焦节点详情" onClick={event => {
        const id = active && geometry.placed.has(active) ? active : ordered[0]?.id
        if (id) inspect(id,event.currentTarget)
      }} disabled={!ordered.length || state.busy || !!state.error}/>
      {resetControls}
      <IconAction icon={IconMinus} label="缩小" onClick={() => changeZoom(Math.max(.42, zoom - .2))} disabled={zoom<=.42}/>
      <span role="status">{Math.round(zoom * 100)}%</span>
      <IconAction icon={IconNew} label="放大" onClick={() => changeZoom(Math.min(2.25, zoom + .2))} disabled={zoom>=2.25}/>
    </div>
    {state.busy && <p role="status" className="relationship-action-status">正在读取关系索引…</p>}
    {actionError && <p role="alert" className="relationship-action-status">{actionError}</p>}
    {state.error && <p role="alert" className="relationship-action-status">关系索引读取失败：{state.error}</p>}
    {(state.error || edges.some(edge=>!byId.has(edge.source)||!byId.has(edge.target))) &&
      <button type="button" aria-disabled={state.busy} onClick={()=>{if (!state.busy) {first.current?.focus();reload()}}}>重试关系图</button>}
    {!state.busy && !state.error && !nodes.length && <p role="status" className="relationship-action-status">点击「新建主节点」，或双击空白画布开始。</p>}
    {legend && <p className="relationship-action-status">箭头从资料指向使用它的笔记。双击或 Shift+Enter 打开笔记，C 折叠或展开子节点。</p>}
    {edges.some(edge=>!byId.has(edge.source)||!byId.has(edge.target)) && <p role="status">部分关联笔记已不可用</p>}
    {active && !activeNote && <p role="status">选中的节点已从索引移除。</p>}
    <div className="relationship-stage" data-detail={!!detailNote && !state.error}>
    <div className="relations-canvas" hidden={!!state.error} ref={viewport} tabIndex={0} aria-label="关系图画布"
      onKeyDown={event=>{
        if(event.target!==event.currentTarget || event.nativeEvent.isComposing)return
        const d=directions.find(d=>d.key===event.key)
        if(d){event.preventDefault();lastFrame.current=undefined;const p=camera.current;flyTo({...p,x:p.x+d.x*4,y:p.y+d.y*4},false)}
      }}>
      <svg width="100%" height="100%" role="group" aria-label="笔记节点"
        onPointerDown={event=>{
          if (event.button!==0 || event.target!==event.currentTarget)return
          clearTimeout(clickTimer.current)
          stopCamera()
          gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,start:{...camera.current}}
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event=>{
          if (linkDrag.current?.pointer === event.pointerId) {
            const cursor = point(event)
            setLinkDraft({ from: linkDrag.current.from, to: { x: cursor.x, y: cursor.y } })
            return
          }
          const g=gesture.current
          if (!g || g.id!==event.pointerId){move(event);return}
          if (Math.hypot(event.clientX-g.x,event.clientY-g.y)<3)return
          lastFrame.current=undefined
          paint({...g.start,x:g.start.x+event.clientX-g.x,y:g.start.y+event.clientY-g.y})
        }}
        onDoubleClick={event => { if (event.target === event.currentTarget) void createNoteAt(event.clientX, event.clientY) }}
        onPointerUp={event=>{
          if (linkDrag.current?.pointer === event.pointerId) { event.stopPropagation(); finishLinkDrag(event.clientX, event.clientY); return }
          if(gesture.current?.id===event.pointerId)gesture.current=null;stop(event)
        }}
        onLostPointerCapture={event=>{
          if (linkDrag.current?.pointer === event.pointerId) { finishLinkDrag(event.clientX, event.clientY); return }
          if(gesture.current?.id===event.pointerId)gesture.current=null;cancelDrag(event)
        }}
        onPointerCancel={event=>{
          if (linkDrag.current?.pointer === event.pointerId) { linkDrag.current = null; setLinkDraft(null); return }
          if(gesture.current?.id===event.pointerId)gesture.current=null;cancelDrag(event)
        }}>
        <defs><marker id={arrowId} viewBox="0 0 8 8" refX="8" refY="4" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L8 4 L0 8 Z" fill="context-stroke" />
        </marker></defs>
        <g ref={world} className="relationship-world" data-focus={!!details}>
        {local && <g className="relationship-lanes">
          {(['上游资料','当前笔记','下游去向'] as const).map((title,i)=><g key={title}>
            <rect x={laneXs[i]!-104} y="19" width="208" height={height-38} rx="12"/>
            <text x={laneXs[i]} y="49" textAnchor="middle">{title}</text>
            {((i===0 && !vicinity.upstream.length) || (i===2 && !vicinity.downstream.some(n=>!vicinity.upstream.some(u=>u.id===n.id)))) &&
              <text x={laneXs[i]} y={(height+40)/2} textAnchor="middle" className="relationship-lane-empty">{i===2 && vicinity.downstream.length ? '互引笔记见左栏' : '暂无关联笔记'}</text>}
          </g>)}
        </g>}
        {linkDraft && <line className="relationship-link-draft" x1={linkDraft.from.x} y1={linkDraft.from.y}
          x2={linkDraft.to.x} y2={linkDraft.to.y} />}
        {([false,true] as const).map(hot=>
          geometry.wires.filter(wire=>(wire.target===highlighted || (!!highlighted && wire.sources.includes(highlighted)))===hot)
          .map((wire,index) => <g key={wire.id} className="relationship-wire" data-flow={local && (wire.target===center?'in':'out')}>
            <path data-source={wire.source || undefined} data-target={wire.target} data-port={wire.port}
              data-exit={wire.exit} data-members={wire.sources.join(' ')} data-trunk={wire.id.endsWith(':trunk')} data-spine={!!wire.spine}
              className="relations-edge" data-active={hot}
              data-muted={!!details && !hot} d={wire.d} markerEnd={wire.arrow?`url(#${arrowId})`:undefined}/>
            {wire.sources.some(source => activeEdges.has([source, wire.target].sort().join('|'))) &&
              <path className="brain-edge--synaptic-flowing" d={wire.d}/>}
            {live && hot && index < 160 && <path key={highlighted} className="relationship-signal" d={wire.d}
              style={{
                '--rf-signal-start':wire.period-wire.length-wire.tail,
                '--rf-signal-end':-wire.length-wire.tail,
                '--rf-signal-gap':wire.period-9,
              } as CSSProperties}/>}
          </g>))}
        {ordered.map((note,index) => {
          const p = at(note.id)
          const card = cards.get(note.id)!
          const top = -card.height/2
          const role = note.id===center ? 'center' : local && vicinity.upstream.some(n=>n.id===note.id) ? 'up' : local?'down':'note'
          const childCount = graph.children.get(note.id)?.length ?? 0
          const memory = brain.notes[note.id]
          const activated = activeNodes.has(note.id)
          const dormant = brainOpen && brainVitality && !!memory?.dormant && !activated
          return <g key={note.id} data-graph-node={note.id} transform={`translate(${p.x} ${p.y})`}
            className="relations-node" role="button" aria-label={label(note)}
            data-brain-active={activated} data-brain-seed={brain.wave?.seedNoteId === note.id}
            data-brain-probe={fresh?.probe.includes(note.id) || undefined}
            data-brain-dormant={dormant} data-brain-crystal={crystal === note.id}
            style={{ '--node-vitality': memory?.vitality ?? 1 } as CSSProperties} aria-pressed={note.id === (active ?? center)}
            tabIndex={note.id===rovingId?0:-1}
            data-selected={note.id === (active ?? center)} data-center={local && note.id === center} data-kind={role}
            data-muted={!!details && !neighborhood.has(note.id)} data-hovered={hovered===note.id}
            onPointerEnter={event=>{if(event.pointerType==='mouse' && !drag.current)setHovered(note.id)}}
            onPointerLeave={()=>setHovered(current=>current===note.id?undefined:current)}
            onClick={event => {
              if (performance.now()-lastDrag.current<500 || event.detail>1)return
              setActive(note.id)
            }}
            onFocus={()=>setActive(current=>current===note.id ? current : note.id)}
            onKeyDown={event=>{
              if(event.nativeEvent.isComposing || event.repeat && ['Enter',' '].includes(event.key))return
              if(event.key==='Enter' && !event.shiftKey){event.preventDefault();void deriveSibling(note.id)}
              else if(event.key==='Enter'){event.preventDefault();activate(note.id,event.currentTarget)}
              else if(event.key==='Tab'){event.preventDefault();void deriveChild(note.id)}
              else if(event.key.toLowerCase()==='c' && childCount){event.preventDefault();toggleCollapse(note.id)}
              else if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();setActive(note.id);setNodeAction('delete')}
              else if(event.key==='F10'&&event.shiftKey){event.preventDefault();showMenu(note.id,event.currentTarget)}
              else if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown','Home','End'].includes(event.key)){
                event.preventDefault()
                const next=ordered[Math.max(0,Math.min(ordered.length-1,event.key==='Home'?0:event.key==='End'?ordered.length-1:index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)))]
                if(!next || !world.current)return
                world.current.querySelector<SVGElement>(`[data-graph-node="${CSS.escape(next.id)}"]`)?.focus({preventScroll:true})
                const t=at(next.id),c=camera.current,v=viewport.current
                if(v && (t.x*c.scale+c.x<72 || t.x*c.scale+c.x>v.clientWidth-72 || t.y*c.scale+c.y<36 || t.y*c.scale+c.y>v.clientHeight-50)){
                  lastFrame.current=undefined
                  flyTo({scale:c.scale,x:v.clientWidth/2-t.x*c.scale,y:v.clientHeight/2-t.y*c.scale},false)
                }
              }
            }}
            onPointerDown={(event) => start(event, note.id)} onDoubleClick={event => {
              event.stopPropagation()
              clearTimeout(clickTimer.current)
              if (performance.now()-lastDrag.current>500) activate(note.id,event.currentTarget)
            }}
            onContextMenu={event => { event.preventDefault(); showMenu(note.id,event.currentTarget,{x:event.clientX,y:event.clientY}) }}>
            <title>{label(note)}</title>
            {dormant && <circle className="brain-dormant-dot" r="6"/>}
            {brain.wave?.seedNoteId === note.id && <rect className="brain-node-ripple" x={-cardWidth / 2 - 3}
              y={top - 3} width={cardWidth + 6} height={card.height + 6} rx="10"/>}
            <g className="relationship-card-ink"><rect x={-cardWidth / 2} y={top} width={cardWidth} height={card.height} rx="8"
              data-pulse={taskSummary[note.id]?.doing ? 'doing' : taskSummary[note.id]?.pending ? 'pending' : undefined} />
            {(() => {
              const summary = taskSummary[note.id]
              if (!summary) return null
              const total = summary.todo + summary.doing + summary.pending + summary.done + summary.error
              const badge = summary.doing ? '⚡ ' + summary.doing + ' 进行中'
                : summary.pending ? '● ' + summary.pending + ' 待审阅'
                : summary.done ? '✓ ' + summary.done + '/' + total : null
              return badge ? <text className="relationship-card-status" x={cardWidth / 2 - 10} y={top + 17} textAnchor="end">{badge}</text> : null
            })()}
            <path className="relationship-note-glyph" transform={`translate(-73 ${top+11})`} d="M0 0h6l3 3v9h-9z M6 0v3h3 M2 6h5 M2 9h4"/>
            <text className="relationship-card-title">{card.title.map((line,i)=><tspan key={i} x="-56" y={top+20+i*14}>{line}</tspan>)}</text>
            <text className="relationship-card-preview">{card.preview.map((line,i)=><tspan key={i} x="-56" y={top+19+card.title.length*14+i*12}>{line}</tspan>)}</text>
            {card.tag.length>0 && <text className="relationship-card-tags" x="-56" y={top+19+card.title.length*14+card.preview.length*12}>{card.tag[0]}</text>}
            </g>
            {brainOpen && memory && <EvolutionBadge version={memory.version}
              x={-cardWidth / 2 + 8} y={top - 5.5} open={() => setTimeline(note)}/>}
            {childCount > 0 && (() => {
              const collapsedNow = collapsed.has(note.id)
              const shown = childCount
              const label = collapsedNow ? `展开 ${childCount} 个子节点` : `折叠 ${shown} 个子节点`
              return <g className="relationship-collapse" role="button" tabIndex={-1} aria-hidden="true"
                data-collapsed={collapsedNow} data-count={collapsedNow ? childCount : shown}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); toggleCollapse(note.id) }}
                onKeyDown={event => {
                  if (event.nativeEvent.isComposing || event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault(); event.stopPropagation(); toggleCollapse(note.id)
                }}>
                <rect x={cardWidth / 2 - 28} y={top - 9} width="30" height="18" rx="5"/>
                <text x={cardWidth / 2 - 13} y={top + 4} textAnchor="middle">{collapsedNow ? `+${childCount}` : shown}</text>
                <title>{label}</title>
              </g>
            })()}
            {(['left','right','top','bottom'] as const).map(side=>{
              const dot=port({x:0,y:0,width:cardWidth,height:card.height},side)
              return <g key={side} className="relationship-port-group" data-side={side}
                onPointerDown={event => {
                  if (event.button !== 0 || !event.isPrimary) return
                  event.stopPropagation()
                  const base = at(note.id)
                  linkDrag.current = { id: note.id, pointer: event.pointerId, from: { x: base.x + dot.x, y: base.y + dot.y } }
                  event.currentTarget.setPointerCapture(event.pointerId)
                }}>
                <circle className="relationship-port-hit" cx={dot.x} cy={dot.y} r="9" />
                <circle className="relationship-port" cx={dot.x} cy={dot.y} r="2.1" />
              </g>
            })}
          </g>
        })}
        </g>
      </svg>
    </div>
    {detailNote && !state.error && !editorOpen && <aside ref={panel} className="relationship-detail" aria-labelledby="relationship-detail-title">
      <div className="relationship-detail-top">
        <small>笔记详情</small><IconAction icon={IconReject} label="关闭笔记详情" onClick={closeDetails}/>
      </div>
      <h2 id="relationship-detail-title" ref={detailsHeading} tabIndex={-1}>{detailNote.title}</h2>
      <div className="relationship-detail-actions">
        <button type="button" className="button-primary" onClick={event=>activate(detailNote.id,event.currentTarget)}>打开笔记</button>
        <button type="button" onClick={()=>{chooseScope('nearby',detailNote.id);requestAnimationFrame(()=>first.current?.focus())}}>以此为中心</button>
        {brainOpen && <button type="button" onClick={() => setTimeline(detailNote)}>认知年轮</button>}
      </div>
      {detailNote.preview && <p className="relationship-detail-preview">{detailNote.preview}</p>}
      <p className="relationship-detail-identity">{label(detailNote).slice(detailNote.title.length+3)}</p>
      {!!detailNote.tags?.length && <div className="relationship-detail-tags">{detailNote.tags.map(tag=><span key={tag}>#{tag}</span>)}</div>}
      {([['上游资料', detailLinks.upstream], ['下游去向', detailLinks.downstream]] as const).map(([title, items])=>
        <section key={title} aria-label={title}>
          <h3>{title} <small>{items.length}</small></h3>
          {items.length ? <ul>{items.map(note=><li key={note.id}><button type="button" aria-label={label(note)} onClick={event=>{
            if (points.has(note.id)) inspect(note.id,event.currentTarget)
            else { chooseScope('nearby',note.id);requestAnimationFrame(()=>first.current?.focus()) }
          }}><span aria-hidden="true" className="relationship-row-arrow">{title==='上游资料'?'入 →':'出 →'}</span>
            <strong>{note.title}</strong>
            {((titleCounts.get(note.title)??0)>1 || note.preview) && <small>{(titleCounts.get(note.title)??0)>1 ? label(note).slice(note.title.length+3) : note.preview}</small>}
          </button></li>)}</ul> : <p>暂无关联笔记</p>}
        </section>
      )}
      {detailLinks.self && <p>这篇笔记引用了自己。</p>}
    </aside>}
    </div>
    {activeNote && nodeAction==='menu' && !state.error && <div ref={menuRef} className="relations-node-menu"
      role="menu" aria-label="节点操作" style={{left:position?.x,top:position?.y,width:Math.min(320,(section.current?.clientWidth??336)-16)}}
      onBlur={event=>{if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setNodeAction(undefined)}}
      onKeyDown={event=>{
        if (event.nativeEvent.isComposing) return
        const items=[...event.currentTarget.querySelectorAll('button')]
        const i=items.indexOf(event.target as HTMLButtonElement)
        if (event.key==='Escape') {event.preventDefault();event.stopPropagation();closeInfo()}
        else if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
          event.preventDefault()
          items[event.key==='Home'?0:event.key==='End'?items.length-1:(i+items.length+(event.key==='ArrowDown'?1:-1))%items.length]?.focus()
        }
      }}>
      <button role="menuitem" type="button" onClick={()=>{locate(activeNote.id);closeInfo()}}>选中并定位</button>
      <button role="menuitem" type="button" onClick={()=>{setNodeAction(undefined);activate(activeNote.id,dialogOrigin.current)}}>打开笔记</button>
      <button role="menuitem" type="button" onClick={()=>setNodeAction('info')}>完整信息</button>
      <button role="menuitem" type="button" onClick={()=>setNodeAction('delete')}>删除笔记…</button>
      <button role="menuitem" type="button" onClick={moveNode}>移动节点</button>
      <button role="menuitem" type="button" disabled={!graph.children.get(activeNote.id)?.length}
        onClick={()=>{toggleCollapse(activeNote.id)}}>{collapsed.has(activeNote.id)?'展开子节点':'折叠子节点'}</button>
    </div>}
    {nodeAction && nodeAction!=='menu' && <EditorDialog key={nodeAction} title={nodeAction==='move'?'移动节点':nodeAction==='delete'?'删除笔记':'节点详情'} close={closeInfo}>
      {!activeNote || state.error ? <p role="status">节点已不可用，请返回关系图。</p> : nodeAction==='delete' ? <>
      <p>将删除笔记「{activeNote.title}」及其 Markdown 文件。图中的关联会随索引刷新移除。</p>
      <button type="button" className="button-primary" onClick={()=>{void deleteNode(activeNote.id);closeInfo()}}>确认删除</button>
      </> : nodeAction==='info' ? <>
      <p>{label(activeNote)}</p><p className="editor-full-path">{activeNote.path}</p><p>{activeNote.id}</p>
      <button type="button" onClick={()=>{locate(activeNote.id);closeInfo()}}>选中并定位</button>
      <ul>{links.filter(e=>e.source===activeNote.id||e.target===activeNote.id).map(e=>{
        const target = e.source===activeNote.id ? e.target : e.source
        const note = ordered.find(n=>n.id===target)!
        const direction = e.source===e.target ? '引用自身' : e.source===activeNote.id?'上游资料':'下游去向'
        return <li key={JSON.stringify([e.source,e.target])}>{direction} · <button type="button" onClick={()=>locate(target)}>{note.title}</button></li>
      })}</ul>
      <button type="button" onClick={() => { setNodeAction(undefined);activate(activeNote.id,dialogOrigin.current) }}>打开笔记</button>
      <button type="button" onClick={moveNode}>移动节点</button>
      </> : moveTo && <div onKeyDown={event=>{
        if (event.nativeEvent.isComposing || event.repeat && event.key==='Enter') return
        const direction=directions.find(d=>d.key===event.key)
        if (direction) {event.preventDefault(); setMoveTo(p=>clamp({x:p!.x+direction.x,y:p!.y+direction.y}))}
        else if (event.key==='Enter') {event.preventDefault(); commit()}
      }}>
        <p data-editor-initial tabIndex={-1}>方向键每步移动 8 单位；Enter 应用，Esc 取消。</p>
        <output data-node-coordinates aria-live="polite">{moveTo.x}, {moveTo.y}</output>
        <div className="relations-toolbar">{directions.map(d=>{
          const next=clamp({x:moveTo.x+d.x,y:moveTo.y+d.y})
          const disabled=next.x===moveTo.x && next.y===moveTo.y
          return <button key={d.key} type="button" aria-disabled={disabled} onClick={()=>setMoveTo(next)}>
            {d.label}{disabled?' · 已到边界':''}</button>
        })}</div>
        <button type="button" onClick={commit}>应用</button>
      </div>}
    </EditorDialog>}

  </section>
}

