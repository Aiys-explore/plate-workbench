import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import type Database from 'better-sqlite3'
import { DEFAULT_PROJECT } from '../shared/ipc'
import { sessionAdapters } from '../shared/sessions'
import { matchAgent, scanDelegation } from '../shared/delegation-markdown'
import { taskIdPattern } from '../shared/task-anchor'
import { projectColors, sessionKey, type Facts, type Ownership, type Preview, type ProjectFields, type Receipt,
  type Request, type SessionPlace, type SessionRef, type Subject, type TaskInfo, type TaskRef } from '../shared/p11'
import type { AgentStore } from './agents'
import type { NoteStore } from './notes'
import type { SessionService } from './session-logs/service'
import { defaultCodexLog } from './delegation-cli'
import { installBindingRevision, makeBindingCore, type Authority, type SessionKey } from './binding'
import { detachedProject, suggestOwnership, type Decision } from './ownership'
import { verifiedDirectory } from './p11-directory'
import { Journal, missing } from './p11-journal'
import { DeleteCoordinator, digest, subjectText } from './delete-coordinator'
import { captureFile, managedPlan } from './managed-delete-file'
import { deleteTaskRange } from './delete-task-range'
import type { Scope } from './delete-scope'
import { scanWiki } from '../shared/wiki-markdown'

const fingerprint=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const labels:Record<string,string>={
  'invalid-request':'身份无效', 'session-unverified':'无法唯一核实会话与登记的 Agent 档案', 'anchor-unverified':'无法唯一核实原任务锚点',
  'anchor-mismatch':'任务标记属于另一笔记', 'archived-target':'目标项目已归档', 'target-readonly':'任务不可写或有待处理草稿',
  'agent-mismatch':'会话档案与任务指令不符', 'target-occupied':'目标已有绑定', 'run-in-progress':'有活跃或待核对运行',
  'already-bound':'已绑定到该任务', 'already-unbound':'会话没有绑定', 'stale-preview':'原预览已失效，请重新读取',
  busy:'存储繁忙，请重新读取'
}
const reason=(code:string)=>labels[code] ?? '无法核对，请重新读取'
const same=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b
function inside(root:string,file:string) {
  try {
    if(!root)return false
    const r=relative(realpathSync.native(root),file)
    return r==='' || !isAbsolute(r) && r!=='..' && !/^\.\.[\\/]/.test(r)
  } catch { return false }
}
const uuid=(s:unknown):s is string=>typeof s==='string' && taskIdPattern.test(s)
const checkSession=(s:SessionRef)=> {
  if (!s || !sessionAdapters.includes(s.adapter) || typeof s.id!=='string' || !s.id.trim() || s.id.length>256 || /[\x00-\x1f]/.test(s.id))
    throw new Error('会话身份无效')
  return {adapter:s.adapter,id:s.id}
}
const checkTask=(t:TaskRef)=>{
  if (!t || !uuid(t.noteId) || !uuid(t.blockId)) throw new Error('任务身份无效')
  return {noteId:t.noteId,blockId:t.blockId}
}
type BindingRow = {localId:string;noteId:string;blockId:string;agentId:string;externalId:string}
type SessionFact={key:SessionKey;revision:string;cwd:string|null;status:string}
type LaunchSafe = {status:string;parentId:string|null}
type Entry={removeSignature?:string;owner:string;deadline:number;request:Request;key:string;sig?:string;binding?:{token:string;revision:string}}

export class P11 {
  private readonly journal:Journal
  private readonly epoch=randomUUID()
  private readonly core
  private readonly previews=new Map<string,Entry>()
  private facts?:ReturnType<P11['scan']>
  private observed?:Map<string,LaunchSafe>
  constructor(private db:Database.Database,private notes:NoteStore,private agents:AgentStore,private sessions:SessionService,private remove?:DeleteCoordinator) {
    installBindingRevision(db)
    db.exec(`CREATE TABLE IF NOT EXISTS p11_ownership (
      agent_id TEXT NOT NULL, external_id TEXT NOT NULL, independent_project TEXT, detached_unassigned INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL, PRIMARY KEY(agent_id,external_id)
    ) STRICT;`)
    this.journal=new Journal(db)
    const authority:Authority={
      session:k=>{
        const p=this.agents.delegationProfile(k.agentId)
        const fact=p && this.session({adapter:p.type as SessionRef['adapter'],id:k.externalId})
        if (!fact || fact.key.agentId!==k.agentId) return null
        if (!['DONE','REVIEW','PAUSED','ERROR'].includes(fact.status)) return null
        const selected=this.decision(k).decision
        const project=selected.kind==='manual-project'?this.notes.projectDetails().find(p=>p.id===selected.projectId):null
        return {...fact,revision:fingerprint([fact.revision,project])}
      },
      anchor:key=>{
        const scan=this.facts ?? this.scan()
        const item=scan.tasks.find(t=>t.noteId===key.noteId && t.blockId===key.blockId)
        if (!item || !item.identified || !scan.source.stable()) return null
        return {key,revision:item.revision,projectId:item.project.id,archived:item.project.archivedAt!==null,
          writable:item.writable,allowedAgentId:item.allowedAgent}
      }
    }
    this.core=makeBindingCore(db,authority,undefined,(id,result)=>{
      if(result.action==='unbind'){
        const key=this.db.prepare('SELECT agent_id agentId, external_id externalId FROM delegation_session WHERE id=?').get(result.sessionId) as SessionKey
        const {decision,revision}=this.decision(key)
        if(decision.kind==='manual-project' && !detachedProject(decision,this.projectEvidence(false))) {
          this.db.prepare('UPDATE p11_ownership SET detached_unassigned=1, revision=? WHERE agent_id=? AND external_id=?')
            .run(revision+1,key.agentId,key.externalId)
        }
      }
      this.journal.finish(id,{status:'saved',message:result.action==='unbind'?'已解除绑定':'已更新绑定'})
    })
  }

