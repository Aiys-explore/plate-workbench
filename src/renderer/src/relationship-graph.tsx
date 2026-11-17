import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import type { NoteEdge, NoteSummary, RelationshipNote } from '../../shared/ipc'
import { EditorDialog } from './note-editor'
import { noteRelations } from './relation-directions'
import { frameNodes, interpolateCamera, type Camera, type Point } from './relationship-camera'
import { cardWidth, connectCards, measureCards, port, type CardBox } from './relationship-geometry'
import { IconAction } from './icon-action'
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

export function RelationshipGraph({ nodes, edges, selected, label, open, board, close, state, reload }: {
  nodes: RelationshipNote[]; edges: NoteEdge[]; selected?: string; label: NoteLabel
  open: (id: string, origin?:HTMLElement) => void; close: () => void
  board: (id: string, origin?:HTMLElement) => void
  state: { busy: boolean; error?: string }; reload: () => void
}) {
  const [scope, setScope] = useState<'nearby' | 'all'>(() => selected ? 'nearby' : 'all')
  const [anchor, setAnchor] = useState(selected)
  const [style, setStyle] = useState<Style>(initialStyle)
  const [wideCanvas, setWideCanvas] = useState(true)
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
  const diagramWidth = local ? Math.max(760,Math.min(width,sceneWidth-38)) : width
  const laneXs=[diagramWidth*.2,diagramWidth*.5,diagramWidth*.8]
  const vicinity = useMemo(() => noteRelations(edges, byId, center), [edges, byId, center])
  const { ordered, points, height } = useMemo(() => {
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
  const [nodeAction, setNodeAction] = useState<'menu' | 'info' | 'move'>()
  const [moveTo,setMoveTo] = useState<Point>()
  const [undoMove,setUndoMove] = useState<{id:string; before:Point | undefined}>()
  const [more,setMore] = useState(false)
  const section = useRef<HTMLElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const [position,setPosition] = useState<Point>()
  const menuRef = useRef<HTMLDivElement>(null)
  const [row, setRow] = useState<string>()
  const first = useRef<HTMLButtonElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const listToggle = useRef<HTMLElement>(null)
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
  const detailLinks = useMemo(() => noteRelations(edges, byId, details), [edges, byId, details])
  useLayoutEffect(() => { first.current?.focus() }, [])
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
      (!local || e.source===center || e.target===center)).map(e=>[JSON.stringify([e.source,e.target]),e])).values()]
  },[points,edges,local,center])
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
      const size=cards.get(id)!.height
      const p=(nodeAction==='move' && active===id ? moveTo : undefined) ?? moved.get(id) ?? point
      placed.set(id,{x:Math.max(cardWidth/2+8,Math.min(diagramWidth-cardWidth/2-8,p.x)),
        y:Math.max(size/2+8,Math.min(height-size/2-8,p.y)),width:cardWidth,height:size})
    }
    return {placed,wires:connectCards(links,placed,local)}
  },[points,links,cards,nodeAction,active,moveTo,moved,diagramWidth,height,local])
  const clamp = ({x,y}:Point,id=active)=> {
    const half=((id && cards.get(id)?.height)||36)/2+8
    return {x:Math.max(cardWidth/2+8,Math.min(diagramWidth-cardWidth/2-8,x)),y:Math.max(half,Math.min(height-half,y))}
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
      setUndoMove({id:drag.current.id,before:drag.current.before})
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
    }
  }
  const lastDrag = useRef(-Infinity)
  useLayoutEffect(() => { cancelDrag() },[nodes,edges])
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
    const scale=Math.min(1.12,Math.max(.42,Math.min((w-24)/diagramWidth,(h-48)/height)))
    flyTo({scale,x:Math.max(12,(w-diagramWidth*scale)/2),y:Math.max(8,(h-height*scale)/2-12)},false)
  }
  function frameDetail(id:string,animate=live) {
    const target=viewport.current
    if (!target || !points.has(id)) return
    const w=target.clientWidth,h=target.clientHeight, side=panel.current?.getBoundingClientRect()
    const pane=target.getBoundingClientRect()
    const right=side && side.width < w*.52 ? side.left-pane.left-20 : w-22
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
    setMoved(new Map()); setUndoMove(undefined)
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
  const resetLayout = () => { setMoved(new Map());setUndoMove(undefined) }
  const closeInfo = () => {
    setNodeAction(undefined)
    setMoveTo(undefined)
    requestAnimationFrame(() => {
      const origin = dialogOrigin.current
      if (origin instanceof HTMLElement && origin.isConnected && origin.getClientRects().length) origin.focus({preventScroll:true})
      else if (origin instanceof SVGElement) viewport.current?.focus({preventScroll:true})
      else (listToggle.current ?? first.current)?.focus({preventScroll:true})
    })
  }
  function commit() {
    if (!activeNote || !moveTo || state.busy || state.error) return
    setUndoMove({id:activeNote.id,before:moved.get(activeNote.id)})
    setMoved(old=>new Map(old).set(activeNote.id,moveTo))
    closeInfo()
  }
  const activate = (id:string, origin?:Element|null) => {
    if (!state.error && !state.busy) open(id,origin instanceof HTMLElement ? origin : viewport.current??undefined)
  }
  const rowOrigin=useRef<string>(undefined)
  const previousRows=useRef<string[]>([])
  useLayoutEffect(()=>{
    const ids=ordered.map(n=>n.id)
    if (rowOrigin.current && !ids.includes(rowOrigin.current) && document.activeElement===document.body) {
      const at=previousRows.current.indexOf(rowOrigin.current)
      const next=[...previousRows.current.slice(at+1),...previousRows.current.slice(0,at).reverse()].find(id=>ids.includes(id))
      const target=next && section.current?.querySelector<HTMLElement>(`[data-graph-open="${CSS.escape(next)}"]`)
      ;(target || listToggle.current)?.focus()
    }
    previousRows.current=ids
  },[ordered])
  useLayoutEffect(()=>{if (nodeAction==='menu' && (!activeNote || state.error)) closeInfo()},[activeNote,nodeAction,state.error])
  const resetControls = <><button type="button" onClick={() => {
    if(details)frameDetail(details,false)
    else {lastFrame.current=undefined;fitOverview()}
  }}>适合画布</button>
    <button type="button" onClick={resetLayout}>重置布局</button>
    <button type="button" aria-disabled={!undoMove} onClick={()=>{if (undoMove) { restoreMovement(undoMove); setUndoMove(undefined) }}}>撤销移动</button></>
  return <section ref={section} className="relations relationship-flow" data-flow-style={style} data-wide={wideCanvas}
    data-motion={live?'live':'still'} aria-label="笔记关系图" onKeyDown={event => {
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
      else if (more) { setMore(false);moreButton.current?.focus() }
      else if (drag.current) cancelDrag()
      else if (details) closeDetails()
      else close()
    }
  }}>
    <div className="relations-toolbar">
      <strong tabIndex={-1} data-m51-graph-focus aria-label="关系图">笔记关系图</strong>
      <button type="button" onClick={() => chooseScope('nearby')} aria-pressed={local && center===selected} disabled={!selected || !byId.has(selected)}>当前笔记周边</button>
      <button type="button" onClick={() => chooseScope('all', center)} aria-pressed={!local}>全部笔记</button>
      <IconAction ref={first} icon="focus" label="聚焦" onClick={event => { const id = active && points.has(active) ? active : center && points.has(center) ? center : ordered[0]?.id
        if (id) inspect(id,event.currentTarget) }} disabled={!ordered.length || state.busy || !!state.error}/>
      <button ref={moreButton} type="button" aria-expanded={more} onClick={()=>setMore(!more)}>更多</button>
      <button type="button" aria-expanded={legend} onClick={() => setLegend(!legend)}>图例</button>
      <button type="button" className="relationship-wide-toggle" aria-label="宽画布" aria-pressed={wideCanvas}
        onClick={()=>setWideCanvas(!wideCanvas)}>{wideCanvas?'显示侧栏':'展开画布'}</button>
      <button type="button" onClick={close}>返回笔记</button>
    </div>
    <div className="relationship-meta">
      <span>{local ? '来源 › 当前主题 › 后续使用' : '全库 · 按资料流向查看'} <span aria-hidden="true">／</span> {ordered.length} 篇 · {links.length} 条关系</span>
      <div className="relationship-view-controls">
      <button type="button" aria-label="关系图动效" aria-pressed={live} onClick={toggleMotion} disabled={reduced}
        title={reduced?'系统已开启减少动态效果':'切换静态与动效'}>{live?'◉ 动效':'○ 静态'}</button>
      <div className="relationship-style" onBlur={event=>{if(event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setStyleOpen(false)}}>
        <button type="button" ref={styleButton} aria-expanded={styleOpen} aria-controls={styleOpen?'relationship-styles':undefined}
          onClick={()=>setStyleOpen(!styleOpen)}>视觉风格：{styles.find(([id])=>id===style)?.[1]} ▾</button>
        {styleOpen && <div id="relationship-styles" className="relationship-style-pop" role="group" aria-label="视觉风格">
          <header>视觉表达 <small><kbd>S</kbd> 循环切换</small></header>
          {styles.map(([id,name,hint])=><button key={id} type="button" aria-pressed={style===id} onClick={()=>{
            switchStyle(id);setStyleOpen(false);styleButton.current?.focus()
          }}><span className="relationship-swatch" data-swatch={id} aria-hidden="true"/><span><strong>{name}</strong><small>{hint}</small></span>
            <span aria-hidden="true">{style===id?'✓':''}</span></button>)}
        </div>}
      </div>
      </div>
    </div>
    {more && <div className="relations-toolbar relations-overflow">{resetControls}</div>}
    {state.busy && <p role="status">正在读取关系索引…</p>}
    {state.error && <p role="alert">关系索引读取失败：{state.error}</p>}
    {(state.error || edges.some(edge=>!byId.has(edge.source)||!byId.has(edge.target))) &&
      <button type="button" aria-disabled={state.busy} onClick={()=>{if (!state.busy) {first.current?.focus();reload()}}}>重试关系图</button>}
    {!state.busy && !state.error && !nodes.length && <p role="status">暂无可显示的笔记</p>}
    {legend && <p className="relations-help">箭头从被引用的资料指向使用它的笔记。单击聚焦并看详情，双击打开，拖动可调整位置。互相引用的笔记保留两支箭头。</p>}
    {edges.some(edge=>!byId.has(edge.source)||!byId.has(edge.target)) && <p role="status">部分关联笔记已不可用</p>}
    {active && !activeNote && <p role="status">选中的节点已从索引移除。</p>}
    <div className="relationship-stage" data-detail={!!detailNote && !state.error}>
    <div className="relations-canvas" hidden={!!state.error || !nodes.length} ref={viewport} tabIndex={0} aria-label="关系图画布"
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
          const g=gesture.current
          if (!g || g.id!==event.pointerId){move(event);return}
          if (Math.hypot(event.clientX-g.x,event.clientY-g.y)<3)return
          lastFrame.current=undefined
          paint({...g.start,x:g.start.x+event.clientX-g.x,y:g.start.y+event.clientY-g.y})
        }}
        onPointerUp={event=>{if(gesture.current?.id===event.pointerId)gesture.current=null;stop(event)}}
        onLostPointerCapture={event=>{if(gesture.current?.id===event.pointerId)gesture.current=null;cancelDrag(event)}}
        onPointerCancel={event=>{if(gesture.current?.id===event.pointerId)gesture.current=null;cancelDrag(event)}}>
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
        {([false,true] as const).map(hot=>
          geometry.wires.filter(wire=>(wire.target===highlighted || (!!highlighted && wire.sources.includes(highlighted)))===hot)
          .map((wire,index) => <g key={wire.id} className="relationship-wire" data-flow={local && (wire.target===center?'in':'out')}>
            <path data-source={wire.source || undefined} data-target={wire.target} data-port={wire.port}
              data-exit={wire.exit} data-members={wire.sources.join(' ')} data-trunk={wire.id.endsWith(':trunk')} data-spine={!!wire.spine}
              className="relations-edge" data-active={hot}
              data-muted={!!details && !hot} d={wire.d} markerEnd={wire.arrow?`url(#${arrowId})`:undefined}/>
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
          return <g key={note.id} data-graph-node={note.id} transform={`translate(${p.x} ${p.y})`}
            className="relations-node" role="button" aria-label={label(note)} aria-pressed={note.id===details}
            tabIndex={note.id===(details ?? center ?? ordered[0]?.id)?0:-1}
            data-selected={note.id === (active ?? center)} data-center={local && note.id === center} data-kind={role}
            data-muted={!!details && !neighborhood.has(note.id)} data-hovered={hovered===note.id}
            onPointerEnter={event=>{if(event.pointerType==='mouse' && !drag.current)setHovered(note.id)}}
            onPointerLeave={()=>setHovered(current=>current===note.id?undefined:current)}
            onClick={event => {
              if (performance.now()-lastDrag.current<500)return
              clearTimeout(clickTimer.current)
              if(event.detail>1)return
              const origin=event.currentTarget
              clickTimer.current=setTimeout(()=>{if(origin.isConnected)inspect(note.id,origin)},270)
            }}
            onKeyDown={event=>{
              if(event.nativeEvent.isComposing || event.repeat && ['Enter',' '].includes(event.key))return
              if(event.key==='Enter'||event.key===' '){event.preventDefault();inspect(note.id,event.currentTarget)}
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
              clearTimeout(clickTimer.current)
              if (performance.now()-lastDrag.current>500) activate(note.id,event.currentTarget)
            }}
            onContextMenu={event => { event.preventDefault(); showMenu(note.id,event.currentTarget,{x:event.clientX,y:event.clientY}) }}>
            <title>{label(note)}</title>
            <g className="relationship-card-ink"><rect x={-cardWidth / 2} y={top} width={cardWidth} height={card.height} rx="8" />
            <path className="relationship-note-glyph" transform={`translate(-73 ${top+11})`} d="M0 0h6l3 3v9h-9z M6 0v3h3 M2 6h5 M2 9h4"/>
            <text className="relationship-card-title">{card.title.map((line,i)=><tspan key={i} x="-56" y={top+20+i*14}>{line}</tspan>)}</text>
            <text className="relationship-card-preview">{card.preview.map((line,i)=><tspan key={i} x="-56" y={top+19+card.title.length*14+i*12}>{line}</tspan>)}</text>
            {card.tag.length>0 && <text className="relationship-card-tags" x="-56" y={top+19+card.title.length*14+card.preview.length*12}>{card.tag[0]}</text>}
            </g>
            {(['left','right','top','bottom'] as const).map(side=>{
              const dot=port({x:0,y:0,width:cardWidth,height:card.height},side)
              return <g key={side} className="relationship-port-group" data-side={side}>
                <circle className="relationship-port-hit" cx={dot.x} cy={dot.y} r="9" />
                <circle className="relationship-port" cx={dot.x} cy={dot.y} r="2.1" />
              </g>
            })}
          </g>
        })}
        </g>
      </svg>
    </div>
    {!!ordered.length && !state.error && <div className="relationship-camera-tools" role="group" aria-label="画布缩放">
      <IconAction icon="minus" label="缩小" onClick={() => changeZoom(Math.max(.42, zoom - .2))} disabled={zoom<=.42}/>
      <span role="status">{Math.round(zoom * 100)}%</span>
      <IconAction icon="plus" label="放大" onClick={() => changeZoom(Math.min(2.25, zoom + .2))} disabled={zoom>=2.25}/>
    </div>}
    {detailNote && !state.error && <aside ref={panel} className="relationship-detail" aria-labelledby="relationship-detail-title">
      <div className="relationship-detail-top">
        <small>笔记详情</small><button type="button" onClick={closeDetails} aria-label="关闭笔记详情">×</button>
      </div>
      <h2 id="relationship-detail-title" ref={detailsHeading} tabIndex={-1}>{detailNote.title}</h2>
      <div className="relationship-detail-actions">
        <button type="button" className="button-primary" onClick={event=>activate(detailNote.id,event.currentTarget)}>打开笔记</button>
        <button type="button" onClick={event=>board(detailNote.id,event.currentTarget)}>在画板中打开</button>
        <button type="button" onClick={()=>{chooseScope('nearby',detailNote.id);requestAnimationFrame(()=>first.current?.focus())}}>以此为中心</button>
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
    <details hidden={!!state.error || !nodes.length} className="relations-list" open={listOpen} onToggle={event=>setListOpen(event.currentTarget.open)}>
      <summary ref={listToggle}>关系图笔记列表（{ordered.length}）</summary>
      <ul onKeyDown={event=>{
        if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute('data-graph-open')) return
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-graph-open]')]
        const index = buttons.indexOf(event.target as HTMLButtonElement)
        if (['ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
          event.preventDefault()
          const next = event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1
            : Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowUp' ? -1 : 1)))
          buttons[next]?.focus()
        } else if (event.key===' ' || event.key==='F10' && event.shiftKey) {
          event.preventDefault()
          const id = ordered[index]?.id
          if (id) (event.key===' ' ? inspect(id,event.target) : showMenu(id,event.target))
        }
      }}>{ordered.map((note,index) => <li key={note.id}>
        <button type="button" data-graph-open={note.id} aria-current={note.id === selected ? 'true' : undefined}
          tabIndex={(ordered.some(n=>n.id===row) ? note.id===row : index===0) ? 0 : -1}
          onFocus={()=>{rowOrigin.current=note.id;setRow(note.id)}} onBlur={event=>{if(event.relatedTarget) rowOrigin.current=undefined}} onClick={event => activate(note.id,event.currentTarget)}>{label(note)}{note.id===active?' · 已选':''}</button>
        <button type="button" tabIndex={-1} aria-label={`查看节点 ${label(note)}`} onClick={event => inspect(note.id,event.currentTarget)}>详情</button>
      </li>)}</ul>
    </details>
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
      <button role="menuitem" type="button" onClick={()=>{setNodeAction(undefined);board(activeNote.id,dialogOrigin.current instanceof HTMLElement ? dialogOrigin.current : viewport.current??undefined)}}>在画板中打开</button>
      <button role="menuitem" type="button" onClick={()=>setNodeAction('info')}>完整信息</button>
      <button role="menuitem" type="button" onClick={moveNode}>移动节点</button>
    </div>}
    {nodeAction && nodeAction!=='menu' && <EditorDialog key={nodeAction} title={nodeAction==='move'?'移动节点':'节点详情'} close={closeInfo}>
      {!activeNote || state.error ? <p role="status">节点已不可用，请返回关系图。</p> : nodeAction==='info' ? <>
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

