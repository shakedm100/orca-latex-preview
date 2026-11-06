import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { createSynctex, parseSynctex } from '../worker/synctex.mjs'

// From `pdflatex -synctex=-1` on a two-paragraph document, its folder renamed to /project.
const fixture = await readFile(new URL('./fixtures/tiny.synctex', import.meta.url), 'utf8')
const dir = await mkdtemp(path.join(os.tmpdir(), 'synctex-test-'))
after(() => rm(dir, { recursive: true, force: true }))

test('parses inputs and the records of each page', () => {
  const { inputs, pages } = parseSynctex(fixture)
  assert.equal(inputs.get(1), '/project/./tiny.tex')
  assert.equal(pages.size, 1)
  const records = pages.get(1)
  assert.ok(records.length > 20)
  // Coordinates are PDF points: the text block starts one inch plus 1.5 cm from the left.
  const first = records.find((record) => record.kind === 'h' && record.line === 3)
  assert.ok(Math.abs(first.x - 133.77) < 0.5, `x was ${first.x}`)
})

async function synctexFor(text) {
  const file = path.join(dir, `doc-${Math.random().toString(36).slice(2)}.synctex.gz`)
  await writeFile(file, gzipSync(Buffer.from(text.replaceAll('/project', dir))))
  return createSynctex({ synctexPath: file, rootDir: dir, overlayDir: path.join(dir, 'overlay') })
}

test('forward: a source line becomes boxes on its page', async () => {
  const sync = await synctexFor(fixture)
  const hit = await sync.forward(path.join(dir, 'tiny.tex'), 5)
  assert.equal(hit.page, 1)
  assert.equal(hit.line, 5)
  assert.ok(hit.boxes.length >= 1)
  const [box] = hit.boxes
  assert.ok(box.y > 100 && box.y < 140, `y was ${box.y}`)
  assert.ok(box.w > 50)
})

test('inverse: a point on the page becomes the line under it', async () => {
  const sync = await synctexFor(fixture)
  const forward = await sync.forward(path.join(dir, 'tiny.tex'), 3)
  const [box] = forward.boxes
  const hit = await sync.inverse(1, box.x + 20, box.y + box.h / 2)
  assert.equal(path.basename(hit.file), 'tiny.tex')
  assert.equal(hit.line, 3)
})

test('unsaved buffers read from the overlay map back to the project file', async () => {
  const overlaid = fixture.replace('Input:1:/project/./tiny.tex', 'Input:1:/project/overlay/tiny.tex')
  const sync = await synctexFor(overlaid)
  const hit = await sync.forward(path.join(dir, 'tiny.tex'), 3)
  assert.equal(hit?.page, 1)
})
