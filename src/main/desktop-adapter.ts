import { createHash } from 'node:crypto'
import { execFile, spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { win32 } from 'node:path'
import type { Subject, VerifiedResumeAdapter } from './resume-host'
import { canonicalTerminalPath } from './resume-terminal-native'

type Inspection = NonNullable<Awaited<ReturnType<VerifiedResumeAdapter['inspect']>>>
type Desktop = NonNullable<Inspection['desktop']>
type Plan = Parameters<VerifiedResumeAdapter['dispatch']>[0]
export const codexDesktop = Object.freeze({
  prefix: 'codex://threads/',
  family: 'OpenAI.Codex_2p2nqsd0c76g0',
  package: 'OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0',
  app: 'OpenAI.Codex_2p2nqsd0c76g0!App',
  version: '26.1111.2228.0',
  exe: 'cf2ee1ce895df9ee158ee61830d9d0f805c77d9b212ad0e159ae605ae04260c6',
  archive: '2551cba1057a05cdc5cf5d75b146fac4092bff4ce77a10c43e3286c88d24c82d',
  manifest: '582352034a5db3859c30f73be5bf2a7e80a2ce310bd28f456b077586b900cbdb'
})
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const sha = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s)
const uuid = (s: unknown): s is string => typeof s === 'string' && s.length === 36 &&
  /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s) && s !== '00000000-0000-0000-0000-000000000000'
