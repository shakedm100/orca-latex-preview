import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findRequirements } from '../worker/requirements.mjs'

const MISSING_PACKAGE = "! LaTeX Error: File `enumitem.sty' not found.\n"
const base = { steps: [], missingEngine: null, tools: { pdflatex: '/bin/pdflatex' }, engine: 'pdflatex', shellEscape: false }
const systems = {
  fedora: { os: 'linux', family: 'fedora', name: 'Fedora Linux' },
  debian: { os: 'linux', family: 'debian', name: 'Ubuntu' },
  arch: { os: 'linux', family: 'arch', name: 'Arch Linux' },
  macos: { os: 'macos', family: 'macos', name: 'macOS' },
  windows: { os: 'windows', family: 'windows', name: 'Windows' }
}

const installFor = async (system, tex, log = MISSING_PACKAGE, extra = {}) => {
  const found = await findRequirements({ ...base, ...extra, log, tex, system: systems[system] })
  return found
}

test('a missing package names the command for each system and TeX', async () => {
  const cases = [
    ['fedora', { kind: 'system' }, /dnf install 'tex\(enumitem\.sty\)'/],
    ['debian', { kind: 'system' }, /apt-file search \/enumitem\.sty/],
    ['arch', { kind: 'system' }, /pacman/],
    ['macos', { kind: 'mactex' }, /sudo tlmgr install enumitem/],
    ['windows', { kind: 'miktex' }, /miktex packages install enumitem/],
    ['arch', { kind: 'tinytex', userWritable: true }, /^tlmgr install enumitem/]
  ]
  for (const [system, tex, pattern] of cases) {
    const [requirement] = await installFor(system, tex)
    assert.equal(requirement.key, 'package:enumitem.sty', `${system}/${tex.kind}`)
    assert.ok(requirement.install.some((line) => pattern.test(line)), `${system}/${tex.kind}: ${requirement.install.join(' | ')}`)
  }
})

test('no TeX at all: how to install one, per system', async () => {
  const none = { kind: 'none' }
  const extra = { missingEngine: 'pdflatex', tools: {} }
  const windows = await installFor('windows', none, '', extra)
  assert.ok(windows[0].install.some((line) => line.includes('winget install MiKTeX.MiKTeX')))
  const macos = await installFor('macos', none, '', extra)
  assert.ok(macos[0].install.some((line) => /brew install --cask mactex/.test(line)), macos[0].install.join(' | '))
  const fedora = await installFor('fedora', none, '', extra)
  assert.ok(fedora[0].install.some((line) => /dnf install/.test(line)))
})

test('every requirement says which system it is for', async () => {
  const [requirement] = await installFor('debian', { kind: 'system' })
  assert.equal(requirement.system, 'Ubuntu')
  assert.ok(requirement.title && requirement.detail)
})

test('a clean log needs nothing', async () => {
  assert.deepEqual(await installFor('fedora', { kind: 'system' }, 'Output written on main.pdf (1 page).\n'), [])
})
