
import { scanDelegation } from '../shared/delegation-markdown'

// Keep line terminators and the BOM byte-for-byte. The delegation parser supplies
// ownership evidence, but indented prose may also be a user's conclusion.
export function deleteTaskRange(content:string,noteId:string,blockId:string){
  const parsed=scanDelegation(content)
  const hits=parsed.anchors.filter(x=>x.blockId===blockId)
  const a=hits[0], task=a&&parsed.taskAt(a.line)
  if(hits.length!==1 || a.claimedNoteId!==noteId || task?.blockId!==blockId || task.issue ||
      task.excludedRoots.length || parsed.resultIssues.length)throw new Error('无法划清任务与相邻内容')
  const lines=content.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)??[]
  const i=a.line-1, top=lines[i]
  if(!top || !/^\uFEFF? {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+\[[ xX]\][ \t]/.test(top))
    throw new Error('仅支持有明确边界的 Markdown 待办块')
  let end=i+1
  const directive=lines[end] ?? ''
  if(/^ {0,3}<!--[ \t]*agent\s*:/i.test(directive)){
    while(end<lines.length && !/-->[ \t]*(?:\r\n|\r|\n|$)$/.test(lines[end]))end++
    if(end===lines.length)throw new Error('块级指令边界不清')
    end++
  }else{
    const fence=/^ {0,3}(\x60{3,}|~{3,})[ \t]*agent[ \t]*(?:\r\n|\r|\n|$)/i.exec(directive)
    if(fence){
      const close=new RegExp('^ {0,3}'+fence[1][0]+'{'+fence[1].length+',}[ \\t]*(?:\\r\\n|\\r|\\n|$)')
      end++
      while(end<lines.length&&!close.test(lines[end]))end++
      if(end===lines.length)throw new Error('块级指令边界不清')
      end++
    }
  }
  if(task.includedLines.some(line=>line!==a.line && line>end))
    throw new Error('任务包含缩进正文，无法证明其与独立结论的边界')
  const prefix=lines.slice(0,i).join('')+(top.startsWith('\uFEFF')?'\uFEFF':'')
  const removed=lines.slice(i,end).join('').replace(i===0?/^\uFEFF/:/$^/,'')
  const suffix=lines.slice(end).join('')
  const next=prefix+suffix, check=scanDelegation(next)
  const payload=(scan:typeof parsed,text:string)=>scan.resultRegions.map(r=>[r.runId,
    (text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)??[]).slice(r.startLine-1,r.endLine).join('')])
  const others=(scan:typeof parsed)=>scan.lines.flatMap(n=>{
    const t=scan.taskAt(n)
    return t?.blockId===blockId?[]:[[t?.blockId,t?.rawLine?.replace(/^\uFEFF/,''),t?.marker,t?.text,t?.issue]]
  })
  const moreAnchors=(scan:typeof parsed)=>scan.anchors.filter(x=>x.blockId!==blockId).map(x=>[x.blockId,x.claimedNoteId])
  if(check.anchors.some(x=>x.blockId===blockId) || check.resultIssues.length ||
     JSON.stringify(others(parsed))!==JSON.stringify(others(check)) ||
     JSON.stringify(moreAnchors(parsed))!==JSON.stringify(moreAnchors(check)) ||
     JSON.stringify(payload(parsed,content))!==JSON.stringify(payload(check,next)))
    throw new Error('删去该范围会改变相邻任务或独立结论的解释')
  const start=Buffer.byteLength(prefix), stop=start+Buffer.byteLength(removed)
  return {bytes:Buffer.from(next), removed,start,stop}
}
