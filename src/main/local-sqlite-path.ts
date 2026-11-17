import { win32 } from 'node:path'

// SQLite on Windows may otherwise hit MAX_PATH, including its sibling journal.
// Keep durable workspace coordinates human-readable; namespace only the actual open.
export function localSqlitePath(file: string) {
  if (process.platform === 'win32' && file.length + '-journal'.length >= 260 && /^[a-z]:[\\/]/i.test(file))
    return win32.toNamespacedPath(file)
  return file
}
