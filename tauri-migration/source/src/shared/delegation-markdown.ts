import type { MarkdownIt } from 'markdown-it'
import { wikiParser } from './wiki-markdown'
import type { AgentProfile } from './agents'
import { delegationSelectorPattern as selector, delegationValuePattern as value, taskComment, taskCommentId, taskSource } from './task-anchor'

export interface Marker {
  agent: string
  model?: string
  effort?: string
  workdir?: string
}

export interface DelegationTask {
  line: number
  rawLine: string
  marker: Marker | null
  issue?: string
  text: string
  includedLines: number[]
  excludedRoots: number[]
  blockId?: string
}

// Capture ASCII selectors (including UUIDs); model IDs may include dots,
// colons and plus signs. Slash is the separator, never part of a field.
const suffix = new RegExp('^@(' + selector + ')(?:/(' + value + ')(?:/(' + value + '))?)?(?=[ \\t]*(?:\\n|$))', 'i')
const blockAgent = new RegExp('^(' + selector + ')(?=\\s|$)', 'i')
const validValue = new RegExp('^' + value + '$', 'i')
const commentStart = /^<!--\s*agent\s*:/i
const fenceInfo = (info: string) => /^agent$/i.test(info.trim())

// Install only the hidden directive block in the existing safe renderer.
// Generic HTML remains disabled; ordinary code fences retain their renderer.
export function delegationBlocks(parser: MarkdownIt) {
  parser.inline.ruler.before('html_inline', 'workbench_task_comment', (state, silent) => {
    if (!state.src.startsWith('<!-- workbench-task:', state.pos)) return false
    const end = state.src.indexOf('-->', state.pos) + 3
    if (end <= state.pos || end > state.posMax || !taskCommentId(state.src.slice(state.pos, end))) return false
    if (!silent) state.push('workbench_task_comment', '', 0)
    state.pos = end
    return true
  })
  parser.renderer.rules.workbench_task_comment = () => ''
  parser.block.ruler.before('html_block', 'agent_comment', (state, start, end, silent) => {
    if (state.sCount[start] - state.blkIndent >= 4) return false
    const line = (n: number) => state.src.slice(state.bMarks[n] + state.tShift[n], state.eMarks[n])
    if (!commentStart.test(line(start))) return false
    let last = start
    while (!line(last).includes('-->')) {
      if (++last >= end || (!state.isEmpty(last) && state.sCount[last] < state.blkIndent)) return false
      if (line(last).includes('<!--')) return false
    }
    if (!/-->[ \t]*$/.test(line(last)) || line(last).indexOf('-->') !== line(last).lastIndexOf('-->')) return false
    if (silent) return true
    state.line = last + 1
    const token = state.push('agent_comment', '', 0)
    token.map = [start, state.line]
    token.content = state.getLines(start, state.line, state.blkIndent, false)
      .trim().replace(commentStart, '').replace(/-->$/, '')
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote'] })
  parser.renderer.rules.agent_comment = () => ''
  const fence = parser.renderer.rules.fence!
  parser.renderer.rules.fence = (tokens, i, options, env, self) =>
    fenceInfo(tokens[i].info) ? '' : fence(tokens, i, options, env, self)
}

const parser = wikiParser()
// Used only for lexical classification, never for rendering.
parser.set({ html: true })
delegationBlocks(parser)
parser.inline.ruler.before('text', 'agent_suffix', (state, silent) => {
  const { pos, src } = state
  if (src[pos] !== '@' || (pos > 0 && !/[ \t\n]/.test(src[pos - 1])) || state.linkLevel) return false
  const match = suffix.exec(src.slice(pos, state.posMax))
  if (!match) return false
  if (!silent) {
    const token = state.push('agent_suffix', '', 0)
    token.content = match[0]
    token.meta = { pos, marker: { agent: match[1], model: match[2], effort: match[3] } satisfies Marker }
  }
  state.pos += match[0].length
  return true
})

type Directive = { start: number; end: number; marker: Marker | null; issue?: string }
function directive(start: number, end: number, content: string): Directive {
  const invalid = (): Directive => ({ start, end, marker: null, issue: '块级指令格式无效' })
  let input = content.trim()
  const name = blockAgent.exec(input)
  if (!name) return invalid()
  const marker: Marker = { agent: name[1] }
  input = input.slice(name[0].length).trimStart()
  while (input) {
    const field = /^(model|effort|workdir)=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?=\s|$)/.exec(input)
    if (!field) return invalid()
    const key = field[1] as 'model' | 'effort' | 'workdir'
    const val = field[2] ?? field[3] ?? field[4]
    if (marker[key] !== undefined || (key !== 'workdir' && !validValue.test(val))) return invalid()
    marker[key] = val
    input = input.slice(field[0].length).trimStart()
  }
  return { start, end, marker }
}

const indent = (line: string) => {
  let width = 0
  for (const char of line) {
    if (char === ' ') width++
    else if (char === '\t') width += 4 - width % 4
    else break
  }
  return width
}

const contentOf = (line: string) => line.trim()
  .replace(/^(?:(?:[-+*]|\d{1,9}[.)]|#{1,6})[ \t]+)(?:\[[ xX]\](?:[ \t]+|$))?/, '').trim()

export function scanDelegation(text: string) {
  const source = taskSource(text)
  const raw = source.lf.split('\n')
  const counts = new Map<string, number>()
  for (const { blockId } of source.all) counts.set(blockId, (counts.get(blockId) ?? 0) + 1)
  const clean = raw.map((line, row) => {
    // The BOM is not part of the Markdown task/prompt. Keep it in rawLine for review.
    const bom = row === 0 && line.startsWith('\uFEFF') ? 1 : 0
    let body = line.slice(bom)
    for (const { from, to } of [...(source.byLine.get(row) ?? [])].reverse()) body = body.slice(0, from) + body.slice(to)
    return body
  })
  const lines = source.lines.map((line, row) => {
    if (source.masked.has(row)) return ' '.repeat(line.length)
    if (source.resultLexicalLines.has(row)) return source.resultLexicalLines.get(row)!
    return source.byLine.has(row) ? clean[row] : line
  })
  const resultIssueLines = new Set(source.resultIssues.map(issue => issue.line))
  const markers = new Map<number, { marker: Marker; column: number }>()
  const directives = new Map<number, Directive>()
  const prose = new Set<number>()
  const blockCodes = new Set<number>()
  for (const token of parser.parse(lines.join('\n'), {})) {
    if (!token.map) continue
    const [start, end] = token.map
    if (token.type === 'fence' || token.type === 'code_block' || token.type === 'html_block') {
      for (let i = start; i < end; i++) blockCodes.add(i)
    }
    if (token.type === 'agent_comment') directives.set(start, directive(start, end, token.content))
    if (token.type === 'fence' && fenceInfo(token.info)) {
      const close = new RegExp('^' + token.markup[0] + '{' + token.markup.length + ',}[ \\t]*$')
      const contentLines = token.content ? token.content.trimEnd().split('\n').length : 0
      const last = clean[end - 1].trimStart().replace(/^(?:>[ \t]*)+/, '')
      directives.set(start, end > start + 1 && contentLines < end - start - 1 && close.test(last)
        ? directive(start, end, token.content)
        : { start, end, marker: null, issue: '块级指令围栏未闭合' })
    }
    if (token.type !== 'inline') continue
    for (let i = start; i < end; i++) prose.add(i)
    const offsets = [0]
    for (let i = token.content.indexOf('\n'); i >= 0; i = token.content.indexOf('\n', i + 1)) offsets.push(i + 1)
    let row = 0
    for (const child of token.children ?? []) {
      if (child.type !== 'agent_suffix') continue
      const { pos, marker } = child.meta as { pos: number; marker: Marker }
      while (row + 1 < offsets.length && offsets[row + 1] <= pos) row++
      const line = start + row
      if (source.masked.has(line)) continue
      const rawEnd = clean[line].trimEnd()
      const column = rawEnd.length - child.content.length
      if (rawEnd.endsWith(child.content) && /[ \t]/.test(rawEnd[column - 1] ?? '') && contentOf(rawEnd.slice(0, column))) {
        markers.set(line, { column, marker })
      }
    }
  }

  const hidden = new Set<number>()
  const blocksByOwner = new Map<number, Directive[]>()
  let previous: Directive | undefined
  let owner: number | undefined
  for (const block of directives.values()) {
    for (let i = block.start; i < block.end; i++) hidden.add(i)
    const candidate = block.start - 1
    if (previous?.end !== block.start) {
      owner = prose.has(candidate) && !blockCodes.has(candidate) && contentOf(clean[candidate]) &&
        indent(clean[block.start]) >= indent(clean[candidate]) ? candidate : undefined
    } else if (owner !== undefined && indent(clean[block.start]) < indent(clean[owner])) owner = undefined
    if (owner !== undefined) {
      const blocks = blocksByOwner.get(owner) ?? []
      blocks.push(block)
      blocksByOwner.set(owner, blocks)
    }
    previous = block
  }

  function taskAt(line: number): DelegationTask | undefined {
    const row = line - 1
    const inline = markers.get(row)
    const blocks = blocksByOwner.get(row)
    if (!inline && !blocks) return undefined
    const block = blocks?.[0]
    const anchors = source.byLine.get(row) ?? []
    const lineSource = raw[row].replace(/^\uFEFF/, '')
    const blockId = anchors.length === 1 && anchors[0].inline && !lineSource.slice(anchors[0].to).trim() &&
      !!lineSource.slice(0, anchors[0].from).trim() ? anchors[0].blockId : undefined
    let issue = (anchors.length && !blockId) || (blockId && counts.get(blockId)! > 1)
      ? '任务标记重复或不在任务行末尾' : blocks && blocks.length > 1 ? '同一行只能使用一条块级指令' : block?.issue ??
      (inline && block?.marker && inline.marker.agent.toLowerCase() !== block.marker.agent.toLowerCase()
        ? '行尾标记与块级指令的 Agent 不一致' : undefined)
    const marker = inline ? {
      ...block?.marker, agent: inline.marker.agent,
      model: inline.marker.model ?? block?.marker?.model,
      effort: inline.marker.effort ?? block?.marker?.effort
    } : block?.marker ?? null
    const first = inline ? clean[row].slice(0, inline.column).trimEnd() : clean[row]
    const body = [first]
    const includedLines = [line]
    const excludedRoots: number[] = []
    const base = indent(clean[row])
    let skip: number | undefined
    let blanks: { value: string; line: number }[] = []
    for (let i = row + 1; i < raw.length; i++) {
      if (hidden.has(i) || source.masked.has(i) || (source.byLine.has(i) && !clean[i].trim())) continue
      const value = clean[i]
      if (!value.trim()) {
        if (skip === undefined) blanks.push({ value, line: i + 1 })
        continue
      }
      const depth = indent(value)
      if (depth <= base) break
      if (skip !== undefined && depth > skip) continue
      skip = undefined
      if (markers.has(i) || blocksByOwner.has(i)) {
        skip = depth
        excludedRoots.push(i + 1)
        continue
      }
      for (const blank of blanks) { body.push(blank.value); includedLines.push(blank.line) }
      blanks = []
      body.push(value)
      includedLines.push(i + 1)
    }
    if (includedLines.some(n => resultIssueLines.has(n) || source.resultReviewRows.has(n - 1))) {
      issue ??= '结果区标记歧义或损坏，请检查源文'
    }
    const separator = text.includes('\r\n') && !text.replaceAll('\r\n', '').includes('\n') ? '\r\n' : '\n'
    return { line, rawLine: raw[row], marker, issue, text: body.join(separator), includedLines, excludedRoots, blockId }
  }

  return { taskAt, resultIssues: source.resultIssues, resultRegions: source.resultRegions,
    anchors: source.all.map(({ blockId, claimedNoteId, line }) => ({ blockId, claimedNoteId, line: line + 1 })),
    lines: [...new Set([...markers.keys(), ...blocksByOwner.keys()])].sort((a, b) => a - b).map((n) => n + 1) }
}

// Single insertion only. Require that parsing after the edit gives the same task and prompt.
export function attachTaskAnchor(content: string, task: DelegationTask, blockId: string, noteId: string) {
  if (task.blockId || !task.marker || task.issue) return undefined
  let at = 0
  for (let line = 1; line < task.line; line++) {
    const end = /\r\n|\r|\n/g
    end.lastIndex = at
    const match = end.exec(content)
    if (!match) return undefined
    at = end.lastIndex
  }
  if (content.slice(at, at + task.rawLine.length) !== task.rawLine) return undefined
  at += task.rawLine.trimEnd().length
  const insert = taskComment(blockId, noteId)
  const next = content.slice(0, at) + insert + content.slice(at)
  const parsed = scanDelegation(next).taskAt(task.line)
  if (!parsed || parsed.issue || parsed.blockId !== blockId || parsed.text !== task.text ||
      JSON.stringify(parsed.marker) !== JSON.stringify(task.marker) ||
      JSON.stringify(parsed.includedLines) !== JSON.stringify(task.includedLines) ||
      JSON.stringify(parsed.excludedRoots) !== JSON.stringify(task.excludedRoots)) return undefined
  return { next, task: parsed, at, insert }
}

export type AgentMatch<T> =
  | { status: 'matched'; profile: T }
  | { status: 'ambiguous' | 'disabled' | 'missing' }

export function matchAgent<T extends Pick<AgentProfile, 'id' | 'type' | 'enabled'>>(profiles: T[], selector: string): AgentMatch<T> {
  const key = selector.toLowerCase()
  const exact = profiles.find((profile) => profile.id.toLowerCase() === key)
  const candidates = exact ? [exact] : profiles.filter((profile) => profile.type === key)
  const enabled = candidates.filter((profile) => profile.enabled)
  if (enabled.length > 1) return { status: 'ambiguous' }
  if (enabled.length === 1) return { status: 'matched', profile: enabled[0] }
  return { status: candidates.length ? 'disabled' : 'missing' }
}
