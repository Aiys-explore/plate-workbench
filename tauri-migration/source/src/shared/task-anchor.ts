import { markdownLanguage } from '@codemirror/lang-markdown'
import type { MarkdownParser } from '@lezer/markdown'

const id = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
export const taskIdPattern = new RegExp(`^${id}$`)
const anchor = new RegExp(`^<!-- workbench-task:(${id}) note:(${id}) -->$`)
export const delegationSelectorPattern = '[a-z0-9][a-z0-9_-]*'
export const delegationValuePattern = '[a-z0-9][a-z0-9._:+-]*'
const bareDelegation = new RegExp(`[ \\t]@${delegationSelectorPattern}(?:/${delegationValuePattern}){0,2}[ \\t]*$`, 'i')
const generated = new RegExp(`^<!-- workbench-result:(start|end):(${id}) -->$`)
const resultPrefix = '<!-- workbench-result'
const resultLine = /^<!-- workbench-result(?=[: \t-]|$)/
const resultParser = (markdownLanguage.parser as MarkdownParser).configure({
  defineNodes: [{ name: 'WorkbenchResultBoundary', block: true }],
  parseBlock: [{
    name: 'WorkbenchResultBoundary', before: 'HTMLBlock',
    parse(cx, line) {
      if (!resultLine.test(line.text.slice(line.pos))) return false
      // Reserve only this block-comment namespace, and consume one line even when
      // its HTML terminator was truncated. Ordinary comments and code stay literal.
      const from = cx.lineStart + line.pos, to = cx.lineStart + line.text.length
      cx.nextLine()
      cx.addElement(cx.elt('WorkbenchResultBoundary', from, to))
      return true
    }
  }]
})

type Boundary = {
  row: number; scope: string; scopeEnd: number; quotes: number; indent: number
  edge?: 'start' | 'end'; runId?: string
}
type Blocker = { row: number; resultQuoteDepth?: number }
type ResultIssueCode = 'malformed-marker' | 'missing-end' | 'unmatched-end' |
  'duplicate' | 'overlap' | 'different-scope' | 'crosses-task-or-section'
export type ResultIssue = {
  code: ResultIssueCode; line: number; runId?: string; relatedLine?: number
}
export type ResultRegion = { runId: string; startLine: number; endLine: number }

