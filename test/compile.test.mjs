// Builds the fixture project with the TeX installed on this machine; skipped without one.
import assert from 'node:assert/strict'
import { cp, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { compileDocument } from '../worker/compile.mjs'
import { scanProject } from '../worker/project.mjs'
import { createSynctex } from '../worker/synctex.mjs'
import { detectTools } from '../worker/tools.mjs'

const info = await detectTools('')
const skip = info.tools.pdflatex ? false : 'pdflatex is not installed'
const work = await mkdtemp(path.join(os.tmpdir(), 'latex-preview-test-'))
after(() => rm(work, { recursive: true, force: true }))

const rootDir = path.join(work, 'project')
const outDir = path.join(work, 'out')
const root = path.join(rootDir, 'main.tex')
await cp(new URL('./fixtures/project/', import.meta.url), rootDir, { recursive: true })

const build = (extra = {}) =>
  compileDocument({ root, engine: 'pdflatex', tools: info.tools, tex: info.tex, searchDirs: info.dirs, useLatexmk: Boolean(info.tools.latexmk), outDir, shellEscape: false, ...extra })

test('builds the PDF and reports issues in the file they come from', { skip }, async () => {
  const result = await build()
  assert.ok(result.produced, result.logTail)
  assert.ok((await stat(path.join(outDir, 'main.pdf'))).size > 1000)
  const issue = (text) => result.issues.find((entry) => entry.message.includes(text))
  assert.equal(issue('missing:chapter')?.file, 'chapter.tex')
  assert.equal(issue('missing:chapter')?.line, 2)
  assert.equal(issue('nowhere')?.file, 'main.tex')
  assert.ok(result.issues.some((entry) => entry.severity === 'badbox' && entry.file === 'chapter.tex'))
  assert.ok(!issue('nobody2020') || issue('nobody2020').file === 'main.tex')
})

test('unsaved text in the overlay folder is what gets built, under its project name', { skip }, async () => {
  const overlayDir = path.join(work, 'overlay')
  const { mkdir, writeFile, readFile } = await import('node:fs/promises')
  await mkdir(overlayDir, { recursive: true })
  const text = await readFile(path.join(rootDir, 'chapter.tex'), 'utf8')
  await writeFile(path.join(overlayDir, 'chapter.tex'), text.replace('missing:chapter', 'missing:unsaved'))
  const result = await build({ overlayDir })
  const issue = result.issues.find((entry) => entry.message.includes('missing:unsaved'))
  assert.equal(issue?.file, 'chapter.tex')
  await rm(overlayDir, { recursive: true, force: true })
})

test('SyncTeX and the .aux numbers of the last build', { skip }, async () => {
  await build()
  const sync = createSynctex({ synctexPath: path.join(outDir, 'main.synctex.gz'), rootDir, overlayDir: path.join(work, 'overlay') })
  const hit = await sync.forward(path.join(rootDir, 'chapter.tex'), 2)
  assert.equal(hit?.page, 1)
  const back = await sync.inverse(hit.page, hit.boxes[0].x + 5, hit.boxes[0].y + hit.boxes[0].h / 2)
  assert.equal(path.basename(back.file), 'chapter.tex')
  const project = await scanProject({ root, rootDir, outDir, overlays: new Map() })
  const figure = project.labels.find((label) => label.name === 'fig:plot')
  assert.equal(figure.number, '1')
  assert.equal(figure.page, '1')
  const knuth = project.citations.find((entry) => entry.key === 'knuth1984')
  if (info.tools.bibtex) assert.equal(knuth.number, '1')
})
