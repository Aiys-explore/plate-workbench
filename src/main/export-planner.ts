export type LinkResolution =
  | { readonly kind: 'resolved'; readonly targetNoteId: string }
  | { readonly kind: 'broken' }
  | { readonly kind: 'ambiguous'; readonly candidateNoteIds: readonly string[] }
  | { readonly kind: 'outside-scope'; readonly targetNoteId: string };

export interface WikiLink {
  readonly raw: string;
  readonly resolution: LinkResolution;
}

export interface SourceNote {
  readonly noteId: string;
  readonly sourceRelativePath: string;
  readonly links: readonly WikiLink[];
}

export interface ExportRequest {
  readonly scope: 'single' | 'project';
  readonly existing?: 'number' | 'skip';
  readonly notes: readonly SourceNote[];
  // UTF-16 units. Path budget is the remaining allowance for the basename,
  // after the caller accounts for the actual target directory and separator.
  readonly maxNameUnits: number;
  readonly remainingPathUnits: number;
  readonly occupiedNames: readonly string[];
}

export type NamingReason = 'sanitized' | 'shortened' | 'batch-conflict' | 'existing-conflict' | 'mapping-conflict';
type Assignment =
  | { readonly status: 'planned'; readonly fileName: string }
  | { readonly status: 'skipped'; readonly reason: 'existing-target' }
  | { readonly status: 'rejected'; readonly reason: 'no-safe-name'; readonly stage: 'batch' | 'destination' };
export interface NoteRow {
  readonly noteId: string;
  readonly sourceRelativePath: string;
  readonly originalName: string;
  readonly batchName: string | null;
  readonly naming: readonly NamingReason[];
  readonly destination: Assignment;
}
type LinkTarget =
  | { readonly targetNoteId: string; readonly fileName: string }
  | { readonly targetNoteId: string; readonly reason: 'existing-target' | 'no-safe-name' };
type LinkRow<T> = { readonly sourceNoteId: string; readonly raw: string; readonly target: T };
export interface LinkMap {
  readonly internal: readonly LinkRow<LinkTarget & { readonly fileName: string }>[];
  readonly skipped: readonly LinkRow<LinkTarget & { readonly reason: 'existing-target' }>[];
  readonly unavailable: readonly LinkRow<LinkTarget & { readonly reason: 'no-safe-name' }>[];
  readonly outsideScope: readonly LinkRow<{ readonly targetNoteId: string }>[];
  readonly broken: readonly LinkRow<null>[];
  readonly ambiguous: readonly LinkRow<{ readonly candidateNoteIds: readonly string[] }>[];
}

export interface ExportPlan {
  readonly scope: ExportRequest['scope'];
  readonly nameBudget: number;
  readonly notes: readonly NoteRow[];
  readonly links: LinkMap;
  readonly mapping: null | { readonly status: 'planned'; readonly fileName: string; readonly naming: readonly NamingReason[] }
    | { readonly status: 'rejected'; readonly reason: 'no-safe-name' };
  readonly blockers: readonly ('empty-scope' | 'all-skipped' | 'note-name-unavailable' | 'mapping-name-unavailable')[];
}

