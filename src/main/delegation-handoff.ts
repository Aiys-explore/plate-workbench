import { readdirSync, readFileSync, realpathSync, statSync, lstatSync } from 'node:fs'
import { basename, join, normalize } from 'node:path'
import { externalUuid, hash, isInside, realCwd } from './delegation-cli'

const filename = /^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-([0-9a-f-]{36})\.jsonl$/
const fold = (s: string) => normalize(s).toLowerCase()
const pad = (n: number) => String(n).padStart(2, '0')
export const handoffWindow = 15 * 60_000

// Only today's time neighborhood is inspected, and only regular Codex rollout
// names. Older sessions and external log/chat projections are never candidates.
export function rolloutFiles(root: string, since: number) {
  const canonical = realpathSync(root)
  if (!statSync(canonical).isDirectory() || fold(canonical) !== fold(root)) throw new Error('无法核对日志目录。')
  const days = new Set<string>()
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const date = new Date(since + offset)
    days.add(join(canonical, String(date.getFullYear()), pad(date.getMonth()+1), pad(date.getDate())))
  }
  const paths = new Map<string, string>()
  for (const day of days) {
    const info = lstatSync(day, { throwIfNoEntry: false })
    if (!info) continue
    if (!info.isDirectory() || fold(realpathSync(day)) !== fold(day)) throw new Error('日志日目录无法核对。')
    for (const entry of readdirSync(day, { withFileTypes: true })) {
      const id = filename.exec(entry.name)?.[1]
      if (!id || !externalUuid.test(id)) continue
      if (!entry.isFile() || paths.has(id) || paths.size >= 3000) throw new Error('日志不唯一或超过扫描范围。')
      paths.set(id, join(day, entry.name))
    }
  }
  return paths
}

export function matchRollouts(root: string, since: number, before: ReadonlySet<string>, text: string, cwd: string) {
  const now = Date.now()
  if (now < since || now - since > handoffWindow) throw new Error('本次交接的核对时段已结束。')
  const matches: { externalId: string; at: string; ref: string }[] = []
  const files = [...rolloutFiles(root, since)].filter(([id]) => !before.has(id))
  if (files.length > 32) throw new Error('新会话过多，无法安全列全。')
  for (const [id, file] of files) {
    const real = realpathSync(file)
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || fold(real) !== fold(file) ||
        !isInside(root, real) || stat.size > 2_000_000) throw new Error('日志暂时无法完整核对。')
    const rows = readFileSync(real, 'utf8').split('\n')
    // Ignore a partial final line while the external client is writing. A
    // candidate requires a complete first actual UserMessage event.
    rows.pop()
    if (!rows[0]) continue
    const head = JSON.parse(rows[0])
    const meta = head.payload
    const t = Date.parse(meta?.timestamp)
    if (head.type !== 'session_meta' || (meta?.session_id ?? meta?.id) !== id ||
        (meta?.session_id && meta?.id && meta.session_id !== meta.id)) throw new Error('日志头与会话 ID 不符。')
    if (!Number.isFinite(t) || t < since || t > now || typeof meta.cwd !== 'string') continue
    if (fold(meta.cwd) !== fold(cwd) || fold(realCwd(cwd)) !== fold(cwd)) continue
    for (const row of rows.slice(1)) {
      if (!row.trim()) continue
      const event = JSON.parse(row)
      if (event.type !== 'event_msg' || event.payload?.type !== 'item_completed' ||
          event.payload?.item?.type !== 'UserMessage') continue
      const items = event.payload.item.content
      if (Array.isArray(items) && items.length === 1 && items[0]?.type === 'text' && items[0]?.text === text) {
        matches.push({ externalId: id, at: new Date(t).toISOString(), ref: basename(file)+':'+hash(rows[0]+'\n'+row) })
      }
      break
    }
  }
  return matches
}
