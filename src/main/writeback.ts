import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'
import { createHash } from 'node:crypto'

export interface Target { noteId: string; blockId: string }
export interface Round extends Target { runId: string; ordinal: number }
export interface VerifiedConclusion extends Round {
  evidence: 'verified-for-display'
  summary: string
  durationMs: number | null
  tokens: number | null
}
export interface Authority {
  current: Round
  lastWritten: (Round & { fingerprint: string }) | null
}
export interface TaskView {
  rawLine: string; text: string; blockId?: string; issue?: string; marker: object | null
  includedLines: number[]; excludedRoots: number[]
}
// Inject the M3.3 replacement scanDelegation. Offsets in its view are one-based lines.
export type Scan = (source: string) => {
  lines: number[]; taskAt(line: number): TaskView | undefined
  anchors: { blockId: string; claimedNoteId: string; line: number }[]
  resultRegions: { runId: string; startLine: number; endLine: number }[]
  resultIssues: readonly { code: string; line: number }[]
}
export interface Request {
  source: Uint8Array
  target: Target
  conclusion: VerifiedConclusion
  authority: Authority
}
export type ReviewReason = 'invalid-source' | 'invalid-identity' | 'unverified-conclusion' |
  'stale-round' | 'invalid-authority' | 'anchor-missing' | 'anchor-ambiguous' | 'wrong-note' |
  'task-ambiguous' | 'container-ambiguous' | 'damaged-region' | 'unowned-region' |
  'owned-region-missing' | 'region-moved' | 'fingerprint-mismatch' | 'run-collision' |
  'replay-mismatch' | 'structure-changed' | 'parser-unavailable'
export type Plan =
  | { kind: 'review'; reason: ReviewReason }
  | { kind: 'noop'; fingerprint: string }
  | { kind: 'insert' | 'update'; fingerprint: string; edit: {
      startByte: number; endByte: number; replacement: Uint8Array
    } }

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const identity = new RegExp(`^${uuid}$`)
const anchorSyntax = new RegExp(`^<!-- workbench-task:(${uuid}) note:(${uuid}) -->$`)
const edge = (direction: 'start' | 'end', run: string) => `<!-- workbench-result:${direction}:${run} -->`
const encode = new TextEncoder()
const sha = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
const review = (reason: ReviewReason): Plan & { kind: 'review' } => ({ kind: 'review', reason })
const sameTarget = (a: Target, b: Target) => a.noteId === b.noteId && a.blockId === b.blockId
const sameRound = (a: Round, b: Round) => sameTarget(a, b) && a.runId === b.runId && a.ordinal === b.ordinal
const validTarget = (t: Target) => t && typeof t.noteId === 'string' && typeof t.blockId === 'string' &&
  t.noteId.length === 36 && t.blockId.length === 36 && identity.test(t.noteId) && identity.test(t.blockId)
const validRound = (r: Round) => validTarget(r) && typeof r.runId === 'string' && r.runId.length === 36 && identity.test(r.runId) &&
  Number.isSafeInteger(r.ordinal) && r.ordinal > 0
const validMetric = (n: number | null) => n === null || (Number.isSafeInteger(n) && n >= 0)