  setDeleteCoordinator(value:DeleteCoordinator){this.remove=value}
  project(id:string) {
    if(typeof id!=='string')throw new Error('项目身份无效')
    const found=this.notes.projectDetails().find(p=>p.id===id)
    if(!found)throw new Error('项目不存在')
    return found
  }
  private get observedSessions() {
    return this.observed ?? new Map(this.sessions.list().map(s=>[sessionKey(s),s]))
  }
  private session(input:SessionRef, observed=this.observedSessions):SessionFact|null {
    if (!sessionAdapters.includes(input.adapter)) return null
    const r=this.sessions.resumeRecord(input.adapter,input.id)
    const evidence=observed.get(sessionKey(input))
    if (!r || r.subagent || !evidence || evidence.parentId) return null
    const matches=this.agents.delegationProfiles().filter(p=>p.enabled && p.type===input.adapter)
      .flatMap(row=>{
        const p=this.agents.delegationProfile(row.id)
        if(!p)return []
        const root=p.logPath
        const source=inside(root,r.source) ||
          input.adapter==='codex' && same(root,defaultCodexLog()) && inside(join(dirname(root),'archived_sessions'),r.source) ||
          input.adapter==='zcode' && basename(root).toLowerCase()==='db.sqlite' && basename(dirname(root)).toLowerCase()==='db' &&
            inside(join(dirname(dirname(root)),'log'),r.source)
        return source?[p]:[]
      })
    if(matches.length!==1)return null
    const p=matches[0]!
    const stamp=this.decision({agentId:p.id,externalId:input.id}).revision
    const status=evidence.status
    return {key:{agentId:p.id,externalId:input.id},revision:fingerprint([r,p.id,p.revision,status,stamp]),cwd:r.cwd,status}
  }
  private rows():BindingRow[] {
    return this.db.prepare(`SELECT s.id localId,b.note_id noteId,b.id blockId,s.agent_id agentId,s.external_id externalId
      FROM delegation_binding link JOIN delegation_block b ON b.id=link.block_id JOIN delegation_session s ON s.id=link.session_id
      ORDER BY b.note_id,b.id`).all() as BindingRow[]
  }
  private binding(k:SessionKey):BindingRow|undefined {
    return this.db.prepare(`SELECT s.id localId,b.note_id noteId,b.id blockId,s.agent_id agentId,s.external_id externalId
      FROM delegation_session s JOIN delegation_binding link ON link.session_id=s.id
      JOIN delegation_block b ON b.id=link.block_id WHERE s.agent_id=? AND s.external_id=?`).get(k.agentId,k.externalId) as BindingRow|undefined
  }
  private decision(k:SessionKey):{decision:Decision;revision:number;suppressed:boolean} {
    const row=this.db.prepare('SELECT independent_project p, revision, detached_unassigned detached FROM p11_ownership WHERE agent_id=? AND external_id=?')
      .get(k.agentId,k.externalId) as {p:string|null;revision:number;detached:number}|undefined
    return {decision:!row?{kind:'undecided'}:row.p===null?{kind:'manual-unassigned'}:{kind:'manual-project',projectId:row.p},
      revision:row?.revision ?? 0,suppressed:row?.detached===1}
  }
  private projectEvidence(readRoots:boolean) {
    return this.notes.projectDetails().map(p=>({...p,root:readRoots?verifiedDirectory(p.root):null}))
  }
  private ownershipData(input:SessionRef,fact:SessionFact, rootEvidence=true):Ownership {
    const projects=this.notes.projectDetails()
    const b=this.binding(fact.key)
    const owner=b && this.notes.list().find(n=>n.id===b.noteId)
    const d=this.decision(fact.key)
    const read=suggestOwnership(rootEvidence?verifiedDirectory(fact.cwd):null,this.projectEvidence(rootEvidence),
      d.suppressed?{kind:'manual-unassigned'}:d.decision,b?{...b,projectId:owner?.projectId ?? null}:null)
    const p=projects.find(p=>p.id===read.effective.projectId)
    const sources={inherited:owner?'继承绑定任务所在项目':'绑定仍在；任务所属笔记待核对',manual:'人工选择',
      'manual-unassigned':d.suppressed?'解绑时原项目不可用，已回未归属':'明确保持未归属',undecided:'尚未选择'}
    const candidates=read.candidates.map(c=>({project:projects.find(p=>p.id===c.project.id)!,
      evidence:({exact:'与工作目录相同',ancestor:'工作目录位于项目根内','no-verified-root':'根目录未配置或不可读取',
        'no-verified-cwd':'观测工作目录不可核实','outside-root':'工作目录不在项目根内'})[c.evidence]}))
    const suggestion=({unique:'有一个建议。请人工选择。',choose:'有重叠或同根项目。请人工选择。',
      'no-match':'没有目录匹配。可人工选择。','unknown-cwd':'工作目录不可核实。可人工选择。'})[read.suggestion.kind]
    return {session:input,agentId:fact.key.agentId,cwd:fact.cwd,place:{projectId:read.effective.projectId,name:p?.name ?? '未归属',
      archived:!!p && p.archivedAt!==null,source:sources[read.effective.kind],bound:!!b,noteId:b?.noteId},suggestion,candidates}
  }
  ownership(input:SessionRef) {
    input=checkSession(input)
    const fact=this.session(input)
    if(!fact)throw new Error(reason('session-unverified'))
    return this.ownershipData(input,fact)
  }
  places() {
    const entries=Object.create(null) as Record<string,SessionPlace>
    const observed=this.observedSessions
    for(const key of observed.keys()){
      const [adapter,id]=JSON.parse(key) as [SessionRef['adapter'],string]
      const fact=this.session({adapter,id},observed)
      if(fact)entries[key]=this.ownershipData({adapter,id},fact,false).place
    }
    return entries
  }
  private scan() {
    const source=this.notes.delegationSources()
    const projects=this.notes.projectDetails()
    const summaries=this.notes.list()
    const profiles=this.agents.delegationProfiles()
    const bindings=this.rows()
    const files=[...source.files.values()].map(f=>({...f,scan:scanDelegation(f.disk.content),row:summaries.find(n=>n.path===f.path && n.id===f.noteId)}))
    const noteCounts=new Map<string,number>(), blockCounts=new Map<string,number>()
    for(const f of files){
      if(f.noteId)noteCounts.set(f.noteId,(noteCounts.get(f.noteId)??0)+1)
      for(const a of f.scan.anchors)blockCounts.set(a.blockId,(blockCounts.get(a.blockId)??0)+1)
    }
    const tasks=files.flatMap(f=>f.scan.anchors.flatMap(a=>{
      const row=f.row, project=projects.find(p=>p.id===row?.projectId), task=f.scan.taskAt(a.line)
      if(!row || !project)return []
      const unique=noteCounts.get(row.id)===1 && blockCounts.get(a.blockId)===1 && a.claimedNoteId===row.id &&
        task?.blockId===a.blockId && !task.issue
      const registered=this.db.prepare('SELECT note_id noteId FROM delegation_block WHERE id=?').get(a.blockId) as Pick<TaskRef,'noteId'>|undefined
      const identified=unique && (!registered || registered.noteId===row.id)
      let writable=false
      try {
        writable=!!identified && !!this.notes.p11Note(row.id,f.path,f.disk.revision)
        if(writable) {accessSync(f.path,constants.W_OK);accessSync(dirname(f.path),constants.W_OK)}
      } catch { writable=false }
      const match=task?.marker && matchAgent(profiles,task.marker.agent)
      const selector=task?.marker?.agent.toLowerCase()
      const eligibleAgents=profiles.filter(p=>p.enabled && (p.id===selector || p.type===selector)).map(p=>p.id)
      const allowedAgent=match && match.status==='matched'?match.profile.id:'unresolved'
      const binding=bindings.find(b=>b.blockId===a.blockId && b.noteId===row.id)
      const profile=binding && this.agents.delegationProfile(binding.agentId)
      return [{noteId:row.id,blockId:a.blockId,title:task?.text || task?.rawLine || '待定位任务',note:row.title,project,
        reason:!identified?'锚点无法唯一验证':!writable?'任务不可写或有草稿':project.archivedAt!==null?'目标项目已归档':
          binding?'目标已有绑定':allowedAgent==='unresolved'?'任务 Agent 档案无法唯一核实':'',
        ...(binding && {externalId:binding.externalId,agentId:binding.agentId}),
        ...(binding && profile && sessionAdapters.includes(profile.type as SessionRef['adapter']) &&
          {binding:{adapter:profile.type as SessionRef['adapter'],id:binding.externalId}}),
        identified,writable,allowedAgent,eligibleAgents,
        revision:fingerprint([f.disk.revision,project,p11Profile(profile),match && match.status==='matched' && p11Profile(this.agents.delegationProfile(match.profile.id))])}]
    })).sort((a,b)=>projects.indexOf(a.project)-projects.indexOf(b.project)||a.note.localeCompare(b.note))
    return {source,files,tasks,summaries,bindings,projects}
  }
  tasks(noteId?:string):TaskInfo[] {
    if(noteId!==undefined && !uuid(noteId))throw new Error('笔记身份无效')
    const s=this.scan()
    const result:TaskInfo[]=s.tasks.filter(t=>!noteId || t.noteId===noteId)
    for(const b of s.bindings){
      if(noteId && b.noteId!==noteId || result.some(t=>t.noteId===b.noteId && t.blockId===b.blockId))continue
      const note=s.summaries.find(n=>n.id===b.noteId)
      const project=s.projects.find(p=>p.id===note?.projectId) ?? s.projects.find(p=>p.id===DEFAULT_PROJECT)
      if(!project)continue
      const p=this.agents.delegationProfile(b.agentId)
      result.push({...b,title:'待定位的已绑任务',note:note?.title ?? b.noteId,project,reason:'锚点无法唯一验证',
        ...(p && sessionAdapters.includes(p.type as SessionRef['adapter']) && {binding:{adapter:p.type as SessionRef['adapter'],id:b.externalId}})})
    }
    return result
  }

