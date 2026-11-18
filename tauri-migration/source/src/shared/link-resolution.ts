import type { NoteSummary } from './ipc'

export const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export const normalizeTitle = (title: string) => title.normalize('NFC').toLowerCase()
export const referenceKey = (title: string) => normalizeTitle(title.trim().replace(/\.md$/i, ''))
export const isUuid = (ref: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ref)

export function linkCatalog(notes: Iterable<NoteSummary>) {
  const byId = new Map<string, NoteSummary>()
  const byTitle = new Map<string, NoteSummary[]>()
  for (const note of notes) {
    byId.set(note.id, note)
    if (note.kind !== 'note') continue
    const key = normalizeTitle(note.title)
    const matches = byTitle.get(key)
    if (matches) matches.push(note)
    else byTitle.set(key, [note])
  }
  return { byId, byTitle }
}

export type LinkResolution =
  | { status: 'resolved'; note: NoteSummary }
  | { status: 'ambiguous'; candidates: NoteSummary[] }
  | { status: 'missing' }

export function resolveLink(catalog: ReturnType<typeof linkCatalog>, ref: string, bound: string | null | undefined): LinkResolution {
  if (isUuid(ref) || typeof bound === 'string') {
    const note = catalog.byId.get(bound ?? ref)
    return note ? { status: 'resolved', note } : { status: 'missing' }
  }
  const candidates = catalog.byTitle.get(ref) ?? []
  if (!candidates.length) return { status: 'missing' }
  if (candidates.length > 1 || bound === null) return { status: 'ambiguous', candidates }
  return { status: 'resolved', note: candidates[0] }
}
