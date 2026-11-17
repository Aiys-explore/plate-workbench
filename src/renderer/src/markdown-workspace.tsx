import { Compartment, EditorState, StateField } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import DOMPurify from 'dompurify'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { markdownSource, scanWiki, wikiParser, type WikiLink } from '../../shared/wiki-markdown'
import { delegationBlocks } from '../../shared/delegation-markdown'
import { delegationEditor, type OpenDelegation } from './delegation-editor'

export type MarkdownMode = 'edit' | 'preview' | 'split'

const parser = wikiParser()
delegationBlocks(parser)
// Remove the image URL before sanitization or DOM parsing.
parser.renderer.rules.image = (tokens, index) =>
  `<span title="预览不会加载图片">[图片：${parser.utils.escapeHtml(tokens[index].content)}]</span>`
parser.renderer.rules.wiki_link = (tokens, index) => {
  const { ref, label } = tokens[index].meta as WikiLink
  return `<button type="button" class="wiki-link" data-wiki-ref="${parser.utils.escapeHtml(ref)}">${parser.utils.escapeHtml(label)}</button>`
}

type Activate = (ref: string, anchor: Element) => void
const linkMarks = (text: string) => {
  const { links } = scanWiki(text, true)
  return Decoration.set(links.map(({ ref, from, to }) => Decoration.mark({
    class: 'wiki-source-link', attributes: { 'data-wiki-ref': ref, title: 'Ctrl+单击或 Ctrl+Enter 打开笔记引用' }
  }).range(from, to)), true)
}
const wikiMarks = StateField.define({
  create: (state) => linkMarks(state.doc.toString()),
  update: (marks, tr) => tr.docChanged ? linkMarks(tr.newDoc.toString()) : marks,
  provide: (field) => EditorView.decorations.from(field)
})

const highlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.heading, tags.strong], color: 'var(--accent)', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
  { tag: [tags.monospace, tags.processingInstruction], color: 'var(--text-muted)' }
]))

const editorTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text)', backgroundColor: 'var(--surface-editor)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-markdown)', fontSize: 'var(--text-markdown)', lineHeight: '1.75' },
  '.cm-content': { caretColor: 'var(--text)', padding: '12px 0' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { backgroundColor: 'var(--surface-side)', color: 'var(--text-muted)', borderColor: 'var(--border)' },
  '.cm-gutterElement': { paddingRight: '8px' },
  '.cm-content ::selection, .cm-content::selection': { backgroundColor: 'var(--accent-bg)' }
})

const readOnly = (busy: boolean) => [
  EditorState.readOnly.of(busy),
  EditorState.changeFilter.of(() => !busy),
  EditorView.contentAttributes.of({ 'aria-readonly': String(busy) })
]

export function MarkdownEditor({ value, onChange, busy, hidden, activate, delegate }: {
  value: string; onChange: (next: string) => void; busy: boolean; hidden: boolean; activate: Activate
  delegate: OpenDelegation
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const access = useMemo(() => new Compartment(), [])
  const initial = useRef(value)
  const action = useRef(activate)
  const openDelegation = useRef(delegate)
  const onEdit = useRef(onChange)
  useLayoutEffect(() => { onEdit.current = onChange }, [onChange])
  useLayoutEffect(() => { action.current = activate }, [activate])
  useLayoutEffect(() => { openDelegation.current = delegate }, [delegate])

  useLayoutEffect(() => {
    const text = initial.current
    // CodeMirror uses LF internally. Keep the source line ending for homogeneous files.
    const separator = text.includes('\r\n') && !text.replaceAll('\r\n', '').includes('\n') ? '\r\n' : '\n'
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(), history(), markdown(), highlight, editorTheme, EditorView.lineWrapping, wikiMarks,
        delegationEditor((...args) => openDelegation.current(...args), separator),
        keymap.of([{ key: 'Mod-Enter', run: (editor) => {
          const cursor = editor.state.selection.main.head
          let handled = false
          editor.state.field(wikiMarks).between(cursor, cursor, (from, to, mark) => {
            if (!handled && cursor >= from && cursor <= to) {
              handled = true
              action.current(mark.spec.attributes['data-wiki-ref'], editor.contentDOM)
            }
          })
          return handled
        } }, ...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          mousedown: (event) => {
            const link = (event.target as Element).closest<HTMLElement>('[data-wiki-ref]')
            if (event.button !== 0 || (!event.ctrlKey && !event.metaKey) || !link?.dataset.wikiRef) return false
            event.preventDefault()
            action.current(link.dataset.wikiRef, link)
            return true
          }
        }),
        EditorView.contentAttributes.of({
          role: 'textbox', 'aria-label': 'Markdown 正文', 'aria-multiline': 'true', spellcheck: 'false'
        }),
        access.of(readOnly(false)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onEdit.current(update.state.doc.toString().replaceAll('\n', separator))
        })
      ]
    })
    const editor = new EditorView({ state, parent: host.current! })
    view.current = editor
    return () => { view.current = null; editor.destroy() }
  }, [access])

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: access.reconfigure(readOnly(busy)) })
  }, [access, busy])

  return <div ref={host} className="markdown-source" hidden={hidden} />
}

export function MarkdownPreview({ value, activate }: { value: string; activate: Activate }) {
  const html = useMemo(() => ({ __html: DOMPurify.sanitize(parser.render(markdownSource(value)), {
    ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'span',
      'em', 'strong', 's', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'th', 'td', 'button'],
    ALLOWED_ATTR: ['href', 'title', 'start', 'type', 'class', 'data-wiki-ref'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false
  }) }), [value])
  return <article className="markdown-preview" aria-label="Markdown 预览" tabIndex={0}
    onClick={(event) => {
      const element = event.target as Element
      if (element.closest('a')) event.preventDefault()
      const link = element.closest<HTMLButtonElement>('button[data-wiki-ref]')
      if (link?.dataset.wikiRef) activate(link.dataset.wikiRef, link)
    }}
    dangerouslySetInnerHTML={html} />
}
