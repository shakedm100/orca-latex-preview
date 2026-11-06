import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPreambleCache, preambleOf } from '../worker/preamble.mjs'

test('the preamble is everything before \\begin{document}', () => {
  const text = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHi\n\\end{document}'
  assert.equal(preambleOf(text), '\\documentclass{article}\n\\usepackage{amsmath}\n')
})

test('no preamble to dump: no document environment, or packages that cannot be dumped', () => {
  assert.equal(preambleOf('\\section{Only a chapter}'), null)
  assert.equal(preambleOf('\\documentclass{article}\n\\usepackage{minted}\n\\begin{document}\\end{document}'), null)
  assert.equal(preambleOf('\\documentclass{article}\n\\usepackage[cache=false]{minted}\n\\begin{document}\\end{document}'), null)
  // A commented-out package does not count.
  assert.ok(preambleOf('\\documentclass{article}\n% \\usepackage{minted}\n\\begin{document}\\end{document}'))
})

test('only pdfLaTeX uses a format', async () => {
  const cache = createPreambleCache()
  const prepared = await cache.prepare({ root: '/x/main.tex', engine: 'xelatex', tools: { xelatex: '/bin/xelatex' }, env: {}, dir: '/x', outDir: '/x/out', text: '\\documentclass{article}\\begin{document}\\end{document}' })
  assert.equal(prepared, null)
})
