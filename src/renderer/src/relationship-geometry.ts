import type { Point } from './relationship-camera'
import type { NoteEdge, RelationshipNote } from '../../shared/ipc'

const faces = ['left','right','top','bottom'] as const
export type Port = typeof faces[number]
export type CardBox = Point & { width:number; height:number }
export const cardWidth=168
const mono='"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono","Liberation Mono","Noto Sans Mono CJK SC","PingFang SC","Hiragino Sans GB","Microsoft YaHei",monospace'
export const cardFonts = {
  title: '600 11px '+mono,
  preview: '400 8px '+mono,
  tag: '600 7px '+mono,
}
export function measureCards(notes:RelationshipNote[]) {
  const ctx=document.createElement('canvas').getContext('2d')!
  const wrap=(text:string,font:string,max:number)=>{
    ctx.font=font
    return text.trim().split(/\s+/u).filter(Boolean).reduce((lines,word)=>{
      let line=lines.pop()??''
      if (line && ctx.measureText(line+' '+word).width>128) {lines.push(line);line=''}
      else if(line)line+=' '
      for(const ch of word) {
        if (line && ctx.measureText(line+ch).width>128) {lines.push(line.trimEnd());line=''}
        line+=ch
      }
      lines.push(line)
      return lines
    },[] as string[]).map((line,i,all)=>{
      if(i!==max-1||all.length<=max)return line
      const chars=Array.from(line)
      while(chars.length && ctx.measureText(chars.join('')+'…').width>128) chars.pop()
      return chars.join('')+'…'
    }).slice(0,max)
  }
  return new Map(notes.map(note=>{
    const title=wrap(note.title,cardFonts.title,3)
    const preview=wrap(note.preview??'',cardFonts.preview,4)
    const tags=note.tags??[]
    const shown=tags.slice(0,2).map(tag=>'#'+tag).join('  ')
    const tag=wrap(shown+(tags.length>2?'  +'+(tags.length-2):''),cardFonts.tag,1)
    return [note.id,{title,preview,tag,height:Math.max(36,22+title.length*14+preview.length*12+tag.length*11)}]
  }))
}
export function port(box:CardBox, side:Port):Point {
  switch(side){
    case 'left':return {x:box.x-box.width/2,y:box.y}
    case 'right':return {x:box.x+box.width/2,y:box.y}
    case 'top':return {x:box.x,y:box.y-box.height/2}
    case 'bottom':return {x:box.x,y:box.y+box.height/2}
  }
}
const hor=(side:Port)=>side==='left'||side==='right'
const shift=(p:Point,side:Port,d:number)=>({
  x:p.x+(side==='left'?-d:side==='right'?d:0),
  y:p.y+(side==='top'?-d:side==='bottom'?d:0),
})
const distance=(a:Point,b:Point)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y)
const same=(a:Point,b:Point)=>a.x===b.x&&a.y===b.y
const clean=(points:Point[])=>points.filter((p,i)=>!i||!same(points[i-1]!,p))
const path=(p:Point[])=>clean(p).map(({x,y},i)=>(i?'L':'M')+' '+x+' '+y).join(' ')
const pathLength=(p:Point[])=>p.slice(1).reduce((n,v,i)=>n+distance(p[i]!,v),0)

function crosses(u:Point,v:Point,b:CardBox,pad=5) {
  const l=b.x-b.width/2-pad,r=b.x+b.width/2+pad,t=b.y-b.height/2-pad,d=b.y+b.height/2+pad
  return u.x===v.x ? u.x>l && u.x<r && Math.max(u.y,v.y)>t && Math.min(u.y,v.y)<d
    : u.y>t && u.y<d && Math.max(u.x,v.x)>l && Math.min(u.x,v.x)<r
}
// Try the nearest unobstructed orthogonal channel first. Nearby card margins
// add detours without making the shared trunk change for every source.
function elbow(a:Point,b:Point,obstacles:CardBox[],side:Port,spine?:number) {
  const candidates=[[a,{x:b.x,y:a.y},b],[a,{x:a.x,y:b.y},b]]
  const xs=new Set([(a.x+b.x)/2,a.x,b.x]),ys=new Set([(a.y+b.y)/2,a.y,b.y])
  const near=obstacles.filter(o=>o.x+o.width/2+32>=Math.min(a.x,b.x) && o.x-o.width/2-32<=Math.max(a.x,b.x) &&
    o.y+o.height/2+32>=Math.min(a.y,b.y) && o.y-o.height/2-32<=Math.max(a.y,b.y))
  for(const o of near.slice(0,32)) {
    xs.add(o.x-o.width/2-11); xs.add(o.x+o.width/2+11)
    ys.add(o.y-o.height/2-11); ys.add(o.y+o.height/2+11)
  }
  for(const x of xs)candidates.push([a,{x,y:a.y},{x,y:b.y},b])
  for(const y of ys)candidates.push([a,{x:a.x,y},{x:b.x,y},b])
  const routeScore=(points:Point[])=>{
    let score=0
    if(spine!==undefined) {
      const axis=(p:Point)=>hor(side)?p.x:p.y
      const half=Math.sign(axis(b)-spine)
      if(points.some((p,i)=>i>0&&(axis(p)-spine)*half<=0))score+=10000000
    }
    for(let i=1;i<points.length;i++) {
      const u=points[i-1]!,v=points[i]!
      score+=distance(u,v)+9
      for(const o of near)if(crosses(u,v,o))score+=100000
    }
    const last=points.at(-2)
    if(last && (hor(side)?last.x!==b.x:last.y!==b.y))score+=7
    return score
  }
  let best=clean(candidates[0]!), cost=Infinity
  for(const candidate of candidates){const c=clean(candidate),n=routeScore(c);if(n<cost){cost=n;best=c}}
  return best
}
type Input = { source:string; target:string; exit:Port; entry:Port; self?:boolean }
type WireInfo = { id:string; source:string; target:string; sources:string[]; port:Port; exit?:Port; arrow:boolean; spine?:boolean }
export type Wire = WireInfo & { d:string; length:number; tail:number; period:number }

