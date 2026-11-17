import { createHash } from 'node:crypto'
import { isAbsolute, relative, sep } from 'node:path'
import { restrictedArgv, validResumeId, type NativeIdentity } from './resume-plan'
import { canonicalTerminalPath, terminalResourceSha, type NativeSnapshot, type Protocol,
  type TerminalResource } from './resume-terminal-native'

export type CurrentSource = Readonly<{
  logRoot:string; path:string; identity:string; revision:string; profileRevision:string
}>
export type TerminalSubject = Readonly<{
  agent:string; id:string; revision:string; cwd:string|null; profile?:string; configured?:string
  source?:CurrentSource; localEvidenceEligible:boolean; fingerprint:string
}>

/** A/B qualify the mechanism for this installation and default account; these receipts are
 * independent of the UUID that the operator later selects. Each selected UUID needs fresh proof. */
export type TerminalQualification = Readonly<{
  scope:string; windowsIdentity:string; providerAccount:string; defaultConfig:string; providerSessionRoot:string
  allowedLogRoot:string; consoleHost:string; installedPermissions:string; effectivePolicy:string;
  executable:NativeIdentity; transportSha:string
  environment:'win32-system-root-only-v1'
  interactive:{ref:string; result:'exact-id-same-cwd-continued-with-restrictions'}
  console:{ref:string; result:'independent-visible-window-survived-host-exit'}
}>

export type TerminalProof = Readonly<{
  qualification:TerminalQualification
  /** The observed default scope at this instant, independent of the approved qualification. */
  observed:Pick<TerminalQualification,'scope'|'windowsIdentity'|'providerAccount'|'defaultConfig'|
    'providerSessionRoot'|'consoleHost'|'installedPermissions'|'effectivePolicy'|'environment'>
  session:{agent:string;id:string;revision:string;cwd:string;profile:string;source:CurrentSource;unique:true}
}>

/** Only privileged, built-in host code. No receipts imported from renderer, sidecar files,
 * environment or preferences. Read is metadata-only and must never start a provider. The
 * dispatch lease must hold the scope, source, effective account, policy, installation and
 * launch dependencies across the callback. If a premise cannot be held it returns null. */
export interface TerminalAuthority {
  readCurrent(subject:TerminalSubject):TerminalProof|null
  acquireCurrent(subject:TerminalSubject):{
    proof:TerminalProof
    stillCurrent():boolean
    release():void
  }|null
}

export type TerminalResult = 'requested'|'rejected'|'unavailable'|'create-failed'
export type NativeConsolePlan = Readonly<{
  kind:'win32-new-console-v1'; executable:NativeIdentity; cwd:string; protocol:Protocol
  argv:readonly string[]; id:string; selected:string; proof:string; snapshot:NativeSnapshot
}>

const sha=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const hex=(x:unknown):x is string=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x)
const equalPath=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase()
const within=(root:string,path:string)=>{
  const r=relative(root,path)
  return !!r && r!=='..' && !r.startsWith('..'+sep) && !isAbsolute(r)
}
const sourceKeys=['logRoot','path','identity','revision','profileRevision'] as const
const observedKeys=['scope','windowsIdentity','providerAccount','defaultConfig','providerSessionRoot','consoleHost',
  'installedPermissions','effectivePolicy','environment'] as const
const proofKey=(p:TerminalProof)=>sha([
  ...observedKeys.map(k=>p.observed[k]),p.qualification.allowedLogRoot,p.qualification.transportSha,
  p.qualification.executable.path,p.qualification.executable.version,p.qualification.executable.sha256,
  p.qualification.interactive.ref,p.qualification.console.ref,...sourceKeys.map(k=>p.session.source[k])
])
const selectKey=(s:TerminalSubject)=>sha([s.agent,s.id,s.revision,s.cwd,s.profile,s.configured,s.fingerprint,
  ...sourceKeys.map(k=>s.source?.[k])])
const protocolFor=(agent:string)=>agent==='codex'?'codex-restricted-v1':agent==='grok-cli'?'grok-restricted-v1':null
const argvFor=(protocol:Protocol,id:string)=>restrictedArgv(
  protocol==='codex-restricted-v1'?'codex-interactive-resume':'grok-interactive-resume',id)

