import { createHash, randomUUID } from 'node:crypto'
import { accessSync, closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, normalize } from 'node:path'
import type { ResumeAction, ResumeOrigin, ResumeResult, ResumeView } from '../shared/resume'
import { sessionAdapters, type SessionAdapter } from '../shared/sessions'
import { taskIdPattern } from '../shared/task-anchor'
import { planResume, validResumeId, type Evidence, type NativeIdentity, type Plan, type Scope } from './resume-plan'
import type { Availability } from './resume-availability'
import type { CurrentSource, NativeConsolePlan, TerminalAdapter, TerminalResult } from './resume-terminal'

export type Subject = { agent: string; id: string; revision: string; cwd: string | null; fingerprint: string;
  profile?: string; configured?: string; localEvidenceEligible: boolean; source?: CurrentSource;
  conversation?: Extract<ResumeOrigin,{kind:'log'}> }
type DesktopRoute = Readonly<{ scheme: string; prefix: string; suffix: string; handler: NativeIdentity; registration: string;
  ref: string; scope: Scope; result: 'exact-id-continued-with-verified-handler'; privilege:'existing-client-no-elevation' }>
type LiveDesktop = { handler: NativeIdentity; registration: string }
type DesktopPlan = { kind: 'desktop'; address: string; route: DesktopRoute }
type TerminalPlan = Extract<Plan,{kind:'independent-terminal'}>
type External = DesktopPlan | TerminalPlan
type DesktopRoutePlan = { action:'desktop'; plan:DesktopPlan }
type TerminalRoutePlan = { action:'terminal'; plan:TerminalPlan | NativeConsolePlan }
type Copy = { action:'copy-id'|'copy-command'; text:string }
type Method = DesktopRoutePlan | TerminalRoutePlan | Copy

/** Only compile-time host adapters can implement this. There is no setting, file import, or IPC for evidence.
 * inspect must check the current device, Windows user and provider account, current effective ACL/registration,
 * verified config/log provenance and whether this exact session still exists. No fallback, probing GUI, or "recent".
 * At dispatch the adapter must synchronously check these premises again, bind the checked handler/terminal rather
 * than delegate to unchecked shell resolution, and reject if it cannot guarantee the original target and policy.
 * It owns no process on behalf of DelegationLaunch. Success only acknowledges the request; it does not prove the UI.
 */
