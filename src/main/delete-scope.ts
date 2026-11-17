
import type Database from 'better-sqlite3'
import { DEFAULT_PROJECT } from '../shared/ipc'
import type { Subject } from '../shared/p11'

export type Scope = {subject:Subject; notes:string[]; blocks:string[]; agent?:string; at:number}
export type Owner = 'index'|'delegation'|'sessions'|'agents'
export type Rows = Record<string,Record<string,string|number|null>[]>
export const tables:Record<Owner,string[]> = {
  index:['project','p11_project','note','note_draft','note_draft_copy','note_link_binding','note_link','note_tag','m43_removed_project','m43_removed_note'],
  delegation:['delegation_block','delegation_binding','delegation_session','delegation_run','delegation_intent','delegation_launch_evidence','p10_write','p10_confirm','p11_ownership','m43_removed_anchor','m43_removed_session'],
  sessions:['agent_session','session_message_revision','session_confirmation','session_tombstone'],
  agents:['agent_profile']
}
export const ownerNames = Object.keys(tables) as Owner[]
const empty:Rows={}
const ownershipOrder=(a:Rows[string][number],b:Rows[string][number])=>JSON.stringify([a.agent_id,a.external_id]).localeCompare(JSON.stringify([b.agent_id,b.external_id]))
function inventory(db:Database.Database,name:Owner,s:Scope):Rows {
  const {subject:t,notes,blocks}=s, project=t.kind==='project'?t.id:null
  const selected=t.kind==='session'?t.session:null, external=selected?.id
  const o:Rows={}
  const rows=(table:string,where:string,...p:unknown[])=>o[table]=db.prepare('SELECT * FROM '+table+' WHERE '+where+' ORDER BY rowid').all(...p) as Rows[string]
  const none='SELECT value FROM json_each(?)'
  const n=JSON.stringify(notes), b=JSON.stringify(blocks)
  if(name==='index') {
    if(project){
      for(const table of ['project','p11_project','m43_removed_project'])rows(table,'id=?',project)
      rows('note','project_id=? OR id IN ('+none+')',project,n)
      rows('note_draft','project_id=? OR note_id IN ('+none+')',project,n)
    } else if(notes.length) {
      rows('note','id IN ('+none+')',n)
      rows('note_draft','note_id IN ('+none+')',n)
      if(t.kind==='note'){
        rows('note_draft_copy','draft_id IN ('+none+') OR copy_id IN ('+none+')',n,n)
        rows('m43_removed_note','id=?',t.id)
        rows('note_tag','note_id IN ('+none+')',n)
        rows('note_link','source_note_id IN ('+none+') OR target_note_id IN ('+none+')',n,n)
        rows('note_link_binding','source_note_id IN ('+none+') OR target_note_id IN ('+none+')',n,n)
      }
    }
  }
  if(name==='delegation'){
    const bs='SELECT id FROM delegation_block WHERE id IN ('+none+')'
      +(t.kind==='note'||t.kind==='project'?' OR note_id IN ('+none+')':'')
    const bp=t.kind==='note'||t.kind==='project'?[b,n]:[b]
    const ss='SELECT id FROM delegation_session WHERE agent_id=? AND external_id=?'
    const args=selected?[s.agent!,external!]:bp
    const association=selected?'session_id IN ('+ss+')':'block_id IN ('+bs+')'
    const run=association+(selected?' OR target_session_id IN ('+ss+') OR block_id IN (SELECT value FROM json_each(?))':'')
    const runArgs=selected?[...args,...args,b]:args
    rows('delegation_binding',association,...args)
    rows('delegation_run',selected?run:'block_id IN ('+bs+')',...runArgs)
    const runIds=JSON.stringify(o.delegation_run.map(r=>r.id))
    rows('delegation_intent','run_id IN ('+none+')',runIds)
    rows('delegation_launch_evidence','run_id IN ('+none+')',runIds)
    rows('p10_write','runId IN ('+none+')',runIds)
    rows('p10_confirm','runId IN ('+none+')',runIds)
    rows('delegation_block','id IN ('+(selected?'SELECT block_id FROM delegation_binding WHERE '+association:bs)+')',...args)
    if(t.kind==='note'||t.kind==='task')
      rows('m43_removed_anchor','block_id IN ('+none+')',b)
    if(project){rows('p11_ownership','independent_project=?',project); o.p11_ownership.sort(ownershipOrder)}
    if(selected){
      rows('p11_ownership','agent_id=? AND external_id=?',s.agent!,external!)
      rows('m43_removed_session','agent_id=? AND external_id=?',s.agent!,external!)
      rows('delegation_session','id IN ('+ss+')',s.agent!,external!)
    }
  }
  if(name==='sessions'&&selected){
    for(const table of ['agent_session','session_confirmation','session_message_revision','session_tombstone'])
      rows(table,'adapter=? AND id=?',selected.adapter,selected.id)
  }
  if(name==='agents'&&s.agent)rows('agent_profile','id=?',s.agent)
  return o
}
export function before(db:Database.Database,name:Owner,s:Scope):Rows {
  return inventory(db,name,s)
}
export function after(name:Owner,s:Scope,old:Rows):Rows {
  const t=s.subject
  if(!Object.keys(old).length)return empty
  const o:Rows=structuredClone(old)
  if(name==='index'&&t.kind==='project'){
    o.project=[];o.p11_project=[];o.m43_removed_project=[{id:t.id,at:s.at}]
    o.note=o.note.map(r=>({...r,project_id:DEFAULT_PROJECT}))
    o.note_draft=o.note_draft.map(r=>({...r,project_id:DEFAULT_PROJECT}))
  }
  if(name==='index'&&t.kind==='note'){
    for(const table of ['note','note_tag','note_link'])o[table]=[]
    o.m43_removed_note=[{id:t.id,at:s.at}]
    o.note_link_binding=o.note_link_binding.filter(r=>r.source_note_id!==t.id)
  }
  if(name==='delegation'&&t.kind==='project'){
    // The scope still names the removed project; rows whose manual choice was
    // cleared leave this predicate. Verify their exact identities explicitly.
    o.p11_ownership=o.p11_ownership.map(r=>({...r,independent_project:null,detached_unassigned:1,revision:Number(r.revision)+1}))
  }
  if(name==='delegation'&&t.kind!=='project'){
    o.delegation_binding=[]
    if(t.kind==='note'||t.kind==='task'){
      o.m43_removed_anchor=[...o.m43_removed_anchor,...s.blocks.filter(block=>!o.m43_removed_anchor.some(r=>r.block_id===block))
        .map(block=>({block_id:block,note_id:s.notes[0],at:s.at}))]
      // A block with retained history remains a foreign-key parent.
      o.delegation_block=o.delegation_block.filter(block=>o.delegation_run.some(r=>r.block_id===block.id))
    } else if(t.kind==='session'){
      o.m43_removed_session=[{agent_id:s.agent!,external_id:t.session.id,at:s.at}]
      o.p11_ownership=[]
    }
  }
  if(name==='sessions'&&t.kind==='session'){
    o.agent_session=[];o.session_confirmation=[];o.session_message_revision=[]
    o.session_tombstone=[{adapter:t.session.adapter,id:t.session.id,at:s.at,agent_id:s.agent!,reason:'explicit-remove'}]
  }
  return o
}
export function readOwner(db:Database.Database,name:Owner,s:Scope,baseline:Rows):Rows {
  const o=inventory(db,name,s)
  if(name==='delegation'&&s.subject.kind==='project'){
    const have=new Set(o.p11_ownership.map(r=>JSON.stringify([r.agent_id,r.external_id])))
    for(const r of baseline.p11_ownership){
      if(have.has(JSON.stringify([r.agent_id,r.external_id])))continue
      const row=db.prepare('SELECT * FROM p11_ownership WHERE agent_id=? AND external_id=?').get(r.agent_id,r.external_id) as Rows[string][number]|undefined
      if(row)o.p11_ownership.push(row)
    }
    o.p11_ownership.sort(ownershipOrder)
  }
  if(name==='delegation'&&s.subject.kind==='session'){
    // The binding may be gone after this step. The original block is retained.
    o.delegation_block=baseline.delegation_block.flatMap(r=>{
      const current=db.prepare('SELECT * FROM delegation_block WHERE id=?').get(r.id) as Rows[string][number]|undefined
      return current?[current]:[]
    })
  }
  return o
}
export function writeOwner(db:Database.Database,name:Owner,s:Scope,old:Rows) {
  const t=s.subject
  if(name==='index'){
    if(t.kind==='project'){
      db.prepare('INSERT INTO m43_removed_project VALUES (?,?)').run(t.id,s.at)
      db.prepare('UPDATE note SET project_id=? WHERE project_id=?').run(DEFAULT_PROJECT,t.id)
      db.prepare('UPDATE note_draft SET project_id=? WHERE project_id=?').run(DEFAULT_PROJECT,t.id)
      db.prepare('DELETE FROM p11_project WHERE id=?').run(t.id)
      db.prepare('DELETE FROM project WHERE id=?').run(t.id)
    }else if(t.kind==='note'){
      db.prepare('INSERT INTO m43_removed_note VALUES (?,?)').run(t.id,s.at)
      db.prepare('DELETE FROM note WHERE id=?').run(t.id)
    }
  }
  if(name==='delegation'){
    if(t.kind==='project')
      db.prepare('UPDATE p11_ownership SET independent_project=NULL,detached_unassigned=1,revision=revision+1 WHERE independent_project=?').run(t.id)
    else{
      const del=db.prepare('DELETE FROM delegation_binding WHERE block_id=? AND session_id=?')
      for(const r of old.delegation_binding)del.run(r.block_id,r.session_id)
      if(t.kind==='session'){
        db.prepare('INSERT INTO m43_removed_session VALUES (?,?,?)').run(s.agent,t.session.id,s.at)
        db.prepare('DELETE FROM p11_ownership WHERE agent_id=? AND external_id=?').run(s.agent,t.session.id)
      }else{
        for(const block of s.blocks)db.prepare('INSERT OR IGNORE INTO m43_removed_anchor VALUES (?,?,?)').run(block,s.notes[0],s.at)
        const remove=db.prepare('DELETE FROM delegation_block WHERE note_id=? AND id=? AND NOT EXISTS(SELECT 1 FROM delegation_run WHERE block_id=?)')
        for(const r of old.delegation_block)remove.run(r.note_id,r.id,r.id)
      }
    }
  }
  if(name==='sessions'&&t.kind==='session'){
    db.prepare('INSERT INTO session_tombstone(adapter,id,at,agent_id,reason) VALUES (?,?,?,?,?)').run(t.session.adapter,t.session.id,s.at,s.agent,'explicit-remove')
    for(const table of ['agent_session','session_confirmation'])
      db.prepare('DELETE FROM '+table+' WHERE adapter=? AND id=?').run(t.session.adapter,t.session.id)
  }
}
