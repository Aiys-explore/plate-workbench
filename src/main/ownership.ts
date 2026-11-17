// Main-side input only. A scanner's raw cwd or user-entered path is not verification.
// The resolver must open a readable directory, resolve aliases/reparse points and
// return canonical on-disk spelling (including UNC share spelling).
export interface DirectoryEvidence {
  readonly canonicalWindowsPath: string
}
export interface Project {
  readonly id: string
  readonly name: string
  readonly archivedAt: number | null
  readonly root: DirectoryEvidence | null
}
export type Decision =
  | { readonly kind: 'undecided' }
  | { readonly kind: 'manual-unassigned' }
  | { readonly kind: 'manual-project'; readonly projectId: string }

type Inherited = { readonly noteId: string; readonly blockId: string; readonly projectId: string | null }
const DEFAULT_PROJECT = 'default'
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const invalidPart = (s: string) => !s || /[<>:"|?*\x00-\x1f]/u.test(s) || /[. ]$/u.test(s)

function segments(evidence: DirectoryEvidence | null): string[] | null {
  if (!evidence) return null
  let path = evidence.canonicalWindowsPath
  if (/^\\\\\?\\UNC\\/iu.test(path)) path = '\\\\' + path.slice(8)
  else if (/^\\\\\?\\[a-z]:\\/iu.test(path)) path = path.slice(4)
  if (/[\/\x00-\x1f]/u.test(path)) return null
  const drive = /^([a-z]):\\(.*)$/iu.exec(path)
  const unc = /^\\\\([^\\]+)\\([^\\]+)(?:\\(.*))?$/u.exec(path)
  if (!drive && !unc) return null
  const tail = (drive?.[2] ?? unc?.[3] ?? '').replace(/\\$/u, '')
  const parts = tail ? tail.split('\\') : []
  if ((drive?.[2] ?? unc?.[3]) === '\\' || parts.some(invalidPart)) return null
  if (drive?.[1]) return [drive[1].toUpperCase() + ':', ...parts]
  const host = unc?.[1], share = unc?.[2]
  if (!host || !share || invalidPart(host) || invalidPart(share)) return null
  // DNS/NetBIOS host aliases must already be resolved by the evidence provider.
  return ['UNC', host.replace(/[A-Z]/g, c => c.toLowerCase()), share, ...parts]
}

export function suggestOwnership(
  cwd: DirectoryEvidence | null, projects: readonly Project[], decision: Decision,
  binding: Inherited | null = null,
) {
  const seen = new Set<string>()
  for (const project of projects) {
    if (!project.id.trim() || seen.has(project.id)) throw new Error('Invalid or duplicate project ID')
    seen.add(project.id)
  }
  const path = segments(cwd)
  const candidates = projects.filter(p => p.archivedAt === null && p.id !== DEFAULT_PROJECT).map(project => {
    const root = segments(project.root)
    const matches = !!path && !!root && root.every((part, i) => part === path[i])
    return {
      project,
      evidence: matches ? (root.length === path.length ? 'exact' as const : 'ancestor' as const)
        : !root ? 'no-verified-root' as const : !path ? 'no-verified-cwd' as const : 'outside-root' as const,
      depth: matches ? root.length : 0,
    }
  }).sort((a, b) => b.depth - a.depth || ordinal(a.project.id, b.project.id))
  const matches = candidates.filter(c => c.evidence === 'exact' || c.evidence === 'ancestor')
  const suggestion = !path ? { kind: 'unknown-cwd' as const }
    : matches.length === 1 ? { kind: 'unique' as const, projectId: matches[0]!.project.id }
    : matches.length > 1 ? { kind: 'choose' as const, projectIds: matches.map(m => m.project.id) }
    : { kind: 'no-match' as const }
  const effective = binding ? {
    kind: 'inherited' as const, ...binding, projectId: binding.projectId === DEFAULT_PROJECT ? null : binding.projectId,
  } : decision.kind === 'manual-project' ? {
    kind: 'manual' as const, projectId: decision.projectId,
    status: decision.projectId === DEFAULT_PROJECT || !seen.has(decision.projectId) ? 'missing' as const
      : candidates.some(c => c.project.id === decision.projectId) ? 'active' as const : 'archived' as const,
  } : { kind: decision.kind, projectId: null }
  return { candidates, suggestion, effective }
}

// At the unlink transition only: the stored manual choice remains intact.
export function detachedProject(decision: Decision, projects: readonly Project[]): string | null {
  return decision.kind === 'manual-project' && decision.projectId !== DEFAULT_PROJECT &&
    projects.some(p => p.id === decision.projectId && p.archivedAt === null) ? decision.projectId : null
}
