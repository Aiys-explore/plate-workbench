import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentProfile } from '../../shared/agents'
import type { EditorSurface } from './editor/surface'

const directPattern = /^[ \t]*(?:(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)?(?:\/(?:t[a-z]*)?|tod[o]?|「(?:to[d]?)?|待办)|[-*+][ \t]+\[[ xX]\] +)$/i
const taskHead = /^[ \t]*(?:[-*+][ \t]+\[[ xX]\][ \t]+)?(TODO(?:\(@?[a-z0-9_-]+\))?)(?=$|[ \t:@：(\\])/i
type Completion = { from: number; to: number; indent: string; body?: string }

export type AutocompleteItem = {
  id: string
  label: string
  hint: string
  agent: string | null
}

export function useDiscoveredAgents() {
  const [profiles, setProfiles] = useState<AgentProfile[]>()
  useEffect(() => {
    let live = true
    let generation = 0
    const load = () => {
      const current = ++generation
      void window.workbench.agents.list().then(rows => {
        if (live && generation === current) setProfiles(rows)
      }, () => {
        if (live && generation === current) setProfiles([])
      })
    }
    const unlisten = window.workbench.agentPlugins.onChange(load)
    load()
    return () => { live = false; unlisten() }
  }, [])
  return profiles
}

export function useTaskAutocomplete(
  surface: React.RefObject<EditorSurface | null>,
  profiles: AgentProfile[] | undefined,
  readOnly: boolean,
  version: number,
  caret: number,
  composing: boolean,
) {
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<{ left: number; top: number }>()
  const [hintPosition, setHintPosition] = useState<{ left: number; top: number }>()
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'todo' | 'agent'>('todo')
  const contextRef = useRef<Completion | undefined>(undefined)

  useLayoutEffect(() => {
    if (readOnly || composing || surface.current?.session.mode !== 'render') {
      contextRef.current = undefined
      setQuery('')
      setPosition(undefined)
      setHintPosition(undefined)
      return
    }
    const editor = surface.current
    const point = editor?.session.selection.head ?? -1
    const line = point >= 0 ? editor?.lineAt(point) : undefined
    const caret = point
    if (!editor || !line || editor.session.composing || editor.inCode(caret) ||
        !(editor.host.ownerDocument.activeElement === editor.host.querySelector('[data-editor-host=render]'))) {
      contextRef.current = undefined
      setQuery('')
      setPosition(undefined)
      setHintPosition(undefined)
      return
    }
    const collapsed = editor.session.selection.anchor === caret
    const before = line.text.slice(0, caret - line.start)
    const atMatch = /\\?@([a-z0-9_-]*)$/i.exec(before)
    const head = taskHead.exec(before)
    if (head && atMatch && atMatch.index >= head[0].length && collapsed) {
      const gap = before.slice(head[0].length, atMatch.index)
      const editingHead = /^[ \t]*(?:\\?\([ \t]*)?$/.test(gap)
      const after = line.text.slice(caret - line.start)
      const consumed = editingHead ? /^\)?(?:[ \t]*[:：][ \t]*)?/.exec(after)![0].length : 0
      const body = editingHead ? undefined : gap.endsWith(':') || gap.endsWith('：') ? gap + ' ' : gap
      contextRef.current = { from: line.start + head[0].length - head[1].length, to: caret + consumed, indent: '', body }
      setMode('agent')
      setQuery(atMatch[1])
      setActive(0)
      const box = editor.caretAt(caret)
      setPosition(box && { left: box.left, top: box.top + box.height })
      setHintPosition(undefined)
      return
    }
    const displayLine = line.text.replace(/\\([/\[\]*+\-])/g, '$1')
    if (directPattern.test(displayLine) && collapsed && caret === line.start + line.text.length) {
      contextRef.current = { from: line.start, to: line.start + line.text.length, indent: /^[ \t]*/.exec(line.text)![0] }
      setMode('todo')
      setQuery(line.text.trim().toLowerCase())
      setActive(0)
      const box = editor.caretAt(caret)
      setPosition(box && { left: box.left, top: box.top + box.height })
      setHintPosition(undefined)
      return
    }
    if (collapsed && caret === line.start + line.text.length &&
        /^[ \t]*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)?$/.test(line.text)) {
      const box = editor.caretAt(caret)
      contextRef.current = undefined
      setPosition(undefined)
      if (box) setHintPosition({ left: box.left, top: box.top })
      else setHintPosition(undefined)
      return
    }
    contextRef.current = undefined
    setQuery('')
    setPosition(undefined)
    setHintPosition(undefined)
  }, [readOnly, profiles, surface, version, caret, composing])

  const items = useMemo<AutocompleteItem[]>(() => {
    const agents = (profiles ?? []).map(agent => ({
      id: agent.id, label: '● ' + agent.name + (agent.model ? ' · ' + agent.model : ''),
      hint: 'TODO(@' + agent.id + ')', agent: agent.id,
    }))
    return mode === 'todo'
      ? [{ id: 'default', label: '⚡ TODO · ' + (agents.length ? '交办给默认 Agent' : '待分派'),
        hint: '- [ ] TODO:', agent: null }, ...agents]
      : agents
  }, [profiles, mode])
  const filtered = useMemo(() => mode === 'todo' || !query ? items :
    items.filter(item => item.id.includes(query.toLowerCase()) || item.hint.toLowerCase().includes(query.toLowerCase())),
    [items, mode, query])
  const open = !composing && filtered.length > 0 && position !== undefined && contextRef.current !== undefined

  const accept = (item: AutocompleteItem | undefined) => {
    const context = contextRef.current
    const editor = surface.current
    if (!editor || !context || !item) return false
    const replace = mode === 'todo'
      ? `${context.indent}- [ ] TODO${item.agent ? `(@${item.agent})` : ''}: `
      : `TODO(@${item.id})${context.body ?? ': '}`
    const caret = context.from + replace.length
    if (!editor.applyAutocomplete({ from: context.from, to: context.to, insert: replace, caret })) return false
    contextRef.current = undefined
    setQuery('')
    setPosition(undefined)
    editor.focus()
    return true
  }

  return { active, setActive, items: filtered, open, position, hintPosition, mode, query, accept, close: () => {
    contextRef.current = undefined; setQuery(''); setPosition(undefined)
  } }
}