const localPath = (p: unknown): p is string => typeof p === 'string' && /^[A-Za-z]:\\/.test(p) &&
  !/[\x00-\x1f\x7f<>:"/|?*]/.test(p.slice(2)) && win32.normalize(p) === p
const packageStamp = hash(['store-only/Windows.Protocol/v1',codexDesktop])

/** Trusted build data only. A/B characterize the verified account capability. Never renderer inputs. */
export type SealedDesktopProof = Readonly<{
  reportSha256: string; brokerSha256: string; registration: string
  windowsScope: string; accountScope: string; profile: string
  a: string; b: string; aCreated: number; bCreated: number; fixtureCwdIdentity: string
  sourceKey: string; expiresAt: number
  result: 'cold-and-hot-a-newer-same-directory-b-no-fallback-same-id-turn-a-only-readback'
}>
export const sealedDesktopProof: SealedDesktopProof | null = null
export const desktopBrokerSha = '5ed472c8bcbecd136e6cabf18a1cfe44bc4218d929ffadbfbf2e88ea95ad00a9'

/** Main-process capability. Must re-read a trusted assertion of the CURRENT account and exact local
 * ownership. No `.codex` token, equivalent login secret, titles, log bodies, recently opened thread,
 * arbitrary site/profile, or approximate lookup. Return null if an account/existence lease cannot be
 * guaranteed through the launch boundary. This lookup is for the current selection, independent of A/B. */
export type Ownership = Readonly<{
  windowsScope: string; accountScope: string; profile: string; scopeLeaseUntil: number
  selectedId: string; cwdIdentity: string; cwd: string; nativeIdentity: string
  sourceKey: string; subjectFingerprint: string; subjectRevision: string
  local: true; exactUnique: true
}>
export type OwnershipReader = (selected: Readonly<Subject>) => Ownership | null

type Fail = 'proof-unavailable' | 'selection-unverified' | 'target-drift' | 'duplicate' | 'expired' | 'launch-rejected'
export type DesktopTransport = Readonly<{
  permits: (id: string) => boolean
  verify: () => Promise<Desktop | null>
  request: (id: string, until: number, canCommit?:()=>boolean) => boolean
}>

function validProof(p: SealedDesktopProof | null, time: number) {
  return p && p.result === 'cold-and-hot-a-newer-same-directory-b-no-fallback-same-id-turn-a-only-readback' &&
    [p.reportSha256,p.brokerSha256,p.windowsScope,p.accountScope,p.fixtureCwdIdentity,p.sourceKey].every(sha) &&
    p.registration === packageStamp && uuid(p.a) && uuid(p.b) && p.a !== p.b && !!p.profile &&
    Number.isSafeInteger(p.aCreated) && Number.isSafeInteger(p.bCreated) && p.aCreated < p.bCreated &&
    Number.isSafeInteger(p.expiresAt) && p.expiresAt > time
}
const bindingStamp = (key: string, p: SealedDesktopProof) => hash([packageStamp,key,p.reportSha256,p.brokerSha256])
const routeExpected = (d: Desktop, key: string, p: SealedDesktopProof) => ({
  scheme:'codex' as const,prefix:codexDesktop.prefix,suffix:'',handler:d.handler,registration:d.registration,
  ref:p.reportSha256,scope:{key,platform:'win32' as const},result:'exact-id-continued-with-verified-handler' as const,
  privilege:'existing-client-no-elevation' as const
})
const validDesktop = (d: Desktop | null): d is Desktop => !!d && d.registration === packageStamp &&
  d.handler.version === codexDesktop.version && d.handler.sha256 === codexDesktop.exe && localPath(d.handler.path) &&
  d.handler.path.toLowerCase().endsWith('\\'+codexDesktop.package.toLowerCase()+'\\app\\chatgpt.exe')

/** Pure orchestration entry point for the isolated suite. Production only uses createDesktopAdapter below. */
export function desktopPolicy(proof: SealedDesktopProof | null, read: OwnershipReader, io: DesktopTransport,
    now = Date.now, ticks = () => performance.now(), deny: (reason: Fail) => void = () => {}): VerifiedResumeAdapter {
  const p = proof && Object.freeze({...proof})
  const cooldown = new Map<string,number>()
  function owned(s: Readonly<Subject>, t: number) {
    if (!p || s.agent !== 'codex' || !s.localEvidenceEligible || !uuid(s.id) || !io.permits(s.id) || s.profile !== p.profile ||
        !sha(s.revision) || !s.fingerprint || !localPath(s.cwd)) return null
    const live = read(s)
    if (!live || live.profile !== p.profile || live.windowsScope !== p.windowsScope || live.accountScope !== p.accountScope ||
        live.selectedId !== s.id || live.subjectFingerprint !== s.fingerprint ||
        live.subjectRevision !== s.revision || live.sourceKey !== p.sourceKey || !live.local || !live.exactUnique ||
        !localPath(live.cwd) || live.cwd.toLowerCase() !== s.cwd.toLowerCase() || !sha(live.cwdIdentity) || !sha(live.nativeIdentity) ||
        !Number.isSafeInteger(live.scopeLeaseUntil) || live.scopeLeaseUntil <= t || live.scopeLeaseUntil - t > 15_000) return null
    const key = hash([p.windowsScope,p.accountScope,p.profile,p.sourceKey,s.id,s.revision,s.fingerprint,live.cwdIdentity,live.nativeIdentity])
    return {key, until: live.scopeLeaseUntil}
  }
  const fail = (why: Fail): never => { deny(why); throw new Error(why) }
  return {
    async inspect(s) {
      try {
        const t = now()
        if (!p || !validProof(p,t)) { deny('proof-unavailable'); return null }
        const first = owned(s,t)
        if (!first) { deny('selection-unverified'); return null }
        const d = await io.verify()
        const after = now(), last = owned(s,after)
        if (!validDesktop(d) || !last || last.key !== first.key || after >= first.until || !validProof(p,after)) {
          deny('target-drift'); return null
        }
        // A new account/metadata read at act time leaves the same key only for the same premises.
        const desktop = {handler:{...d.handler}, registration:bindingStamp(last.key,p)}
        const route = routeExpected(desktop,last.key,p)
        return {scope:route.scope,native:null,terminal:null,terminalAdapter:null,desktop,evidence:{},route}
      } catch { deny('target-drift'); return null }
    },
    dispatch(plan: Readonly<Plan>, s, context) {
      const t = now()
      if (!p || !validProof(p,t)) return fail('proof-unavailable')
      const live = owned(s,t)
      if (!live) return fail('selection-unverified')
      if (plan.kind !== 'desktop' || plan.address !== codexDesktop.prefix + s.id ||
          !validDesktop({handler:plan.route.handler,registration:packageStamp}) ||
          hash(plan.route) !== hash(routeExpected({handler:plan.route.handler,registration:bindingStamp(live.key,p)},live.key,p)))
        return fail('target-drift')
      const remaining = Math.min(live.until,p.expiresAt,t+8_000,context?.until ?? Infinity)
      if (now() >= remaining || (context && !context.canCommit())) return fail('expired')
      const tick = ticks()
      for (const [id,until] of cooldown) if (until <= tick) cooldown.delete(id)
      if (cooldown.has(s.id) || cooldown.size >= 128) return fail('duplicate')
      cooldown.set(s.id,tick+5_000)
      let accepted = false
      try { accepted = io.request(s.id,remaining,context?.canCommit) } catch { /* one attempt */ }
      if (!accepted) return fail('launch-rejected')
    }
  }
}

export function brokerTransport(resources: string, digest: string, onlyProvenId: string): DesktopTransport {
  const exe = win32.join(resources,'m45-desktop','CodexDesktopBroker.exe')
  const checked = () => {
    if (process.platform !== 'win32' || process.arch!=='x64' || !sha(digest) || !localPath(exe) ||
        realpathSync.native(exe).toLowerCase() !== exe.toLowerCase()) throw new Error('broker unavailable')
    const st=canonicalTerminalPath(exe,true)
    const bytes=readFileSync(exe)
    if (st.size!==BigInt(bytes.length) || bytes.length>128*1024 || createHash('sha256').update(bytes).digest('hex')!==digest)
      throw new Error('broker drift')
    const pe=bytes.readUInt32LE(60), after=lstatSync(exe,{bigint:true})
    if (bytes.readUInt16LE(0)!==0x5a4d || bytes.readUInt32LE(pe)!==0x4550 || bytes.readUInt16LE(pe+4)!==0x8664 ||
        bytes.readUInt16LE(pe+22)&0x2000 ||
        [st.dev,st.ino,st.birthtimeNs,st.mtimeNs,st.ctimeNs,st.size,st.nlink].some((x,i)=>
          x!==[after.dev,after.ino,after.birthtimeNs,after.mtimeNs,after.ctimeNs,after.size,after.nlink][i]))
      throw new Error('broker identity drift')
    return exe
  }
  const options = { shell:false,windowsHide:true,timeout:9_000,maxBuffer:2048,encoding:'utf8' as const }
  return {
    permits: id => id === onlyProvenId,
    async verify() {
      const path = await new Promise<string | null>(resolve => execFile(checked(),['verify'],options,
        (error,out) => resolve(error ? null : out.trim())))
      return path ? {registration:packageStamp,handler:{path,version:codexDesktop.version,sha256:codexDesktop.exe}} : null
    },
    request(id,until,canCommit) {
      const t = Date.now()
      if (!uuid(id) || id !== onlyProvenId || !Number.isSafeInteger(until) || until <= t || until - t > 8_000) return false
      const executable=checked()
      if (!canCommit?.() || Date.now()>=until) return false
      const r = spawnSync(executable,['dispatch'],{...options,stdio:['pipe','pipe','pipe'],input:id+'\n'+String(until)})
      return !r.error && r.status === 0 && r.stdout.trim() === 'requested'
    }
  }
}

/** Copy-only default. This factory takes no authorization, URI, app or handler path from runtime config. */
export function createDesktopAdapter(read: OwnershipReader, packaged:boolean): VerifiedResumeAdapter | undefined {
  const p = sealedDesktopProof
  return packaged && p && p.brokerSha256===desktopBrokerSha && process.platform==='win32' && process.arch==='x64'
    ? desktopPolicy(p,read,brokerTransport(process.resourcesPath,desktopBrokerSha,p.a)) : undefined
}