function matches(s:TerminalSubject,p:TerminalProof):boolean {
  const q=p.qualification, session=p.session, current=s.source
  if (!(s.cwd && s.profile && s.localEvidenceEligible && current) || !validResumeId(s.agent,s.id) ||
      q.environment!=='win32-system-root-only-v1' || q.transportSha!==terminalResourceSha ||
      q.interactive.result!=='exact-id-same-cwd-continued-with-restrictions' ||
      q.console.result!=='independent-visible-window-survived-host-exit' ||
      !hex(q.interactive.ref) || !hex(q.console.ref) || q.interactive.ref===q.console.ref ||
      !observedKeys.every(k=>q[k]===p.observed[k] && (k==='environment' || k==='providerSessionRoot' || hex(q[k]))) ||
      !hex(q.executable.sha256) || !/^[0-9A-Za-z. +()-]{1,80}$/.test(q.executable.version) ||
      !/\.exe$/i.test(q.executable.path) || (s.configured && !equalPath(s.configured,q.executable.path)) ||
      session.unique!==true || session.id!==s.id || session.agent!==s.agent || session.revision!==s.revision ||
      session.profile!==s.profile || session.cwd!==s.cwd || !sourceKeys.every(k=>current[k]===session.source[k]))
    return false
  canonicalTerminalPath(q.providerSessionRoot,false)
  canonicalTerminalPath(q.allowedLogRoot,false)
  const onDisk=canonicalTerminalPath(current.path,true)
  return equalPath(current.logRoot,q.allowedLogRoot) &&
    (equalPath(q.providerSessionRoot,q.allowedLogRoot) || within(q.providerSessionRoot,q.allowedLogRoot)) &&
    within(q.providerSessionRoot,current.path) &&
    [onDisk.dev,onDisk.ino,onDisk.birthtimeNs].join(':')===current.identity
}

export function terminalAdapter(resource:TerminalResource, authority:TerminalAuthority|null, now=Date.now) {
  return {
    get needsProof() {return authority===null},
    review(subject:TerminalSubject):NativeConsolePlan|null {
      try {
        const protocol=protocolFor(subject.agent)
        if (!authority || !protocol || !subject.source || !subject.cwd || !subject.localEvidenceEligible ||
            !validResumeId(subject.agent,subject.id)) return null
        const p=authority.readCurrent(subject)
        if (!p || !matches(subject,p)) return null
        const addon=resource.open(), executable=p.qualification.executable
        if (!addon) return null
        const snapshot=addon.inspect(executable.path,subject.cwd)
        if (snapshot.status!=='verified' || snapshot.win32!==0 || snapshot.sha256!==executable.sha256 ||
            !hex(snapshot.image) || !hex(snapshot.cwd) || !resource.current()) return null
        return {kind:'win32-new-console-v1',executable:{...executable},cwd:subject.cwd,protocol,
          argv:argvFor(protocol,subject.id),id:subject.id,selected:selectKey(subject),proof:proofKey(p),snapshot}
      } catch {return null}
    },
    dispatch(plan:NativeConsolePlan,subject:TerminalSubject,until:number,canCommit:()=>boolean):TerminalResult {
      try {
        if (!authority || selectKey(subject)!==plan.selected || protocolFor(subject.agent)!==plan.protocol ||
            subject.id!==plan.id || subject.cwd!==plan.cwd || !validResumeId(subject.agent,plan.id) ||
            sha(plan.argv)!==sha(argvFor(plan.protocol,plan.id)) || !Number.isSafeInteger(until) || until<=now())
          return 'rejected'
        const lease=authority.acquireCurrent(subject)
        if (!lease) return 'rejected'
        try {
          const live=lease.proof
          if (!matches(subject,live) || proofKey(live)!==plan.proof ||
              sha(live.qualification.executable)!==sha(plan.executable) ||
              plan.snapshot.sha256!==plan.executable.sha256) return 'rejected'
          const addon=resource.open()
          if (!addon || !resource.current()) return 'unavailable'
          if (!lease.stillCurrent() || !canCommit()) return 'rejected'
          const remaining=Math.min(5000,Math.floor(until-now()))
          if (remaining<1) return 'rejected'
          const r=addon.dispatch(plan.executable.path,plan.cwd,plan.snapshot.image,plan.snapshot.cwd,
            plan.snapshot.sha256,plan.protocol,plan.id,remaining)
          switch (r.status) {
            case 'requested': return 'requested'
            case 'rejected': case 'unavailable': case 'create-failed': return r.status
            default: return 'rejected'
          }
        } finally {
          // Once Windows has accepted the request, cleanup must not misreport its outcome.
          try {lease.release()} catch { /* lease releases only its own evidence handles */ }
        }
      } catch {return 'rejected'}
    }
  }
}

export type TerminalAdapter = ReturnType<typeof terminalAdapter>
