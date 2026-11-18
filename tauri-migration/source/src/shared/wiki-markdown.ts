import MarkdownIt from 'markdown-it'
import { referenceKey } from './link-resolution'

export interface WikiLink extends Record<string, unknown> { ref: string; label: string; from: number; to: number }

export const frontmatter = /^\uFEFF?---[ \t]*\n([\s\S]*?)^---[ \t]*(?:\n|$)/m
export const markdownSource = (text: string) => {
  const lf = text.replace(/\r\n?/g, '\n')
  return lf.replace(frontmatter, (match, _yaml, index) => index === 0 ? match.replace(/[^\n]/g, ' ') : match)
}

export function wikiParser() {
  const parser = new MarkdownIt({ html: false, linkify: false })
  parser.inline.ruler.before('link', 'wiki_link', (state, silent) => {
    if (state.linkLevel || state.src[state.pos] !== '[' || state.src[state.pos + 1] !== '[') return false
    const match = /^\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/.exec(state.src.slice(state.pos, state.posMax))
    if (!match) return false
    // Preserve legacy .md and #heading targets. Navigation opens the note itself.
    const ref = referenceKey(match[1].split('#', 1)[0])
    if (!ref) return false
    if (!silent) {
      const token = state.push('wiki_link', '', 0)
      token.meta = { ref, label: match[2]?.trim() || match[1].trim(), from: state.pos, to: state.pos + match[0].length }
    }
    state.pos += match[0].length
    return true
  })
  return parser
}

const parser = wikiParser()

export function scanWiki(text: string, positions = false) {
  const source = markdownSource(text)
  const blocks = parser.parse(source, {})
  const references = new Set<string>()
  const inlineProse: string[] = []
  const links: WikiLink[] = []
  const lines = positions ? source.split('\n') : []
  const offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1)
  let tableRow = -1
  let cellEnd = 0
  for (const block of blocks) {
    if (block.type === 'tr_open') { tableRow = block.map?.[0] ?? -1; cellEnd = 0 }
    if (block.type === 'tr_close') tableRow = -1
    if (block.type !== 'inline') continue
    if (!positions) inlineProse.push((block.children ?? []).map((token) => {
      if (token.type === 'text') return token.content
      if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n'
      if (!token.nesting) return '\u0000'
      return ''
    }).join(''))
    const parts = (block.children ?? []).filter((token) => token.type === 'wiki_link').map((token) => token.meta as WikiLink)
    for (const part of parts) references.add(part.ref)
    if (!positions || (!parts.length && tableRow < 0)) continue

    // Markdown-it reports the original block line and offsets within its inline
    // text. Align that text to the source, skipping list/quote/heading prefixes.
    let innerStart = 0
    for (const [i, line] of block.content.split('\n').entries()) {
      const row = (block.map?.[0] ?? tableRow) + i
      const raw = lines[row] ?? ''
      const chars: number[] = []
      let comparable = ''
      for (let j = 0; j < raw.length; j++) {
        if (tableRow >= 0 && raw[j] === '\\' && raw[j + 1] === '|') continue
        chars.push(j)
        comparable += raw[j]
      }
      const start = tableRow >= 0 ? comparable.indexOf(line, cellEnd) : comparable.lastIndexOf(line)
      if (start >= 0) {
        if (tableRow >= 0) cellEnd = start + line.length
        for (const part of parts) {
          if (part.from < innerStart || part.to > innerStart + line.length) continue
          const from = offsets[row] + chars[start + part.from - innerStart]
          const to = offsets[row] + chars[start + part.to - innerStart - 1] + 1
          if (Number.isFinite(from) && Number.isFinite(to)) links.push({ ...part, from, to })
        }
      }
      innerStart += line.length + 1
    }
  }
  return { references, links, inlineProse }
}
