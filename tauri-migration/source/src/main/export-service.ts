import Database from 'better-sqlite3'
import { localSqlitePath } from './local-sqlite-path'
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { Scope, Policy, Preview, Receipt, Row } from '../shared/p12'
import { planWindowsExport, type WikiLink } from './export-planner'
import { runManaged } from './managed-delete-file'
import type { NoteStore } from './notes'
const sha=(buf:Buffer|string)=>createHash('sha256').update(buf).digest('hex')
const msg=(e:unknown)=>e instanceof Error?e.message:String(e)
const pin=(dir:string,...forbid:string[])=>runManaged(5,join(dir,'.notes-directory-pin'),forbid[0]??'',forbid[1]??'').parent
const mappingId=':mapping'
type Target={dir:string; parent:string; sourceRoot:string; profileRoot:string}
type Item=Row & {links?:readonly WikiLink[]; identity?:string;stamp?:string;sha?:string;stage?:string;armed?:boolean;settled?:boolean}
type Operation={id:string; scope:Scope; target:Target; rows:Item[]; phase:string; stopping:boolean; superseded?:string}
type Request={scope:Scope;fingerprint:string;target:string;policy:Policy;saved:boolean;retry?:string}
type Plan={request:Request; target:Target; fingerprint:string; rows:Item[]; blockers:string[]}
const cut=(phase:string,id:string,item:string)=>{
  const hook=(process as unknown as Record<symbol,unknown>)[Symbol.for('workbench.m44.acceptance.cut')]
  if(typeof hook==='function')hook(phase,id,item)
}
function view(row:Item):Row {
  const {id,source,name,target,reason,status,check}=row
  return {id,source,name,target,reason,status,check}
}
export class ExportService {
  private readonly db:Database.Database
  private target?:{token:string;value:Target}
  private previewed?:{id:string;plan:Plan}
  private active?:Operation
  constructor(private readonly notes:NoteStore,private readonly root:string,private readonly profile:string) {
    this.db=new Database(localSqlitePath(join(profile,'markdown-export.sqlite')))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.exec('CREATE TABLE IF NOT EXISTS export_op (id TEXT PRIMARY KEY, image TEXT NOT NULL)')
  }
  private closing=false
  close() {this.closing=true;this.db.close()}
  scope(scope:Scope) {return this.notes.exportSource(scope).display}
  private assertTarget(t:Target) {
    if(pin(this.root)!==t.sourceRoot || pin(this.profile)!==t.profileRoot || pin(t.dir,t.sourceRoot,t.profileRoot)!==t.parent)
      throw new Error('目标或受保护目录已换成不同实体，请重新选择')
  }
  choose(dir:string) {
    if(!isAbsolute(dir))throw new Error('目标必须是本机绝对目录')
    dir=resolve(dir)
    const sourceRoot=pin(this.root),profileRoot=pin(this.profile)
    const parent=pin(dir,sourceRoot,profileRoot)
    const token=randomUUID()
    this.previewed=undefined
    this.target={token,value:{dir,parent,sourceRoot,profileRoot}}
    return {token,directory:dir}
  }
  private occupancy(t:Target) {
    this.assertTarget(t)
    const names=readdirSync(t.dir).sort()
    const fingerprint=names.map(name=>{
      const s=lstatSync(join(t.dir,name),{bigint:true})
      return [name,s.dev,s.ino,s.birthtimeNs,s.ctimeNs,s.mtimeNs,s.size].map(String)
    })
    this.assertTarget(t)
    return {names,fingerprint}
  }
  private make(request:Request,target:Target) {
    if(request.policy!=='number' && request.policy!=='skip')throw new Error('未知重名策略')
    const source=this.notes.exportSource(request.scope)
    if(source.display.fingerprint!==request.fingerprint)throw new Error('源范围、修订或恢复稿已变化，请重新读取范围')
    const prev=request.retry?this.load(request.retry):undefined
    if(request.retry && (!prev || prev.superseded || JSON.stringify(prev.scope)!==JSON.stringify(request.scope) || this.active?.id===prev.id))
      throw new Error('不能使用该操作生成重试计划')
    if(prev) {
      this.audit(prev)
      if(prev.rows.some(r=>r.status==='待核对'))throw new Error('请先核对现场')
    }
    const allowed=(row:Item)=>row.status==='失败'||row.status==='未开始'
    const keep=prev?.rows.filter(r=>r.id!==mappingId&&!allowed(r))
    // Reuse exact prior successful names and targets in retry mapping.
    if(prev && (prev.target.parent!==target.parent || prev.target.dir!==target.dir))throw new Error('剩余项只能在原导出目录核对及重试')
    const chosen=source.items.filter(row=>!prev || prev.rows.some(r=>r.id===row.noteId&&allowed(r)))
    const occupied=this.occupancy(target)
    const diskPlan=planWindowsExport({scope:request.scope.kind==='project'?'project':'single',existing:request.policy,
      notes:chosen,occupiedNames:occupied.names,maxNameUnits:255,remainingPathUnits:Math.max(0,32760-target.dir.length-1)})
    const rows:Item[]=diskPlan.notes.map(r=>({id:r.noteId,source:r.sourceRelativePath,name:r.originalName,
      target:r.destination.status==='planned'?join(target.dir,r.destination.fileName):null,
      reason:(r.destination.status==='skipped'?['已有同名目标，未生成']:r.destination.status==='rejected'?['没有可用的安全文件名']:[])
        .concat(r.naming.map(k=>({sanitized:'修正导出名',shortened:'缩短导出名','batch-conflict':'批内重名','existing-conflict':'目标已有同名','mapping-conflict':'映射重名'})[k])).join('；'),
      status:r.destination.status==='skipped'?'跳过':'未开始',settled:r.destination.status==='skipped',
      links:chosen.find(x=>x.noteId===r.noteId)?.links}))
    const blockers:string[]=[]
    if(!request.saved && source.display.rows.some(r=>r.recovery))blockers.push('有本地恢复稿，请先明确选择只导出已保存版本')
    if(!chosen.length&&!prev)blockers.push('范围内没有持久化 Markdown')
    if(diskPlan.blockers.includes('all-skipped'))blockers.push('所有笔记都将跳过')
    if(diskPlan.blockers.includes('note-name-unavailable'))blockers.push('笔记没有可用的安全导出名')
    for(const row of prev?.rows.filter(r=>r.id!==mappingId&&allowed(r))??[]) {
      if(!chosen.some(x=>x.noteId===row.id))blockers.push('待重试源已不在本范围：'+row.source)
    }
    if(request.scope.kind==='project'&&(chosen.length||prev?.rows.some(r=>r.id===mappingId&&allowed(r)))) {
      const fallback=planWindowsExport({scope:'project',notes:[{noteId:':probe',sourceRelativePath:'placeholder.md',links:[]}],
        occupiedNames:occupied.names,maxNameUnits:255,remainingPathUnits:Math.max(0,32760-target.dir.length-1)}).mapping
      const map=diskPlan.mapping??fallback
      if(map?.status==='planned')rows.push({id:mappingId,source:'项目映射',name:'mapping.json',target:join(target.dir,map.fileName),
        reason:map.naming.length?'映射使用独立名称':'',status:'未开始'})
      else blockers.push('映射没有可用的安全导出名')
    }
    const full=[...(keep??[]),...rows]
    if(!full.some(r=>!r.settled&&r.target))blockers.push('没有可生成的剩余项')
    const plan:Plan={request,target,rows:full,blockers,fingerprint:sha(JSON.stringify([occupied.fingerprint,source.display.fingerprint,full.map(view)]))}
    return {plan,bytes:source.bytes}
  }
  preview(request:Request):Preview {
    this.previewed=undefined
    if(!this.target || request.target!==this.target.token)throw new Error('请重新选择目标目录')
    const {plan}=this.make(request,this.target.value)
    const id=randomUUID()
    this.previewed={id,plan}
    return {id,rows:plan.rows.map(view),blockers:plan.blockers}
  }
  release(id:string) {if(this.previewed?.id===id)this.previewed=undefined}
  confirm(id:string):Receipt {
    const saved=this.load(id)
    if(saved)return this.receipt(id)!
    if(this.active)throw new Error('已有导出正在运行')
    const pending=this.previewed
    if(!pending || pending.id!==id)throw new Error('预览已失效，请重新预览')
    this.previewed=undefined
    const {plan,bytes}=this.make(pending.plan.request,pending.plan.target)
    if(plan.fingerprint!==pending.plan.fingerprint||plan.blockers.length)throw new Error('源或目标已变化，请重新预览')
    const op:Operation={id, scope:plan.request.scope,target:plan.target,rows:plan.rows,phase:'已确认',stopping:false}
    this.db.transaction(()=>{
      if(plan.request.retry){
        const old=this.load(plan.request.retry)!
        old.superseded=id;this.write(old)
      }
      this.write(op)
    })()
    this.active=op
    setImmediate(()=>{if(!this.closing)void this.execute(op,bytes).catch(e=>console.error('无法写入 Markdown 导出账：',msg(e)))})
    return this.present(op)
  }
  private write(op:Operation) {
    this.db.prepare('INSERT INTO export_op VALUES (?,?) ON CONFLICT(id) DO UPDATE SET image=excluded.image').run(op.id,JSON.stringify(op))
  }
  private load(id?:string) {
    const r=(id?this.db.prepare('SELECT image FROM export_op WHERE id=?').get(id):
      this.db.prepare('SELECT image FROM export_op ORDER BY rowid DESC LIMIT 1').get()) as {image:string}|undefined
    return r?JSON.parse(r.image) as Operation:undefined
  }
  private present(op:Operation):Receipt {
    return {id:op.id,scope:op.scope,directory:op.target.dir,active:this.active?.id===op.id,stopping:op.stopping,
      phase:op.phase,rows:op.rows.map(view),canRetry:!this.active&&!op.superseded&&!op.rows.some(r=>r.status==='待核对') &&
        op.rows.some(r=>r.status==='失败'||r.status==='未开始')}
  }
  stop(id:string) {
    if(this.active?.id===id&&!this.active.stopping) {
      this.active.stopping=true
      this.active.phase='正在取消，已生成文件会保留'
      this.write(this.active)
    }
  }
  receipt(id?:string) {
    if(this.active && (!id||id===this.active.id))return this.present(this.active)
    const op=this.load(id)
    if(!op)return null
    this.audit(op)
    return this.present(op)
  }
  private probe(op:Operation,path:string) {
    this.assertTarget(op.target)
    const result=runManaged(0,path)
    if(result.parent!==op.target.parent)throw new Error('目标目录已变化')
    return result
  }
  private reconcile(op:Operation,row:Item) {
    if(row.settled)return
    if(!row.stage || !row.target)return
    try {
      const stage=this.probe(op,row.stage)
      const same=(c:ReturnType<typeof runManaged>)=>!!row.identity&&c.identity===row.identity&&!!c.bytes&&sha(c.bytes)===row.sha
      if(!row.armed) {
        row.status='未开始'
        if(stage.identity && !same(stage))row.check=row.stage+'：暂存身份没有写入账目，仍需检查'
      } else {
        // Probe the stage first. An occupied foreign final path is never adopted.
        if(same(stage)&&stage.stamp===row.stamp) {
          row.status='失败'
          let occupied=false
          try {lstatSync(row.target);occupied=true}catch{}
          row.reason=occupied?'目标在发布前已被占用，保留原目标':row.reason||'已核实未发布，仍在本操作暂存位置'
        } else if(!stage.identity&&same(this.probe(op,row.target))) {
          row.status='已生成';row.reason=''
        } else {
          row.status='待核对';row.reason='最终名与暂存无法按文件实体对账'
        }
      }
      if(row.status!=='待核对') {
        row.settled=true
        this.write(op)
        if(same(stage)&&stage.stamp===row.stamp)this.clean(op,row)
      }
    } catch(e) {
      row.status='待核对';row.reason=msg(e)
    }
  }
  private clean(op:Operation,row:Item) {
    try {
      this.assertTarget(op.target)
      if(!row.stage || !new RegExp('^\\.notes-export-'+op.id+'-[0-9a-f-]{36}\\.tmp$').test(basename(row.stage)))
        throw new Error('暂存名称不能证明属于此操作')
      cut('cleanup',op.id,row.id)
      runManaged(4,row.stage,op.target.parent,row.identity,row.stamp)
      row.check=undefined;this.write(op)
    } catch(e) {row.check=row.stage+'：仍需检查；'+msg(e)}
  }
  private audit(op:Operation) {
    for(const row of op.rows) {
      if(!row.settled)this.reconcile(op,row)
      // A crash between settling and cleaning may leave the proved stage.
      if(row.settled&&row.stage&&row.identity&&row.status!=='已生成')this.clean(op,row)
    }
    if(op.rows.some(r=>r.status==='待核对'))op.phase='中断或失败：请核对结果'
    else if(!['完成','取消完成','执行结束，存在未生成项'].includes(op.phase))
      op.phase='已核对中断结果'
    this.write(op)
  }
  private mapping(op:Operation) {
    const notes=op.rows.filter(r=>r.id!==mappingId)
    const destinations=new Map(notes.map(n=>[n.id,n]))
    return Buffer.from(JSON.stringify({operation:op.id,projectId:op.scope.id,notes:notes.map(n=>({
      sourceId:n.id,source:n.source,originalName:n.name,
      fileName:n.status==='已生成'&&n.target?basename(n.target):null,
      result:n.status,reason:n.status==='已生成'?null:n.reason||n.status,
      links:n.links?.map(link=>{
        const r=link.resolution
        if(r.kind!=='resolved')return link
        const dest=destinations.get(r.targetNoteId)
        return {raw:link.raw,resolution:{...r,kind:dest?.status==='已生成'?'generated':dest?'not-generated':'outside-scope',
          fileName:dest?.status==='已生成'&&dest.target?basename(dest.target):null,
          reason:dest&&dest.status!=='已生成'?dest.reason||dest.status:undefined}}
      })
    }))},null,2)+'\n','utf8')
  }
  private async execute(op:Operation,bytes:Map<string,Buffer>) {
    try {
      for(const row of op.rows) {
        if(this.closing)return
        if(op.stopping || op.rows.some(r=>r.status==='待核对'))break
        if(row.settled||!row.target)continue
        op.phase='正在处理 '+row.name
        try {
          this.assertTarget(op.target)
          const content=row.id===mappingId?this.mapping(op):bytes.get(row.id)
          if(!content || content.length>16*1024*1024)throw new Error('快照超出安全发布部件容量')
          row.stage=join(op.target.dir,'.notes-export-'+op.id+'-'+randomUUID()+'.tmp')
          row.sha=sha(content)
          this.write(op)
          const stage=runManaged(2,row.stage,op.target.parent,content)
          row.identity=stage.identity;row.stamp=stage.stamp
          if(!stage.bytes?.equals(content)||!row.identity||!row.stamp)throw new Error('暂存实读不符')
          this.write(op);cut('staged',op.id,row.id)
          row.armed=true;this.write(op);cut('armed',op.id,row.id)
          runManaged(1,row.stage,row.target,op.target.parent,op.target.parent,row.identity,row.stamp,content)
          cut('published',op.id,row.id)
          row.status='已生成';row.reason='';row.settled=true
          this.write(op);cut('receipt',op.id,row.id)
        } catch(e) {
          row.reason=(row.armed?'原子发布：':row.stage?'同卷暂存：':'准备发布：')+msg(e)
          if(row.stage)this.reconcile(op,row)
          if(row.status==='未开始'&&!row.armed) {
            row.status='失败';row.settled=true
          }
          this.write(op)
        }
        await new Promise<void>(resolve=>setTimeout(resolve,90))
      }
      if(this.closing)return
      op.phase=op.rows.some(r=>r.status==='待核对')?'请核对结果':op.stopping?'取消完成':
        op.rows.every(r=>r.status==='已生成'||r.status==='跳过')?'完成':'执行结束，存在未生成项'
      this.write(op)
    } finally {this.active=undefined}
  }
}