export interface VerifiedResumeAdapter {
  inspect(subject: Readonly<Subject>): Promise<{
    scope: Scope; native: NativeIdentity | null; terminal: NativeIdentity | null; terminalAdapter: string | null;
    desktop: LiveDesktop | null; evidence: Evidence; route?: DesktopRoute
  } | null>
  dispatch(plan: Readonly<External>, subject: Readonly<Subject>, context?:{until:number;canCommit:()=>boolean}): void
}
type Resolve = (origin: ResumeOrigin) => Subject | null
type Choice = { view: ResumeView; methods: Method[]; fingerprint: string; subjectHash:string }
type Ticket = { origin:ResumeOrigin; choice:Choice; owner:number; until:number; copyOnly:boolean }
const revision = (x: unknown) => typeof x==='string' && /^[a-f0-9]{64}$/.test(x)
const runKey = (x: unknown) => typeof x==='string' && taskIdPattern.test(x)
const validOrigin = (x: unknown): x is ResumeOrigin => {
  if (!x || typeof x!=='object' || !('revision' in x) || !revision(x.revision) || !('kind' in x)) return false
  return x.kind === 'run'
    ? Object.keys(x).length === 5 && 'noteId' in x && 'blockId' in x && 'runId' in x &&
      runKey(x.noteId) && runKey(x.blockId) && runKey(x.runId)
    : x.kind === 'log' && Object.keys(x).length === 4 && 'adapter' in x && sessionAdapters.includes(x.adapter as SessionAdapter) &&
      'id' in x && typeof x.id === 'string' && x.id.length > 0 && x.id.length <= 256
}
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fileStamp = (st: BigIntStats) => [st.dev,st.ino,st.birthtimeNs,st.size,st.mtimeNs,st.ctimeNs].join(':')
const safeWin = (p: string) => /^[A-Za-z]:\\/.test(p) && normalize(p)===p && !/[\x00-\x1f\x7f<>:"/|?*]/.test(p.slice(2)) &&
  !p.slice(3).split('\\').some(x=>/[. ]$/.test(x) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(x))
function checkedPath(path: string, dir: boolean) {
  if (!safeWin(path) || (!dir && !/\.exe$/i.test(path)) || /\\Microsoft\\WindowsApps\\/i.test(path)) throw Error()
  for (let p=path; ; p=dirname(p)) {
    const st=lstatSync(p,{bigint:true})
    if (st.isSymbolicLink() || (p===path && !dir ? !st.isFile() : !st.isDirectory())) throw Error()
    if (dirname(p)===p) break
  }
  if (realpathSync.native(path).toLowerCase() !== path.toLowerCase()) throw Error()
  accessSync(path,constants.R_OK | constants.X_OK)
  const st=lstatSync(path,{bigint:true})
  if (!st.ino) throw Error()
  return st
}
const cwdKey = (cwd: string) => {
  const st = checkedPath(cwd,true)
  return [st.dev,st.ino,st.birthtimeNs].join(':')
}
// Hash the actual PE through a fixed descriptor; never run it to get its identity.
async function verifyNative(native: NativeIdentity | null) {
  if (!native || !/^[a-f0-9]{64}$/.test(native.sha256) || !/^[0-9A-Za-z. +()-]{1,80}$/.test(native.version)) return null
  const path=native.path
  let fd: number | undefined
  try {
    const start = checkedPath(path,false), stamp = fileStamp(start)
    if (start.size<64n || start.size>512n*1024n*1024n || start.nlink!==1n) return null
    fd=openSync(path,'r')
    if (fileStamp(fstatSync(fd,{bigint:true}))!==stamp) return null
    const header=Buffer.alloc(64), pe=Buffer.alloc(24)
    if (readSync(fd,header,0,64,0)!==64 || header.readUInt16LE(0)!==0x5a4d ||
        readSync(fd,pe,0,24,header.readUInt32LE(60))!==24 || pe.readUInt32LE(0)!==0x4550 ||
        !(pe.readUInt16LE(22)&2) || (pe.readUInt16LE(22)&0x2000)) return null
    const hash=createHash('sha256')
    for await (const bytes of createReadStream(path,{fd,autoClose:false,start:0,end:Number(start.size)-1})) hash.update(bytes)
    const recheck = () => fileStamp(checkedPath(path,false))===stamp
    if (hash.digest('hex')!==native.sha256 || !recheck()) return null
    return {native,recheck,stamp}
  } catch { return null }
  finally { if (fd!==undefined) closeSync(fd) }
}
function desktopPlan(subject: Subject, route: DesktopRoute | undefined, live: LiveDesktop | null, scope: Scope): DesktopPlan | null {
  if (!route || !live || route.result !== 'exact-id-continued-with-verified-handler' || route.scope.platform !== 'win32' ||
      !scope.key || route.scope.key !== scope.key || !route.ref || !route.registration || route.registration !== live.registration ||
      route.privilege!=='existing-client-no-elevation' ||
      sha(route.handler) !== sha(live.handler) || !/^[a-z][a-z0-9+.-]{1,32}$/.test(route.scheme) ||
      ['http','https','file','javascript','data','mailto','shell','ms-settings'].includes(route.scheme) ||
      !route.prefix.startsWith(route.scheme+'://') || !/^[a-z0-9+.:/?&=_-]+$/i.test(route.prefix) ||
      !/^[a-z0-9.&#=_-]*$/i.test(route.suffix)) return null
  const address=route.prefix+encodeURIComponent(subject.id)+route.suffix
  return {kind:'desktop',address,route}
}

const reasons: Record<string,string> = {
  'invalid-id':'会话 ID 无效，无法安全复制或恢复。',
  'unknown-session':'当前会话或轮次已变化，或无法唯一核对 ID。请重新读取。',
  'unsupported-platform':'此系统没有已验证的自动定位方式。请在原客户端手动查找。',
  'registration-only':'本机仅核对到协议登记，尚未验证能定位此会话。',
  'cannot-locate':'此客户端无法精确定位会话，请手动查找。',
  'client-not-found':'在本机已检查的位置找不到客户端。可保留 ID，待客户端可用后手动查找。',
  'interactive-unverified':'尚未验证交互续接会打开此会话。',
  'terminal-unverified':'尚未验证独立终端可按原目录续接并在工作台退出后继续。',
  'cwd-unverified':'暂时无法核对原工作目录，不能自动续接。',
  'native-unverified':'没有通过本机验证的自动定位方式。请在原客户端手动查找。',
  'capability-unknown':'没有通过本机验证的自动定位方式。请在原客户端手动查找。'
}
const unavailable = (reason = 'unknown-session'): ResumeView => ({reason:reasons[reason],methods:[]})
const consoleFailure:Record<Exclude<TerminalResult,'requested'>,string>={
  rejected:'启动前未能重新确认会话、账户、程序或目录。可以手动复制会话 ID。',
  unavailable:'当前环境无法启动独立终端。可以手动复制会话 ID。',
  'create-failed':'Windows 未能启动独立终端。可以手动复制会话 ID。'
}

export class ResumeHost {
  private readonly tickets = new Map<string, Ticket>()
  private readonly busy = new Set<string>()
  private readonly external = new Map<string, number>()
  private copying=false
  constructor(private resolve: Resolve, private clipboard: {writeText(text:string):void | Promise<void>; readText():string | Promise<string>},
    private availability: (agent:string, configured?:string)=>Promise<Availability>,
    private adapter?: VerifiedResumeAdapter, private terminal?: TerminalAdapter) {}

  private async assess(origin: ResumeOrigin): Promise<(Choice & { valid:()=>boolean; subject:Subject }) | null> {
    const subject=this.resolve(origin)
    if (!subject || subject.revision!==origin.revision) return null
    const subjectHash=sha(subject)
    const unchanged=()=>sha(this.resolve(origin))===subjectHash
    if (!validResumeId(subject.agent,subject.id)) {
      return {view:unavailable('invalid-id'),methods:[],fingerprint:subjectHash,subjectHash,valid:unchanged,subject}
    }
    const availability=await this.availability(subject.agent,subject.configured).catch(()=>'unknown' as const)
    let checks: (()=>boolean)[]=[]
    let identity: unknown
    let reason=reasons[availability==='unknown'?'capability-unknown':availability]
    const methods: Method[]=[]
    if (process.platform!=='win32') reason=reasons['unsupported-platform']
    if (process.platform==='win32' && this.adapter && subject.localEvidenceEligible) {
      try {
        const live=await this.adapter.inspect(subject)
        if (live?.scope.platform==='win32' && live.scope.key) {
          const [desktop, cli, terminal]=await Promise.all([
            verifyNative(live.route ? live.desktop?.handler ?? null : null),
            verifyNative(live.evidence.interactive ? live.native : null),verifyNative(live.evidence.terminal ? live.terminal : null)
          ])
          const route=desktop && desktopPlan(subject,live.route,live.desktop,live.scope)
          if (route && desktop) {
            methods.push({action:'desktop',plan:route})
            checks.push(desktop.recheck)
          }
          let dir: string | null=null
          try { if (subject.cwd) dir=cwdKey(subject.cwd) } catch { /* copy-only, unless an exact desktop route is proven */ }
          const restricted=live.evidence.interactive?.fixedArgv==='restricted-interactive-v1'
          const p=planResume(subject,{platform:process.platform,scope:live.scope,session:{...subject,cwdIdentity:dir},
            native:cli?.native ?? null, terminal:terminal?.native ?? null, terminalAdapter:live.terminalAdapter,availability},
            restricted ? live.evidence : {})
          if (p.kind==='independent-terminal') {
            methods.push({action:'terminal',plan:p})
            checks.push(cli!.recheck,terminal!.recheck,()=>cwdKey(p.cwd)===dir)
          }
          methods.push({action:'copy-id',text:subject.id})
          if (p.kind==='fallback') {
            const command=p.copy.find(x=>x.kind==='manual-powershell')
            if (command && cli && subject.cwd && dir) {
              methods.push({action:'copy-command',text:command.text})
              checks.push(cli.recheck,()=>cwdKey(subject.cwd!)===dir)
            }
            if (cli || availability==='unknown') reason=reasons[p.reason] ?? reason
          }
          if (route || p.kind==='independent-terminal') reason='选择如何打开此会话；实际定位结果请在客户端核对。'
          identity=[desktop?.stamp,cli?.stamp,terminal?.stamp,dir,live.scope]
        }
      } catch { methods.length=0; checks=[] }
    }
    if (!methods.length) methods.push({action:'copy-id',text:subject.id})
    if (process.platform==='win32' && this.terminal) {
      const plan=subject.localEvidenceEligible && availability!=='client-not-found' ? this.terminal.review(subject) : null
      if (plan) {
        const old=methods.findIndex(m=>m.action==='terminal')
        if (old!==-1) methods.splice(old,1)
        methods.splice(methods[0]?.action==='desktop'?1:0,0,{action:'terminal',plan})
        reason='选择如何打开此会话；实际定位结果请在客户端核对。'
      } else if (methods.every(m=>m.action==='copy-id')) {
        reason+=' 当前仅可复制会话 ID。'
      }
    }
    const valid=()=>unchanged() && checks.every(check=>check())
    if (!valid()) return null
    const {agent,id,cwd,conversation} = subject
    return {subject, subjectHash, valid, fingerprint:sha([subjectHash,methods,identity]), methods,
      view:{ reason, methods:methods.map(m=>m.action), subject:{agent,id,cwd}, conversation }}
  }

  private issue(owner:number, origin:ResumeOrigin, choice:Choice, copyOnly=false): ResumeView {
    if (!choice.methods.length) return choice.view
    const now=Date.now()
    for (const [k,t] of this.tickets) if (t.until<now) this.tickets.delete(k)
    if (this.tickets.size>=128) this.tickets.delete(this.tickets.keys().next().value!)
    const ticket=randomUUID()
    this.tickets.set(ticket,{ owner, origin, choice, until:now+120_000, copyOnly })
    return {...choice.view,ticket}
  }

  async review(owner:number, origin:unknown) {
    if (!validOrigin(origin)) return unavailable()
    try {
      const choice=await this.assess(origin)
      return choice ? this.issue(owner,origin,choice) : unavailable()
    } catch { return unavailable() }
  }
  close(owner:number,ticket:unknown) {
    if (typeof ticket==='string' && this.tickets.get(ticket)?.owner===owner) this.tickets.delete(ticket)
  }
  private copyFallback(owner:number,origin:ResumeOrigin,choice:Choice,reason:string) {
    const methods=choice.methods.filter(m=>m.action==='copy-id')
    return this.issue(owner,origin,{...choice,methods,view:{...choice.view,reason,methods:methods.map(m=>m.action)}},true)
  }
  async act(owner:number,ticket:unknown,action:unknown,allowed:()=>boolean): Promise<ResumeResult> {
    const stale: ResumeResult={state:'stale',message:'会话或能力已变化。请重新核对；未执行此操作。'}
    if (typeof ticket!=='string' || !runKey(ticket)) return stale
    const selected=this.tickets.get(ticket)
    if (!selected || selected.owner!==owner || selected.until<Date.now() || this.busy.has(ticket) ||
        !selected.choice.methods.some(m=>m.action===action)) return stale
    this.busy.add(ticket)
    try {
      // A returned copy-only ticket checks the same subject independently of external availability.
      const currentCopy=()=> {
        const subject=this.resolve(selected.origin)
        return subject && subject.revision===selected.origin.revision && validResumeId(subject.agent,subject.id) &&
          sha(subject)===selected.choice.subjectHash ? subject : null
      }
      const copy=selected.copyOnly ? currentCopy() : null
      const choice=selected.copyOnly ? (copy && {...selected.choice,subject:copy,valid:()=>!!currentCopy()}) : await this.assess(selected.origin)
      if (this.tickets.get(ticket)!==selected || !allowed() || selected.until<Date.now()) return stale
      this.tickets.delete(ticket)
      if (!choice || !choice.valid() || choice.fingerprint!==selected.choice.fingerprint) {
        if (action==='terminal' && currentCopy()) {
          return {state:'failed',message:consoleFailure.rejected,
            next:this.copyFallback(owner,selected.origin,selected.choice,consoleFailure.rejected)}
        }
        return stale
      }
      const method=choice.methods.find(m=>m.action===action)!
      const {agent,id}=choice.subject
      if (method.action==='copy-id' || method.action==='copy-command') {
        if (this.copying) return {state:'failed',message:'正在确认另一项剪贴板操作。请再试。',next:this.issue(owner,selected.origin,choice,selected.copyOnly)}
        this.copying=true
        try {
          await this.clipboard.writeText(method.text)
          if (await this.clipboard.readText()!==method.text) throw Error()
          return {state:'copied',message:method.action==='copy-id'?'已复制当前会话 ID。':'已复制命令，请核对后在终端手动执行。',
            next:this.issue(owner,selected.origin,choice,selected.copyOnly)}
        } catch {
          return {state:'failed',message:'未能确认剪贴板内容。请手动选取文字，或重新核对后再试。',
            next:this.issue(owner,selected.origin,choice,selected.copyOnly)}
        } finally {this.copying=false}
      }
      const key=sha([agent,id])
      const now=Date.now()
      for (const [k, until] of this.external) if (until<=now) this.external.delete(k)
      if (this.external.has(key) || this.external.size>=128) return {state:'failed',message:'刚刚已请求打开会话，请先核对客户端。',
        next:this.issue(owner,selected.origin,choice)}
      this.external.set(key,now+5000)
      try {
        // Adapter dispatch is the last step. It must reject drift before committing or report failure.
        const plan=(method as DesktopRoutePlan | TerminalRoutePlan).plan
        if (plan.kind==='win32-new-console-v1') {
          const result=this.terminal!.dispatch(plan,choice.subject,selected.until,
            ()=>allowed() && !!currentCopy() && Date.now()<selected.until)
          if (result==='requested') {
            return {state:'requested',message:'已请求在独立终端中打开。请在终端核对当前会话。',
              next:this.copyFallback(owner,selected.origin,choice,'请在终端核对是否为当前会话。')}
          }
          return {state:'failed',message:consoleFailure[result],
            next:currentCopy()?this.copyFallback(owner,selected.origin,choice,consoleFailure[result]):undefined}
        }
        this.adapter!.dispatch(plan,choice.subject,{until:selected.until,canCommit:()=>allowed() && !!currentCopy() && Date.now()<selected.until})
        return {state:'requested',message:'已请求打开。请在客户端核对是否为当前会话。',next:this.issue(owner,selected.origin,choice)}
      } catch {
        const message='未能确认打开请求。请先核对客户端，也可以手动复制当前会话 ID。'
        return {state:'failed',message,next:currentCopy()?this.copyFallback(owner,selected.origin,choice,message):undefined}
      }
    } catch { return stale }
    finally { this.busy.delete(ticket) }
  }
}
