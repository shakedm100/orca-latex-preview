import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { isSelected, orcaCliCandidates, pruneStaleCopies, uploadCommand, orcaDataDirs, readSshTargets, rsyncFilters, sshArgs, sshTargetId, tarCommand } from '../worker/remote.mjs'

test('reads the SSH target id from a workspace host id', () => {
  assert.equal(sshTargetId('ssh:ssh-1793696715423-w26rrp'), 'ssh-1793696715423-w26rrp')
  assert.equal(sshTargetId('ssh:a%20b'), 'a b')
  assert.equal(sshTargetId('local'), null)
  assert.equal(sshTargetId('runtime:abc'), null)
  assert.equal(sshTargetId(null), null)
})

test('reaches a host imported from ~/.ssh/config by its alias', () => {
  const args = sshArgs({ id: 't', configHost: 'server', host: '10.0.0.4', port: 22, username: '' }, { platform: 'linux' })
  assert.deepEqual(args.slice(-2), ['--', 'server'])
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(!args.includes('-p') && !args.includes('-l'))
})

test('passes the port, user, key and jump host Orca saved', () => {
  const args = sshArgs(
    { id: 't', host: 'build.example', port: 2222, username: 'ada', identityFile: '~/.ssh/id_build', jumpHost: 'bastion' },
    { platform: 'linux', home: '/home/ada' }
  )
  const after = (flag) => args[args.indexOf(flag) + 1]
  assert.equal(after('-p'), '2222')
  assert.equal(after('-l'), 'ada')
  assert.equal(after('-i'), path.join('/home/ada', '/.ssh/id_build'))
  assert.equal(after('-J'), 'bastion')
  assert.deepEqual(args.slice(-2), ['--', 'build.example'])
})

test('shares one connection only where the socket path fits', () => {
  const short = sshArgs({ id: 't', host: 'h' }, { platform: 'linux', controlDir: '/home/ada/.cache/x/ssh' })
  assert.ok(short.some((arg) => arg.startsWith('ControlPath=')))
  const long = sshArgs({ id: 't', host: 'h' }, { platform: 'linux', controlDir: `/home/${'a'.repeat(80)}/ssh` })
  assert.ok(!long.some((arg) => arg.startsWith('ControlPath=')))
  const windows = sshArgs({ id: 't', host: 'h' }, { platform: 'win32', controlDir: 'C:\\c' })
  assert.ok(!windows.some((arg) => arg.startsWith('ControlPath=')))
})

test('refuses a host that would read as an ssh option', () => {
  assert.throws(() => sshArgs({ id: 't', host: '-oProxyCommand=x' }, { platform: 'linux' }))
})

test("looks for Orca's data where Electron keeps it on each system", () => {
  assert.ok(orcaDataDirs('linux', {}, '/home/ada').includes(path.join('/home/ada', '.config', 'orca')))
  assert.ok(orcaDataDirs('darwin', {}, '/Users/ada').includes(path.join('/Users/ada', 'Library', 'Application Support', 'orca')))
  assert.ok(orcaDataDirs('win32', { USERPROFILE: 'C:\\Users\\ada' }, 'C:\\Users\\ada').includes(path.join('C:\\Users\\ada', 'AppData', 'Roaming', 'orca')))
})

