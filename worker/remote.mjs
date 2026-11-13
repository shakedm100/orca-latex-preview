// Workspaces on SSH hosts. The build runs on this machine, so the plugin copies the remote
// workspace's TeX sources and figures into its cache with OpenSSH (rsync, or tar when rsync is
// missing) and compiles that copy. Orca's plugin API names a remote workspace's host but not how
// to reach it, so the connection settings come from the SSH hosts saved in Orca's profile.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Folders never copied: the same ones the local scan skips. Hidden folders are skipped too. */
export const SKIP_DIRS = ['node_modules', 'build', 'dist', 'out', 'target', 'vendor', '__pycache__']

/** What a build can read: sources, styles, bibliographies, figures and data for plots. */
const BUILD_EXTS = [
  'tex', 'ltx', 'bib', 'sty', 'cls', 'clo', 'bst', 'bbx', 'cbx', 'lbx', 'dbx', 'def', 'cfg', 'fd', 'ldf', 'ist',
  'tikz', 'pgf', 'png', 'jpg', 'jpeg', 'pdf', 'eps', 'ps', 'svg', 'gif', 'bmp', 'tif', 'tiff',
  'csv', 'tsv', 'dat', 'txt', 'table', 'mps'
]
const BUILD_NAMES = ['latexmkrc', '.latexmkrc']
const MAX_FILE = '50M'

