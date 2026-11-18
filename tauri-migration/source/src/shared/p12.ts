import type { NoteSummary, ProjectSummary } from './ipc'
export type Scope = {kind:'note'|'project';id:string}
export type Policy = 'number'|'skip'
export type Source = {project:ProjectSummary; rows:(NoteSummary & {revision:string; recovery:string|null})[]; fingerprint:string}
export type Status = '未开始'|'已生成'|'跳过'|'失败'|'待核对'
export type Row = {id:string; source:string; name:string; target:string|null; reason:string; status:Status; check?:string}
export type Preview = {id:string; rows:Row[]; blockers:string[]}
export type Receipt = {id:string; directory:string; scope:Scope; rows:Row[]; active:boolean; stopping:boolean; phase:string; canRetry:boolean}
export interface P12Api {
  scope(scope:Scope):Promise<Source>
  choose():Promise<{token:string;directory:string}|null>
  preview(request:{scope:Scope;fingerprint:string;target:string;policy:Policy;saved:boolean;retry?:string}):Promise<Preview>
  confirm(id:string):Promise<Receipt>
  receipt(id?:string):Promise<Receipt|null>
  stop(id:string):Promise<void>
  release(id:string):Promise<void>
}
