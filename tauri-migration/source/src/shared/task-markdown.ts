// S6 简化任务语法：
//   - [ ] TODO: 任务内容            （默认 Agent）
//   - [ ] TODO(@dsh): 任务内容      （括号内指定 Agent 类型）
//   - [ ] TODO                      （无冒号，内容为行内剩余文字）
//   「TODO」任务内容                （中文直角引号触发）
// 运行态标记：DOING #t-xxxx / PENDING #t-xxxx / DONE #t-xxxx（状态归 SQLite，终态改写 Markdown）。
export type TaskLineState = 'DOING' | 'PENDING' | 'DONE'

export interface TaskTodo {
  /** 行号（1 起） */
  line: number
  /** 状态标记 token 的绝对字符区间 */
  from: number
  to: number
  /** 括号内指定的 Agent 类型；空串表示默认 */
  agent: string
  /** 标记后的任务内容（去掉冒号/空格） */
  content: string
}

export interface TaskMarker {
  line: number
  from: number
  to: number
  state: TaskLineState
  taskId: string
  /** 标记 token 之后的行内剩余文字 */
  rest: string
}

const TODO_TOKEN =
  /^(?<prefix>[ \t]*(?:[-*+][ \t]+\[[ xX]\][ \t]+)?)(?<token>TODO(?:\(@?(?<agent1>[a-z0-9_-]{1,32})\))?|「TODO(?:@?(?<agent2>[a-z0-9_-]{1,32})\))?」)(?<sep>:[ \t]*|[ \t]+)?(?<content>[^\r\n]*)$/

// id 含「t-」前缀，与 task_runs.taskId（'t-xxxxxx'）一致，避免两侧标识错位。
const MARKER_TOKEN =
  /^(?<prefix>[ \t]*(?:[-*+][ \t]+\[[ xX]\][ \t]+)?)(?<state>DOING|PENDING|DONE)[ \t]+#(?<id>t-[0-9a-z]{4,12})(?<rest>[^\r\n]*)$/

export function scanTaskLines(raw: string): { todos: TaskTodo[]; markers: TaskMarker[] } {
  const todos: TaskTodo[] = []
  const markers: TaskMarker[] = []
  const todoRe = new RegExp(TODO_TOKEN.source, 'gm')
  const markerRe = new RegExp(MARKER_TOKEN.source, 'gm')
  let line = 1
  // 逐行扫描：以换行切分并累计绝对偏移（兼容 CRLF）。
  let cursor = 0
  while (cursor <= raw.length) {
    let newline = raw.indexOf('\n', cursor)
    let lineEnd = newline === -1 ? raw.length : newline
    let lineText = raw.slice(cursor, lineEnd)
    if (lineText.endsWith('\r')) { lineText = lineText.slice(0, -1); lineEnd = cursor + lineText.length }
    const markerMatch = markerRe.exec(lineText)
    markerRe.lastIndex = 0
    if (markerMatch?.groups) {
      const { prefix, state, id, rest } = markerMatch.groups
      const from = cursor + prefix.length
      const tokenLength = state.length + 1 + 1 + id.length
      markers.push({
        line, from, to: from + tokenLength,
        state: state as TaskLineState, taskId: id, rest: rest.replace(/^[ \t]+/, ''),
      })
    } else {
      const todoMatch = todoRe.exec(lineText)
      todoRe.lastIndex = 0
      if (todoMatch?.groups) {
        const { prefix, token, agent1, agent2, sep, content } = todoMatch.groups
        const from = cursor + prefix.length
        todos.push({
          line, from, to: from + token.length,
          agent: agent1 ?? agent2 ?? '',
          content: content.trim(),
        })
        void sep
      }
    }
    if (newline === -1) break
    cursor = newline + 1
    line++
  }
  return { todos, markers }
}

/** 把输出文本转为任务行下方引用块的 Markdown。 */
export function outputQuote(output: string, newline: string, maxLines = 40): string {
  const lines = output.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim()).slice(0, maxLines)
  if (!lines.length) return ''
  return lines.map(l => `> ${l}`).join(newline)
}

