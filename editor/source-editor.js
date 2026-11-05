// The LaTeX source pane of the Editor | PDF view: CodeMirror 6 with the stex mode, themed from
// Orca's frame colors.
import {
  basicSetup,
  Compartment,
  defaultHighlightStyle,
  EditorState,
  EditorView,
  indentUnit,
  indentWithTab,
  keymap,
  oneDarkHighlightStyle,
  StateEffect,
  StateField,
  Decoration,
  StreamLanguage,
  stex,
  syntaxHighlighting,
  HighlightStyle,
  tags
} from './vendor/codemirror.mjs'
import { latexCompletions } from './completions.js'

/** Dark when Orca says so, else judged by the frame background Orca painted. */
function isDark() {
  const classes = document.documentElement.classList
  if (classes.contains('dark')) return true
  if (classes.contains('light')) return false
  // Orca's colors are oklch(); painting one pixel converts any CSS color to RGB.
  try {
    const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    context.fillStyle = getComputedStyle(document.body).backgroundColor
    context.fillRect(0, 0, 1, 1)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128
  } catch {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
}

function chrome(dark) {
  return EditorView.theme(
    {
      '&': { backgroundColor: 'var(--bg)', color: 'var(--fg)' },
      '.cm-content': { caretColor: 'var(--fg)' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fg)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: dark ? 'rgba(120, 160, 255, 0.28)' : 'rgba(9, 105, 218, 0.18)'
      },
      '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--fg)' },
      '.cm-searchMatch': { backgroundColor: 'rgba(255, 200, 0, 0.25)' },
      '.cm-tooltip': { backgroundColor: 'var(--card)', border: '1px solid var(--border)' }
    },
    { dark }
  )
}

// LaTeX colors. stex marks commands as tagName, environment names as keyword,
// optional arguments as atom.
const latexStyle = (dark) =>
  HighlightStyle.define(
    dark
      ? [
          { tag: tags.tagName, color: '#61afef' },
          { tag: tags.keyword, color: '#c678dd' },
          { tag: tags.atom, color: '#d19a66' },
          { tag: tags.number, color: '#d19a66' },
          { tag: tags.bracket, color: '#abb2bf' },
          { tag: tags.comment, color: '#7f848e', fontStyle: 'italic' },
          { tag: tags.invalid, color: '#e06c75' }
        ]
      : [
          { tag: tags.tagName, color: '#0b4fa8' },
          { tag: tags.keyword, color: '#8a1fa8' },
          { tag: tags.atom, color: '#a35200' },
          { tag: tags.number, color: '#0b7a55' },
          { tag: tags.bracket, color: '#57606a' },
          { tag: tags.comment, color: '#6a737d', fontStyle: 'italic' },
          { tag: tags.invalid, color: '#cf222e' }
        ]
  )
const highlight = (dark) => [
  syntaxHighlighting(latexStyle(dark)),
  syntaxHighlighting(dark ? oneDarkHighlightStyle : defaultHighlightStyle)
]

// Lines with compile errors, shaded until the next build.
const setErrorLines = StateEffect.define()
const errorLines = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setErrorLines)) {
        const lines = [...new Set(effect.value)].filter((line) => line >= 1 && line <= transaction.state.doc.lines).sort((a, b) => a - b)
        value = Decoration.set(
          lines.map((line) => Decoration.line({ class: 'cm-error-line' }).range(transaction.state.doc.line(line).from))
        )
      }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field)
})

// One line highlighted for a moment after a jump from the PDF.
const setFlash = StateEffect.define()
const flashField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setFlash)) {
        value = effect.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-flash-line' }).range(effect.value)])
      }
    }
    return value
  },
  provide: (field) => EditorView.decorations.from(field)
})

/**
 * @param {HTMLElement} parent
 * @param {{ text: string, readOnly: boolean, onChange: (text: string) => void, getProject: () => any,
 *   onDoubleClick?: (line: number) => void }} options
 */
export function createSourceEditor(parent, { text, readOnly, onChange, getProject, onDoubleClick }) {
  const themeSlot = new Compartment()
  const readOnlySlot = new Compartment()
  let applyingOutside = false

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        indentUnit.of('  '),
        StreamLanguage.define(stex),
        EditorView.lineWrapping,
        EditorState.languageData.of(() => [{ autocomplete: latexCompletions(getProject) }]),
        flashField,
        EditorView.domEventHandlers({
          dblclick(event, view) {
            const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
            if (pos !== null && onDoubleClick) onDoubleClick(view.state.doc.lineAt(pos).number)
            return false // keep CodeMirror's own word selection
          }
        }),
        errorLines,
        themeSlot.of([chrome(isDark()), highlight(isDark())]),
        readOnlySlot.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !applyingOutside) onChange(update.state.doc.toString())
        })
      ]
    })
  })

  orca.on('theme', () => {
    view.dispatch({ effects: themeSlot.reconfigure([chrome(isDark()), highlight(isDark())]) })
  })

  return {
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    /** Takes text that changed outside this editor, replacing only what differs so the cursor stays. */
    replace(next) {
      const current = view.state.doc.toString()
      if (current === next) return
      let start = 0
      while (start < current.length && start < next.length && current[start] === next[start]) start += 1
      let endCurrent = current.length
      let endNext = next.length
      while (endCurrent > start && endNext > start && current[endCurrent - 1] === next[endNext - 1]) {
        endCurrent -= 1
        endNext -= 1
      }
      applyingOutside = true
      try {
        view.dispatch({ changes: { from: start, to: endCurrent, insert: next.slice(start, endNext) } })
      } finally {
        applyingOutside = false
      }
    },
    setReadOnly(value) {
      view.dispatch({ effects: readOnlySlot.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]) })
    },
    goToLine(line) {
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
      view.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) })
      view.focus()
    },
    /** The selection and the first line on screen, to restore when the view reopens. */
    getPlace() {
      const { anchor, head } = view.state.selection.main
      return { anchor, head, top: view.lineBlockAtHeight(view.scrollDOM.scrollTop).from }
    },
    setPlace(place) {
      const length = view.state.doc.length
      const clamp = (n) => Math.min(Math.max(0, Number(n) || 0), length)
      view.dispatch({
        selection: { anchor: clamp(place.anchor), head: clamp(place.head) },
        effects: EditorView.scrollIntoView(clamp(place.top), { y: 'start' })
      })
    },
    /** The 1-based line and column of the cursor. */
    cursor() {
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      return { line: line.number, column: head - line.from }
    },
    /** Moves the cursor to `line` and briefly highlights it (an inverse search landed there). */
    flashLine(line) {
      const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
      view.dispatch({
        selection: { anchor: target.from },
        effects: [EditorView.scrollIntoView(target.from, { y: 'center' }), setFlash.of(target.from)]
      })
      view.focus()
      setTimeout(() => view.dispatch({ effects: setFlash.of(null) }), 1400)
    },
    markErrors(lines) {
      view.dispatch({ effects: setErrorLines.of(lines) })
    }
  }
}