export function connectCards(edges:NoteEdge[], boxes:ReadonlyMap<string,CardBox>, local=false) {
  const pairs=new Set(edges.map(e=>e.target+':'+e.source))
  const groups=new Map<string,Input[]>()
  for(const edge of edges) {
    // Stored links point to what was cited; material flows from cited to citing.
    const source=edge.target,target=edge.source
    const from=boxes.get(source),to=boxes.get(target)
    if(!from||!to)continue
    const dx=to.x-from.x,dy=to.y-from.y
    const horizontal=(local || Math.abs(dx)>=Math.abs(dy)*.62) && Math.abs(dx)>cardWidth*.7
    let exit:Port=horizontal?(dx>0?'right':'left'):(dy>0?'bottom':'top')
    let entry:Port=horizontal?(dx>0?'left':'right'):(dy>0?'top':'bottom')
    const self=source===target
    if(self){exit='right';entry='top'}
    else if (pairs.has(target+':'+source) && source>target) {
      // Give the return leg separate ports so the two arrowheads stay distinct.
      if(horizontal){exit=dy<=0?'top':'bottom';entry=dy<=0?'top':'bottom'}
      else {exit=dx>=0?'right':'left';entry=dx>=0?'right':'left'}
    }
    const key=self?source+':loop':target+':'+entry
    const group=groups.get(key)??[]
    group.push({source,target,entry,exit,self})
    groups.set(key,group)
  }
  const wires:Wire[]=[]
  const emit=(info:WireInfo,points:Point[],tail=0,period?:number)=>{
    const length=pathLength(points)
    if(length>0)wires.push({...info,d:path(points),length,tail,period:period??length+40})
  }
  const obstacles=[...boxes.values()]
  for(const [key,group] of groups) {
    const {target,entry}=group[0]!
    const end=port(boxes.get(target)!,entry)
    if(group[0]!.self) {
      const start=port(boxes.get(target)!,'right')
      const top=shift(end,'top',22)
      const outside=shift(start,'right',22)
      emit({id:key,source:target,sources:[target],target,exit:'right',port:'top',arrow:true},
        [start,outside,{x:outside.x,y:top.y},top,end])
      continue
    }
    if(group.length>1) {
      // One spine parallel to the target edge. Each source joins at its own
      // cross position; the final segment enters the same midpoint once.
      const join=shift(end,entry,34)
      const vertical=hor(entry)
      const cross=(point:Point)=>vertical?point.y:point.x
      const axis=(point:Point)=>vertical?point.x:point.y
      const onSpine=(value:number)=>vertical?{x:join.x,y:value}:{x:value,y:join.y}
      const finish=cross(join), spineAxis=axis(join), trunkLength=distance(join,end)
      const branches=group.map(edge=>{
        const from=boxes.get(edge.source)!
        const start=port(from,edge.exit), leave=shift(start,edge.exit,13)
        const coordinate=cross(leave), tap=onSpine(coordinate)
        // Approach the bus from its side, never by drawing a second stroke along it.
        const delta=axis(leave)-spineAxis
        const towards=delta!==0?Math.sign(delta):Math.sign(axis(start)-spineAxis)||1
        const offset=towards*Math.min(8,Math.abs(delta)||8)
        const approach=vertical?{x:spineAxis+offset,y:tap.y}:{x:tap.x,y:spineAxis+offset}
        const points=delta===0?[start,leave]:[start,...elbow(leave,approach,obstacles,entry,spineAxis),tap]
        return {edge,coordinate,points,tail:Math.abs(coordinate-finish)+trunkLength}
      })
      const period=Math.max(...branches.map(branch=>pathLength(branch.points)+branch.tail))+40
      for(const {edge,points,tail} of branches) {
        emit({id:key+':'+edge.source,source:edge.source,sources:[edge.source],target,exit:edge.exit,port:entry,arrow:false},points,tail,period)
      }
      const span=[...new Set([finish,...branches.map(branch=>branch.coordinate)])].sort((a,b)=>a-b)
      for(let i=1;i<span.length;i++){
        const low=span[i-1]!,high=span[i]!,mid=(low+high)/2
        const [from,to]=mid<finish?[low,high]:[high,low]
        // Each interval belongs only to routes that actually traverse it.
        const sources=branches.filter(({coordinate})=>mid<finish?coordinate<mid:coordinate>mid).map(({edge})=>edge.source)
        emit({id:key+':spine:'+i,source:'',sources,target,port:entry,arrow:false,spine:true},
          [onSpine(from),onSpine(to)],Math.abs(to-finish)+trunkLength,period)
      }
      emit({id:key+':trunk',source:'',sources:group.map(e=>e.source),target,port:entry,arrow:true},[join,end],0,period)
    } else {
      const edge=group[0]!, start=port(boxes.get(edge.source)!,edge.exit)
      const leave=shift(start,edge.exit,13), approach=shift(end,entry,17)
      emit({id:key,source:edge.source,sources:[edge.source],target,exit:edge.exit,port:entry,arrow:true},
        [start,...elbow(leave,approach,obstacles,entry),end])
    }
  }
  return wires
}