/** `ssh:<target id>` hosts only; other kinds (paired runtimes) have no SSH target. */
export function sshTargetId(hostId) {
  if (typeof hostId !== 'string' || !hostId.startsWith('ssh:')) return null
  try {
    return decodeURIComponent(hostId.slice(4)) || null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ Orca's saved SSH hosts

/** Orca's user data folder on each OS (Electron's `userData` for the app named "orca"). */
export function orcaDataDirs(platform = process.platform, env = process.env, home = os.homedir()) {
  const bases =
    platform === 'win32'
      ? [env.APPDATA, env.USERPROFILE && path.join(env.USERPROFILE, 'AppData', 'Roaming')]
      : platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support')]
        : [env.XDG_CONFIG_HOME, path.join(home, '.config')]
  const dirs = []
  for (const base of bases) {
    if (!base) continue
    for (const name of ['orca', 'Orca']) {
      const dir = path.join(base, name)
      if (!dirs.includes(dir)) dirs.push(dir)
    }
  }
  return dirs
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** The `sshTargets` document of Orca's profile database, read only. */
async function targetsFromDatabase(file) {
  if (!existsSync(file)) return null
  let db
  try {
    const { DatabaseSync } = await import('node:sqlite')
    db = new DatabaseSync(file, { readOnly: true })
    const row = db.prepare('SELECT payload FROM profile_state_documents WHERE domain = ?').get('sshTargets')
    const targets = row ? JSON.parse(row.payload) : null
    return Array.isArray(targets) ? targets : null
  } catch {
    return null
  } finally {
    try {
      db?.close()
    } catch {
      // Already closed.
    }
  }
}

/**
 * The SSH hosts saved in Orca's active profile, by id. Newer Orca keeps them in
 * `profiles/<id>/profile-state.db`; older builds in `orca-data.json`.
 */
export async function readSshTargets(dirs = orcaDataDirs()) {
  const found = new Map()
  for (const dir of dirs) {
    const index = await readJson(path.join(dir, 'orca-profile-index.json'))
    const profile = typeof index?.activeProfileId === 'string' ? index.activeProfileId : 'local-default'
    const profileDir = path.join(dir, 'profiles', profile)
    const targets =
      (await targetsFromDatabase(path.join(profileDir, 'profile-state.db'))) ??
      (await readJson(path.join(profileDir, 'orca-data.json')))?.sshTargets ??
      (await readJson(path.join(dir, 'orca-data.json')))?.sshTargets
    if (!Array.isArray(targets)) continue
    for (const target of targets) {
      if (target && typeof target.id === 'string' && !found.has(target.id)) found.set(target.id, target)
    }
  }
  return found
}

// ------------------------------------------------------------------ Orca servers on SSH hosts

/**
 * The `orca` CLI. A host running its own Orca server (an "environment", as Orca sets up on an SSH
 * host) keeps its workspaces there, and the plugin API lists only this machine's; the CLI can
 * list both. On Linux it is `orca-ide`, since GNOME's screen reader owns `orca`.
 */
export function orcaCliCandidates({ platform = process.platform, env = process.env, home = os.homedir(), dirs = orcaDataDirs(platform, env, home) } = {}) {
  const pathDirs = String(env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  if (platform === 'linux') {
    return [
      ...dirs.map((dir) => path.join(dir, 'linux-orca-cli-shim', 'orca')),
      ...pathDirs.map((dir) => path.join(dir, 'orca-ide')),
      path.join(home, '.local', 'bin', 'orca-ide')
    ]
  }
  if (platform === 'darwin') {
    return ['/usr/local/bin/orca', path.join(home, '.local', 'bin', 'orca'), '/Applications/Orca.app/Contents/Resources/bin/orca']
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [...pathDirs.map((dir) => path.join(dir, 'orca.exe')), path.join(local, 'Programs', 'Orca', 'resources', 'bin', 'orca.exe')]
  }
  return []
}

async function orcaCli(cli, args) {
  const result = await run(cli, [...args, '--json'], { timeoutMs: 20_000 })
  let answer
  try {
    answer = JSON.parse(result.stdout)
  } catch {
    throw new Error(`orca ${args.join(' ')}: ${trimError(result.stderr || result.stdout) || `exit code ${result.code}`}`)
  }
  if (!answer.ok) throw new Error(`orca ${args.join(' ')}: ${answer.error?.message ?? 'failed'}`)
  return answer.result
}

/**
 * The workspaces of every Orca server that runs on an SSH host, as `workspace.list` would give
 * them, with `hostId` naming the SSH host so they are copied like any SSH workspace. Servers that
 * are not reachable are skipped.
 */
export async function listEnvironmentWorkspaces({ candidates = orcaCliCandidates(), log = () => {} } = {}) {
  const cli = candidates.find((file) => existsSync(file))
  if (!cli) return []
  const { environments = [] } = await orcaCli(cli, ['environment', 'list'])
  const lists = await Promise.all(
    environments
      .filter((environment) => environment.orcadDeployment?.sshTargetId)
      .map(async (environment) => {
        try {
          const { worktrees = [] } = await orcaCli(cli, ['worktree', 'list', '--environment', environment.id, '--limit', '500'])
          // `local` there means the server's own machine; anything else is out of reach.
          return worktrees
            .filter((worktree) => !worktree.hostId || worktree.hostId === 'local')
            .map((worktree) => ({
              id: `environment:${environment.id}:${worktree.id}`,
              kind: 'worktree',
              name: worktree.displayName || path.posix.basename(worktree.path),
              path: worktree.path,
              branch: worktree.branch ? String(worktree.branch).replace(/^refs\/heads\//, '') : null,
              hostId: `ssh:${encodeURIComponent(environment.orcadDeployment.sshTargetId)}`,
              environment: environment.name
            }))
        } catch (error) {
          log(`cannot list the workspaces of ${environment.name}: ${error.message}`)
          return []
        }
      })
  )
  return lists.flat()
}

// ------------------------------------------------------------------ ssh command line

const expandHome = (file, home) => (file && file.startsWith('~') ? path.join(home, file.slice(1)) : file)

/**
 * Orca starts plugin workers without SSH_AUTH_SOCK, so a key that lives only in an agent needs
 * the agent's socket found again: the host's IdentityAgent, else the usual places.
 */
export async function findAgentSocket(target, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const own = expandHome(target?.identityAgent, home)
  if (own && own !== 'none' && !own.startsWith('$')) return own
  if (env.SSH_AUTH_SOCK) return env.SSH_AUTH_SOCK
  if (platform === 'win32') return null // OpenSSH for Windows uses its named pipe without a variable
  const candidates = [path.join(home, '.1password', 'agent.sock')]
  if (platform === 'darwin') {
    try {
      for (const name of await readdir('/private/tmp')) {
        if (name.startsWith('com.apple.launchd.')) candidates.push(path.join('/private/tmp', name, 'Listeners'))
      }
    } catch {
      // No launchd folders.
    }
  } else if (typeof process.getuid === 'function') {
    const runtime = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`
    candidates.unshift(
      path.join(runtime, 'ssh-agent.socket'),
      path.join(runtime, 'gcr', 'ssh'),
      path.join(runtime, 'keyring', 'ssh'),
      path.join(runtime, 'openssh_agent')
    )
  }
  return candidates.find((socket) => existsSync(socket)) ?? null
}

/**
 * The options and destination for `ssh`, from an Orca SSH host. A host imported from
 * ~/.ssh/config is reached by its alias, so OpenSSH applies the same config Orca read.
 */
export function sshArgs(target, { controlDir = null, platform = process.platform, home = os.homedir() } = {}) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2']
  // `%C` is 40 characters, and a socket path must stay under about 104 bytes (macOS).
  if (controlDir && platform !== 'win32' && Buffer.byteLength(controlDir) + 41 < 100) {
    // One connection shared by the copies that follow, kept for 10 minutes.
    args.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(controlDir, '%C')}`, '-o', 'ControlPersist=600')
  }
  const port = Number(target.port)
  if (port && port !== 22) args.push('-p', String(port))
  if (target.username) args.push('-l', String(target.username))
  const identity = expandHome(target.identityFile, home)
  if (identity) args.push('-i', identity)
  if (target.identitiesOnly) args.push('-o', 'IdentitiesOnly=yes')
  if (target.jumpHost) args.push('-J', String(target.jumpHost))
  if (target.proxyCommand) args.push('-o', `ProxyCommand=${target.proxyCommand}`)
  const destination = String(target.configHost || target.host || '')
  if (!destination || destination.startsWith('-')) throw new Error(`SSH host "${target.label ?? target.id}" has no address.`)
  args.push('--', destination)
  return args
}

// ------------------------------------------------------------------ copying

/**
 * rsync filter rules: every folder but hidden and skipped ones, then the wanted files only.
 * `exclude` lists paths (from the workspace, `/`-separated) never copied, such as a PDF this
 * plugin uploads itself.
 */
export function rsyncFilters(scope, exclude = []) {
  const rules = [...exclude.map((rel) => `--exclude=/${rel.replace(/^\/+/, '')}`), '--exclude=.*/']
  for (const dir of SKIP_DIRS) rules.push(`--exclude=${dir}/`)
  rules.push('--include=*/')
  if (scope === 'tex') {
    rules.push('--include=*.tex', '--include=*.TEX')
  } else {
    for (const ext of BUILD_EXTS) rules.push(`--include=*.${ext}`, `--include=*.${ext.toUpperCase()}`)
    for (const name of BUILD_NAMES) rules.push(`--include=${name}`)
  }
  rules.push('--exclude=*')
  return rules
}

const shellQuote = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`

/** The same selection as `rsyncFilters`, as a POSIX shell command that prints the paths. */
export function findCommand(remotePath, scope, exclude = []) {
  const prune = ['-name', "'.?*'", ...SKIP_DIRS.flatMap((dir) => ['-o', '-name', shellQuote(dir)])].join(' ')
  const names =
    scope === 'tex'
      ? ["-iname '*.tex'"]
      : [...BUILD_EXTS.map((ext) => `-iname '*.${ext}'`), ...BUILD_NAMES.map((name) => `-name ${shellQuote(name)}`)]
  return (
    `cd ${shellQuote(remotePath)} && find . -type d \\( ${prune} \\) -prune -o -type f \\( ${names.join(' -o ')} \\)` +
    ` -size -${parseInt(MAX_FILE, 10) * 1024}k${exclude.map((rel) => ` ! -path ${shellQuote(`./${rel.replace(/^\/+/, '')}`)}`).join('')} -print`
  )
}

/** A POSIX command that writes stdin to `remoteFile`, through a temporary file and a rename. */
export function uploadCommand(remoteFile) {
  const dir = path.posix.dirname(remoteFile)
  const name = path.posix.basename(remoteFile)
  const temp = `.${name}.orca-latex-preview-upload`
  return `cd ${shellQuote(dir)} && cat > ${shellQuote(temp)} && mv -f ${shellQuote(temp)} ${shellQuote(name)}`
}

/** That selection, tarred to stdout. */
export const tarCommand = (remotePath, scope, exclude) => `${findCommand(remotePath, scope, exclude)} | tar -cf - -T -`

/** Whether a copy of `scope` takes the file at `rel` (relative to the workspace). */
export function isSelected(rel, scope) {
  const parts = rel.split(/[\\/]/)
  const name = parts.pop()
  if (parts.some((dir) => dir.startsWith('.') || SKIP_DIRS.includes(dir))) return false
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return scope === 'tex' ? ext === 'tex' : BUILD_EXTS.includes(ext) || BUILD_NAMES.includes(name)
}

/** Removes the selected files of `localPath` that are not in `keep` (paths like `./a/b.tex`). */
async function pruneLocal(localPath, keep, scope) {
  const kept = new Set([...keep].map((rel) => rel.replace(/^\.\//, '')))
  const queue = ['']
  while (queue.length > 0) {
    const dir = queue.shift()
    let entries = []
    try {
      entries = await readdir(path.join(localPath, dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) queue.push(rel)
      else if (isSelected(rel, scope) && !kept.has(rel)) await rm(path.join(localPath, rel), { force: true })
    }
  }
}

/** rsync's -e takes one string; quotes keep a path with spaces in one argument. */
const rshString = (args) => ['ssh', ...args].map((arg) => (/[\s"']/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ')

function run(command, args, { env, signal, input, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, signal, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    if (input) {
      child.stdin.on('error', () => {}) // the command ended early: its exit code says why
      child.stdin.end(input)
    }
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 20_000) stderr += chunk
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** `ssh ... remote command | tar -x` into `localPath`. */
function tarCopy({ ssh, env, remotePath, localPath, scope, signal, exclude }) {
  return new Promise((resolve, reject) => {
    const source = spawn('ssh', [...ssh, tarCommand(remotePath, scope, exclude)], { env, signal, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const sink = spawn('tar', ['-xf', '-', '-C', localPath], { env, signal, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    const keep = (chunk) => {
      if (stderr.length < 20_000) stderr += chunk
    }
    source.stderr.on('data', keep)
    sink.stderr.on('data', keep)
    source.stdout.pipe(sink.stdin)
    sink.stdin.on('error', () => {}) // tar gone early: its own exit code says why
    const timer = setTimeout(() => {
      source.kill()
      sink.kill()
    }, 300_000)
    let failed = null
    source.on('error', (error) => (failed = error))
    sink.on('error', (error) => (failed = error))
    let sourceCode = null
    source.on('close', (code) => (sourceCode = code))
    sink.on('close', (code) => {
      clearTimeout(timer)
      if (failed) reject(failed)
      else resolve({ code: sourceCode || code, stderr })
    })
  })
}

/** Touched after each copy; hidden, so neither rsync nor the tar pruning ever removes it. */
const USED_MARKER = '.orca-latex-preview-used'

async function markUsed(localPath) {
  const marker = path.join(localPath, USED_MARKER)
  const now = new Date()
  try {
    await utimes(marker, now, now)
  } catch {
    await writeFile(marker, '').catch(() => {})
  }
}

/**
 * Deletes the copies under `remoteRoot` that no build has used for `maxAgeMs` (a copy without a
 * marker counts by its folder's age), except those in `keep`. Returns the removed folders.
 */
export async function pruneStaleCopies(remoteRoot, { maxAgeMs, keep = new Set(), now = Date.now() } = {}) {
  let names = []
  try {
    names = await readdir(remoteRoot)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    const dir = path.join(remoteRoot, name)
    if (keep.has(dir)) continue
    const used = await stat(path.join(dir, USED_MARKER)).catch(() => stat(dir).catch(() => null))
    if (used && now - used.mtimeMs > maxAgeMs) {
      await rm(dir, { recursive: true, force: true })
      removed.push(dir)
    }
  }
  return removed
}

const trimError = (text) => text.trim().split('\n').slice(-3).join(' ').slice(0, 400)

/**
 * Keeps local copies of remote workspaces. `sync` brings one up to date: `scope` 'tex' copies the
 * .tex files (enough to find the document), 'full' everything a build can read.
 */
export function createRemoteMirror({ cacheRoot, log = () => {} }) {
  const controlDir = path.join(cacheRoot, 'ssh')
  let targetsAt = 0
  let targets = new Map()
  const noRsync = new Set() // hosts (or 'local') without rsync: use tar
  const unreachable = new Map() // host id -> { at, message }
  const inFlight = new Map() // local path -> promise

  async function targetFor(hostId) {
    const id = sshTargetId(hostId)
    if (!id) throw new Error(`Workspaces on ${hostId} cannot be read by plugins.`)
    if (!targets.has(id) || Date.now() - targetsAt > 30_000) {
      targets = await readSshTargets()
      targetsAt = Date.now()
    }
    const target = targets.get(id)
    if (!target) throw new Error(`Could not find the settings of SSH host ${id} in Orca's profile.`)
    return target
  }

  async function connection(hostId) {
    const target = await targetFor(hostId)
    await mkdir(controlDir, { recursive: true })
    const env = { ...process.env }
    const agent = await findAgentSocket(target)
    if (agent) env.SSH_AUTH_SOCK = agent
    return { target, env, ssh: sshArgs(target, { controlDir }) }
  }

  async function copy({ hostId, remotePath, localPath, scope, signal, exclude }) {
    const { target, env, ssh } = await connection(hostId)
    await mkdir(localPath, { recursive: true })
    const name = target.label || target.configHost || target.host
    if (!noRsync.has('local') && !noRsync.has(hostId)) {
      const source = `${ssh[ssh.length - 1]}:${remotePath.replace(/\/+$/, '')}/`
      // --delete removes files gone from the host; the filters keep it to the files copied.
      const args = ['-rt', '--delete', '--protect-args', `--max-size=${MAX_FILE}`, '--timeout=60', '-e', rshString(ssh.slice(0, -2)), ...rsyncFilters(scope, exclude), source, `${localPath}${path.sep}`]
      try {
        const result = await run('rsync', args, { env, signal })
        // 24: files vanished while copying, which a later sync settles.
        if (result.code === 0 || result.code === 24) return
        // 12 or 127 with "command not found": the host has no rsync.
        if (!/rsync: (command )?not found|command not found|No such file or directory.*rsync/i.test(result.stderr)) {
          throw new Error(`Could not copy from ${name}: ${trimError(result.stderr) || `rsync exited with ${result.code}`}`)
        }
        noRsync.add(hostId)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        noRsync.add('local')
      }
      log(`rsync unavailable for ${name}; copying with tar`)
    }
    const result = await tarCopy({ ssh, env, remotePath, localPath, scope, signal, exclude })
    if (result.code !== 0) throw new Error(`Could not copy from ${name}: ${trimError(result.stderr) || `exit code ${result.code}`}`)
    // tar only adds files: list the host's and drop the local ones it no longer has.
    const listing = await run('ssh', [...ssh, findCommand(remotePath, scope, exclude)], { env, signal })
    // Excluded files are kept, as rsync keeps them.
    if (listing.code === 0) await pruneLocal(localPath, [...listing.stdout.split('\n').filter(Boolean), ...exclude.map((rel) => `./${rel}`)], scope)
  }

  /** Brings `localPath` up to date with the remote folder; concurrent calls share one copy. */
  async function sync({ hostId, remotePath, localPath, scope = 'full', signal, exclude = [] }) {
    const key = `${localPath}|${scope}`
    const running = inFlight.get(key)
    if (running) return running
    const recentFailure = unreachable.get(hostId)
    if (recentFailure && Date.now() - recentFailure.at < 60_000) throw new Error(recentFailure.message)
    const job = copy({ hostId, remotePath, localPath, scope, signal, exclude })
      .then(() => {
        unreachable.delete(hostId)
        return markUsed(localPath)
      })
      .catch((error) => {
        if (/Could not resolve|timed out|Connection refused|Permission denied|Host key|No route/i.test(error.message)) {
          unreachable.set(hostId, { at: Date.now(), message: error.message })
        }
        throw error
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, job)
    return job
  }

  /** Writes `bytes` to `remoteFile` (an absolute path on the host). */
  async function upload({ hostId, remoteFile, bytes, signal }) {
    const { target, env, ssh } = await connection(hostId)
    const result = await run('ssh', [...ssh, uploadCommand(remoteFile)], { env, signal, input: bytes })
    if (result.code !== 0) {
      throw new Error(`Could not write ${path.posix.basename(remoteFile)} on ${target.label || target.host}: ${trimError(result.stderr) || `exit code ${result.code}`}`)
    }
  }

  /** The name Orca shows for an SSH host. */
  async function hostName(hostId) {
    const target = await targetFor(hostId)
    return target.label || target.configHost || target.host
  }

  return { sync, upload, hostName, targetFor }
}