const device = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/iu;
const trailing = /[\s.]+$/u;
const reserved = (s: string): boolean => device.test((s.split('.')[0] ?? '').replace(trailing, ''));
const key = (s: string): string => s.replace(trailing, '').normalize('NFC').toLowerCase().toUpperCase().normalize('NFC');
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function clean(name: string): { stem: string; ext: string; changed: boolean } {
  const safe = Array.from(name.replace(trailing, ''), c => /[<>:"/\\|?*\x00-\x1f\ud800-\udfff]/u.test(c) ? '_' : c)
    .join('').replace(trailing, '');
  const dot = safe.lastIndexOf('.');
  let stem = (dot > 0 ? safe.slice(0, dot) : safe) || '_';
  const ext = dot > 0 ? safe.slice(dot) : '';
  if (reserved(stem + ext)) stem = '_' + stem;
  return { stem, ext, changed: stem + ext !== name };
}

interface Candidate { name: string; ordinal: number; shortened: boolean }
function allocate(parts: ReturnType<typeof clean>, budget: number, start: number, occupied: ReadonlySet<string>): Candidate | null {
  // Distinct ordinals yield distinct comparison keys; at most occupied.size
  // can be occupied. A longer suffix cannot restore a failed length budget.
  for (let i = start; i <= start + occupied.size; i++) {
    const suffix = i === 1 ? '' : ' (' + i + ')';
    const room = budget - suffix.length - parts.ext.length;
    if (room < 1) return null;
    let stem = parts.stem.slice(0, room).replace(/[\ud800-\udbff]$/u, '');
    if (!parts.ext && !suffix) stem = stem.replace(trailing, '');
    stem ||= '_';
    if (reserved(stem + suffix + parts.ext)) stem = '_' + stem.slice(1);
    const name = stem + suffix + parts.ext;
    if (!occupied.has(key(name))) return { name, ordinal: i, shortened: parts.stem.length > room };
  }
  return null;
}

export function planWindowsExport(input: ExportRequest): ExportPlan {
  for (const limit of [input.maxNameUnits, input.remainingPathUnits]) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Invalid UTF-16 name budget');
  }
  if (input.scope === 'single' && input.notes.length > 1) throw new TypeError('Single scope accepts at most one note');
  const budget = Math.min(input.maxNameUnits, input.remainingPathUnits);
  const batch = new Set<string>();
  const ids = new Set<string>();
  const staged = [...input.notes].sort((a, b) => compare(a.noteId, b.noteId)).map(note => {
    if (!note.noteId || ids.has(note.noteId)) throw new TypeError('Missing or duplicate noteId');
    ids.add(note.noteId);
    const segments = note.sourceRelativePath.split(/[/\\]/u);
    const originalName = segments.at(-1);
    if (!originalName || /^[a-z]:/iu.test(note.sourceRelativePath)
      || segments.some(p => !p || p === '.' || p === '..')) throw new TypeError('Expected a verified source relative path');
    const parts = clean(originalName);
    const candidate = allocate(parts, budget, 1, batch);
    if (candidate) batch.add(key(candidate.name));
    return { note, originalName, parts, candidate };
  });
  const external = new Set(input.occupiedNames.map(key));
  const taken = new Set([...batch, ...external]);
  const notes = staged.map(({ note, originalName, parts, candidate }): NoteRow => {
    const naming: NamingReason[] = [];
    if (parts.changed) naming.push('sanitized');
    if (candidate?.ordinal && candidate.ordinal > 1) naming.push('batch-conflict');
    let destination: Assignment;
    let final = candidate;
    if (!candidate) destination = { status: 'rejected', reason: 'no-safe-name', stage: 'batch' };
    else if (!external.has(key(candidate.name))) destination = { status: 'planned', fileName: candidate.name };
    else {
      naming.push('existing-conflict');
      if (input.existing === 'skip') destination = { status: 'skipped', reason: 'existing-target' };
      else {
        final = allocate(parts, budget, candidate.ordinal + 1, taken);
        destination = final ? { status: 'planned', fileName: final.name }
          : { status: 'rejected', reason: 'no-safe-name', stage: 'destination' };
        if (final) taken.add(key(final.name));
      }
    }
    if (candidate?.shortened || final?.shortened) naming.push('shortened');
    return { noteId: note.noteId, sourceRelativePath: note.sourceRelativePath, originalName,
      batchName: candidate?.name ?? null, naming, destination };
  });

  const mappingParts = clean('mapping.json');
  const mappingName = input.scope === 'project' && notes.length ? allocate(mappingParts, budget, 1, taken) : null;
  const mapping: ExportPlan['mapping'] = mappingName ? {
    status: 'planned', fileName: mappingName.name,
    naming: [...(mappingName.ordinal > 1 ? ['mapping-conflict' as const] : []),
      ...(mappingName.shortened ? ['shortened' as const] : [])],
  } : input.scope === 'project' && notes.length ? { status: 'rejected', reason: 'no-safe-name' } : null;

  const byId = new Map(notes.map(n => [n.noteId, n.destination]));
  const links = {
    internal: [], skipped: [], unavailable: [], outsideScope: [], broken: [], ambiguous: [],
  } satisfies { [K in keyof LinkMap]: [] } as { [K in keyof LinkMap]: LinkMap[K][number][] };
  for (const { note } of staged) for (const { raw, resolution } of note.links) {
    const row = { sourceNoteId: note.noteId, raw };
    switch (resolution.kind) {
      case 'broken': links.broken.push({ ...row, target: null }); break;
      case 'ambiguous': links.ambiguous.push({ ...row, target: { candidateNoteIds: [...resolution.candidateNoteIds].sort(compare) } }); break;
      case 'outside-scope': links.outsideScope.push({ ...row, target: { targetNoteId: resolution.targetNoteId } }); break;
      case 'resolved': {
        const { targetNoteId } = resolution;
        const target = byId.get(targetNoteId);
        if (!target) links.outsideScope.push({ ...row, target: { targetNoteId } });
        else if (target.status === 'planned') links.internal.push({ ...row, target: { targetNoteId, fileName: target.fileName } });
        else if (target.status === 'skipped') links.skipped.push({ ...row, target: { targetNoteId, reason: target.reason } });
        else links.unavailable.push({ ...row, target: { targetNoteId, reason: target.reason } });
        break;
      }
    }
  }
  const blockers: ExportPlan['blockers'][number][] = [];
  if (!notes.length) blockers.push('empty-scope');
  else if (notes.every(n => n.destination.status === 'skipped')) blockers.push('all-skipped');
  if (notes.some(n => n.destination.status === 'rejected')) blockers.push('note-name-unavailable');
  if (mapping?.status === 'rejected') blockers.push('mapping-name-unavailable');
  return { scope: input.scope, nameBudget: budget, notes, links, mapping, blockers };
}
