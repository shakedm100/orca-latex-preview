import assert from 'node:assert/strict'
import { test } from 'node:test'
import { latexCompletions } from '../editor/completions.js'

/** The part of CodeMirror's CompletionContext the source uses, for text with the cursor at its end. */
function contextFor(text, explicit = false) {
  return {
    explicit,
    pos: text.length,
    state: { doc: { toString: () => text } },
    matchBefore(pattern) {
      const lineStart = text.lastIndexOf('\n') + 1
      const line = text.slice(lineStart)
      const anchored = new RegExp(`(?:${pattern.source})$`, pattern.flags)
      const match = anchored.exec(line)
      return match ? { from: lineStart + match.index, to: text.length, text: match[0] } : null
    }
  }
}

const project = {
  labels: [{ name: 'fig:plot', file: '/p/main.tex', line: 3 }],
  citations: [{ key: 'knuth1984', author: 'Knuth, Donald E.', year: '1984', title: 'The TeXbook', venue: 'Addison-Wesley' }],
  environments: [],
  commands: [{ name: 'myvec', args: 1 }],
  files: { tex: ['chapter'], images: ['plot.png'], bib: ['refs.bib'] }
}
const complete = (text, explicit) => latexCompletions(() => project)(contextFor(text, explicit))
const labels = (result) => result?.options.map((option) => option.label) ?? []

test('block names at the start of a line offer whole blocks', () => {
  assert.deepEqual(labels(complete('Intro.\n  fig')), ['figure'])
  assert.deepEqual(labels(complete('Intro.\nsubf')), ['subfigures'])
  // Not in the middle of a sentence, and not for words no block starts with.
  assert.equal(complete('Some fig'), null)
  assert.equal(complete('\nframework'), null)
})

test('citations show author, year, title and venue', () => {
  const result = complete('see \\cite{kn')
  const [option] = result.options
  assert.equal(option.label, 'knuth1984')
  assert.equal(option.detail, 'Knuth 1984')
  assert.equal(option.info, 'The TeXbook\nAddison-Wesley')
})

test('references, files and the project’s own commands', () => {
  assert.ok(labels(complete('Figure~\\ref{fi')).includes('fig:plot'))
  assert.ok(labels(complete('\\includegraphics{')).includes('plot.png'))
  assert.ok(labels(complete('\\input{')).includes('chapter'))
  assert.ok(labels(complete('\\myv')).includes('\\myvec'))
  assert.ok(labels(complete('\\begin{fig')).includes('figure'))
})
