import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'
import { parseDocument } from 'yaml'
import { plateTitle } from '../../../shared/plate-title'
import { scanWiki, wikiParser, type WikiLink } from '../../../shared/wiki-markdown'
import { taskCommentId } from '../../../shared/task-anchor'

export type Span = { from: number; to: number }
export type Leaf = Span & { kind: 'text'; text: string; points: number[] }
export type Box = Span & {
  kind: 'box' | 'atom' | 'protected'
  role: string
  children: Node[]
  label?: string
  hidden?: boolean
  wiki?: WikiLink
  attrs?: { url?: string; title?: string; alt?: string; align?: string; level?: number; start?: number }
  content?: Span
  marker?: Span
}
export type Node = Leaf | Box
export type Projection = {
  root: Box; protected: Box[]; lines: number[]; newline: string; errors: string[]
  rawPoints: number[]; normalized: string; syntax: string
}
const parser = wikiParser()
const entities = parser.utils
const attr = (t: { attrGet(name: string): unknown } | undefined, name: string) => { const value = t?.attrGet(name); return typeof value === 'string' ? value : undefined }
const children = (n: SyntaxNode) => {
  const result: SyntaxNode[] = []
  for (let c = n.firstChild; c; c = c.nextSibling) result.push(c)
  return result
}
export function normalize(raw: string) {
  let normalized = ''
  const rawPoints = [0]
  for (let i = 0; i < raw.length;) {
    const ch = raw[i++]
    if (ch === '\r' && raw[i] === '\n') i++
    normalized += ch === '\r' ? '\n' : ch
    rawPoints.push(i)
  }
  return { normalized, rawPoints }
}

