// Editing help for the LaTeX source: hovers on \ref and \cite, undefined keys underlined,
// Enter after \begin{x} writes \end{x}, and folding of environments and sections.
import { Decoration, foldService, getIndentUnit, hoverTooltip, keymap, Prec, StateEffect, ViewPlugin } from './vendor/codemirror.mjs'

// \ref-like and \cite-like commands, with their optional arguments and the {keys} group.
const REFERENCE = /\\([a-zA-Z]*ref|[cC]ref|labelcref|cpageref|vref|nameref|autoref)\*?\s*\{([^}]*)\}/g
const CITATION = /\\((?:no|auto|paren|text|foot|full|super)?[cC]ite[a-zA-Z]*)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g

/** Every key in a line: which command, the key, and where it is in the line. */
function keysIn(text) {
  const found = []
  for (const [pattern, kind] of [[REFERENCE, 'ref'], [CITATION, 'cite']]) {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      if (kind === 'ref' && match[1] === 'href') continue // a link, not a reference
      const groupStart = match.index + match[0].lastIndexOf('{') + 1
      let offset = 0
      for (const part of match[2].split(',')) {
        const key = part.trim()
        const start = groupStart + offset + part.indexOf(key)
        if (key && key !== '*') found.push({ kind, command: match[1], key, from: start, to: start + key.length })
        offset += part.length + 1
      }
    }
  }
  return found
}

/** Labels defined in the buffer itself, which the project scan may not have seen yet. */
function bufferLabels(doc) {
  const labels = new Set()
  for (const match of doc.toString().matchAll(/\\label\s*\{([^}]+)\}/g)) labels.add(match[1].trim())
  return labels
}

const firstAuthor = (author) => {
  const first = (author ?? '').split(/\s+and\s+/)[0] ?? ''
  return first.includes(',') ? first.split(',')[0].trim() : first.trim().split(/\s+/).pop() ?? ''
}
const authors = (author) => {
  const names = (author ?? '').split(/\s+and\s+/).filter(Boolean)
  return names.length > 2 ? `${firstAuthor(author)} et al.` : names.map((name) => firstAuthor(name)).join(' and ')
}

function card(lines) {
  const dom = document.createElement('div')
  dom.className = 'cm-latex-hover'
  for (const [className, text] of lines) {
    if (!text) continue
    const line = document.createElement('div')
    line.className = className
    line.textContent = text
    dom.append(line)
  }
  return { dom }
}

const shortFile = (file) => String(file ?? '').split(/[\\/]/).pop()

/**
 * @param {() => any} getProject  the latest `latex.project` answer, or null
 */
export function latexTools(getProject) {
  const projectChanged = StateEffect.define()

  const hover = hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos)
    const hit = keysIn(line.text).find((key) => pos >= line.from + key.from && pos <= line.from + key.to)
    if (!hit) return null
    const project = getProject() ?? {}
    let content
    if (hit.kind === 'ref') {
      const label = (project.labels ?? []).find((entry) => entry.name === hit.key)
      if (label) {
        const number = label.number ? `${label.number}${label.page ? `, page ${label.page}` : ''}` : ''
        content = card([
          ['title', label.context ? label.context.slice(0, 240) : hit.key],
          ['muted', [number, `${shortFile(label.file)}:${label.line}`].filter(Boolean).join('  ·  ')]
        ])
      } else if (bufferLabels(view.state.doc).has(hit.key)) {
        content = card([['title', hit.key], ['muted', 'Defined in this file; recompile for its number.']])
      } else {
        content = card([['title warn', `Undefined reference: ${hit.key}`], ['muted', 'No \\label with this name in the project.']])
      }
    } else {
      const entry = (project.citations ?? []).find((citation) => citation.key === hit.key)
      if (entry) {
        const who = authors(entry.author)
        content = card([
          ['title', entry.title || hit.key],
          ['', [who, entry.year].filter(Boolean).join(', ')],
          ['muted', [entry.venue, entry.number ? `[${entry.number}]` : '', entry.type === 'bibitem' ? `\\bibitem in ${shortFile(entry.file)}` : entry.type].filter(Boolean).join('  ·  ')]
        ])
      } else if (project.citationSources) {
        content = card([['title warn', `Undefined citation: ${hit.key}`], ['muted', 'Not in the bibliography files this document loads.']])
      } else {
        content = card([['title', hit.key], ['muted', 'No bibliography found: add \\bibliography{...} or \\addbibresource{...}.']])
      }
    }
    return { pos: line.from + hit.from, end: line.from + hit.to, above: true, create: () => content }
  })

  // Keys with no definition get a wavy underline, in the lines on screen.
  const undefinedMark = Decoration.mark({ class: 'cm-undefined-key' })
  function undefinedKeys(view) {
    const project = getProject()
    if (!project) return Decoration.none
    const labels = new Set((project.labels ?? []).map((label) => label.name))
    for (const name of bufferLabels(view.state.doc)) labels.add(name)
    const citations = new Set((project.citations ?? []).map((entry) => entry.key))
    const ranges = []
    for (const { from, to } of view.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = view.state.doc.lineAt(pos)
        const text = line.text.replace(/(^|[^\\])%.*$/, '$1') // not in comments
        for (const key of keysIn(text)) {
          const missing = key.kind === 'ref' ? !labels.has(key.key) : project.citationSources > 0 && !citations.has(key.key)
          if (missing && !key.key.includes('#')) ranges.push(undefinedMark.range(line.from + key.from, line.from + key.to))
        }
        pos = line.to + 1
      }
    }
    return Decoration.set(ranges, true)
  }
  const underline = ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = undefinedKeys(view)
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(projectChanged)))) {
          this.decorations = undefinedKeys(update.view)
        }
      }
    },
    { decorations: (plugin) => plugin.decorations }
  )

  return {
    extensions: [hover, underline, Prec.high(keymap.of([{ key: 'Enter', run: closeEnvironment }])), foldService.of(foldLatex)],
    /** Tells the editor that `getProject()` has new data. */
    projectChanged: () => projectChanged.of(null)
  }
}