test("reads the active profile's SSH targets from orca-data.json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'olp-remote-'))
  try {
    await writeFile(path.join(dir, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: 'work' }))
    await mkdir(path.join(dir, 'profiles', 'work'), { recursive: true })
    await writeFile(
      path.join(dir, 'profiles', 'work', 'orca-data.json'),
      JSON.stringify({ sshTargets: [{ id: 'ssh-1', label: 'Builder', host: 'builder', port: 22, username: 'u' }] })
    )
    const targets = await readSshTargets([dir])
    assert.equal(targets.get('ssh-1').label, 'Builder')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reads SSH targets from the profile database', async (t) => {
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    t.skip('node:sqlite is not available in this Node')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'olp-remote-'))
  try {
    const profile = path.join(dir, 'profiles', 'local-default')
    await mkdir(profile, { recursive: true })
    const db = new DatabaseSync(path.join(profile, 'profile-state.db'))
    db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY, payload TEXT)')
    db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)').run('sshTargets', JSON.stringify([{ id: 'ssh-2', configHost: 'server', host: 'server', port: 22 }]))
    db.close()
    const targets = await readSshTargets([dir])
    assert.equal(targets.get('ssh-2').configHost, 'server')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('copies sources and figures, never hidden or dependency folders', () => {
  const tex = rsyncFilters('tex')
  assert.equal(tex[0], '--exclude=.*/')
  assert.ok(tex.includes('--exclude=node_modules/'))
  assert.ok(tex.includes('--include=*.tex'))
  assert.ok(!tex.includes('--include=*.png'))
  assert.equal(tex.at(-1), '--exclude=*')
  const full = rsyncFilters('full')
  for (const rule of ['--include=*.bib', '--include=*.png', '--include=*.pdf', '--include=latexmkrc']) assert.ok(full.includes(rule), rule)
  assert.match(tarCommand("/home/o'neil/paper", 'tex'), /^cd '\/home\/o'\\''neil\/paper' && find \./)
})

test('finds the Orca CLI under its Linux name, never GNOME Orca', () => {
  const candidates = orcaCliCandidates({ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/home/ada', dirs: ['/home/ada/.config/orca'] })
  assert.equal(candidates[0], path.join('/home/ada/.config/orca', 'linux-orca-cli-shim', 'orca'))
  assert.ok(candidates.includes(path.join('/usr/bin', 'orca-ide')))
  assert.ok(!candidates.includes(path.join('/usr/bin', 'orca')))
})

test('prunes only files a copy would have brought', () => {
  assert.ok(isSelected('docs/notebook.tex', 'tex'))
  assert.ok(!isSelected('docs/plot.png', 'tex'))
  assert.ok(isSelected('docs/figures/plot.PNG', 'full'))
  assert.ok(isSelected('latexmkrc', 'full'))
  assert.ok(!isSelected('.git/notes.tex', 'full'))
  assert.ok(!isSelected('node_modules/x/readme.txt', 'full'))
  assert.ok(!isSelected('docs/notebook.aux', 'full'))
})

test('deletes copies unused for longer than the limit, keeping those in use', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'olp-copies-'))
  try {
    const day = 24 * 60 * 60 * 1000
    const old = new Date(Date.now() - 30 * day)
    for (const name of ['stale', 'fresh', 'busy']) {
      await mkdir(path.join(root, name))
      await writeFile(path.join(root, name, '.orca-latex-preview-used'), '')
    }
    await utimes(path.join(root, 'stale', '.orca-latex-preview-used'), old, old)
    await utimes(path.join(root, 'busy', '.orca-latex-preview-used'), old, old)
    const removed = await pruneStaleCopies(root, { maxAgeMs: 14 * day, keep: new Set([path.join(root, 'busy')]) })
    assert.deepEqual(removed, [path.join(root, 'stale')])
    assert.ok(!existsSync(path.join(root, 'stale')))
    assert.ok(existsSync(path.join(root, 'fresh')) && existsSync(path.join(root, 'busy')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('uploads through a temporary file, then renames it into place', () => {
  assert.equal(
    uploadCommand("/home/o'neil/docs/notebook.pdf"),
    "cd '/home/o'\\''neil/docs' && cat > '.notebook.pdf.orca-latex-preview-upload' && mv -f '.notebook.pdf.orca-latex-preview-upload' 'notebook.pdf'"
  )
})

test('never downloads the PDF the plugin uploads', () => {
  const rules = rsyncFilters('full', ['docs/notebook/notebook.pdf'])
  assert.equal(rules[0], '--exclude=/docs/notebook/notebook.pdf')
  assert.ok(rules.indexOf('--exclude=/docs/notebook/notebook.pdf') < rules.indexOf('--include=*.pdf'))
})
