import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { test } from 'node:test'
import { bibText, countWords, labelContext, scanProject, stripComments } from '../worker/project.mjs'

const rootDir = fileURLToPath(new URL('./fixtures/project/', import.meta.url))
const root = path.join(rootDir, 'main.tex')

test('scans the main file and its \\input in document order', async () => {
  const project = await scanProject({ root, rootDir, overlays: new Map() })
  assert.deepEqual(project.outline.map((entry) => entry.title), ['Introduction', 'Method'])
  assert.equal(path.basename(project.outline[1].file), 'chapter.tex')
  assert.deepEqual(project.labels.map((label) => label.name).sort(), ['fig:plot', 'sec:intro', 'sec:method'])
  assert.equal(project.citationSources, 1)
})

test('labels say what they name', async () => {
  const project = await scanProject({ root, rootDir, overlays: new Map() })
  const byName = Object.fromEntries(project.labels.map((label) => [label.name, label.context]))
  assert.equal(byName['sec:intro'], 'section: Introduction')
  assert.equal(byName['fig:plot'], 'figure: A plot of results')
  assert.equal(byName['sec:method'], 'section: Method')
})

test('reads citation keys, authors, years and venues', async () => {
  const project = await scanProject({ root, rootDir, overlays: new Map() })
  const knuth = project.citations.find((entry) => entry.key === 'knuth1984')
  assert.equal(knuth.year, '1984')
  assert.equal(knuth.venue, 'Addison-Wesley')
  assert.equal(knuth.title, 'The TeXbook')
  const lamport = project.citations.find((entry) => entry.key === 'lamport1986')
  assert.equal(lamport.venue, 'Journal of Examples')
})

test('unsaved text replaces the file on disk', async () => {
  const overlays = new Map([[path.join(rootDir, 'chapter.tex'), '\\section{Rewritten}\\label{sec:new}\n']])
  const project = await scanProject({ root, rootDir, overlays })
  assert.deepEqual(project.outline.map((entry) => entry.title), ['Introduction', 'Rewritten'])
})

test('a label right after a heading, inside an environment, or alone', () => {
  const text = '\\begin{equation}\n  x = 1 \\label{eq:one}\n\\end{equation}\nSome words \\label{plain}'
  assert.equal(labelContext(text, text.indexOf('\\label{eq:one}')), 'equation')
  assert.equal(labelContext(text, text.indexOf('\\label{plain}')), 'Some words')
})

test('word count skips the preamble, math, commands and comments', () => {
  const text = '\\documentclass{article}\n\\title{Not counted}\n\\begin{document}\nOne two three $x + y$ four. % five six\n\\begin{equation} a = b \\end{equation}\n\\textbf{Seven} eight\\cite{key}.\n\\end{document}'
  assert.equal(countWords([text]), 6)
})

test('comments are removed but escaped percent signs stay', () => {
  assert.equal(stripComments('50\\% done % comment\nnext'), '50\\% done \nnext')
})

test('bibliography text: TeX accents and special letters become plain letters', () => {
  assert.equal(bibText("Th{\\'e}orie analytique de la chaleur"), 'Théorie analytique de la chaleur')
  assert.equal(bibText('Erd\\H{o}s and G{\\"o}del and \\v{C}ech'), 'Erdős and Gödel and Čech')
  assert.equal(bibText('Stra{\\ss}e, {\\AA}ngstr{\\"o}m, \\l{}uk, na\\"{\\i}ve'), 'Straße, Ångström, łuk, naïve')
  assert.equal(bibText('{LaTeX}: A {\\TeX} \\& {B}ib{\\TeX} guide'), 'LaTeX: A TeX & BibTeX guide')
  assert.equal(bibText('Fran\\c{c}ois  and~Jos\\\'e'), 'François and José')
})
