import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { discover } from './agent-probe'

export type Availability = 'client-not-found' | 'registration-only' | 'cannot-locate' | 'unknown'
const protocols: Record<string,string> = {
  codex:'codex', deepseek:'dsh', zcode:'zcode', workbuddy:'workbuddy', opencode:'opencode'
}

function query(scheme: string, suffix: string, value: string[]): Promise<string | null> {
  const root = process.env.SystemRoot
  if (!root || !/^[A-Za-z]:\\[^\r\n]+$/.test(root)) return Promise.resolve(null)
  return new Promise(resolve => execFile(join(root,'System32','reg.exe'),
    ['query','HKCR\\'+scheme+suffix,...value], {windowsHide:true,shell:false,timeout:1500,maxBuffer:16384},
    (err,out)=>resolve(err ? null : out)))
}
const fileStatus = async (path: string) => {
  if (!/^[A-Za-z]:[\\/]/.test(path)) return 'unknown'
  try {
    const st = await lstat(path)
    return st.isFile() && !st.isSymbolicLink() ? 'present' : 'unknown'
  } catch (e) { return ['ENOENT','ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '') ? 'missing' : 'unknown' }
}

/** Read local registration only. Treat its text as data; never invoke it or infer a route. */
export async function resumeAvailability(agent: string, configured: string | undefined): Promise<Availability> {
  if (process.platform !== 'win32') return 'unknown'
  const scheme = Object.hasOwn(protocols,agent) ? protocols[agent] : undefined
  if (scheme && await query(scheme,'',['/v','URL Protocol'])) {
    const command = await query(scheme,'\\shell\\open\\command',['/ve'])
    const path = command?.match(/REG_(?:EXPAND_)?SZ[ \t]+"([A-Za-z]:\\[^"%\r\n]+\.exe)"/i)?.[1]
    if (path && await fileStatus(path) === 'missing') return 'client-not-found'
    return 'registration-only'
  }
  if (configured && await fileStatus(configured) === 'missing') return 'client-not-found'
  // Scope this negative finding to the discovery locations and configured path.
  if (!configured && (agent === 'grok-cli' || agent === 'claude')) {
    const native = await discover(agent,AbortSignal.timeout(1600)).catch(()=>null)
    const profile = process.env.USERPROFILE
    if (native?.length === 0 && profile && /^[A-Za-z]:\\/.test(profile)) {
      const paths = agent === 'grok-cli' ? [join(profile,'.grok','bin','grok.exe')] :
        [join(profile,'.local','bin','claude.exe'),join(profile,'.claude','local','claude.exe')]
      if ((await Promise.all(paths.map(fileStatus))).every(x=>x==='missing')) return 'client-not-found'
    }
  }
  return 'unknown'
}
