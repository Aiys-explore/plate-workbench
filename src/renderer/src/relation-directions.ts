import type { NoteEdge, NoteSummary } from '../../shared/ipc'

// The stored edge is citing note → cited note. In the flow, material moves
// from the cited note to the note that uses it.
export function noteRelations<T extends NoteSummary>(edges: NoteEdge[], notes: ReadonlyMap<string, T>, id?: string) {
  const upstream = new Map<string, T>()
  const downstream = new Map<string, T>()
  let self = false
  if (id) for (const {source, target} of edges) {
    if (source === id && target === id) { self = true; continue }
    if (source === id && notes.has(target)) upstream.set(target, notes.get(target)!)
    if (target === id && notes.has(source)) downstream.set(source, notes.get(source)!)
  }
  return { upstream: [...upstream.values()], downstream: [...downstream.values()], self }
}