  impact(subject:Subject):Facts {
    const scan=this.scan()
    const project=subject.kind==='project'?this.project(subject.id):null
    if (project?.id===DEFAULT_PROJECT)throw new Error('内置未归属不可移除')
    const note=subject.kind==='note'?scan.summaries.find(n=>n.id===subject.id):undefined
    const task=subject.kind==='task'?scan.tasks.find(t=>t.noteId===subject.task?.noteId && t.blockId===subject.task?.blockId):undefined
    const session=subject.kind==='session'?this.session(checkSession(subject.session)):null
    const sessionBound=session && this.binding(session.key)
    const id=project?.id ?? note?.id ?? task?.blockId ?? session?.key.externalId
    if(!id || !['note','project','task','session'].includes(subject.kind))throw new Error('无法核实目标身份')
    const notes=project?scan.summaries.filter(n=>n.projectId===project.id):note?[note]:[]
    const ids=new Set(notes.map(n=>n.id))
    const tasks=task?[task]:scan.tasks.filter(t=>ids.has(t.noteId))
    const bindings=subject.kind==='session'?(sessionBound?[sessionBound]:[]):scan.bindings.filter(b=>task?
      b.noteId===task.noteId && b.blockId===task.blockId:ids.has(b.noteId))
    const independents=project?(this.db.prepare(`SELECT o.agent_id agentId,o.external_id externalId FROM p11_ownership o
      WHERE o.independent_project=? AND o.detached_unassigned=0 AND NOT EXISTS (
        SELECT 1 FROM delegation_binding b JOIN delegation_session s ON s.id=b.session_id
        WHERE s.agent_id=o.agent_id AND s.external_id=o.external_id)`).all(project.id) as SessionKey[]):[]
    const references=this.notes.links().bindings.filter(b=>b.target && ids.has(b.target) && !ids.has(b.source))
    const keep=project?'笔记和任务移到未归属；原绑定保留并随任务移动。独立会话移到未归属。Markdown 与项目根保留。':
      subject.kind==='note'?'保留原始会话和日志；计划仅移除应用管理的目标 Markdown 并解除相关绑定。':
      subject.kind==='task'?'计划仅改写目标任务所在 Markdown，解除其绑定，保留外部会话、结论与其他任务。':
      '计划仅移除本地会话投影与绑定，保留任务、已写结论、外部日志。'
    const pinned=project?references.map(r=>'对下列笔记的引用保留：'+r.source+' → '+r.target):
      references.map(r=>'引用保留供核对：'+r.source+' → '+r.target)
    return {title:project?.name ?? note?.title ?? task?.title ?? '外部会话',id,
      counts:[{label:'项目',value:project?1:0},{label:'笔记',value:notes.length},
        {label:'已登记标记的任务',value:tasks.length},{label:'受影响绑定',value:bindings.length},
        {label:'独立会话',value:independents.length},{label:'受影响会话',value:session?1:bindings.length+independents.length},
        {label:'其他笔记的链接目标数',value:references.length}],
      details:[keep,...(project?[project.root||'未配置外部根目录']:[]),
        ...notes.map(n=>n.title+' · '+n.id+' · '+n.path),
        ...tasks.map(t=>t.title+' · '+t.blockId),
        ...bindings.map(b=>b.agentId+' / '+b.externalId+' → '+b.noteId+' / '+b.blockId),
        ...independents.map(s=>s.agentId+' / '+s.externalId),...pinned]}
  }

