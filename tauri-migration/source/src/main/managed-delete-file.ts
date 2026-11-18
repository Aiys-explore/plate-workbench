
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

type Capture = {parent:string; identity?:string; stamp?:string; bytes?:Buffer}
export type FileImage = {identity:string; stamp:string; sha:string}
export type ManagedFilePlan = {path:string; backup:string; replacement:string; parent:string; stagingParent:string;
  before:FileImage; next:string|null}
const addonSha='ec684cd5aca70bcc44fdc02f4eb95ae4af4590a2a0398b76def6221902796273'
const digest=(x:Buffer)=>createHash('sha256').update(x).digest('hex')
let native:{handle:(mode:number,...args:unknown[])=>Capture}|undefined
export function runManaged(mode:number,...args:unknown[]):Capture {
  if (!native) {
    if(process.platform!=='win32' || process.arch!=='x64')throw new Error('此平台未验证受管文件操作')
    const file=app.isPackaged ? join(process.resourcesPath,'managed.node') : join(app.getAppPath(),'native','managed.node')
    if(digest(readFileSync(file))!==addonSha)throw new Error('受管文件部件身份不符')
    native=require(file)
  }
  return native!.handle(mode,...args)
}
function image(x:Capture):FileImage {
  if (!x.identity || !x.stamp || !x.bytes) throw new Error('找不到原受管文件')
  return {identity:x.identity,stamp:x.stamp,sha:digest(x.bytes)}
}
const fileId=(id?:string)=>id?.split(':').slice(0,2).join(':')
const matches=(x:Capture,y:FileImage)=>!!x.bytes && fileId(x.identity)===fileId(y.identity) && digest(x.bytes)===y.sha
export function captureFile(path:string,bytes:Buffer) {
  const now=runManaged(0,path)
  if(!now.bytes?.equals(bytes))throw new Error('受管文件字节已变化')
  return {parent:now.parent,before:image(now)}
}
export function managedPlan(location:ReturnType<typeof captureFile>,path:string,staging:string,id:string,next:Buffer|null):ManagedFilePlan {
  const backup=join(staging,id+'.original'), replacement=join(staging,id+'.replacement')
  const a=runManaged(0,backup), b=runManaged(0,replacement)
  if(a.identity || b.identity || a.parent!==b.parent || a.parent.split(':')[0]!==location.parent.split(':')[0] || dirname(path)===staging)
    throw new Error('同卷隔离位置无法核实')
  return {...location,path,backup,replacement,stagingParent:a.parent,next:next?.toString('base64')??null}
}
function read(f:ManagedFilePlan) {
  const original=runManaged(0,f.path), backup=runManaged(0,f.backup), replacement=runManaged(0,f.replacement)
  if(original.parent!==f.parent || backup.parent!==f.stagingParent || replacement.parent!==f.stagingParent)
    throw new Error('受管目录身份已变化')
  return {original,backup,replacement}
}
export function prepareReplacement(f:ManagedFilePlan):FileImage|null {
  if(f.next===null)return null
  return image(runManaged(2,f.replacement,f.stagingParent,Buffer.from(f.next,'base64')))
}
export function filePhase(f:ManagedFilePlan, staged:FileImage|null) {
  const {original,backup,replacement}=read(f)
  const old=matches(original,f.before) && !backup.identity
  const parked=matches(backup,f.before) && !original.identity
  if(old)return 'original'
  if(parked && (!staged || matches(replacement,staged)))return 'staged'
  if(staged && matches(backup,f.before) && matches(original,staged) && !replacement.identity)return 'installed'
  throw new Error('原位、隔离位或文件身份无法唯一对账')
}
export function stageOriginal(f:ManagedFilePlan,staged:FileImage|null) {
  const {original,backup,replacement}=read(f)
  if(!matches(original,f.before) || (original.identity!==f.before.identity || original.stamp!==f.before.stamp) || backup.identity ||
     (staged ? !matches(replacement,staged) || staged.stamp!==replacement.stamp : !!replacement.identity))
    throw new Error('文件或隔离位已变化；请重新预览')
  runManaged(1,f.path,f.backup,f.parent,f.stagingParent,f.before.identity,f.before.stamp,original.bytes)
}
export function restoreOriginal(f:ManagedFilePlan) {
  const {original,backup}=read(f)
  if(original.identity || !matches(backup,f.before))throw new Error('不能复位到已被占用或未核实的位置')
  runManaged(1,f.backup,f.path,f.stagingParent,f.parent,backup.identity,backup.stamp,backup.bytes)
}
export function installReplacement(f:ManagedFilePlan,staged:FileImage) {
  const {original,backup,replacement}=read(f)
  if(original.identity || !matches(backup,f.before) || !matches(replacement,staged) || replacement.stamp!==staged.stamp)
    throw new Error('不能安装未经验证的替换文件')
  runManaged(1,f.replacement,f.path,f.stagingParent,f.parent,staged.identity,staged.stamp,replacement.bytes)
}
