import { lstatSync, opendirSync, realpathSync, statSync } from 'node:fs'
import { win32 } from 'node:path'
import type { DirectoryEvidence } from './ownership'

export function verifiedDirectory(input:unknown):DirectoryEvidence|null {
  if (typeof input!=='string' || input.length>32767 || /[\x00-\x1f]/u.test(input)) return null
  const path=input.replaceAll('/','\\')
  // Reject device namespaces, relative drive paths, and incomplete UNC roots.
  if (!/^[a-z]:\\/i.test(path) && !/^\\\\[^\\?.][^\\]*\\[^\\]+(?:\\|$)/u.test(path)) return null
  try {
    const canonical=realpathSync.native(path)
    const before=lstatSync(canonical,{bigint:true})
    if (!before.isDirectory() || before.ino===0n) return null
    // Opening the directory verifies access without enumerating project files.
    opendirSync(canonical).closeSync()
    const after=statSync(path,{bigint:true})
    const latest=lstatSync(canonical,{bigint:true})
    if ([after,latest].some(s=>!s.isDirectory() || s.dev!==before.dev || s.ino!==before.ino)) return null
    const normal=win32.normalize(canonical)
    return {canonicalWindowsPath:normal.length===win32.parse(normal).root.length?normal:normal.replace(/\\$/u,'')}
  } catch { return null }
}