  removedRefs() {
    const indexes=this.notes.deleteDatabase()
    const project=indexes.prepare('SELECT id FROM m43_removed_project').all() as {id:string}[]
    const note=indexes.prepare('SELECT id FROM m43_removed_note').all() as {id:string}[]
    const task=this.db.prepare('SELECT note_id,block_id FROM m43_removed_anchor').all() as {note_id:string;block_id:string}[]
    const session=this.sessions.deleteDatabase().prepare('SELECT adapter,id FROM session_tombstone WHERE agent_id IS NOT NULL')
      .all() as {adapter:string;id:string}[]
    return [...project.map(p=>'project:'+p.id),...note.map(n=>n.id),
      ...task.map(t=>'task:'+t.note_id+':'+t.block_id),...session.map(s=>'session:'+s.adapter+':'+s.id)].map(x=>x.toLowerCase())
  }

  private removeImpact(input:Subject) {
    const scan=this.scan(), blocked:string[]=[]
    let subject:Subject,title:string,id:string,session:SessionFact|null=null
    let notes:typeof scan.summaries=[]
    let tasks:typeof scan.tasks=[]
    let refs:string[]=[]
    let file:{location:ReturnType<typeof captureFile>;path:string;next:Buffer|null}|undefined
    let detail:string[]=[]
    const t=input?.kind
    if(t==='project'){
      const p=this.project(input.id)
      if(p.id===DEFAULT_PROJECT)throw new Error('内置未归属不可移除')
      subject={kind:t,id:p.id};id=p.id;title=p.name
      notes=scan.summaries.filter(n=>n.projectId===id)
      detail=['Markdown 留在原位；项目根目录保留：'+(p.root||'未配置'),'笔记、任务和独立会话进入未归属，绑定保持。']
    }else if(t==='note'||t==='task'){
      const ref=t==='task'?checkTask(input.task):undefined
      const n=scan.summaries.find(n=>n.id===(ref?.noteId ?? ('id' in input ? input.id : '')))
      if(!n)throw new Error('无法核实笔记身份')
      notes=[n];id=ref?.blockId??n.id;title=n.title
      subject=t==='note'?{kind:t,id:n.id}:{kind:'task',task:ref!}
      const found=scan.files.filter(f=>f.path===n.path && (f.noteId===n.id || n.kind==='conflict' && f.row?.id===n.id))
      const f=found[0]
      if(t==='task'){
        tasks=scan.tasks.filter(x=>x.noteId===n.id&&x.blockId===id)
        if(tasks.length!==1||!tasks[0].identified)blocked.push('无法唯一核实任务锚点')
        else title=tasks[0].title
      }
      detail=[(t==='note'?'拟移除目标 Markdown：':'拟仅改写任务范围：')+n.path,
        '解除相关绑定；会话、原日志、委派历史和现有冲突副本保留。']
      try{
        if(found.length!==1 || !f || n.kind!=='note' && t==='note')throw new Error('不能证明文件为目标受管笔记')
        const next=t==='task'?deleteTaskRange(f.disk.content,n.id,id):null
        if(next)detail.push('源字节 ['+next.start+', '+next.stop+')：\n'+next.removed)
        file={path:n.path,location:captureFile(n.path,f.disk.bytes),next:next?.bytes??null}
      }catch(e){blocked.push(e instanceof Error?e.message:String(e))}
    }else if(t==='session'){
      const ref=checkSession(input.session)
      subject={kind:t,session:ref};id=ref.id;title='外部会话 '+ref.adapter
      session=this.session(ref)
      if(!session)blocked.push(reason('session-unverified'))
      else if(!['DONE','REVIEW','ERROR'].includes(session.status))
        blocked.push('会话活跃、暂停或终态无法核实')
      detail=['仅移除本地会话；保持 Markdown、任务、历史和 Agent 日志。',
        '登记 Agent：'+(session?.key.agentId??'未核实')+' / 外部 ID：'+ref.id]
    }else throw new Error('未知移除对象')
    const noteIds=notes.map(n=>n.id).sort(), noteSet=new Set(noteIds)
    if(t==='project'||t==='note')tasks=scan.tasks.filter(x=>noteSet.has(x.noteId))
    if(t==='note' && !scan.files.some(f=>f.row?.id===id && f.scan.anchors.length===tasks.length))blocked.push('无法完整核对笔记的任务锚点')
    if(tasks.some(x=>!x.identified))blocked.push('受影响笔记有无法唯一定位的任务')
    const bindings=t==='session'?(session?scan.bindings.filter(b=>b.agentId===session!.key.agentId&&b.externalId===id):[]):
      scan.bindings.filter(b=>t==='task'?b.noteId===noteIds[0]&&b.blockId===id:noteSet.has(b.noteId))
    if(t==='session') for(const b of bindings) {
      if(!noteIds.includes(b.noteId))noteIds.push(b.noteId)
    }
    const indexedBlocks=(t==='project'||t==='note') ?
      (this.db.prepare('SELECT id FROM delegation_block WHERE note_id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(noteIds)) as {id:string}[]).map(r=>r.id):[]
    const blocks=[...new Set([...tasks.map(x=>x.blockId),...indexedBlocks,...bindings.map(b=>b.blockId)])].sort()
    const scope:Scope={subject,notes:noteIds,blocks,agent:session?.key.agentId,at:Date.now()}
    if(t==='session'&&!session)return {subject,scope,steps:[],file,facts:{title,id,counts:[{label:'会话',value:null}],details:detail},signature:'',blocked:blocked.join('；')}
    const steps=this.remove!.capture(scope)
    const index=steps.find(s=>s.owner==='index')?.old
    const delegation=steps.find(s=>s.owner==='delegation')?.old
    const independent=delegation?.p11_ownership??[]
    if(t==='project'){
      const indexNotes=index?.note??[]
      const actual=scan.files.filter(f=>f.row?.projectId===id || !f.row && dirname(f.path)===this.notes.projectFolder(id))
      if(indexNotes.length!==notes.length || actual.some(f=>!f.row) || notes.some(n=>!actual.some(f=>f.path===n.path)))
        blocked.push('磁盘与项目索引尚未对齐')
    }
    if((t==='note'||t==='task')&&(index?.note_draft?.length??0)>0)
      blocked.push('有本地恢复稿；请先在 P03 保存或放弃，再重新读取')
    if((index?.note_draft_copy??[]).some(r=>!r.copy_id))
      blocked.push('有待整理的冲突副本；请先完成 P03 核对')
    if((delegation?.delegation_run??[]).some(r=>!['finished','cancelled'].includes(String(r.phase))) ||
        (delegation?.p10_write??[]).some(r=>r.state!=='written' && !!r.staged))
      blocked.push(reason('run-in-progress'))
    const sessionEvidence:unknown[]=[]
    for(const b of bindings){
      const p=this.agents.delegationProfile(b.agentId)
      const observed=p && this.observedSessions.get(sessionKey({adapter:p.type as SessionRef['adapter'],id:b.externalId}))
      const fact=p&&observed&&this.session({adapter:p.type as SessionRef['adapter'],id:b.externalId})
      sessionEvidence.push([b.agentId,b.externalId,p?.revision,fact])
      if(!fact || fact.key.agentId!==b.agentId || !['DONE','REVIEW','ERROR'].includes(fact.status))
        blocked.push('受影响绑定含活跃或未核实终态的会话')
    }
    for(const r of independent){
      const p=this.agents.delegationProfile(String(r.agent_id))
      const observed=p && this.observedSessions.get(sessionKey({adapter:p.type as SessionRef['adapter'],id:String(r.external_id)}))
      const fact=p&&observed&&this.session({adapter:p.type as SessionRef['adapter'],id:String(r.external_id)})
      sessionEvidence.push([r.agent_id,r.external_id,p?.revision,fact])
      if(t==='project'&&(!fact || fact.key.agentId!==r.agent_id || !['DONE','REVIEW','ERROR'].includes(fact.status)))
        blocked.push('项目存在活跃或未核实终态的会话归属')
    }
    if(t==='session'&&session&&(!steps.find(s=>s.owner==='sessions')?.old.agent_session?.length ||
       !steps.find(s=>s.owner==='agents')?.old.agent_profile?.length))blocked.push('会话归属库未对齐')
    const links=this.notes.links()
    const explicit=t==='project'?'project:'+id:t==='task'?'task:'+noteIds[0]+':'+id:
      subject.kind==='session'?'session:'+subject.session.adapter+':'+id:null
    for(const f of scan.files){
      if(!f.row || t==='note'&&f.row.id===id)continue
      const {links:positions,references}=scanWiki(f.disk.content,true)
      const matches=(ref:string)=>explicit!==null ? ref===explicit.toLowerCase() :
        ref===id || links.bindings.some(b=>b.source===f.row!.id&&b.target===id&&b.ref===ref)
      const targets=positions.filter(x=>matches(x.ref))
      if([...references].some(ref=>matches(ref)&&!targets.some(x=>x.ref===ref)))blocked.push('无法完整定位全部引用')
      for(const x of targets)refs.push(f.row.title+' · '+f.row.id+' @ '+x.from+' → '+x.label+' · '+(explicit??id)+'（保留，移除后失效）')
    }
    refs=[...new Set(refs)].sort()
    if(!scan.source.stable())blocked.push('读取时 Markdown 发生变化')
    detail=[...detail,...notes.map(n=>(t==='project'?'移到未归属：':'所在笔记：')+n.title+' · '+n.id+' · '+n.path),
      ...tasks.map(x=>(t==='project'?'保留任务：':'拟移除任务：')+x.title+' · '+x.noteId+' / '+x.blockId),
      ...indexedBlocks.filter(b=>!tasks.some(x=>x.blockId===b)).map(b=>'历史记录保留 · 已登记锚点 '+b),
      ...bindings.map(b=>(t==='project'?'保留绑定：':'解除绑定：')+b.agentId+' / '+b.externalId+' → '+b.noteId+' / '+b.blockId),
      ...independent.map(s=>'人工归属：'+s.agent_id+' / '+s.external_id+' → '+(t==='project'?'未归属':'清除本地归属')),
      ...refs,'保留外部目录、Agent 原始日志和已写入的独立结论。']
    const facts:Facts={title,id,counts:[{label:'移除项目',value:t==='project'?1:0},
      {label:'移除笔记',value:t==='note'?1:0},{label:'移到未归属的笔记',value:t==='project'?notes.length:0},
      {label:'移除任务',value:t==='project'?0:t==='note'?tasks.length:t==='task'?(tasks.length||null):0},
      {label:'保留并随项目迁移的任务',value:t==='project'?tasks.length:0},{label:'明确移除会话',value:t==='session'?(session?1:null):0},
      {label:'受影响绑定',value:bindings.length},{label:'人工会话归属记录',value:independent.length},
      {label:'其他笔记引用位置',value:refs.length},{label:'新增会话墓碑',value:t==='session'?(session?1:null):0}],details:detail}
    // Compare full live source inventory: includes revisions even when labels,
    // number of notes, references and resulting bytes would appear unchanged.
    const signature=digest([subject,steps.map(s=>s.old),facts,session,sessionEvidence,file?.location,
      scan.files.map(f=>[f.path,f.disk.revision]),bindings,this.db.prepare('SELECT revision FROM delegation_binding_revision').get()])
    return {subject,scope,steps,file,facts,signature,blocked:[...new Set(blocked)].join('；')||undefined}
  }
  private inspect(input:Request) {
    if(input.type==='project'){
      const base=input.id===undefined?undefined:this.project(input.id)
      if(base && (base.id===DEFAULT_PROJECT || base.revision!==input.revision))throw new Error('项目版本已变化，请重新读取')
      const f=input.fields
      if(!f || typeof f.name!=='string' || !f.name.trim() || f.name.length>120 || /[\r\n\0]/.test(f.name))throw new Error('名称：请输入 1–120 个字符的单行项目名称')
      if(typeof f.root!=='string')throw new Error('根目录：输入无效')
      const root=verifiedDirectory(f.root.trim())
      if(f.root.trim() && !root)throw new Error('根目录：请输入可读取的 Windows 绝对目录')
      if(typeof f.color!=='string' || !Object.hasOwn(projectColors,f.color))throw new Error('颜色：请选择有效颜色')
      const fields:ProjectFields={name:f.name.trim(),root:root?.canonicalWindowsPath ?? '',color:f.color}
      return {sig:fingerprint([base,fields]),fields,action:base?'保存项目':'创建项目'}
    }
    if(input.type==='archive'){
      const p=this.project(input.id)
      if(p.id===DEFAULT_PROJECT || p.revision!==input.revision || typeof input.archived!=='boolean' ||
          input.archived===(p.archivedAt!==null))throw new Error('项目状态已变化，请重新读取')
      const facts=this.impact({kind:'project',id:p.id})
      facts.details[0]=input.archived?'移入归档视图。笔记、任务和会话保留所有归属及绑定。':'回到活动视图。既有归属和绑定不变。'
      return {sig:fingerprint([p,facts]),action:input.archived?'归档项目':'恢复项目',facts}
    }
    if(input.type==='ownership'){
      const ref=checkSession(input.session), fact=this.session(ref)
      if(!fact)throw new Error(reason('session-unverified'))
      if(this.binding(fact.key))throw new Error('已继承任务归属；先解除绑定')
      const p=input.projectId===null?null:this.project(input.projectId)
      if(p && (p.id===DEFAULT_PROJECT || p.archivedAt!==null))throw new Error('请选择活动项目或保持未归属')
      return {sig:fingerprint([fact,p]),fact,action:'确认归属',session:ref,cwd:fact.cwd,agentId:fact.key.agentId,
        destination:p?p.name+' · '+p.id:'保持未归属'}
    }
    throw new Error('未知请求')
  }
  preview(owner:string,input:Request):Preview {
    if(!input || typeof input!=='object')throw new Error('无效预览')
    const now=Date.now()
    for(const [k,v] of this.previews)if(v.deadline<=now)this.cancel(v.owner,k)
    if(this.previews.size>=128){const [k,v]=this.previews.entries().next().value!;this.cancel(v.owner,k)}
    const token=randomUUID(), deadline=now+5*60_000
    if(input.type==='binding'){
      const session=checkSession(input.session),target=input.target===null?null:checkTask(input.target)
      this.observed=this.observedSessions
      try {
        const fact=this.session(session)
        if(!fact)throw new Error(reason('session-unverified'))
        if(!['DONE','REVIEW','PAUSED','ERROR'].includes(fact.status))throw new Error('会话仍活跃或状态未知，不能变更绑定')
        this.facts=this.scan()
        const r=this.core.preview({session:fact.key,target})
        if(!r.ok)throw new Error(reason(r.code))
        const location=(x:typeof r.source)=>x && {project:this.project(x.projectId).name+' · '+x.projectId,...x.key,revision:x.revision}
        const undo=detachedProject(this.decision(fact.key).decision,this.projectEvidence(false))
        this.previews.set(token,{owner,deadline,request:{type:'binding',session,target},key:'session:'+JSON.stringify(fact.key),
          binding:{token:r.previewId,revision:r.revision}})
        return {token,action:r.action==='bind'?'确认绑定':r.action==='migrate'?'确认迁移':'解除绑定',
          session,cwd:fact.cwd,agentId:fact.key.agentId,source:location(r.source),target:location(r.target),
          destination:target?undefined:undo?this.project(undo).name+' · '+undo:'未归属'}
      } finally {this.facts=undefined;this.observed=undefined}
    }
    if(input.type==='remove'){
      if(!this.remove)throw new Error('工作区删除协调账未启用')
      const p=this.removeImpact(input.subject)
      this.previews.set(token,{owner,deadline,request:input,key:JSON.stringify(p.subject),removeSignature:p.signature})
      return {token,action:'移除'+subjectText(p.subject),facts:p.facts,blocked:p.blocked,affectedNotes:p.scope.notes}
    }
    const snapshot=this.inspect(input)
    const key=input.type==='ownership'?'session:'+JSON.stringify(snapshot.fact!.key):'project:'+(input.id ?? 'new')
    this.previews.set(token,{owner,deadline,request:input,key,sig:snapshot.sig})
    const {sig:_sig,fields:_fields,fact:_fact,...preview}=snapshot
    return {token,...preview}
  }
  cancel(owner:string,token:string) {
    const v=this.previews.get(token)
    if(!v || owner!==v.owner)return
    this.previews.delete(token)
    if(v.binding)this.core.cancel(v.binding.token)
  }
  receipt(id:string):Receipt {
    if(!uuid(id))throw new Error('操作 ID 无效')
    const records=[this.remove?.status(id),this.notes.projectJournal.get(id),this.journal.get(id)]
    const r=records.find(x=>x)
    if(r)return r
    if(records.includes(null))return {status:'missing',message:'操作仍未确认。请先核对或重启；不要重复提交。'}
    return missing
  }
  confirm(owner:string,token:string,id:string):Receipt {
    if(!uuid(token) || !uuid(id))throw new Error('核对凭据无效')
    const entry=this.previews.get(token)
    const exact=fingerprint([this.epoch,owner,token])
    const prior=this.remove?.get(id)
    if(prior)return prior.key===exact ? this.remove!.status(id)! : {status:'unchanged',message:'操作 ID 已属于另一份请求。'}
    this.remove?.assertOpen()
    if(entry && owner!==entry.owner)return {status:'unchanged',message:'预览不属于当前窗口'}
    const identity=[this.notes.projectJournal.identity(id),this.journal.identity(id)].find(x=>x)
    if(identity) {
      const saved=identity.request?.split(':')[0]
      if(saved!==exact)return {status:'unchanged',message:'操作 ID 已属于另一份请求；没有提交本次预览。'}
      return this.receipt(id)
    }
    if(!entry || Date.now()>=entry.deadline)return {status:'unchanged',message:'原预览已失效，请重新读取'}
    this.notes.assertIndexReady()
    this.previews.delete(token)
    const input=entry.request
    if(input.type==='remove'){
      const removal=this.remove!
      let p:ReturnType<P11['removeImpact']>, file
      try{
        p=this.removeImpact(input.subject)
        if(p.blocked || p.signature!==entry.removeSignature)
          throw new Error(p.blocked||'精确影响、版本或文件身份发生变化')
        if(p.file)file=managedPlan(p.file.location,p.file.path,removal.staging,id,p.file.next)
      }catch(e){
        return removal.stale(id,exact,{subject:input.subject,notes:[],blocks:[],at:Date.now()},
          '影响预览已过期，请重新读取：'+(e instanceof Error?e.message:String(e)))
      }
      const r=removal.commit(id,exact,p.scope,p.steps,file??null)
      if(r.status==='saved'){this.sessions.invalidateDeletion();this.notes.rescanAfterRemoval()}
      return r
    }
    const journal=input.type==='project' || input.type==='archive'?this.notes.projectJournal:this.journal
    journal.start(id,entry.key,exact+':'+fingerprint([entry.request,entry.sig,entry.binding]))
    const stop=(text:string)=>journal.finish(id,{status:'unchanged',message:text})
    try {
      if(input.type==='binding' && entry.binding){
        this.observed=this.observedSessions
        this.facts=this.scan()
        const r=this.core.confirm({previewId:entry.binding.token,revision:entry.binding.revision,confirmed:true,operation:id})
        return r.ok?this.receipt(id):stop(reason(r.code))
      }
      if(input.type==='project' || input.type==='archive'){
        const verify=()=>{try{return this.inspect(input).sig===entry.sig}catch{return false}}
        if(!verify())return stop('项目或影响已变化，请重新读取')
        return this.notes.projectWrite(input.id,input.revision,input.type==='project'?this.inspect(input).fields:undefined,
          input.type==='archive'?input.archived:undefined,id,verify)
      }
      if(input.type==='ownership')return this.db.transaction(()=>{
        let now
        try {now=this.inspect(input)} catch {return stop('会话或项目已变化，请重新读取')}
        if(now.sig!==entry.sig)return stop('会话或项目已变化，请重新读取')
        const k=now.fact!.key
        this.db.prepare(`INSERT INTO p11_ownership VALUES(?,?,?,0,1)
          ON CONFLICT(agent_id,external_id) DO UPDATE SET independent_project=excluded.independent_project,
          detached_unassigned=0,revision=revision+1`).run(k.agentId,k.externalId,input.projectId)
        return journal.finish(id,{status:'saved',message:'已保存会话归属。'})
      }).immediate()
      return stop('无效操作')
    } catch (e) {
      console.error('P11 transaction rolled back',e)
      const actual=journal.get(id)
      if(actual)return actual
      return stop('事务未提交，请重新读取。')
    } finally {
      this.facts=undefined
      this.observed=undefined
      if(entry.binding)this.core.cancel(entry.binding.token)
    }
  }
}
const p11Profile=(p:ReturnType<AgentStore['delegationProfile']>|undefined)=>p && [p.id,p.revision]

