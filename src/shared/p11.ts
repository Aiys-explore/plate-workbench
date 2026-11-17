import type { ProjectSummary } from './ipc'
import type { SessionAdapter } from './sessions'
export const projectColors = { default: '默认', blue: '蓝', green: '绿', amber: '琥珀', red: '红' } as const
export type ProjectFields = {name:string; root:string; color:keyof typeof projectColors}
export type ProjectDetail = ProjectSummary & ProjectFields & {revision:number}
export type SessionRef = {adapter:SessionAdapter; id:string}
export type TaskRef = {noteId:string; blockId:string}
export type TaskInfo = TaskRef & {title:string; note:string; project:ProjectDetail; reason:string; binding?:SessionRef; externalId?:string; agentId?:string; eligibleAgents?:string[]}
export type SessionPlace = {projectId:string|null; name:string; archived:boolean; source:string; bound:boolean; noteId?:string}
export type Ownership = {session:SessionRef; agentId:string; cwd:string|null; place:SessionPlace; suggestion:string;
  candidates:{project:ProjectDetail; evidence:string}[]}
export type Subject = {kind:'project'|'note';id:string}|{kind:'task';task:TaskRef}|{kind:'session';session:SessionRef}
export type Request =
  | {type:'remove'; subject:Subject}
  | {type:'project'; id?:string; revision?:number; fields:ProjectFields}
  | {type:'archive'; id:string; revision:number; archived:boolean}
  | {type:'ownership'; session:SessionRef; projectId:string|null}
  | {type:'binding'; session:SessionRef; target:TaskRef|null}
export type Facts = {title:string; id:string; counts:{label:string;value:number|null}[]; details:string[]}
export type Identity = {project:string; noteId:string; blockId:string; revision:string}
export type Preview = {token:string; action:string; facts?:Facts; session?:SessionRef; cwd?:string|null; agentId?:string;
  source?:Identity|null; target?:Identity|null; destination?:string; affectedNotes?:string[]; blocked?:string}
export type Receipt = {status:'saved'|'unchanged'|'missing'; message:string; project?:ProjectDetail; removed?:Subject}
export interface P11Api {
  project(id:string):Promise<ProjectDetail>
  browse():Promise<string|null>
  ownership(session:SessionRef):Promise<Ownership>
  places():Promise<Record<string,SessionPlace>>
  tasks(noteId?:string):Promise<TaskInfo[]>
  preview(request:Request):Promise<Preview>
  impact(subject:Subject):Promise<Facts>
  confirm(token:string,id:string):Promise<Receipt>
  cancel(token:string):Promise<void>
  receipt(id:string):Promise<Receipt>
  pending():Promise<{id:string;detail:string;state:string}|null>
}
export const sessionKey = (session:SessionRef) => JSON.stringify([session.adapter,session.id])