/** Enter right after `\begin{name}` (with any arguments) writes the matching \end on its own line. */
export function closeEnvironment(view) {
  const { state } = view
  const range = state.selection.main
  if (!range.empty) return false
  const line = state.doc.lineAt(range.head)
  const before = line.text.slice(0, range.head - line.from)
  const after = line.text.slice(range.head - line.from)
  const match = /\\begin\s*\{([^}]+)\}(?:\s*(?:\[[^\]]*\]|\{[^}]*\}))*\s*$/.exec(before)
  if (!match || after.trim()) return false
  const name = match[1]
  if (isClosed(state.doc.toString(), line.to, name)) return false
  const indent = /^\s*/.exec(line.text)[0]
  const unit = getIndentUnit(state) ? ' '.repeat(getIndentUnit(state)) : '\t'
  const insert = `\n${indent}${unit}\n${indent}\\end{${name}}`
  view.dispatch({
    changes: { from: range.head, to: line.to, insert },
    selection: { anchor: range.head + 1 + indent.length + unit.length },
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

/** Whether the \begin{name} that ends at `from` already has its \end. */
function isClosed(text, from, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\\\(begin|end)\\s*\\{${escaped}\\}`, 'g')
  pattern.lastIndex = from
  // Closed when the next \begin or \end of this name is an \end: a new \begin first means this
  // one is still open (nested environments of one name are rare enough to accept that).
  const next = pattern.exec(text)
  return next?.[1] === 'end'
}

const SECTION_DEPTH = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 }

/** Folds \begin{x}...\end{x}, and a heading down to the next heading of the same or higher rank. */
function foldLatex(state, lineStart, lineEnd) {
  const line = state.doc.lineAt(lineStart)
  const text = line.text.replace(/(^|[^\\])%.*$/, '$1')
  const env = /\\begin\s*\{([^}]+)\}/.exec(text)
  if (env && env[1] !== 'document') {
    const escaped = env[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`\\\\(begin|end)\\s*\\{${escaped}\\}`, 'g')
    let depth = 0
    const limit = Math.min(state.doc.lines, line.number + 5000)
    for (let n = line.number; n <= limit; n += 1) {
      const current = state.doc.line(n)
      const body = current.text.replace(/(^|[^\\])%.*$/, '$1')
      const start = n === line.number ? env.index : 0
      pattern.lastIndex = start
      for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
        depth += match[1] === 'begin' ? 1 : -1
        if (depth === 0) {
          if (n === line.number) return null
          return { from: line.to, to: state.doc.line(n).from + match.index }
        }
      }
    }
    return null
  }
  const heading = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?[\s[{]/.exec(text)
  if (!heading) return null
  const rank = SECTION_DEPTH[heading[1]]
  const limit = Math.min(state.doc.lines, line.number + 20000)
  let last = line.number
  for (let n = line.number + 1; n <= limit; n += 1) {
    const current = state.doc.line(n).text
    const next = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?[\s[{]/.exec(current)
    if ((next && SECTION_DEPTH[next[1]] <= rank) || /^\s*\\(end\{document\}|appendix|bibliography\b|printbibliography)/.test(current)) break
    last = n
  }
  // Leave trailing blank lines outside the fold.
  while (last > line.number && !state.doc.line(last).text.trim()) last -= 1
  return last > line.number ? { from: line.to, to: state.doc.line(last).to } : null
}