function resultRanges(boundaries: Boundary[], blockers: Blocker[]) {
  const masked = new Set<number>()
  const resultIssues: ResultIssue[] = []
  const resultRegions: ResultRegion[] = []
  const resultReviewRows = new Set<number>()
  const byRun = new Map<string, number[]>()
  const report = (b: Boundary, code: ResultIssueCode, relatedRow?: number) =>
    resultIssues.push({ code, line: b.row + 1, runId: b.runId,
      relatedLine: relatedRow === undefined ? undefined : relatedRow + 1 })
  for (const [i, b] of boundaries.entries()) {
    if (!b.runId) { report(b, 'malformed-marker'); continue }
    const group = byRun.get(b.runId) ?? []
    group.push(i)
    byRun.set(b.runId, group)
  }
  // In insertion order, run extents are sorted by their first marker. Include
  // duplicate extents in this sweep so they cannot legitimize an inner pair.
  const runs = [...byRun.entries()]
  let furthestEnd = -1
  const findBlocker = (start: Boundary, end: Boundary) => {
    let low = 0, high = blockers.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (blockers[mid].row <= start.row) low = mid + 1
      else high = mid
    }
    for (let i = low; blockers[i]?.row < end.row; i++) {
      const b = blockers[i]
      if (b.resultQuoteDepth === undefined || b.resultQuoteDepth <= start.quotes) return b.row
    }
  }
  const unresolvedStarts = new Set<number>()
  const markUnresolved = (marker: Boundary) => unresolvedStarts.add(marker.row)
  const unresolved = new Map<string, Boundary>()
  let boundaryIndex = 0
  for (const [j, [runId, indices]] of runs.entries()) {
    const first = indices[0], last = indices.at(-1)!
    const a = boundaries[first], b = boundaries[last]
    while (boundaryIndex < first) {
      const marker = boundaries[boundaryIndex++]
      if (unresolvedStarts.has(marker.row) || (!marker.runId && marker.edge !== 'end')) unresolved.set(marker.scope, marker)
    }
    const nextFirst = runs[j + 1]?.[1][0] ?? Infinity
    const overlap = furthestEnd >= first || nextFirst <= last || last > first + 1
    furthestEnd = Math.max(furthestEnd, last)
    if (indices.length === 1) {
      report(a, a.edge === 'start' ? 'missing-end' : 'unmatched-end')
      if (a.edge === 'start') markUnresolved(a)
      continue
    }
    if (indices.length !== 2 || a.edge === b.edge) {
      const opens: Boundary[] = []
      for (const i of indices) {
        const marker = boundaries[i]
        report(marker, 'duplicate')
        if (marker.edge === 'start') opens.push(marker)
        else opens.pop()
      }
      for (const open of opens) markUnresolved(open)
      continue
    }
    const reject = (code: ResultIssueCode, relatedRow?: number) => {
      report(a, code, relatedRow ?? b.row)
      report(b, code, relatedRow ?? a.row)
    }
    if (a.edge !== 'start') {
      report(a, 'unmatched-end')
      report(b, 'missing-end')
      markUnresolved(b)
      continue
    }
    if (overlap) { reject('overlap'); continue }
    if (a.scope !== b.scope || a.indent !== b.indent) { reject('different-scope'); continue }
    const conflict = findBlocker(a, b)
    if (conflict !== undefined) { reject('crosses-task-or-section', conflict); continue }
    const previous = unresolved.get(a.scope)
    if (previous && findBlocker(previous, a) === undefined) {
      reject('overlap', previous.row)
      continue
    }
    for (let row = a.row; row <= b.row; row++) masked.add(row)
    resultRegions.push({ runId, startLine: a.row + 1, endLine: b.row + 1 })
  }
  resultIssues.sort((a, b) => a.line - b.line)
  // Payload can still look like a delegation when a pair is damaged. Flag
  // surviving rows up to the next real task/section or end of the container.
  const issueRows = new Set(resultIssues.map(issue => issue.line - 1))
  let reviewedThrough = -1
  for (const b of boundaries) {
    if (!issueRows.has(b.row) || b.edge === 'end') continue
    const stopAt = findBlocker(b, { ...b, row: b.scopeEnd + 1 }) ?? b.scopeEnd + 1
    for (let row = Math.max(b.row, reviewedThrough + 1); row < stopAt; row++) resultReviewRows.add(row)
    reviewedThrough = Math.max(reviewedThrough, stopAt - 1)
  }
  return { masked, resultIssues, resultRegions, resultReviewRows }
}
export const taskCommentId = (comment: string) => anchor.exec(comment)?.[1]
export const taskComment = (blockId: string, noteId: string) => `<!-- workbench-task:${blockId} note:${noteId} -->`

