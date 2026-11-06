import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filesByLine, needsRerun, parseLog } from '../worker/logparse.mjs'

// The shape pdfTeX writes with -file-line-error and max_print_line=10000.
const LOG = [
  'This is pdfTeX, Version 3.141592653-2.6-1.40.27 (TeX Live 2025) (preloaded format=pdflatex)',
  '(./main.tex',
  'LaTeX2e <2025-11-01>',
  '(/usr/share/texlive/texmf-dist/tex/latex/base/article.cls',
  'Document Class: article 2025/01/22 v1.4n Standard LaTeX document class',
  '(/usr/share/texlive/texmf-dist/tex/latex/base/size10.clo))',
  '(./main.aux)',
  'LaTeX Warning: Reference `nowhere\' on page 1 undefined on input line 6.',
  '',
  '(./chapter.tex',
  'LaTeX Warning: Reference `missing:chapter\' on page 1 undefined on input line 2.',
  '',
  'Overfull \\hbox (98.9pt too wide) in paragraph at lines 4--4',
  '[]\\OT1/cmr/m/n/10 an overfull box (with parentheses) inside',
  ')',
  'Overfull \\hbox (97.8pt too wide) detected at line 17',
  './main.tex:21: Undefined control sequence.',
  'l.21 \\foo',
  '          ',
  '! Missing $ inserted.',
  '<inserted text> ',
  '                $',
  'l.30 x^',
  '       2',
  'Package natbib Warning: Citation `nobody2020\' on page 1 undefined on input line 6.',
  '',
  '[1{/usr/share/texlive/texmf-dist/fonts/map/pdftex/updmap/pdftex.map}] (./main.aux) )',
  'LaTeX Warning: There were undefined references.',
  'Output written on main.pdf (1 page, 12345 bytes).'
].join('\n')

test('each warning and box names the file TeX was reading', () => {
  const issues = parseLog(LOG)
  const find = (text) => issues.find((issue) => issue.message.includes(text))
  assert.deepEqual([find('nowhere').file, find('nowhere').line], ['main.tex', 6])
  assert.deepEqual([find('missing:chapter').file, find('missing:chapter').line], ['chapter.tex', 2])
  assert.deepEqual([find('98.9pt').file, find('98.9pt').line], ['chapter.tex', 4])
  // After `)` closes chapter.tex, TeX is back in main.tex.
  assert.deepEqual([find('97.8pt').file, find('97.8pt').line], ['main.tex', 17])
  assert.equal(find('nobody2020').file, 'main.tex')
})

test('errors with file:line, and ! errors with their l. line', () => {
  const issues = parseLog(LOG)
  const undefinedCs = issues.find((issue) => issue.message.startsWith('Undefined control sequence'))
  assert.equal(undefinedCs.severity, 'error')
  assert.deepEqual([undefinedCs.file, undefinedCs.line], ['main.tex', 21])
  assert.match(undefinedCs.message, /near: \\foo/)
  const missingDollar = issues.find((issue) => issue.message === 'Missing $ inserted.')
  assert.deepEqual([missingDollar.file, missingDollar.line], ['main.tex', 30])
  // Errors sort first.
  assert.equal(issues[0].severity, 'error')
})

test('a warning without a line has no file either', () => {
  const issue = parseLog(LOG).find((entry) => entry.message.includes('There were undefined references'))
  assert.equal(issue.file, null)
  assert.equal(issue.line, null)
})

test('parentheses that are not files do not confuse the file stack', () => {
  const lines = ['(./a.tex', 'text (with an aside) and (nested (parens))', '(./b.tex', 'inside b', ')', 'back in a', ')', 'outside']
  assert.deepEqual(filesByLine(lines), [null, './a.tex', './a.tex', './b.tex', './b.tex', './a.tex', './a.tex', null])
})

test('Windows paths and quoted names with spaces', () => {
  const lines = ['("C:/Users/me/My Thesis/main.tex"', 'here', '(C:\\texlive\\2025\\texmf-dist\\tex\\latex\\base\\article.cls)', 'still main']
  const files = filesByLine(lines)
  assert.equal(files[1], 'C:/Users/me/My Thesis/main.tex')
  assert.equal(files[3], 'C:/Users/me/My Thesis/main.tex')
})

test('reruns are requested for changed labels and undefined citations', () => {
  assert.ok(needsRerun('LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.'))
  assert.ok(needsRerun("Package rerunfilecheck Warning: File `main.out' has changed."))
  assert.ok(!needsRerun('Output written on main.pdf (1 page).'))
})