export function TaskAutocomplete({ state, surface }: {
  state: ReturnType<typeof useTaskAutocomplete>
  surface: React.RefObject<EditorSurface | null>
}) {
  if (!state.open || !state.position) return null
  return <div data-task-autocomplete data-task-autocomplete-query={state.query} role="listbox" aria-label="TODO 自动补全"
    style={{ position: 'fixed', left: Math.max(8, Math.min(state.position.left, innerWidth - 288)),
      top: Math.max(8, Math.min(state.position.top, innerHeight - state.items.length * 36 - 20)) }}
    onPointerDown={event => event.preventDefault()}>
    {state.items.map((item, index) => <button key={item.id} type="button" role="option" aria-selected={index === state.active}
      data-task-autocomplete-item={item.agent ?? 'default'} data-task-agent={item.agent ?? ''}
      tabIndex={-1}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { state.setActive(index); state.accept(item); surface.current?.focus() }}>
      <strong>{item.label}</strong><span>{item.hint}</span>
    </button>)}
  </div>
}

export function TaskCaretHint({ state }: { state: ReturnType<typeof useTaskAutocomplete> }) {
  if (state.open || !state.hintPosition) return null
  return <span data-task-placeholder aria-hidden="true"
    style={{ position: 'fixed', left: state.hintPosition.left, top: state.hintPosition.top }}>
    输入 / 或 TODO 委派给 Agent…
  </span>
}

export function handleTaskAutocompleteKey(event: React.KeyboardEvent, state: ReturnType<typeof useTaskAutocomplete>) {
  if (!state.open || event.nativeEvent.isComposing || event.keyCode === 229 || event.key === 'Process') return false
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    state.close()
    return true
  }
  if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) return false
  event.preventDefault()
  event.stopPropagation()
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    state.setActive(current => (current + (event.key === 'ArrowDown' ? 1 : -1) + state.items.length) % state.items.length)
  } else state.accept(state.items[state.active])
  return true
}
