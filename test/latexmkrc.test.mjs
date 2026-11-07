import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { latexmkRcArgs } from '../worker/latexmkrc.mjs'

const home = '/home/ada'
const dir = '/work/thesis'
const fs = (...files) => (file) => files.includes(file)

test('leaves latexmk alone when the folder has no rc file', () => {
  assert.deepEqual(latexmkRcArgs({ dir, trustProjectRc: false, home, env: {}, exists: fs(path.join(home, '.latexmkrc')) }), [])
})

test("skips a project's latexmkrc and reads back the user's and the system's", () => {
  const exists = fs(path.join(dir, 'latexmkrc'), '/etc/LatexMk', path.join(home, '.config', 'latexmk', 'latexmkrc'), path.join(home, '.latexmkrc'))
  assert.deepEqual(latexmkRcArgs({ dir, trustProjectRc: false, home, env: {}, exists }), [
    '-norc',
    '-r', '/etc/LatexMk',
    '-r', path.join(home, '.config', 'latexmk', 'latexmkrc'),
    '-r', path.join(home, '.latexmkrc')
  ])
})

test('treats .latexmkrc the same and honours XDG_CONFIG_HOME', () => {
  const xdgRc = path.join('/xdg', 'latexmk', 'latexmkrc')
  const exists = fs(path.join(dir, '.latexmkrc'), xdgRc)
  assert.deepEqual(latexmkRcArgs({ dir, trustProjectRc: false, home, env: { XDG_CONFIG_HOME: '/xdg' }, exists }), ['-norc', '-r', xdgRc])
})

test('runs the project rc file when the user trusts it', () => {
  assert.deepEqual(latexmkRcArgs({ dir, trustProjectRc: true, home, env: {}, exists: fs(path.join(dir, 'latexmkrc')) }), [])
})