function display(c: VerifiedConclusion) {
  if (c.evidence !== 'verified-for-display' || typeof c.summary !== 'string' ||
      c.summary.length > 2000 || !c.summary.trim() || !validMetric(c.durationMs) || !validMetric(c.tokens) ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF\uD800-\uDFFF]/u.test(c.summary) ||
      /workbench\s*-\s*(?:task|result)\b|<!--\s*agent\s*:|<\|[^\n]*?\|>|\[\/?INST\]/i.test(c.summary.normalize('NFKC'))) return
  // Use character references instead of admitting Markdown/HTML/agent syntax from the payload.
  const summary = c.summary.trim().replace(/\s+/gu, ' ')
    .replace(/[!-/:-@[-`{-~]/g, ch => `&#${ch.charCodeAt(0)};`)
  const sec = c.durationMs === null ? null : Math.floor(c.durationMs / 1000)
  const pad = (v: number) => String(v).padStart(2, '0')
  const clock = sec === null ? '未知' : (sec >= 3600 ? Math.floor(sec / 3600) + ':' : '') + pad(Math.floor(sec / 60) % 60) + ':' + pad(sec % 60)
  const metric = `⏱ 用时 ${clock} · tokens ${c.tokens === null ? '未知' : c.tokens}`
  return { summary, metric }
}

interface Line { start: number; end: number; norm: number; text: string; eol: string }
function parse(raw: string) {
  const lines: Line[] = []
  const eols = /\r\n|\r|\n/g
  let start = Number(raw.startsWith('\uFEFF')), norm = 0
  for (;;) {
    eols.lastIndex = start
    const match = eols.exec(raw)
    const end = match?.index ?? raw.length
    lines.push({ start, end, norm, text: raw.slice(start, end), eol: match?.[0] ?? '' })
    if (!match) break
    start = end + match[0].length
    norm += end - lines.at(-1)!.start + 1
  }
  const lf = lines.map(l => l.text).join('\n')
  const yaml = /^---[ \t]*\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?=\n|$)/m.exec(lf)
  const masked = yaml?.index === 0 ? yaml[0].length : /^---[ \t]*\n(?:[ \t]*#[^\n]*\n)*[ \t]*[\w-]+[ \t]*:/.test(lf) ? lf.length : 0
  const source = lf.slice(0, masked).replace(/[^\n]/g, ' ') + lf.slice(masked)
  const row = (pos: number) => {
    let low = 0, high = lines.length
    while (high - low > 1) {
      const mid = (low + high) >>> 1
      if (lines[mid].norm <= pos) low = mid
      else high = mid
    }
    return low
  }
  return { lines, source, row, tree: markdownLanguage.parser.parse(source) }
}
type Parsed = ReturnType<typeof parse>
type View = ReturnType<Scan>
const is = (n: SyntaxNode | null, ...names: string[]) => !!n && names.includes(n.name)
const leafName = (n: SyntaxNode) => is(n, 'Paragraph', 'Task')
const header = (n: SyntaxNode) => /^(?:ATX|Setext)Heading/.test(n.name)
const directive = (n: SyntaxNode, p: Parsed) => {
  const first = p.source.slice(n.from, p.lines[p.row(n.from)].norm + p.lines[p.row(n.from)].text.length)
  return is(n, 'CommentBlock') ? /^<!--\s*agent\s*:/i.test(first) :
    is(n, 'FencedCode') && /^(?:`{3,}|~{3,})[ \t]*agent[ \t]*$/i.test(first)
}

function locate(p: Parsed, view: View, target: Target) {
  const matches = view.anchors.filter(a => a.blockId === target.blockId)
  let suspicious = false
  p.tree.iterate({ enter(n) {
    if (suspicious || !is(n.node, 'Comment', 'CommentBlock')) return
    const value = p.source.slice(n.from, n.to).trimEnd()
    if (/^<!--\s*workbench\s*-\s*task\b/i.test(value) && value.toLowerCase().includes(target.blockId) &&
        anchorSyntax.exec(value)?.[1] !== target.blockId) suspicious = true
  } })
  if (suspicious) return review('anchor-ambiguous')
  if (!matches.length) return review('anchor-missing')
  if (matches.length !== 1) return review('anchor-ambiguous')
  if (matches[0].claimedNoteId !== target.noteId) return review('wrong-note')
  const row = matches[0].line - 1
  if (view.anchors.filter(a => a.line === row + 1).length !== 1) return review('anchor-ambiguous')
  const task = view.taskAt(row + 1)
  if (!task?.marker || task.issue || task.blockId !== target.blockId) return review('task-ambiguous')
  let comment: SyntaxNode | undefined
  const line = p.lines[row]
  p.tree.iterate({ from: line.norm, to: line.norm + line.text.length, enter(n) {
    if (n.name !== 'Comment' || p.row(n.from) !== row) return
    const a = anchorSyntax.exec(p.source.slice(n.from, n.to))
    if (a?.[1] === target.blockId && a[2] === target.noteId && /^[ \t]*$/.test(line.text.slice(n.to - line.norm))) comment = n.node
  } })
  if (!comment) return review('container-ambiguous')
  const leaf = comment.parent
  const scope = leaf?.parent
  if (!leaf || !leafName(leaf) || !scope || !is(scope, 'Document', 'ListItem', 'Blockquote') ||
      p.row(leaf.from) !== row) return review('container-ambiguous')
  if (is(scope, 'ListItem') && !is(leaf.prevSibling, 'ListMark')) return review('container-ambiguous')
  const tail = p.row(leaf.to - 1)
  if (view.lines.some(n => n > row + 1 && n <= tail + 1) ||
      view.anchors.some(a => a.line > row + 1 && a.line <= tail + 1)) return review('container-ambiguous')
  let slot = tail
  let next = leaf.nextSibling
  while (next && p.row(next.from) === slot + 1 && directive(next, p)) {
    slot = p.row(next.to - 1)
    next = next.nextSibling
  }
  // Keep the quote marks and turn any list marker on the owner line into the
  // same number of spaces. The candidate is subsequently checked in both parsers.
  let prefix = line.text.slice(0, leaf.from - line.norm)
  for (let n: SyntaxNode | null = scope; n; n = n.parent) {
    if (!is(n, 'Document', 'Blockquote', 'ListItem', 'BulletList', 'OrderedList')) return review('container-ambiguous')
    if (!is(n, 'ListItem')) continue
    const mark = n.firstChild
    if (!is(mark, 'ListMark') || !mark) return review('container-ambiguous')
    if (p.row(mark.from) === row) {
      const a = mark.from - line.norm, b = mark.to - line.norm
      prefix = prefix.slice(0, a) + ' '.repeat(b - a) + prefix.slice(b)
    }
  }
  if (!/^[ \t>]*$/.test(prefix)) return review('container-ambiguous')
  // A complete pair later in the same owner segment must not be overlooked
  // just because a hand edit moved it off the canonical insertion slot.
  const competing = new Set([...view.lines, ...view.anchors.map(a => a.line)].filter(n => n > row + 1))
  let boundary = Infinity
  for (let n = next; n; n = n.nextSibling) {
    if (header(n) || (leafName(n) && competing.has(p.row(n.from) + 1))) {
      boundary = p.row(n.from)
      break
    }
  }
  const regionNodes = new Map<number, SyntaxNode>()
  for (let n = scope.firstChild; n; n = n.nextSibling) {
    if (is(n, 'CommentBlock')) regionNodes.set(p.row(n.from), n)
  }
  const regions = view.resultRegions.filter(r => r.startLine - 1 > slot && r.startLine - 1 < boundary &&
    regionNodes.has(r.startLine - 1) && regionNodes.has(r.endLine - 1))
  // If a pair begins exactly at the slot in the lexical reader but the
  // editing parser disagrees about its container, don't insert a second one.
  if (view.resultRegions.some(r => r.startLine === slot + 2 && !regions.includes(r))) return review('container-ambiguous')
  // Nested generated blocks are independent only when their container can be
  // traced to another anchored task. A pair tucked into a handwritten quote
  // without a task is not an unambiguous first write for this owner.
  const extent = Math.min(boundary, p.row(Math.max(scope.from, scope.to - 1)) + 1)
  for (const r of view.resultRegions) {
    if (r.startLine - 1 <= slot || r.startLine - 1 >= extent || regions.includes(r)) continue
    const line = p.lines[r.startLine - 1]
    const pos = line.norm + line.text.indexOf(edge('start', r.runId))
    const pairScope = p.tree.resolveInner(pos, 1).parent
    if (!pairScope) return review('container-ambiguous')
    const claimed = view.anchors.some(a => {
      if (a.claimedNoteId !== target.noteId || a.line <= row + 1 || a.line >= r.startLine) return false
      const child = view.taskAt(a.line)
      if (!child?.marker || child.issue || child.blockId !== a.blockId) return false
      const aLine = p.lines[a.line - 1]
      const col = aLine.text.indexOf(`<!-- workbench-task:${a.blockId} `)
      if (col < 0) return false
      const anchorNode = p.tree.resolveInner(aLine.norm + col, 1)
      const owner = anchorNode.parent?.parent
      return is(anchorNode, 'Comment') && !!owner && owner.name === pairScope.name &&
        owner.from === pairScope.from && owner.to === pairScope.to
    })
    if (!claimed) return review('container-ambiguous')
  }
  return { row, slot, prefix, regions }
}

type Window = { from: number; count: number }
const projectedRow = (window: Window, row: number) => row < window.from ? row :
  row >= window.from + window.count ? row - window.count : -1
function structure(p: Parsed, w: Window) {
  const point = (pos: number) => {
    const r = p.row(pos)
    return [projectedRow(w, r), pos - p.lines[r].norm]
  }
  const result: unknown[] = []
  const wrappers = new Set(['Document', 'Blockquote', 'BulletList', 'OrderedList', 'ListItem'])
  // Container extents may grow; unchanged nodes must retain their actual
  // position and ancestor path. Generated lines are projected out of both trees.
  p.tree.iterate({ enter(n) {
    if (point(n.from)[0] < 0 && n.name !== 'Document') return false
    result.push([n.name, point(n.from), wrappers.has(n.name) ? null : point(Math.max(n.from, n.to - 1))])
  }, leave(n) {
    if (point(n.from)[0] >= 0 || n.name === 'Document') result.push(null)
  } })
  return JSON.stringify(result)
}
function tasks(v: View, w: Window) {
  const row = (line: number) => projectedRow(w, line - 1)
  return JSON.stringify({
    anchors: v.anchors.map(a => ({ ...a, line: row(a.line) })),
    tasks: v.lines.map(line => {
      const t = v.taskAt(line)
      return [row(line), t && { rawLine: t.rawLine, text: t.text, blockId: t.blockId, issue: t.issue, marker: t.marker,
        includedLines: t.includedLines.map(row), excludedRoots: t.excludedRoots.map(row) }]
    })
  })
}

function regionText(prefix: string, run: string, body: NonNullable<ReturnType<typeof display>>, eols: string[]) {
  return [edge('start', run), `> 💬 ${body.summary}  `, `> ${body.metric}`, edge('end', run)]
    .map((s, i) => prefix + s + (eols[i] ?? '')).join('')
}

function hasUnpairedComment(p: Parsed, v: View) {
  const edges = new Map(v.resultRegions.flatMap(r => [
    [r.startLine - 1, edge('start', r.runId)], [r.endLine - 1, edge('end', r.runId)]
  ]))
  let found = false
  p.tree.iterate({ enter(n) {
    if (!is(n.node, 'Comment', 'CommentBlock') || found) return
    const literal = p.source.slice(n.from, n.to).trimEnd()
    if (/^<!--\s*workbench\s*-\s*result\b/i.test(literal) &&
        (n.name !== 'CommentBlock' || edges.get(p.row(n.from)) !== literal)) found = true
  } })
  return found
}

export function planWriteback(request: Request, scan: Scan): Plan {
  const { source, target, conclusion, authority } = request
  if (!validTarget(target) || !conclusion || !validRound(conclusion) || !sameTarget(target, conclusion)) return review('invalid-identity')
  if (!authority || !validRound(authority.current) || !sameTarget(target, authority.current)) return review('invalid-authority')
  if (!sameRound(conclusion, authority.current)) return review('stale-round')
  const previous = authority.lastWritten
  if (previous !== null && (!previous || !validRound(previous) || !sameTarget(target, previous) ||
      typeof previous.fingerprint !== 'string' || previous.fingerprint.length !== 64 ||
      !/^[0-9a-f]{64}$/.test(previous.fingerprint))) return review('invalid-authority')
  if (previous && previous.ordinal > conclusion.ordinal) return review('stale-round')
  if (previous && (previous.ordinal === conclusion.ordinal) !== (previous.runId === conclusion.runId)) return review('invalid-authority')
  const body = display(conclusion)
  if (!body) return review('unverified-conclusion')
  if (!(source instanceof Uint8Array)) return review('invalid-source')
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source) }
  catch { return review('invalid-source') }
  if (raw.includes('\0')) return review('invalid-source')
  try {
    const before = scan(raw)
    if (!Array.isArray(before.resultRegions) || !Array.isArray(before.resultIssues)) return review('parser-unavailable')
    if (before.resultIssues.length) return review('damaged-region')
    const p = parse(raw)
    if (hasUnpairedComment(p, before)) return review('damaged-region')
    const found = locate(p, before, target)
    if ('kind' in found) return found
    const { slot, prefix, regions } = found
    if (regions.length > 1) return review('unowned-region')
    const old = regions[0]
    if (old && (!previous || old.runId !== previous.runId)) return review('unowned-region')
    if (previous && !old) return review(before.resultRegions.some(r => r.runId === previous.runId) ? 'region-moved' : 'owned-region-missing')
    if (old && old.startLine !== slot + 2) return review('region-moved')
    if ((!old || old.runId !== conclusion.runId) && before.resultRegions.some(r => r.runId === conclusion.runId)) return review('run-collision')
    const w: Window = { from: slot + 1, count: old ? old.endLine - old.startLine + 1 : 0 }
    let start: number, end: number, replacement: string, generated: string
    if (old && previous) {
      const rows = p.lines.slice(w.from, w.from + w.count)
      start = rows[0].start
      end = rows.at(-1)!.end
      const current = raw.slice(start, end)
      if (sha(current) !== previous.fingerprint) return review('fingerprint-mismatch')
      if (rows.length !== 4 || rows[0].text !== prefix + edge('start', old.runId) ||
          rows[3].text !== prefix + edge('end', old.runId) ||
          !rows[1].text.startsWith(prefix + '> 💬 ') || !rows[2].text.startsWith(prefix + '> ⏱ 用时 ')) return review('damaged-region')
      generated = regionText(prefix, conclusion.runId, body, rows.slice(0, -1).map(l => l.eol))
      if (previous.runId === conclusion.runId) return current === generated
        ? { kind: 'noop', fingerprint: previous.fingerprint } : review('replay-mismatch')
      replacement = generated
    } else {
      start = end = p.lines[slot].end
      const eol = p.lines[slot].eol || p.lines[slot - 1]?.eol || '\n'
      generated = regionText(prefix, conclusion.runId, body, [eol, eol, eol])
      replacement = eol + generated
    }
    const nextRaw = raw.slice(0, start) + replacement + raw.slice(end)
    const next = scan(nextRaw)
    const nextParsed = parse(nextRaw)
    const nextFound = locate(nextParsed, next, target)
    const newer: Window = { from: w.from, count: 4 }
    if (next.resultIssues.length || 'kind' in nextFound || nextFound.slot !== slot || nextFound.prefix !== prefix ||
        nextFound.regions.length !== 1 || nextFound.regions[0].runId !== conclusion.runId ||
        nextFound.regions[0].startLine !== w.from + 1 || nextFound.regions[0].endLine !== w.from + 4 ||
        structure(p, w) !== structure(nextParsed, newer) || tasks(before, w) !== tasks(next, newer)) return review('structure-changed')
    return { kind: old ? 'update' : 'insert', fingerprint: sha(generated), edit: {
      startByte: encode.encode(raw.slice(0, start)).length, endByte: encode.encode(raw.slice(0, end)).length,
      replacement: encode.encode(replacement)
    } }
  } catch { return review('parser-unavailable') }
}
