import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type BigIntStats } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

export const terminalResourceSha = '2a3ead3d626e72ca468ae828ca57f7df6390a863206b88d68ac24e2a0cd0f197'
export const terminalNapi = 8
export type Protocol = 'codex-restricted-v1' | 'grok-restricted-v1'
export type NativeFailure = {status:'rejected'|'unavailable'|'create-failed'; win32:number}
export type NativeSnapshot = {status:'verified'; win32:0; image:string; cwd:string; sha256:string}
export interface NativeTerminal {
  inspect(image: string, cwd: string): NativeSnapshot | NativeFailure
  dispatch(image: string, cwd: string, imageKey: string, cwdKey: string, sha: string,
    protocol: Protocol, id: string, remainingMs: number): {status:'requested'; win32:0} | NativeFailure
}

const fold=(x:string)=>x.toLowerCase()
const stamp=(s:BigIntStats)=>[s.dev,s.ino,s.birthtimeNs,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':')
export function canonicalTerminalPath(path:string,file:boolean):BigIntStats {
  if (!/^[A-Za-z]:\\/.test(path) || normalize(path)!==path ||
      /[\x00-\x1f\x7f<>:"/|?*]/.test(path.slice(2)) || /\\Microsoft\\WindowsApps\\/i.test(path) ||
      path.slice(3).split('\\').some(p=>/[. ]$/.test(p) || /^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]) *(?:\.|$)/i.test(p)))
    throw Error('noncanonical path')
  const leaf=lstatSync(path,{bigint:true})
  if (fold(realpathSync.native(path))!==fold(path)) throw Error('path redirect')
  for (let p=path;;p=dirname(p)) {
    const s=p===path?leaf:lstatSync(p,{bigint:true})
    if (s.isSymbolicLink() || (p===path && file ? !s.isFile() || s.nlink!==1n : !s.isDirectory()) || !s.ino)
      throw Error('untrusted path entry')
    if (p===dirname(p)) return leaf
  }
}

type Install = { packaged: boolean; executable: string; resources: string; asar: string }
export interface TerminalResource {
  open(): NativeTerminal | null
  current(): boolean
}

/** Resources are trusted to the same extent as the installed ASAR/exe. The installed directory
 * must be protected against other writers; Windows Node require does not load from a pinned fd.
 * The field scope authority must independently prove this premise before offering dispatch. */
export function terminalResource(install:Install):TerminalResource {
  let loaded:{addon:NativeTerminal; stamp:string}|undefined
  const file=join(install.resources,'m45-terminal.node')
  function readStamp() {
    if (!install.packaged || process.platform!=='win32' || process.arch!=='x64' ||
        Number(process.versions.napi)<terminalNapi || !process.versions.electron ||
        fold(join(dirname(install.executable),'resources'))!==fold(install.resources) ||
        fold(join(install.resources,'app.asar'))!==fold(install.asar)) throw Error('not installed Electron')
    return stamp(canonicalTerminalPath(file,true))
  }
  return {
    open() {
      try {
        const identity=readStamp()
        if (loaded) return loaded.stamp===identity ? loaded.addon : null
        const fd=openSync(file,'r')
        try {
          const before=fstatSync(fd,{bigint:true})
          if (stamp(before)!==identity || before.size<64n || before.size>4n*1024n*1024n) return null
          const bytes=readFileSync(fd)
          if (createHash('sha256').update(bytes).digest('hex')!==terminalResourceSha ||
              bytes.readUInt16LE(0)!==0x5a4d || stamp(fstatSync(fd,{bigint:true}))!==identity ||
              readStamp()!==identity) return null
          const pe=bytes.readUInt32LE(60)
          if (bytes.readUInt32LE(pe)!==0x4550 || bytes.readUInt16LE(pe+4)!==0x8664 ||
              (bytes.readUInt16LE(pe+22)&0x2002)!==0x2002 || bytes.readUInt16LE(pe+24)!==0x20b) return null
          const addon:NativeTerminal=require(file)
          if (Object.keys(addon).sort().join(',')!=='dispatch,inspect' ||
              typeof addon.inspect!=='function' || typeof addon.dispatch!=='function' ||
              addon.inspect('','').status!=='rejected' || readStamp()!==identity) return null
          loaded={addon,stamp:identity}
          return addon
        } finally {closeSync(fd)}
      } catch {return null}
    },
    current() {
      try {return !!loaded && loaded.stamp===readStamp()} catch {return false}
    }
  }
}