export function project(raw: string): Projection {
  const { normalized, rawPoints } = normalize(raw)
  const lines = [0]
  for (let i = 0; i < normalized.length; i++) if (normalized[i] === '\n') lines.push(rawPoints[i + 1])
  const bom = normalized.startsWith('\uFEFF') ? 1 : 0
  const titleEnd = plateTitle(normalized)?.end ?? bom
  const fm = /^---[ \t]*\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?=\n|$)/m.exec(normalized.slice(titleEnd))
  const yaml = fm?.index === 0 ? fm : null
  const unterminated = !yaml && /^---[ \t]*\n(?:[ \t]*#[^\n]*\n)*[ \t]*[\w-]+[ \t]*:/.test(normalized.slice(titleEnd))
  const yamlEnd = yaml ? titleEnd + yaml[0].length : unterminated ? normalized.length : titleEnd
  const errors: string[] = unterminated ? ['YAML: 找不到结束分隔符'] : []
  if (yaml) {
    const document = parseDocument(yaml[1])
    for (const error of document.errors) errors.push('YAML: ' + error.message)
  }
  // A leading BOM consumes an offset but must not count toward indentation.
  const input = '\n'.repeat(bom) + normalized.slice(bom, yamlEnd).replace(/[^\n]/g, ' ') + normalized.slice(yamlEnd)
  const tree = markdownLanguage.parser.parse(input)
  const protectedNodes: Box[] = []
  const span = (a: number, b: number): Span => ({ from: rawPoints[a], to: rawPoints[b] })
  const box = (role: string, a: number, b: number, c: Node[] = [], extra: Partial<Box> = {}): Box =>
    ({ ...span(a, b), kind: 'box', role, children: c, ...extra })
  const protect = (role: string, a: number, b: number, hidden = false) => {
    const p = box(role, a, b, [], { kind: 'protected', hidden })
    protectedNodes.push(p)
    return p
  }
  const leaf = (a: number, b: number, value?: string): Leaf => {
    const points = value === undefined ? rawPoints.slice(a, b + 1) :
      Array.from({ length: value.length + 1 }, (_, i) => rawPoints[i === value.length ? b : a])
    return { ...span(a, b), kind: 'text', text: value ?? normalized.slice(a, b), points }
  }
  const wiki = new Map(scanWiki(raw, true).links.map(w => [w.from, w]))
  const env: Record<string, unknown> = {}
  parser.parse(input, env) // reference definitions, never render to HTML
  const ext = /!\[\[[^\]\n]*\]\]|\{\{[^{}\n]*\}\}|\[\^[^\]\n]+\]|:[\w-]+\[[^\]\n]*\]|\[\[[^\]\n]*\]\]/g
  function inline(a: number, b: number, ns: SyntaxNode[], table = false): Node[] {
    const output: Node[] = []
    let i = a
    const nodes = ns.filter(n => n.from >= a && n.to <= b)
    // Reserve legacy wiki and known foreign syntax ahead of parser's nested bracket nodes.
    const foreign = new Map<number, { end: number; wiki?: WikiLink }>()
    const local = normalized.slice(a, b)
    for (const m of local.matchAll(ext)) {
      const start = a + m.index
      const known = wiki.get(start)
      if (nodes.some(n => n.from < start && n.to > start)) continue
      foreign.set(start, { end: start + m[0].length, wiki: known?.to === start + m[0].length ? known : undefined })
    }
    // Escaped pipes in tables change the legacy inline representation, but not the raw interval.
    for (const w of wiki.values()) if (w.from >= a && w.to <= b && !nodes.some(n => n.from < w.from && n.to > w.from)) {
      if (normalized.slice(w.from, w.from + 2) === '[[') foreign.set(w.from, { end: w.to, wiki: w })
    }
    const nextSpecial = /\n[ \t]*/g
    while (i < b) {
      const custom = foreign.get(i)
      if (custom) {
        output.push(custom.wiki ? box('wiki', i, custom.end, [], { kind: 'atom', label: custom.wiki.label, wiki: custom.wiki })
          : protect('extension-inline', i, custom.end))
        i = custom.end
        continue
      }
      const n = nodes.find(n => n.from === i && n.to > i)
      if (n) {
        output.push(inlineNode(n, table))
        i = n.to
        if (n.name === 'QuoteMark') while (i < b && /[ \t]/.test(normalized[i])) i++
        continue
      }
      nextSpecial.lastIndex = i
      const nl = nextSpecial.exec(normalized)
      const end = Math.min(b, ...nodes.filter(n => n.from > i).map(n => n.from),
        ...[...foreign.keys()].filter(x => x > i), nl && nl.index >= i ? (nl.index === i ? i + 1 : nl.index) : b)
      output.push(leaf(i, end))
      i = end
      if (nl && end === nl.index + 1 && !table) i = Math.min(b, end + nl[0].length - 1)
    }
    return output.length ? output : [leaf(a, a)]
  }

  function inlineNode(n: SyntaxNode, table: boolean): Node {
    const { from: a, to: b, name } = n
    const ns = children(n)
    const value = normalized.slice(a, b)
    const roles: Record<string, string> = { StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's' }
    if (roles[name] && ns.length >= 2) {
      const start = ns[0].to, end = ns.at(-1)!.from
      return box(roles[name], a, b, inline(start, end, ns.slice(1, -1), table), { content: span(start, end) })
    }
    if (name === 'Escape' || name === 'Entity') return leaf(a, b, entities.unescapeAll(value))
    if (name === 'HardBreak' || (table && name === 'HTMLTag' && value === '<br>')) return leaf(a, b, '\n')
    if (name === 'QuoteMark') return box('prefix', a, b, [], { hidden: true })
    if (name === 'Comment' && taskCommentId(value)) return protect('task-anchor', a, b, true)
    if (name === 'InlineCode' && ns.length === 2) {
      let start = ns[0].to, end = ns[1].from
      const inner = normalized.slice(start, end)
      if (inner.startsWith(' ') && inner.endsWith(' ') && inner.trim()) { start++; end-- }
      const parts: Leaf[] = []
      for (let j = start, k = start; j <= end; j++) {
        const escape = table && normalized.slice(j, j + 2) === '\\|' && j + 1 < end
        if (j === end || escape || normalized[j] === '\n') {
          if (j > k || (start === end && j === end)) parts.push(leaf(k, j))
          if (j < end) { parts.push(leaf(j, j + (escape ? 2 : 1), escape ? '|' : ' ')); if (escape) j++ }
          k = j + 1
        }
      }
      return box('inline-code', a, b, parts, { content: span(start, end) })
    }
    if (name === 'Link' || name === 'Image' || name === 'Autolink' || name === 'URL') {
      const token = parser.parseInline(table ? value.replaceAll('\\|', '|') : value, env)[0]?.children ?? []
      const link = token[0]
      if (name === 'Image' && link?.type === 'image') return box('image', a, b, [], { kind: 'atom',
        label: link.content, attrs: { alt: link.content, url: attr(link, 'src') ?? '', title: attr(link, 'title') } })
      if (name === 'Image') {
        const url = ns.find(c => c.name === 'URL'), marks = ns.filter(c => c.name === 'LinkMark')
        if (url && marks.length >= 4) return box('image', a, b, [], { kind: 'atom', label: normalized.slice(marks[0].to, marks[1].from),
          attrs: { url: normalized.slice(url.from, url.to) } })
      }
      if (name === 'Link') {
        const marks = ns.filter(c => c.name === 'LinkMark')
        if (marks.length >= 2 && (link?.type === 'link_open' || marks.length >= 4)) {
          const start = marks[0].to, end = marks[1].from
          const url = ns.find(c => c.name === 'URL')
          return box('link', a, b, inline(start, end, ns.filter(c => c.name !== 'LinkMark'), table),
            { content: span(start, end), attrs: { url: attr(link, 'href') ?? (url ? normalized.slice(url.from, url.to) : ''), title: attr(link, 'title') } })
        }
        if (/^\[[^\[\]]*\]$/.test(value)) return leaf(a, b)
      }
      if (name === 'Autolink') return box('link', a, b, [leaf(a + 1, b - 1)], { content: span(a + 1, b - 1),
        attrs: { url: attr(link, 'href') ?? value.slice(1, -1) } })
      if (name === 'URL') return leaf(a, b)
      return protect('unmapped-' + name, a, b)
    }
    return protect('unmapped-' + name, a, b)
  }

  function row(n: SyntaxNode, header: boolean, aligns: string[]): Box | undefined {
    const cs = children(n)
    const begin = n.from + (normalized[n.from] === '|' ? 1 : 0)
    const end = n.to - (normalized[n.to - 1] === '|' && cs.at(-1)?.name === 'TableDelimiter' ? 1 : 0)
    const breaks = cs.filter(c => c.name === 'TableDelimiter' && c.from >= begin && c.from < end)
    const cells: Box[] = []
    let start = begin
    for (const edge of [...breaks.map(c => c.from), end]) {
      const body = cs.find(c => c.name === 'TableCell' && c.from >= start && c.to <= edge)
      const point = start + (normalized.slice(start, edge).match(/^[ \t]*/)?.[0].length ?? 0)
      const content = body ? span(body.from, body.to) : span(point, point)
      cells.push(box(header ? 'th' : 'td', start, edge,
        body ? inline(body.from, body.to, children(body), true) : [leaf(point, point)],
        { content, attrs: { align: aligns[cells.length] } }))
      start = edge + 1
    }
    return cells.length === aligns.length ? box('tr', n.from, n.to, cells) : undefined
  }

  function block(n: SyntaxNode): Box {
    const { from: a, to: b, name } = n
    const ns = children(n), value = normalized.slice(a, b)
    if (name === 'Paragraph' || name === 'Task' || /^(ATX|Setext)Heading[1-6]$/.test(name)) {
      if (/^(?:[ \t]*(?:::|\$\$|\[!|\[\^[^\]]+\]:))/m.test(value)) return protect('extension-block', a, b)
      const level = Number(name.at(-1)) || 0
      const marks = ns.filter(c => c.name === 'HeaderMark' || c.name === 'TaskMarker')
      const leading = marks[0]?.from === a ? marks[0] : undefined
      const trailing = marks.at(-1) !== leading ? marks.at(-1) : undefined
      let start = leading?.to ?? a, end = trailing?.from ?? b
      if (leading) while (start < end && /[ \t]/.test(normalized[start])) start++
      if (trailing) while (end > start && /[ \t\n]/.test(normalized[end - 1])) end--
      return box(level ? 'heading' : name === 'Task' ? 'task' : 'paragraph', a, b,
        inline(start, end, ns.filter(c => !marks.includes(c))), {
          attrs: { level }, content: span(start, end), marker: leading && span(leading.from, leading.to)
        })
    }
    if (name === 'Blockquote' || name === 'BulletList' || name === 'OrderedList' || name === 'ListItem') {
      const role = { Blockquote: 'quote', BulletList: 'ul', OrderedList: 'ol', ListItem: 'li' }[name]
      const mark = ns.find(c => c.name === 'ListMark')
      const content = ns.filter(c => !['ListMark', 'QuoteMark'].includes(c.name)).map(block)
      const tail = ns.at(-1)
      if ((!content.length && (role === 'li' || role === 'quote')) ||
          (role === 'quote' && tail?.name === 'QuoteMark' && /^[ \t]*$/.test(normalized.slice(tail.to, b)))) {
        content.push(box('paragraph', b, b, [leaf(b, b)], { content: span(b, b), attrs: { level: 0 } }))
      }
      return box(role, a, b, content,
        { marker: mark && span(mark.from, mark.to), attrs: { start: name === 'OrderedList' ? Number(/^\d+/.exec(value)?.[0]) : undefined } })
    }
    if (name === 'Table') {
      // Lezer uses parity; the existing markdown-it table tokenizer treats
      // any immediately preceding backslash as escaping a pipe.
      if ([...value.matchAll(/(\\+)\|/g)].some(m => m[1].length % 2 === 0))
        return protect('table-ambiguous-escape', a, b)
      const delimiter = ns[1]
      const aligns = normalized.slice(delimiter.from, delimiter.to).trim().replace(/^\||\|$/g, '').split('|').map(s => {
        const t = s.trim()
        return t.startsWith(':') ? t.endsWith(':') ? 'center' : 'left' : t.endsWith(':') ? 'right' : ''
      })
      // A parser that fills or drops uneven imported cells does not provide a reversible mapping.
      const checkpoint = protectedNodes.length
      const rows = ns.filter(c => ['TableHeader', 'TableRow'].includes(c.name)).map(c => row(c, c.name === 'TableHeader', aligns))
      if (!rows.length || rows.some(r => !r)) {
        protectedNodes.length = checkpoint
        return protect('table-ragged', a, b)
      }
      return box('table', a, b, rows as Box[], { marker: span(delimiter.from, delimiter.to) })
    }
    if (name === 'FencedCode') {
      const info = ns.find(c => c.name === 'CodeInfo')
      const language = info ? normalized.slice(info.from, info.to).trim() : ''
      if (/^agent$/i.test(language)) return protect('agent-fence', a, b, true)
      const fences = ns.filter(c => c.name === 'CodeMark')
      if (fences.length !== 2 || !/^[\w+#.-]{0,32}$/.test(language) || /^ +/.test(value) || /[^\n]/.test(input.slice(input.lastIndexOf('\n', a - 1) + 1, a))) {
        return protect('fence-unmapped', a, b)
      }
      const start = normalized.indexOf('\n', a) + 1
      const end = Math.max(start, normalized.lastIndexOf('\n', fences[1].from - 1))
      return box('code', a, b, [leaf(start, end)], { label: language, content: span(start, end) })
    }
    if (name === 'HorizontalRule') return box('rule', a, b, [], { kind: 'atom' })
    if (name === 'LinkReference') return protect('link-definition', a, b)
    if (name === 'CommentBlock' && /^<!-- workbench-result:(?:start|end):[0-9a-f-]{36} -->$/.test(value.trimEnd()))
      return protect('result-boundary', a, b, true)
    if (name === 'CommentBlock' && /^(?:<!-- plate-brain-write:[0-9a-f-]{36} -->|<!-- \/?plate-evolution -->)$/.test(value.trimEnd()))
      return protect('brain-metadata', a, b, true)
    if (name === 'CommentBlock') return protect('comment', a, b, /^<!--\s*agent\s*:/i.test(value) || !!taskCommentId(value.trimEnd()))
    return protect('unmapped-' + name, a, b)
  }

  const root = box('document', 0, normalized.length)
  if (titleEnd > bom) protect('plate-title', bom, titleEnd, true)
  if (yaml || unterminated) root.children.push(protect('yaml', titleEnd, yamlEnd))
  // One blank line separates Markdown blocks. Extra empty lines at the
  // document level are editable paragraph positions (including after Enter).
  const emptyParagraph = (p: number) => box('paragraph', p, p, [leaf(p, p)],
    { content: span(p, p), attrs: { level: 0 } })
  let end = yamlEnd
  const gap = (to: number) => {
    const text = normalized.slice(end, to)
    for (const m of text.matchAll(/(?=(\n[ \t]*\n)(?=\n))/g)) {
      root.children.push(emptyParagraph(end + m.index + m[1].length))
    }
  }
  for (const child of children(tree.topNode)) {
    gap(child.from)
    root.children.push(block(child))
    end = child.to
  }
  gap(normalized.length)
  if (!root.children.some(n => n.kind === 'box' && n.from !== n.to) || /\n[ \t]*\n$/.test(normalized)) root.children.push(box('paragraph', normalized.length, normalized.length,
    [leaf(normalized.length, normalized.length)], { content: span(normalized.length, normalized.length) }))
  return { root, protected: protectedNodes, lines, newline: raw.match(/\r\n|\n|\r/)?.[0] ?? '\n', errors,
    rawPoints, normalized, syntax: tree.toString() }
}
