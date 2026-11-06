// LaTeX Preview worker. The PDF and Editor | PDF custom editors open one session each; a session
// belongs to the build of its main document, which compiles the editors' current (possibly
// unsaved) text over the project files and hands the PDF back in chunks.
//
// Orca gives custom editors the document text but never its path, so `latex.attach` finds the
// file by matching that text against the .tex files of this machine's workspaces.
import { createHash, randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { compileDocument, GENERATED } from './compile.mjs'
import { createPreambleCache } from './preamble.mjs'
import { chooseEngine, resolveRoot, scanTex } from './discover.mjs'
import { scanProject } from './project.mjs'
import { createSynctex, samePath } from './synctex.mjs'
import { detectTools } from './tools.mjs'

const CHUNK_BYTES = 600 * 1024 // 800 KiB of base64, inside the 1 MiB answer limit.
const MAX_CHAINED_REBUILDS = 3
const WAIT_MS = 25_000 // a long poll answers within this, changed or not
const SESSION_TTL_MS = 90_000 // a session that stops polling (its tab closed) is dropped
const BUILD_LINGER_MS = 60_000 // keep a build's PDF a while so switching views is instant
const INDEX_TTL_MS = 20_000
// Each OS's own cache folder: %LOCALAPPDATA% on Windows, ~/Library/Caches on macOS, XDG elsewhere.
const CACHE_ROOT = path.join(
  process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'orca-latex-preview'
)

const hash = (text) => createHash('sha256').update(text).digest('hex')
const coded = (code, message) => Object.assign(new Error(message), { code })

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default async function activate(orca) {
  const setting = async (key, fallback) => {
    try {
      return (await orca.settings.get(key)) ?? fallback
    } catch {
      return fallback
    }
  }

  let toolInfo = await detectTools(await setting('texBinDir', ''))
  orca.log(`node ${process.version}; tools ${JSON.stringify(toolInfo.tools)}`)

  /** @type {Map<string, any>} main document path -> build */
  const builds = new Map()
  /** @type {Map<string, any>} session id -> { id, file, build, lastSeen } */
  const sessions = new Map()
  let pdfRev = 0
  const preambleCache = createPreambleCache()

  // ------------------------------------------------------------------ workspaces and files

  async function workspaces() {
    if (!orca.host.has('workspace.list')) return { focused: null, all: [] }
    const [list, context] = await Promise.all([
      orca.host.call('workspace.list', {}),
      orca.host.has('workspace.readContext') ? orca.host.call('workspace.readContext', {}).catch(() => null) : null
    ])
    // Only this machine's folders can be compiled here; SSH and paired hosts are skipped.
    const local = list.workspaces.filter((workspace) => !workspace.hostId || workspace.hostId === 'local')
    let focused = null
    if (context) {
      const byName = local.filter((workspace) => workspace.name === context.displayName)
      focused = byName.find((workspace) => !context.branch || workspace.branch === context.branch) ?? byName[0] ?? null
    }
    if (focused) local.sort((a, b) => (a === focused ? -1 : b === focused ? 1 : 0))
    return { focused, all: local }
  }

  const indexCache = new Map() // workspace path -> { at, files, dirs }
  async function texIndex(workspace) {
    const cached = indexCache.get(workspace.path)
    if (cached && Date.now() - cached.at < INDEX_TTL_MS) return cached
    const { docs, dirs } = await scanTex(workspace.path, true)
    const entry = { at: Date.now(), files: docs.map((doc) => doc.path), dirs }
    indexCache.set(workspace.path, entry)
    return entry
  }

  /** Lines shared between two texts, as a fraction of the longer one. */
  function similarity(a, b) {
    const left = a.split('\n')
    const right = new Map()
    for (const line of b.split('\n')) right.set(line, (right.get(line) ?? 0) + 1)
    let shared = 0
    for (const line of left) {
      const count = right.get(line)
      if (count) {
        shared += 1
        right.set(line, count - 1)
      }
    }
    return shared / Math.max(left.length, b.split('\n').length, 1)
  }

  /** Finds the file whose content is `text`, or the files it most resembles. */
  async function locate(text) {
    const { focused, all } = await workspaces()
    const size = Buffer.byteLength(text)
    const exact = []
    const scored = []
    for (const workspace of all) {
      const { files } = await texIndex(workspace)
      for (const file of files) {
        let info
        try {
          info = await stat(file)
        } catch {
          continue
        }
        if (info.size > 4 * 1024 * 1024) continue
        const content = await readFile(file, 'utf8').catch(() => null)
        if (content === null) continue
        if (info.size === size && content === text) exact.push({ file, workspace })
        else if (exact.length === 0) scored.push({ file, workspace, score: similarity(text, content) })
      }
      // The focused workspace is scanned first; an exact match there settles it.
      if (exact.length > 0 && workspace === focused) break
    }
    const describe = ({ file, workspace }) => ({
      path: file,
      label: `${path.basename(workspace.path)}/${path.relative(workspace.path, file)}`,
      workspaceId: workspace.id
    })
    if (exact.length === 1) return { match: exact[0], candidates: [] }
    if (exact.length > 1) {
      const inFocus = exact.filter((entry) => entry.workspace === focused)
      if (inFocus.length === 1) return { match: inFocus[0], candidates: [] }
      return { match: null, candidates: exact.map(describe) }
    }
    scored.sort((a, b) => b.score - a.score)
    const best = scored[0]
    // Unsaved edits: take a clear winner, otherwise let the person choose.
    if (best && best.score >= 0.6 && (!scored[1] || best.score - scored[1].score >= 0.15)) {
      return { match: best, candidates: [] }
    }
    return { match: null, candidates: scored.filter((entry) => entry.score > 0.05).slice(0, 12).map(describe) }
  }

  async function workspaceFor(file, workspaceId) {
    const { all } = await workspaces()
    return (
      all.find((workspace) => workspace.id === workspaceId) ??
      all.find((workspace) => file.startsWith(workspace.path + path.sep)) ??
      null
    )
  }

  // ------------------------------------------------------------------ builds

  function snapshot(build) {
    if (!build) return null
    const r = build.result
    return {
      version: build.version,
      root: build.root,
      name: path.basename(build.root),
      engine: build.engine,
      status: build.status,
      rev: build.pdf ? build.pdf.rev : 0,
      pdfSize: build.pdf ? build.pdf.bytes.length : 0,
      chunks: build.pdf ? Math.ceil(build.pdf.bytes.length / CHUNK_BYTES) : 0,
      outDir: build.outDir,
      result: r
        ? {
            ok: r.ok,
            produced: r.produced,
            durationMs: r.durationMs,
            usedLatexmk: r.usedLatexmk,
            usedPreamble: r.usedPreamble ?? false,
            issues: r.issues,
            requirements: r.requirements ?? [],
            logTail: r.logTail.slice(-8000)
          }
        : null
    }
  }

  function changed(build) {
    build.version += 1
    const waiters = build.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  async function getBuild(root, workspace) {
    let build = builds.get(root)
    if (build) {
      clearTimeout(build.linger)
      return build
    }
    const rootDir = path.dirname(root)
    const projectDir = workspace && root.startsWith(workspace.path + path.sep) ? workspace.path : rootDir
    const cacheDir = path.join(CACHE_ROOT, hash(root).slice(0, 16))
    const outSetting = String(await setting('outDir', '')).trim()
    build = {
      root,
      rootDir,
      projectDir,
      workspace: workspace ?? null,
      cacheDir,
      overlayDir: path.join(cacheDir, 'overlay'),
      outDir: outSetting ? path.resolve(rootDir, outSetting) : path.join(cacheDir, 'out'),
      engine: await chooseEngine(root, await setting('engine', 'auto')),
      status: 'idle',
      version: 1,
      pdf: null,
      result: null,
      compiling: false,
      queued: false,
      chain: 0,
      overlays: new Map(), // absolute source path -> unsaved text
      sessions: new Set(),
      waiters: [],
      abort: new AbortController()
    }
    build.synctex = createSynctex({
      synctexPath: path.join(build.outDir, `${path.basename(root).replace(/\.[^.]+$/, '')}.synctex.gz`),
      rootDir,
      overlayDir: build.overlayDir
    })
    builds.set(root, build)
    startWatching(build)
    return build
  }

  function dropBuild(build) {
    clearTimeout(build.debounce)
    clearTimeout(build.linger)
    build.abort.abort()
    try {
      build.watcher?.close()
    } catch {
      // Already closed.
    }
    changed(build)
    builds.delete(build.root)
  }

  function scheduleBuild(build, delay) {
    clearTimeout(build.debounce)
    build.debounce = setTimeout(() => void runBuild(build), delay)
  }

  /** Writes the unsaved buffers where TeX looks first, mirroring their project paths. */
  async function writeOverlays(build) {
    await rm(build.overlayDir, { recursive: true, force: true })
    await mkdir(build.overlayDir, { recursive: true })
    for (const [file, text] of build.overlays) {
      const rel = path.relative(build.rootDir, file)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue // outside the project: TeX reads it from disk
      const target = path.join(build.overlayDir, rel)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, text)
    }
  }

  /** \include writes an .aux per folder, which must exist in the output folder. */
  async function mirrorFolders(build) {
    const { dirs } = await scanTex(build.rootDir, true)
    for (const dir of dirs) {
      const rel = path.relative(build.rootDir, dir)
      if (!rel.startsWith('..')) await mkdir(path.join(build.outDir, rel), { recursive: true })
    }
  }

  async function runBuild(build, { chained = false } = {}) {
    if (!builds.has(build.root)) return
    if (build.compiling) {
      build.queued = true
      return
    }
    build.compiling = true
    build.queued = false
    build.status = 'compiling'
    build.chain = chained ? build.chain + 1 : 0
    changed(build)
    try {
      await mkdir(build.outDir, { recursive: true })
      await Promise.all([writeOverlays(build), mirrorFolders(build)])
      const result = await compileDocument({
        root: build.root,
        engine: build.engine,
        tools: toolInfo.tools,
        tex: toolInfo.tex,
        searchDirs: toolInfo.dirs,
        useLatexmk: await setting('useLatexmk', true),
        outDir: build.outDir,
        overlayDir: build.overlayDir,
        shellEscape: await setting('shellEscape', false),
        preambleCache: (await setting('precompilePreamble', true)) ? preambleCache : null,
        signal: build.abort.signal
      })
      if (!builds.has(build.root)) return
      build.result = result
      if (result.pdfPath && (!build.pdf || build.pdf.mtime !== result.pdfMtime)) {
        pdfRev += 1
        build.pdf = { rev: pdfRev, mtime: result.pdfMtime, bytes: await readFile(result.pdfPath) }
      }
      build.status = result.ok ? 'ok' : result.produced ? 'warnings' : 'failed'
      // Spelled out in the plugin log too, for anyone (or any agent) reading `orca plugin logs`.
      for (const requirement of result.requirements ?? []) {
        orca.log(`[requirement] ${requirement.title}. ${requirement.detail} Install on ${requirement.system}: ${requirement.install.join(' | ') || 'nothing to install'}`)
      }
      orca.log(
        `${path.basename(build.root)}: ${build.status} in ${result.durationMs} ms, ${result.issues.length} issues` +
          (build.trigger ? ` (${build.trigger})` : '')
      )
    } catch (error) {
      build.status = 'failed'
      build.result = {
        ok: false,
        produced: false,
        durationMs: 0,
        usedLatexmk: false,
        issues: [{ severity: 'error', file: null, line: null, message: `Build crashed: ${error.message}` }],
        logTail: String(error.stack ?? error)
      }
    } finally {
      build.compiling = false
      build.trigger = null
    }
    changed(build)
    if (build.queued) {
      // Edits arrived during the build. A build that keeps re-triggering itself (a package that
      // writes a source file) stops after a few rounds instead of looping.
      if (build.chain < MAX_CHAINED_REBUILDS) void runBuild(build, { chained: true })
      else build.queued = false
    }
  }

  const SOURCE_EXTS = new Set(['.tex', '.bib', '.sty', '.cls', '.bst', '.ltx'])
  function isSourceChange(build, filename) {
    if (!filename) return true
    const parts = filename.split(path.sep)
    if (parts.some((part) => part === '.git' || part === 'node_modules' || part.startsWith('_minted') || part === 'svg-inkscape')) {
      return false
    }
    const full = path.resolve(build.projectDir, filename)
    if (full === build.outDir || full.startsWith(build.outDir + path.sep)) return false
    const name = path.basename(filename).toLowerCase()
    if (name.includes('(busy)') || name.endsWith('~') || name.startsWith('.#') || name.startsWith('.~')) return false
    if (name.endsWith('.synctex.gz') || name.endsWith('.run.xml')) return false
    const ext = path.extname(name)
    if (GENERATED.has(ext)) return false
    // A PDF next to the main file is an earlier build of it (yours or another tool's).
    const rootBase = path.basename(build.root).replace(/\.[^.]+$/, '').toLowerCase()
    if (path.dirname(full) === build.rootDir && name.startsWith(`${rootBase}.`) && !SOURCE_EXTS.has(ext)) return false
    return true
  }

  function startWatching(build) {
    const onChange = async (_event, filename) => {
      const name = filename ? String(filename) : ''
      if (!builds.has(build.root) || !isSourceChange(build, name)) return
      // A save of a file open in an editor matches its overlay: nothing new to build.
      const full = path.resolve(build.projectDir, name)
      if (build.overlays.has(full)) {
        const disk = await readFile(full, 'utf8').catch(() => null)
        if (disk === build.overlays.get(full)) {
          build.overlays.delete(full)
          return
        }
      }
      if (!(await setting('autoCompile', true))) return
      if (build.compiling) {
        build.queued = true
        return
      }
      build.trigger = `changed on disk: ${name}`
      scheduleBuild(build, Number(await setting('debounceMs', 400)))
    }
    try {
      build.watcher = watch(build.projectDir, { recursive: true }, onChange)
    } catch (error) {
      orca.log(`recursive watch unavailable (${error.message}); watching ${build.projectDir} only`)
      build.watcher = watch(build.projectDir, onChange)
    }
    build.watcher.on('error', (error) => orca.log(`watch error: ${error.message}`))
  }

  // ------------------------------------------------------------------ sessions

  function sessionOf(id) {
    const session = sessions.get(id)
    if (!session) throw coded('invalid_params', 'session_lost: the worker restarted.')
    session.lastSeen = Date.now()
    return session
  }

  function detach(session) {
    sessions.delete(session.id)
    const build = session.build
    build.sessions.delete(session.id)
    if (![...build.sessions].some((id) => sessions.get(id)?.file === session.file)) build.overlays.delete(session.file)
    if (build.sessions.size === 0) {
      clearTimeout(build.linger)
      build.linger = setTimeout(() => {
        if (build.sessions.size === 0) dropBuild(build)
      }, BUILD_LINGER_MS)
    }
  }

  // Orca caps a request from an editor at 64 KiB, so a long document arrives in parts
  // (`latex.text`) and `latex.attach` or `latex.update` then names the upload instead of the text.
  const uploads = new Map()
  const UPLOAD_TTL_MS = 60_000
  const MAX_UPLOAD_PARTS = 4096

  function takeText({ text, textId }) {
    if (textId === undefined) return text
    const upload = uploads.get(textId)
    uploads.delete(textId)
    if (!upload || upload.received !== upload.parts.length) throw coded('invalid_params', 'The document text did not arrive in full; try again.')
    return upload.parts.join('')
  }

  setInterval(() => {
    const now = Date.now()
    for (const session of sessions.values()) {
      if (now - session.lastSeen > SESSION_TTL_MS) detach(session)
    }
    for (const [id, upload] of uploads) {
      if (now - upload.at > UPLOAD_TTL_MS) uploads.delete(id)
    }
  }, 15_000).unref?.()

  async function setOverlay(build, file, text) {
    const disk = await readFile(file, 'utf8').catch(() => null)
    const before = build.overlays.get(file) ?? disk
    if (disk === text) build.overlays.delete(file)
    else build.overlays.set(file, text)
    return before !== text
  }

  orca.panels.handle('latex.text', async ({ uploadId, index, count, part }) => {
    if (typeof uploadId !== 'string' || typeof part !== 'string' || !Number.isInteger(count) || count < 1 || count > MAX_UPLOAD_PARTS || !Number.isInteger(index) || index < 0 || index >= count) {
      throw coded('invalid_params', 'Bad document part.')
    }
    let upload = uploads.get(uploadId)
    if (!upload) {
      upload = { parts: new Array(count), received: 0, at: Date.now() }
      uploads.set(uploadId, upload)
    }
    if (upload.parts.length !== count) throw coded('invalid_params', 'Bad document part.')
    if (upload.parts[index] === undefined) upload.received += 1
    upload.parts[index] = part
    return { ok: true }
  })

  orca.panels.handle('latex.attach', async (input) => {
    const { path: chosen, workspaceId } = input
    const text = takeText(input)
    let file
    let workspace
    if (chosen) {
      file = path.resolve(chosen)
      if (!file.toLowerCase().endsWith('.tex')) throw coded('invalid_params', 'Pick a .tex file.')
      workspace = await workspaceFor(file, workspaceId)
    } else {
      const { match, candidates } = await locate(String(text ?? ''))
      if (!match) return { sessionId: null, candidates }
      file = match.file
      workspace = match.workspace
    }
    const root = await resolveRoot(file, workspace?.path)
    const build = await getBuild(root, workspace)
    const session = { id: randomUUID(), file, build, lastSeen: Date.now() }
    sessions.set(session.id, session)
    build.sessions.add(session.id)
    const edited = typeof text === 'string' ? await setOverlay(build, file, text) : false
    if (!build.result || edited) {
      build.trigger = `opened ${path.basename(file)}`
      scheduleBuild(build, 0)
    }
    orca.log(`attached ${file} (main ${root})`)
    const pending = pendingJumps.get(path.normalize(file))
    pendingJumps.delete(path.normalize(file))
    for (const [key, jump] of pendingJumps) if (Date.now() - jump.at > JUMP_TTL_MS) pendingJumps.delete(key)
    return {
      sessionId: session.id,
      file,
      rel: workspace ? path.relative(workspace.path, file) : path.basename(file),
      relToRoot: path.relative(path.dirname(root), file).split(path.sep).join('/'),
      state: snapshot(build),
      jump: pending && Date.now() - pending.at < JUMP_TTL_MS ? { line: pending.line } : null
    }
  })

  orca.panels.handle('latex.update', async (input) => {
    const session = sessionOf(input.sessionId)
    const text = takeText(input)
    const build = session.build
    if (await setOverlay(build, session.file, String(text))) {
      if (await setting('autoCompile', true)) {
        build.trigger = `edited ${path.basename(session.file)}`
        if (build.compiling) build.queued = true
        else scheduleBuild(build, Number(await setting('debounceMs', 400)))
      }
    }
    return { ok: true }
  })

  orca.panels.handle('latex.wait', async ({ sessionId, since }, { signal } = {}) => {
    const session = sessionOf(sessionId)
    const build = session.build
    if (build.version === since) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, WAIT_MS)
        const done = () => {
          clearTimeout(timer)
          resolve()
        }
        build.waiters.push(done)
        signal?.addEventListener('abort', done, { once: true })
      })
    }
    session.lastSeen = Date.now()
    const state = snapshot(build)
    if (session.jump) {
      state.jump = session.jump
      session.jump = null
    }
    return state
  })

  // A jump to a line of another file (from the PDF, an issue, the outline): Orca opens the file,
  // and a LaTeX view of it moves to the line, whether already open or opened within a minute.
  const pendingJumps = new Map() // absolute file -> { line, at }
  const JUMP_TTL_MS = 60_000

  orca.panels.handle('latex.open', async ({ sessionId, file, line }) => {
    const session = sessionOf(sessionId)
    const build = session.build
    const target = path.resolve(build.rootDir, String(file))
    const lineNumber = Math.max(1, Number(line) || 1)
    let notified = false
    for (const other of sessions.values()) {
      if (other !== session && samePath(other.file, target)) {
        other.jump = { line: lineNumber, at: Date.now() }
        notified = true
      }
    }
    if (notified) changed(build)
    else pendingJumps.set(path.normalize(target), { line: lineNumber, at: Date.now() })
    const workspace = build.workspace ?? (await workspaceFor(target))
    const rel = workspace ? path.relative(workspace.path, target) : null
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { opened: false, reason: 'outside', rel: path.basename(target) }
    if (!orca.host.has('editor.open')) return { opened: false, reason: 'unsupported', rel }
    try {
      await orca.host.call('editor.open', { workspaceId: workspace.id, path: rel.split(path.sep).join('/') })
      return { opened: true, rel }
    } catch (error) {
      return { opened: false, reason: error.code ?? 'failed', message: error.message, rel }
    }
  })

  orca.panels.handle('latex.compile', async ({ sessionId }) => {
    const build = sessionOf(sessionId).build
    toolInfo = await detectTools(await setting('texBinDir', ''))
    build.engine = await chooseEngine(build.root, await setting('engine', 'auto'))
    build.trigger = 'recompile'
    scheduleBuild(build, 0)
    return snapshot(build)
  })

  orca.panels.handle('latex.detach', async ({ sessionId }) => {
    const session = sessions.get(sessionId)
    if (session) detach(session)
    return { ok: true }
  })

  orca.panels.handle('latex.chunk', async ({ sessionId, rev, index }) => {
    const pdf = sessionOf(sessionId).build.pdf
    if (!pdf || pdf.rev !== rev) throw coded('conflict', 'That PDF was replaced by a newer build.')
    const start = index * CHUNK_BYTES
    if (!Number.isInteger(index) || index < 0 || start >= pdf.bytes.length) throw coded('invalid_params', 'Chunk out of range.')
    return { data: pdf.bytes.subarray(start, start + CHUNK_BYTES).toString('base64') }
  })

  orca.panels.handle('latex.project', async ({ sessionId }) => {
    const session = sessionOf(sessionId)
    const build = session.build
    // Rescanned at most once per build state, unless the session's own text changed since.
    const key = `${build.version}|${build.overlays.get(session.file)?.length ?? -1}`
    if (build.project?.key !== key) build.project = { key, data: await scanProject(build) }
    return build.project.data
  })

  orca.panels.handle('latex.syncForward', async ({ sessionId, file, line }) => {
    const session = sessionOf(sessionId)
    return session.build.synctex.forward(file ? path.resolve(session.build.rootDir, file) : session.file, Number(line))
  })

  orca.panels.handle('latex.syncInverse', async ({ sessionId, page, x, y }) => {
    const session = sessionOf(sessionId)
    const hit = await session.build.synctex.inverse(Number(page), Number(x), Number(y))
    if (!hit?.file) return null
    return {
      ...hit,
      rel: path.relative(session.build.rootDir, hit.file).split(path.sep).join('/'),
      thisFile: samePath(hit.file, session.file)
    }
  })

  orca.panels.handle('latex.diagnostics', async () => ({
    api: orca.api,
    node: process.version,
    granted: orca.grantedCapabilities,
    tools: toolInfo,
    builds: [...builds.values()].map((build) => ({
      ...snapshot(build),
      sessions: build.sessions.size,
      overlays: [...build.overlays.keys()]
    })),
    sessions: sessions.size
  }))
}

export function deactivate() {}
