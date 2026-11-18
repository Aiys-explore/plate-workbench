import { markdownLanguage } from '@codemirror/lang-markdown'

export type TaskLineState = 'DOING' | 'PENDING' | 'DONE'

export interface TaskTodo {
  line: number
  from: number
  to: number
  agent: string
  content: string
}

export interface TaskMarker {
  line: number
  from: number
  to: number
  state: TaskLineState
  taskId: string
  contextEnd: number
}

const TODO_TOKEN =
  /^(?<prefix>[ \t]*(?:[-*+][ \t]+\[[ xX]\][ \t]+)?)(?<token>TODO(?:\(@?(?<agent>[a-z0-9_-]{1,32})\))?(?=$|[ \t:：])|「TODO」)(?:[ \t]*[:：][ \t]*|[ \t]*)(?<content>.*)$/
const MARKER_TOKEN =
  /^(?<prefix>[ \t]*(?:[-*+][ \t]+\[[ xX]\][ \t]+)?)(?<token>(?<state>DOING|PENDING|DONE)[ \t]+#(?<id>t-[0-9a-z]{4,12}))(?=$|[ \t:：])/
type Line = { start: number; end: number; text: string; indent: number }

export function scanTaskLines(raw: string): { todos: TaskTodo[]; markers: TaskMarker[] } {
  const todos: TaskTodo[] = []
  const markers: TaskMarker[] = []
  if (!/(TODO|#t-)/.test(raw)) return { todos, markers }

  const lines: Line[] = []
  let start = 0
  for (const part of raw.split('\n')) {
    const text = part.endsWith('\r') ? part.slice(0, -1) : part
    let indent = 0
    for (const char of text) {
      if (char === ' ') indent++
      else if (char === '\t') indent += 4 - indent % 4
      else break
    }
    lines.push({ start, end: start + text.length, text, indent })
    start += part.length + 1
  }
  const code: Array<{ from: number; to: number }> = []
  markdownLanguage.parser.parse(raw).iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock'].includes(node.name)) {
      code.push({ from: node.from, to: node.to })
      return false
    }
  } })
  let range = 0
  for (const [i, line] of lines.entries()) {
    const marker = MARKER_TOKEN.exec(line.text)?.groups
    const todo = marker ? undefined : TODO_TOKEN.exec(line.text)?.groups
    const match = marker ?? todo
    if (!match) continue
    const from = line.start + match.prefix.length
    const to = from + match.token.length
    while (code[range] && code[range].to <= from) range++
    if (code[range] && code[range].from <= from) continue

    let tail = i
    for (let n = i + 1; n < lines.length; n++) {
      const next = lines[n]
      if (!next.text.trim()) continue
      if (next.indent <= line.indent || TODO_TOKEN.test(next.text) || MARKER_TOKEN.test(next.text)) break
      tail = n
    }
    if (marker) {
      markers.push({ line: i + 1, from, to, state: marker.state as TaskLineState,
        taskId: marker.id, contextEnd: lines[tail].end })
    } else if (todo) {
      const content = todo.content.trimEnd()
      const extra = raw.slice(line.end, lines[tail].end)
      todos.push({ line: i + 1, from, to, agent: todo.agent ?? '', content: (content + extra).trim() })
    }
  }
  return { todos, markers }
}

export function outputQuote(output: string, newline: string): string {
  const text = output.replace(/\r\n/g, '\n').trimEnd()
  if (!text.trim()) return ''
  return text.split('\n').map(line => line ? '> ' + line : '>').join(newline)
}

