import { EditorState, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap } from '@codemirror/view'
import { scanDelegation, type DelegationTask } from '../../shared/delegation-markdown'

export type OpenDelegation = (entry: 'palette' | 'confirm', task: DelegationTask | undefined, focus: () => void) => void

const tasks = StateField.define({
  create: (state) => scanDelegation(state.doc.toString()),
  update: (scan, tr) => tr.docChanged ? scanDelegation(tr.newDoc.toString()) : scan
})

class DelegateButton extends WidgetType {
  constructor(readonly line: number, readonly open: OpenDelegation) { super() }
  eq(other: DelegateButton) { return this.line === other.line && this.open === other.open }
  toDOM(view: EditorView) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'delegate-line'
    button.textContent = '委派'
    button.setAttribute('aria-label', '委派此行')
    button.title = '委派此行 · Ctrl+Shift+P 打开命令面板'
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      if (view.state.readOnly || view.composing || this.line !== currentLine(view)) return
      this.open('confirm', view.state.field(tasks).taskAt(this.line), () => view.focus())
    })
    return button
  }
}

const currentLine = (view: EditorView) => view.state.doc.lineAt(view.state.selection.main.head).number

export function delegationEditor(open: OpenDelegation, separator: string) {
  const snapshot = (task: DelegationTask | undefined) => task && separator !== '\n'
    ? { ...task, text: task.text.replaceAll('\n', separator) } : task
  const dispatch: OpenDelegation = (entry, task, focus) => open(entry, snapshot(task), focus)
  return [tasks, EditorView.decorations.compute([tasks, 'selection', 'doc', EditorState.readOnly], (state) => {
    const line = state.doc.lineAt(state.selection.main.head)
    if (state.readOnly || !state.field(tasks).lines.includes(line.number)) return Decoration.none
    return Decoration.set(Decoration.widget({ widget: new DelegateButton(line.number, dispatch), side: 1 }).range(line.to))
  }), keymap.of([{
    key: 'Mod-Shift-p',
    run: (view) => {
      if (view.composing || view.state.readOnly) return false
      dispatch('palette', view.state.field(tasks).taskAt(currentLine(view)), () => view.focus())
      return true
    }
  }])]
}