export function taskSource(raw: string) {
  const lf = raw.replace(/\r\n?/g, '\n')
  const bom = Number(lf.startsWith('\uFEFF'))
  const body = lf.slice(bom)
  const yaml = /^---[ \t]*\n[\s\S]*?^(?:---|\.\.\.)[ \t]*(?=\n|$)/m.exec(body)
  const yamlLength = yaml?.index === 0 ? yaml[0].length : /^---[ \t]*\n(?:[ \t]*#[^\n]*\n)*[ \t]*[\w-]+[ \t]*:/.test(body) ? body.length : 0
  const source = body.slice(0, yamlLength).replace(/[^\n]/g, ' ') + body.slice(yamlLength)
  const lines = source.split('\n')
  const offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  const rowAt = (point: number) => {
    let l = 0, r = lines.length
    while (r - l > 1) {
      const m = (l + r) >>> 1
      if (offsets[m] <= point) l = m
      else r = m
    }
    return l
  }
  const comments: { blockId: string; claimedNoteId: string; line: number; from: number; to: number; inline: boolean }[] = []
  const boundaries: Boundary[] = []
  const blockers: Blocker[] = []
  const resultLexicalLines = new Map<number, string>()
  const hasResult = source.includes(resultPrefix)
  const tree = source.includes('<!-- workbench-')
    ? (hasResult ? resultParser : markdownLanguage.parser).parse(source) : undefined
  tree?.iterate({ enter(node) {
    const isTaskOrHeading = hasResult && /^(?:Task|ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)
    if (!isTaskOrHeading && !/^(?:WorkbenchResultBoundary|FencedCode|Comment|CommentBlock)$/.test(node.name)) return
    const line = rowAt(node.from)
    const firstLine = source.slice(node.from, offsets[line + 1] - 1)
    if (isTaskOrHeading || (hasResult &&
        ((node.name === 'FencedCode' && /^(?:`{3,}|~{3,})[ \t]*agent[ \t]*$/i.test(firstLine)) ||
        (node.name === 'CommentBlock' && /^<!--\s*agent\s*:/i.test(firstLine))))) blockers.push({ row: line })
    if (node.name === 'WorkbenchResultBoundary') {
      const column = node.from - offsets[line]
      const prefix = lines[line].slice(0, column)
      const literal = lines[line].slice(column).trimEnd()
      const edge = /^[ \t>]*$/.test(prefix) ? generated.exec(literal) : null
      const direction = /^<!-- workbench-result:(start|end)\b/.exec(literal)?.[1]
      const parent = node.node.parent!
      let quotes = 0
      for (let p: typeof parent | null = parent; p; p = p.parent) if (p.name === 'Blockquote') quotes++
      let indent = 0
      for (const char of prefix) indent += char === '\t' ? 4 - indent % 4 : 1
      boundaries.push({ row: line, scope: `${parent.name}:${parent.from}`, scopeEnd: rowAt(parent.to - 1), quotes, indent,
        edge: direction as Boundary['edge'], runId: edge?.[2] })
      // Even a line containing "-->" may reopen an ordinary HTML comment in
      // malformed trailing text. Do not let the second parser swallow neighbors.
      if (!edge) resultLexicalLines.set(line, prefix + '<!-- -->')
      return
    }
    if (node.name !== 'Comment' && node.name !== 'CommentBlock') return
    const literal = source.slice(node.from, node.to).trimEnd()
    const task = anchor.exec(literal)
    if (task) {
      comments.push({ blockId: task[1], claimedNoteId: task[2], line, from: node.from - offsets[line],
        to: node.from - offsets[line] + literal.length, inline: node.name === 'Comment' })
      if (hasResult) blockers.push({ row: line })
    }
  } })
  if (tree && boundaries.length) {
    // A bare delegation suffix is ambiguous too. The result format's 💬 quote
    // label distinguishes result prose from an ordinary quoted delegation.
    // Checklists, anchors, headings and explicit directives above always block.
    const scopeEnd = boundaries.reduce((max, b) => Math.max(max, b.scopeEnd), 0)
    for (let row = boundaries[0].row + 1; row <= scopeEnd; row++) {
      const match = bareDelegation.exec(lines[row])
      if (!match) continue
      let quotes = 0, resultQuote = false, list = false, literal = false
      for (let p: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(offsets[row] + match.index + 1, 1); p; p = p.parent) {
        if (/^(?:FencedCode|CodeBlock|InlineCode|Comment|CommentBlock|WorkbenchResultBoundary|HTMLBlock|Link|Image)$/.test(p.name)) {
          literal = true
          break
        }
        if (p.name === 'Blockquote') {
          quotes++
          if (rowAt(p.from) === row && /^>[ \t]*💬(?:\s|$)/u.test(source.slice(p.from, offsets[row + 1] - 1))) resultQuote = true
        }
        if (p.name === 'ListItem' && rowAt(p.from) === row) list = true
      }
      if (!literal) blockers.push(list || !resultQuote ? { row } : { row, resultQuoteDepth: quotes })
    }
    blockers.sort((a, b) => a.row - b.row)
  }
  const { masked, resultIssues, resultRegions, resultReviewRows } = resultRanges(boundaries, blockers)
  const all = comments.filter(c => !masked.has(c.line))
  const byLine = new Map<number, typeof all>()
  for (const c of all) {
    const row = byLine.get(c.line) ?? []
    row.push(c)
    byLine.set(c.line, row)
  }
  return { lf, lines, masked, all, byLine, resultLexicalLines, resultIssues, resultRegions, resultReviewRows }
}
