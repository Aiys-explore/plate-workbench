
import Database from 'better-sqlite3'
import { localSqlitePath } from './local-sqlite-path'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Receipt, Subject } from '../shared/p11'
import { before, after, readOwner, writeOwner, ownerNames, type Owner, type Rows, type Scope } from './delete-scope'
import { type ManagedFilePlan, type FileImage, filePhase, prepareReplacement, stageOriginal, installReplacement, restoreOriginal } from './managed-delete-file'

export const digest=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
type Step={owner:Owner; dbId:string; old:Rows; next:Rows}
type Plan={id:string;scope:Scope;steps:Step[];file:ManagedFilePlan|null}
type State='preparing'|'staging'|'forward'|'manual'|'committed'|'rolled-back'|'rejected'
type RecordRow={id:string;key:string;plan:string;sha:string;state:State;file_image:string|null;detail:string}
const pending="state IN ('preparing','staging','forward','manual')"
const valid=(id:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
const reject=(message:string):Receipt=>({status:'unchanged',message})
function trustedDir(path:string) {
  return lstatSync(path).isDirectory() && realpathSync.native(path).toLowerCase()===resolve(path).toLowerCase()
}
function verifyDb(file:string) {
  for(const suffix of ['','-wal','-shm','-journal']){
    const stat=lstatSync(file+suffix,{throwIfNoEntry:false})
    if(stat && (!stat.isFile() || stat.nlink!==1 || realpathSync.native(file+suffix).toLowerCase()!==resolve(file+suffix).toLowerCase()))
      throw new Error('工作区数据库不是可核对的本地文件：'+file+suffix)
  }
}
export function openDeleteStores(root:string,userData:string) {
  mkdirSync(root,{recursive:true});mkdirSync(userData,{recursive:true})
  if(!trustedDir(root)||!trustedDir(userData))throw new Error('工作区或档案目录身份无法核实')
  const dbs={index:join(root,'index.sqlite'),delegation:join(root,'delegation.sqlite'),
    sessions:join(userData,'sessions.sqlite'),agents:join(userData,'agents.sqlite')}
  for(const p of Object.values(dbs))verifyDb(p)
  const file=join(root,'m43-delete.sqlite'), gateFile=join(root,'m43-gate.sqlite')
  verifyDb(file);verifyDb(gateFile)
  const gate=new Database(localSqlitePath(gateFile),{timeout:1000})
  let opened:Database.Database|undefined
  try{
    gate.exec('BEGIN EXCLUSIVE')
    const existed=existsSync(file)
    const db=opened=new Database(localSqlitePath(file),{timeout:1000})
    db.pragma('journal_mode = WAL');db.pragma('synchronous = FULL')
    if(!existed){
      for(const p of Object.values(dbs)){
        if(!existsSync(p))continue
        const prior=new Database(localSqlitePath(p),{readonly:true,fileMustExist:true})
        try{if(prior.prepare("SELECT 1 FROM sqlite_schema WHERE name='m43_owner'").get())
          throw new Error('已登记工作区的协调账缺失，拒绝重建')}finally{prior.close()}
      }
      db.exec("CREATE TABLE m43_workspace (id TEXT PRIMARY KEY, stores TEXT NOT NULL, ready INTEGER NOT NULL);"+
        "CREATE TABLE m43_operation(id TEXT PRIMARY KEY,key TEXT NOT NULL,plan TEXT NOT NULL,sha TEXT NOT NULL,state TEXT NOT NULL,file_image TEXT,detail TEXT NOT NULL);"+
        "CREATE UNIQUE INDEX m43_single_pending ON m43_operation((1)) WHERE "+pending+";"+
        "CREATE TRIGGER m43_no_delete BEFORE DELETE ON m43_operation BEGIN SELECT RAISE(ABORT,'immutable operation');END;"+
        "CREATE TRIGGER m43_plan_fixed BEFORE UPDATE OF id,key,plan,sha ON m43_operation BEGIN SELECT RAISE(ABORT,'immutable plan');END;")
      db.prepare('INSERT INTO m43_workspace VALUES (?,?,0)').run(randomUUID(),JSON.stringify(dbs))
    }
    const row=db.prepare('SELECT * FROM m43_workspace').get() as {id:string;stores:string;ready:number}|undefined
    if(!row || row.stores!==JSON.stringify(dbs))throw new Error('删除协调账与当前工作区不匹配')
    if(row.ready && Object.values(dbs).some(p=>!existsSync(p)))throw new Error('工作区登记库缺失；需要恢复')
    return {db,gate,root,dbs,id:row.id,ready:!!row.ready}
  }catch(e){try{opened?.close()}finally{gate.close()}throw e}
}
type Enrollment=ReturnType<typeof openDeleteStores>
export class DeleteCoordinator {
  readonly staging:string
  private readonly db
  private readonly ids={} as Record<Owner,string>
  constructor(private readonly enrollment:Enrollment,private readonly dbs:Record<Owner,Database.Database>,private readonly cut:(point:string,id:string)=>void=()=>{}) {
    this.db=enrollment.db
    this.staging=join(enrollment.root,'.workbench-removed')
    mkdirSync(this.staging,{recursive:true})
    if(!trustedDir(this.staging))throw new Error('受管隔离目录无法核实')
    for(const name of ownerNames){
      const db=dbs[name];db.pragma('synchronous = FULL');db.pragma('foreign_keys = ON')
      db.transaction(()=>{
        const registered=db.prepare("SELECT 1 FROM sqlite_schema WHERE name='m43_owner'").get()
        if(!registered){
          if(enrollment.ready)throw new Error('删除协调账参与库身份丢失：'+name)
          db.exec("CREATE TABLE m43_owner(workspace TEXT PRIMARY KEY,id TEXT NOT NULL,name TEXT NOT NULL);"+
            "CREATE TABLE m43_receipt(id TEXT PRIMARY KEY,proof TEXT NOT NULL,at INTEGER NOT NULL);"+
            "CREATE TRIGGER m43_receipt_fixed BEFORE UPDATE ON m43_receipt BEGIN SELECT RAISE(ABORT,'immutable receipt');END;"+
            "CREATE TRIGGER m43_receipt_keep BEFORE DELETE ON m43_receipt BEGIN SELECT RAISE(ABORT,'immutable receipt');END;")
          db.prepare('INSERT INTO m43_owner VALUES (?,?,?)').run(enrollment.id,randomUUID(),name)
        }
        const owners=db.prepare('SELECT * FROM m43_owner').all() as {workspace:string;id:string;name:string}[]
        if(owners.length!==1 || owners[0].workspace!==enrollment.id || owners[0].name!==name)throw new Error('参与库已属于其他协调账：'+name)
        this.ids[name]=owners[0].id
      }).immediate()
    }
    if(!enrollment.ready)this.db.prepare('UPDATE m43_workspace SET ready=1 WHERE id=?').run(enrollment.id)
  }
  capture(scope:Scope){
    return ownerNames.map(owner=>{
      const old=before(this.dbs[owner],owner,scope)
      return {owner,dbId:this.ids[owner],old,next:after(owner,scope,old)}
    }).filter(step=>Object.keys(step.old).length)
  }
  get(id:string){
    return this.db.prepare('SELECT * FROM m43_operation WHERE id=?').get(id) as RecordRow|undefined
  }
  blocked() {
    return this.db.prepare('SELECT id,detail,state FROM m43_operation WHERE '+pending).get() as Pick<RecordRow,'id'|'detail'|'state'>|undefined
  }
  assertOpen(){
    const row=this.blocked()
    if(row)throw new Error('工作区删除结果待核对 · 操作 ID '+row.id+' · '+(row.detail||row.state))
  }
  status(id:string):Receipt|undefined{
    const row=this.get(id)
    if(!row)return undefined
    if(row.state==='committed'){
      const plan=this.decode(row)
      return {status:'saved',message:'已核实移除和持久回执。',removed:plan.scope.subject}
    }
    if(row.state==='rolled-back'||row.state==='rejected')return reject(row.detail)
    return {status:'missing',message:'结果未确认 · '+row.state+' · '+row.detail}
  }
  stale(id:string,key:string,scope:Scope,message:string){
    const plan:Plan={id,scope,steps:[],file:null}
    this.db.prepare('INSERT INTO m43_operation VALUES (?,?,?,?,?,?,?)').run(id,key,JSON.stringify(plan),digest(plan),'rejected',null,message)
    return this.status(id)!
  }
  commit(id:string,key:string,scope:Scope,steps:Step[],file:ManagedFilePlan|null):Receipt{
    this.assertOpen()
    this.cut('before-journal',id)
    const plan:Plan={id,scope,steps,file}
    this.db.prepare('INSERT INTO m43_operation VALUES (?,?,?,?,?,?,?)').run(id,key,JSON.stringify(plan),digest(plan),'preparing',null,'已登记，未移出原件')
    this.cut('after-journal',id)
    try{
      if(!steps.every(s=>this.inspect(plan,s)==='old'))throw new Error('参与库版本已变化')
      const staged=file ? prepareReplacement(file) : null
      this.cut('after-prepare-file',id)
      this.db.prepare("UPDATE m43_operation SET state='staging',file_image=?,detail=? WHERE id=?").run(JSON.stringify(staged),'原件处于暂存阶段',id)
      this.cut('before-stage',id)
      if(file)stageOriginal(file,staged)
      this.cut('after-stage',id)
      if(file&&filePhase(file,staged)!=='staged')throw new Error('暂存尚未核实')
      if(!steps.every(s=>this.inspect(plan,s)==='old'))throw new Error('暂存后参与库不再匹配')
      this.cut('before-decision',id)
      this.state(id,'forward','前滚决定已保存；正在对账文件与参与库')
      this.cut('after-decision',id)
      return this.recover(id)!
    }catch(e){
      this.detail(id,e);return this.status(id)!
    }
  }
  private decode(row:RecordRow):Plan{
    const p=JSON.parse(row.plan) as Plan
    if(digest(p)!==row.sha || p.id!==row.id || !valid(p.id) ||
       p.steps.some(s=>!ownerNames.includes(s.owner)||this.ids[s.owner]!==s.dbId) ||
       p.file && (p.file.backup!==join(this.staging,p.id+'.original') ||
         p.file.replacement!==join(this.staging,p.id+'.replacement')))
      throw new Error('操作计划、参与库身份或隔离范围不符')
    return p
  }
  private proof(p:Plan,s:Step){return digest([digest(p),p.id,p.scope.subject,s])}
  private inspect(p:Plan,s:Step){
    const db=this.dbs[s.owner]
    const receipt=db.prepare('SELECT proof FROM m43_receipt WHERE id=?').get(p.id) as {proof:string}|undefined
    const now=readOwner(db,s.owner,p.scope,s.old)
    if(receipt)return receipt.proof===this.proof(p,s) && same(now,s.next)?'next':'unverified'
    return same(now,s.old)?'old':'unverified'
  }
  private state(id:string,state:State,detail:string){
    this.db.prepare('UPDATE m43_operation SET state=?,detail=? WHERE id=?').run(state,detail,id)
  }
  private detail(id:string,e:unknown){
    this.db.prepare('UPDATE m43_operation SET detail=? WHERE id=?').run(e instanceof Error?e.message:String(e),id)
  }
  recover(id:string):Receipt|undefined{
    const row=this.get(id)
    if(!row || !['preparing','staging','forward'].includes(row.state))return this.status(id)
    try{
      const p=this.decode(row), f=p.file
      const staged=row.file_image ? JSON.parse(row.file_image) as FileImage|null : null
      const phases=p.steps.map(s=>this.inspect(p,s))
      if(phases.includes('unverified') || phases.some((x,i)=>x==='next'&&phases.slice(0,i).includes('old')))
        throw new Error('参与库记录或回执不符；需要人工核对')
      const phase=f?filePhase(f,staged):null
      if(row.state!=='forward'){
        if(phases.includes('next') || phase==='installed' || row.state==='preparing' && phase==='staged')
          throw new Error('无前滚决定，但发现不可归属的变更')
        this.cut('before-restore',id)
        if(f&&phase==='staged')restoreOriginal(f)
        this.cut('after-restore',id)
        if(f&&filePhase(f,staged)!=='original')throw new Error('原文件未能核实复位')
        this.state(id,'rolled-back','已核实未提交，原件在原位。请重新预览。')
        return this.status(id)
      }
      if(f&&(!phase || phase==='original' || (f.next!==null)!==!!staged))
        throw new Error('前滚决定与文件阶段不符')
      this.cut('before-install',id)
      if(f&&staged&&phase==='staged')installReplacement(f,staged)
      this.cut('after-install',id)
      if(f&&filePhase(f,staged)!==(staged?'installed':'staged'))throw new Error('未核实文件终态')
      p.steps.forEach((step,i)=>{
        if(phases[i]==='next')return
        const db=this.dbs[step.owner]
        this.cut('before-owner:'+step.owner,id)
        db.transaction(()=>{
          if(this.inspect(p,step)!=='old')throw new Error('参与库旧状态已改变：'+step.owner)
          writeOwner(db,step.owner,p.scope,step.old)
          this.cut('after-data:'+step.owner,id)
          if(!same(readOwner(db,step.owner,p.scope,step.old),step.next))throw new Error('参与库未达到预期状态：'+step.owner)
          db.prepare('INSERT INTO m43_receipt VALUES (?,?,?)').run(id,this.proof(p,step),Date.now())
          this.cut('before-owner-commit:'+step.owner,id)
        }).immediate()
        this.cut('after-owner-commit:'+step.owner,id)
      })
      if(!p.steps.every(s=>this.inspect(p,s)==='next') || f&&filePhase(f,staged)!==(staged?'installed':'staged'))
        throw new Error('最终核对未完成')
      this.cut('before-final',id)
      this.state(id,'committed','已核实所有参与库与文件')
      this.cut('after-final',id)
    }catch(e){
      this.state(id,'manual',e instanceof Error?e.message:String(e))
    }
    return this.status(id)
  }
  startup(){
    const p=this.blocked()
    if(p)this.recover(p.id)
  }
  close(){this.db.close();this.enrollment.gate.close()}
}
export const subjectText=(s:Subject)=>s.kind==='project'?'项目':s.kind==='note'?'笔记':s.kind==='task'?'任务':'会话'
