import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { inputsDigest, recordedInputs } from '../worker/inputs.mjs'

test('reads the inputs of a .fls file, relative ones against its PWD', () => {
  const fls = ['PWD /work/paper', 'INPUT main.tex', 'INPUT /usr/share/texmf/tex/latex/base/article.cls', 'OUTPUT main.pdf', 'INPUT main.tex', 'INPUT ./figs/plot.png'].join('\n')
  assert.deepEqual(recordedInputs(fls), [
    path.resolve('/work/paper', 'main.tex'),
    path.normalize('/usr/share/texmf/tex/latex/base/article.cls'),
    path.resolve('/work/paper', 'figs/plot.png')
  ])
})

test('the digest follows the project files read, not TeX files, outputs or where an overlay lives', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'olp-inputs-'))
  try {
    const project = path.join(root, 'project')
    const out = path.join(root, 'out')
    const overlay = path.join(root, 'overlay')
    for (const dir of [project, out, overlay, path.join(root, 'texmf')]) await mkdir(dir, { recursive: true })
    await writeFile(path.join(project, 'main.tex'), 'hello')
    await writeFile(path.join(project, 'plot.png'), 'png1')
    await writeFile(path.join(overlay, 'main.tex'), 'hello')
    await writeFile(path.join(out, 'main.aux'), 'aux1')
    await writeFile(path.join(root, 'texmf', 'article.cls'), 'cls1')
    const fls = (main) => ['PWD ' + project, `INPUT ${main}`, 'INPUT plot.png', `INPUT ${path.join(out, 'main.aux')}`, `INPUT ${path.join(root, 'texmf', 'article.cls')}`].join('\n')
    const digest = async (main) => {
      await writeFile(path.join(out, 'main.fls'), fls(main))
      return inputsDigest({ flsPath: path.join(out, 'main.fls'), projectDir: project, rootDir: project, overlayDir: overlay, outDir: out, extra: 'pdflatex' })
    }
    const first = await digest(path.join(project, 'main.tex'))
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(await digest(path.join(overlay, 'main.tex')), first, 'an overlay with the same text is the same input')
    await writeFile(path.join(out, 'main.aux'), 'aux2')
    await writeFile(path.join(root, 'texmf', 'article.cls'), 'cls2')
    assert.equal(await digest(path.join(project, 'main.tex')), first, 'outputs and TeX files do not count')
    await writeFile(path.join(project, 'plot.png'), 'png2')
    assert.notEqual(await digest(path.join(project, 'main.tex')), first, 'a changed figure counts')
    assert.equal(await inputsDigest({ flsPath: path.join(out, 'missing.fls'), projectDir: project, rootDir: project, overlayDir: overlay, outDir: out }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
