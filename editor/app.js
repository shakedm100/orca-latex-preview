window.__pluginStarted = true
// The PDF and Editor | PDF views of a .tex file. Orca owns the buffer; this frame reads it with
// orca.document.session(), edits it in the split view, and sends its text to the plugin worker,
// which compiles it (unsaved edits included) and returns the PDF.
import { createViewer } from './viewer.js'

const MODE = document.body.dataset.mode // 'pdf' | 'split'
const $ = (id) => document.getElementById(id)
const els = {
  source: $('source'),
  divider: $('divider'),
  status: $('status'),
  issuesToggle: $('issuesToggle'),
  issues: $('issues'),
  requirements: $('requirements'),
  page: $('page'),
  zoomOut: $('zoomOut'),
  zoomIn: $('zoomIn'),
  zoomLabel: $('zoomLabel'),
  download: $('download'),
  compile: $('compile'),
  viewer: $('viewer'),
  empty: $('empty'),
  words: $('words'),
  outlineToggle: $('outlineToggle'),
  outline: $('outline'),
  findToggle: $('findToggle'),
  findBar: $('findBar'),
  findInput: $('findInput'),
  findCount: $('findCount'),
  findPrev: $('findPrev'),
  findNext: $('findNext'),
  findClose: $('findClose')
}

const request = (name, input = {}, timeoutMs = 30000) =>
  orca.plugin?.request
    ? orca.plugin.request(name, input, { timeoutMs })
    : orca.host.call('plugin.request', { name, input, timeoutMs }).then((answer) => answer.output)

// Orca refuses a request from an editor over 64 KiB, so longer text goes ahead in parts and
// the request carries the upload's id instead.
const PART_BYTES = 48 * 1024
const utf8 = new TextEncoder()
const jsonBytes = (text) => utf8.encode(JSON.stringify(text)).length

async function withText(input, text) {
  if (jsonBytes(text) <= PART_BYTES) return { ...input, text }
  const parts = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + PART_BYTES / 2)
    while (end - start > 1 && jsonBytes(text.slice(start, end)) > PART_BYTES) end = start + Math.floor((end - start) / 2)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1 // keep surrogate pairs whole
    parts.push(text.slice(start, end))
    start = end
  }
  const uploadId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
  for (let index = 0; index < parts.length; index += 1) {
    await request('latex.text', { uploadId, index, count: parts.length, part: parts[index] })
  }
  return { ...input, textId: uploadId }
}

// Updates go one at a time, so a slower upload of older text never lands after newer text.
let sending = Promise.resolve()
function sendText() {
  const run = sending.then(async () => {
    if (!app.sessionId) return
    await request('latex.update', await withText({ sessionId: app.sessionId }, app.doc.value))
  })
  sending = run.catch(() => {})
  return run
}

const viewer = createViewer({
  scroller: els.viewer,
  pageInput: $('pageInput'),
  pageCount: $('pageCount'),
  zoomLabel: els.zoomLabel,
  onChange: () => {
    els.empty.hidden = true
    els.download.disabled = false
  },
  onDoubleClick: (point) => void syncInverse(point),
  onFind: (result) => showFindResult(result)
})

const app = {
  doc: null, // Orca document session
  sessionId: null,
  attaching: null,
  file: null,
  relToRoot: null,
  state: null,
  since: 0,
  shownRev: 0,
  loadingRev: 0,
  bytes: null,
  issuesOpen: false,
  userToggledIssues: false,
  editor: null, // CodeMirror controller in split mode
  project: null, // outline, labels, citations... from the worker
  projectKey: null,
  closed: false
}

// ------------------------------------------------------------------ messages

function setEmpty(title, text) {
  if (viewer.hasDocument) return
  els.empty.hidden = false
  els.empty.querySelector('.title').textContent = title
  els.empty.querySelector('.muted').textContent = text ?? ''
  els.empty.querySelector('.choices')?.remove()
}

function showBanner(message) {
  console.warn(message)
  els.viewer.querySelector('.banner')?.remove()
  if (!message) return
  const banner = document.createElement('p')
  banner.className = 'banner'
  banner.textContent = message
  els.viewer.prepend(banner)
}

function setStatus(kind, text, title = '') {
  els.status.className = `status ${kind}`
  els.status.textContent = text
  els.status.title = title
}

const formatMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// ------------------------------------------------------------------ session with the worker

// ------------------------------------------------------------------ reading position
// Orca rebuilds the view when its tab comes back, so the place in the PDF and in the source is
// kept per file (and per view) in this plugin's own localStorage, with the split between the
// source and the PDF. A file seen for the first time starts from the last split used anywhere.

const placeKey = () => (app.file ? `place:${MODE}:${app.file}` : null)

function savePlace() {
  const key = placeKey()
  if (!key) return
  try {
    // Until the PDF is on screen there is no PDF position yet: keep the stored one.
    const before = JSON.parse(localStorage.getItem(key) ?? 'null')
    const split = MODE === 'split' ? parseFloat(document.getElementById('app').style.getPropertyValue('--split')) || null : null
    const place = { pdf: viewer.getPlace() ?? before?.pdf ?? null, source: app.editor?.getPlace() ?? null, split, at: Date.now() }
    if (!place.pdf && !place.source) return
    localStorage.setItem(key, JSON.stringify(place))
  } catch {
    // Storage full or unavailable: positions are a convenience.
  }
}

function restorePlace() {
  let place = null
  try {
    place = JSON.parse(localStorage.getItem(placeKey()) ?? 'null')
  } catch {
    return
  }
  if (!place) return
  if (place.pdf) viewer.setPlace(place.pdf)
  if (place.split && app.applySplit) app.applySplit(place.split)
  if (place.source && app.editor) app.editor.setPlace(place.source)
}

let placeTimer = 0
function placeChanged() {
  if (placeTimer) return
  placeTimer = setTimeout(() => {
    placeTimer = 0
    savePlace()
  }, 300)
}

function trackPlace() {
  document.addEventListener('scroll', placeChanged, { capture: true, passive: true })
  for (const type of ['keyup', 'pointerup']) document.addEventListener(type, placeChanged, true)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePlace()
    // A view out of sight lets the worker stop copying a remote project.
    if (app.sessionId) request('latex.visibility', { sessionId: app.sessionId, visible: document.visibilityState === 'visible' }).catch(() => {})
  })
  pruneStoredPlaces()
}

/** Keeps the 200 most recent files' positions. */
function pruneStoredPlaces() {
  try {
    const entries = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i)
      if (key?.startsWith('place:')) entries.push([key, JSON.parse(localStorage.getItem(key))?.at ?? 0])
    }
    entries.sort((a, b) => b[1] - a[1])
    for (const [key] of entries.slice(200)) localStorage.removeItem(key)
  } catch {
    // Ignore: nothing depends on this.
  }
}

async function attach(choice) {
  if (app.attaching) return app.attaching
  app.attaching = (async () => {
    setStatus('compiling', 'Finding this file in your workspaces…')
    const input = await withText({ ...choice }, app.doc.value)
    const answer = await request('latex.attach', input, 120000)
    if (!answer.sessionId) {
      showChoices(answer.candidates, answer.problems)
      return false
    }
    app.sessionId = answer.sessionId
    const firstAttach = !app.file
    app.file = answer.file
    if (firstAttach) restorePlace()
    app.relToRoot = answer.relToRoot
    els.compile.disabled = false
    applyState(answer.state)
    if (answer.jump) jumpToLine(answer.jump.line)
    return true
  })()
  try {
    return await app.attaching
  } catch (error) {
    setStatus('failed', 'Could not start the preview')
    showBanner(error.message)
    return false
  } finally {
    app.attaching = null
  }
}

function showChoices(candidates, problems = []) {
  setStatus('', 'Which file is this?')
  els.empty.hidden = false
  els.empty.querySelector('.title').textContent = candidates.length ? 'Which file is this?' : 'File not found'
  els.empty.querySelector('.muted').textContent = candidates.length
    ? 'Orca does not tell plugin editors where a file lives, and this text matches more than one file (or has unsaved edits). Pick it:'
    : 'No .tex file in your workspaces matches this text. Save the file, then reopen this view.' +
      (problems.length ? ` Some workspaces could not be read: ${problems.join('; ')}` : '')
  els.empty.querySelector('.choices')?.remove()
  const list = document.createElement('div')
  list.className = 'choices'
  for (const candidate of candidates) {
    const button = document.createElement('button')
    button.textContent = candidate.label
    button.title = candidate.path
    button.addEventListener('click', async () => {
      list.remove()
      if (await attach({ path: candidate.path, workspaceId: candidate.workspaceId })) void poll()
    })
    list.append(button)
  }
  els.empty.append(list)
}

async function poll() {
  while (!app.closed && app.sessionId) {
    try {
      const state = await request('latex.wait', { sessionId: app.sessionId, since: app.since }, 60000)
      if (app.lostContact) {
        app.lostContact = false
        showBanner('')
      }
      applyState(state)
    } catch (error) {
      if (app.closed) return
      if (String(error.message).includes('session_lost')) {
        // The worker restarted (an update, or it was idle): open a new session with the current text.
        app.sessionId = null
        if (await attach()) continue
        return
      }
      if (error.code !== 'timeout') {
        app.lostContact = true
        showBanner(`Lost contact with the LaTeX worker: ${error.message}`)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
  }
}

let updateTimer = 0
function textChanged() {
  clearTimeout(updateTimer)
  updateTimer = setTimeout(async () => {
    if (!app.sessionId) return
    try {
      await sendText()
      scheduleProjectRefresh()
    } catch (error) {
      if (String(error.message).includes('session_lost')) {
        app.sessionId = null
        if (await attach()) void poll()
      }
    }
  }, 150)
}

async function recompile() {
  if (!app.sessionId) return
  clearTimeout(updateTimer)
  try {
    await sendText()
    applyState(await request('latex.compile', { sessionId: app.sessionId }))
  } catch (error) {
    showBanner(error.message)
  }
}

// ------------------------------------------------------------------ build state

/** How the PDF stands on the SSH host, for a document that lives there. */
function syncLabel(upload) {
  if (!upload) return null
  const where = `${upload.file} on ${upload.host}`
  switch (upload.state) {
    case 'syncing':
      return { kind: 'compiling', text: `Syncing to ${upload.host}…`, title: `Writing ${where}` }
    case 'synced':
      return { text: `Synced to ${upload.host}`, title: `${where} is this PDF (${new Date(upload.at).toLocaleTimeString()})` }
    case 'failed':
      return { kind: 'warnings', text: `Not synced to ${upload.host}`, title: upload.message }
    case 'held':
      return { text: `Not synced to ${upload.host} (errors)`, title: `${where} keeps the last PDF built without errors` }
    case 'unsaved':
      return { text: `Syncs to ${upload.host} on save`, title: `${where} is updated once the edits are saved` }
    default:
      return null
  }
}

function applyState(state) {
  if (!state) return
  if (state.jump) jumpToLine(state.jump.line)
  app.state = state
  app.since = state.version
  const result = state.result
  const engine = (result?.usedLatexmk ? `latexmk with ${state.engine}` : state.engine) + (result?.usedPreamble ? ', precompiled preamble' : '')
  if (state.status === 'compiling' || (state.status === 'idle' && !result)) {
    setStatus('compiling', `Compiling ${state.name}…`, `${state.root}\n${engine}`)
  } else if (result) {
    const errors = result.issues.filter((issue) => issue.severity === 'error').length
    const label =
      state.status === 'ok'
        ? `Compiled in ${formatMs(result.durationMs)}`
        : state.status === 'warnings'
          ? `Compiled with ${plural(errors, 'error')}`
          : 'Build failed'
    const title = `${state.root}\n${engine}, ${formatMs(result.durationMs)}\nOutput: ${state.outDir}`
    const sync = syncLabel(state.upload)
    if (sync) setStatus(sync.kind ?? state.status, `${label} · ${sync.text}`, `${title}\n${sync.title}`)
    else setStatus(state.status, label, title)
    renderIssues(result)
    if (!state.rev && !viewer.hasDocument) setEmpty('The build produced no PDF', 'See the errors above.')
  }
  if (state.status !== 'compiling' && app.projectKey !== state.version) {
    app.projectKey = state.version
    void refreshProject()
  }
  if (state.rev && state.rev !== app.shownRev && state.rev !== app.loadingRev) {
    void loadPdf(state.rev, state.chunks, state.pdfSize)
  }
}

/** Paths compare with forward slashes: Windows paths arrive with backslashes. */
const slashes = (file) => String(file).replace(/\\/g, '/')

function issueTargetsThisFile(issue) {
  if (!app.relToRoot) return false
  if (!issue.file) return app.relToRoot === app.state?.name // an unnamed file is the main one
  const file = slashes(issue.file).replace(/^\.\//, '')
  return file === app.relToRoot || file === slashes(app.file)
}

/** Frames have no clipboard permission; a copy inside the click still works. */
function copyText(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.append(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  return ok
}

const COMMAND_LINE = /^(sudo|rpm-ostree|dnf|apt|apt-file|pacman|zypper|emerge|e-file|apk|xbps-install|eopkg|nix-env|brew|port|winget|choco|scoop|tlmgr|miktex|mpm|py|python3?|pip3?|wget|curl|fc-list|fc-cache)\b/

/** What must be installed before the document can build, with the command for this system. */
function renderRequirements(result) {
  const list = result?.requirements ?? []
  const box = els.requirements
  box.replaceChildren()
  box.hidden = list.length === 0
  for (const requirement of list) {
    const item = document.createElement('div')
    item.className = 'requirement'
    const title = document.createElement('div')
    title.className = 'title'
    title.textContent = requirement.title
    const detail = document.createElement('div')
    detail.className = 'detail'
    detail.textContent = requirement.detail
    item.append(title, detail)
    for (const line of requirement.install) {
      const row = document.createElement('div')
      row.className = 'command'
      const code = document.createElement('code')
      code.textContent = line
      row.append(code)
      // Lines that are commands get a copy button (without an "or:" lead-in or a # comment);
      // prose such as a download link or a step in a settings window does not.
      const command = line.replace(/^or:?\s+/, '').replace(/\s+#.*$/, '')
      if (COMMAND_LINE.test(command)) {
        const copy = document.createElement('button')
        copy.textContent = 'Copy'
        copy.addEventListener('click', () => {
          copy.textContent = copyText(command) ? 'Copied' : 'Copy failed'
          setTimeout(() => (copy.textContent = 'Copy'), 1500)
        })
        row.append(copy)
      }
      item.append(row)
    }
    const after = document.createElement('div')
    after.className = 'detail muted'
    after.textContent = requirement.install.length ? `For ${requirement.system}. After installing, press Recompile.` : ''
    if (after.textContent) item.append(after)
    box.append(item)
  }
}

function renderIssues(result) {
  renderRequirements(result)
  const issues = result?.issues ?? []
  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.filter((issue) => issue.severity === 'warning').length
  els.issuesToggle.hidden = !result
  els.issuesToggle.className = `chip ${errors ? 'error' : warnings ? 'warning' : ''}`
  els.issuesToggle.textContent = errors
    ? warnings
      ? `${plural(errors, 'error')}, ${plural(warnings, 'warning')}`
      : plural(errors, 'error')
    : warnings
      ? plural(warnings, 'warning')
      : 'Log'
  els.issuesToggle.title = 'Show or hide errors and the log'
  if (!app.userToggledIssues) app.issuesOpen = errors > 0

  els.issues.textContent = ''
  for (const issue of issues) {
    if (issue.requirement) continue // shown above, in the requirements box
    const row = document.createElement('div')
    row.className = `issue ${issue.severity}`
    const dot = document.createElement('span')
    dot.className = 'dot'
    const body = document.createElement('div')
    const where = document.createElement('div')
    where.className = 'where'
    where.textContent = [issue.file, issue.line ? `line ${issue.line}` : null].filter(Boolean).join(', ') || issue.severity
    const message = document.createElement('div')
    message.className = 'message'
    message.textContent = issue.message
    body.append(where, message)
    row.append(dot, body)
    if (issue.line && issueTargetsThisFile(issue)) {
      row.classList.add('jump')
      row.title = app.editor ? `Go to line ${issue.line}` : `Show line ${issue.line} in the PDF`
      row.addEventListener('click', () => (app.editor ? app.editor.goToLine(issue.line) : void syncForward(app.relToRoot, issue.line)))
    } else if (issue.line && issue.file && isProjectFile(issue.file)) {
      row.classList.add('jump')
      row.title = `Open ${issue.file} at line ${issue.line}`
      row.addEventListener('click', () => void openSource(issue.file, issue.line))
    }
    els.issues.append(row)
  }
  if (result?.logTail) {
    const details = document.createElement('details')
    const summary = document.createElement('summary')
    summary.textContent = 'Raw log (end)'
    const pre = document.createElement('pre')
    pre.textContent = result.logTail
    details.append(summary, pre)
    els.issues.append(details)
  }
  els.issues.hidden = !app.issuesOpen || !result
  app.editor?.markErrors(
    issues.filter((issue) => issue.severity === 'error' && issue.line && issueTargetsThisFile(issue)).map((issue) => issue.line)
  )
}

els.issuesToggle.addEventListener('click', () => {
  app.userToggledIssues = true
  app.issuesOpen = !app.issuesOpen
  els.issues.hidden = !app.issuesOpen
})

// ------------------------------------------------------------------ project: outline, words, completions

let projectTimer = 0
function scheduleProjectRefresh() {
  clearTimeout(projectTimer)
  projectTimer = setTimeout(() => void refreshProject(), 1200)
}

async function refreshProject() {
  if (!app.sessionId) return
  try {
    app.project = await request('latex.project', { sessionId: app.sessionId })
  } catch {
    return
  }
  app.editor?.projectChanged()
  const words = app.project.words ?? 0
  els.words.hidden = !words
  els.words.textContent = `${words.toLocaleString()} words`
  els.words.title = 'Words in the document body: text, headings and captions, without math, commands or comments'
  if (!els.outline.hidden) renderOutline()
}

function renderOutline() {
  const list = els.outline
  list.textContent = ''
  const items = app.project?.outline ?? []
  if (items.length === 0) {
    const note = document.createElement('div')
    note.className = 'empty-note'
    note.textContent = app.project ? 'No \\section, \\chapter or \\subsection in this document.' : 'Reading the document…'
    list.append(note)
    return
  }
  const top = Math.min(...items.map((item) => item.level))
  for (const item of items) {
    const button = document.createElement('button')
    button.className = 'item'
    button.setAttribute('role', 'menuitem')
    button.style.paddingLeft = `${10 + (item.level - top) * 14}px`
    if (item.level === top) button.style.fontWeight = '600'
    button.textContent = item.title
    const rel = relToRoot(item.file)
    if (rel !== app.relToRoot) {
      const where = document.createElement('span')
      where.className = 'where'
      where.textContent = rel
      button.append(where)
    }
    button.title = `${rel}, line ${item.line}`
    button.addEventListener('click', () => {
      closeOutline()
      if (app.editor && rel === app.relToRoot) app.editor.goToLine(item.line)
      else if (app.editor) void openSource(rel, item.line)
      void syncForward(rel, item.line)
    })
    list.append(button)
  }
}

function relToRoot(file) {
  const rootDir = slashes(app.state?.root ?? '').replace(/\/[^/]*$/, '')
  const path = slashes(file)
  return rootDir && path.startsWith(`${rootDir}/`) ? path.slice(rootDir.length + 1) : path
}

function openOutline() {
  els.outline.hidden = false
  els.outlineToggle.setAttribute('aria-expanded', 'true')
  renderOutline()
  els.outline.querySelector('button')?.focus()
}
function closeOutline() {
  els.outline.hidden = true
  els.outlineToggle.setAttribute('aria-expanded', 'false')
}
els.outlineToggle.addEventListener('click', (event) => {
  event.stopPropagation()
  if (els.outline.hidden) openOutline()
  else closeOutline()
})
document.addEventListener('click', (event) => {
  if (!els.outline.hidden && !els.outline.contains(event.target)) closeOutline()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.outline.hidden) closeOutline()
})

// ------------------------------------------------------------------ SyncTeX

function toast(message) {
  document.querySelector('.toast')?.remove()
  const note = document.createElement('div')
  note.className = 'toast'
  note.textContent = message
  document.querySelector('.preview').append(note)
  setTimeout(() => note.remove(), 3500)
}

/** Source to PDF: the given line (the cursor's by default) shown and marked in the PDF. */
async function syncForward(file, line) {
  if (!app.sessionId || !viewer.hasDocument) return
  const target = line ? { file, line } : { line: app.editor?.cursor().line ?? 1 }
  try {
    const hit = await request('latex.syncForward', { sessionId: app.sessionId, ...target })
    if (hit) viewer.reveal(hit.page, hit.boxes)
    else toast('That line is not in the PDF (yet). Recompile, then try again.')
  } catch (error) {
    toast(`Could not find it in the PDF: ${error.message}`)
  }
}

/** PDF to source: a double-click on the PDF moves the cursor to the line that made it. */
async function syncInverse(point) {
  if (!app.sessionId) return
  try {
    const hit = await request('latex.syncInverse', { sessionId: app.sessionId, ...point })
    if (!hit) return
    if (hit.thisFile && app.editor) app.editor.flashLine(hit.line)
    else if (hit.thisFile) toast(`${hit.rel}, line ${hit.line}`)
    else void openSource(hit.rel, hit.line)
  } catch (error) {
    toast(`Could not map that point to the source: ${error.message}`)
  }
}

/** A project file other than this one: relative to the main file's folder, not an absolute path. */
function isProjectFile(file) {
  const name = slashes(file)
  return !/^(?:[A-Za-z]:)?\//.test(name) && !name.startsWith('../')
}

/** This view's file at `line`: the cursor in the source, or the spot in the PDF. */
function jumpToLine(line) {
  if (app.editor) app.editor.flashLine(line)
  else void syncForward(app.relToRoot, line)
}

/** Opens another file of the project in Orca; a LaTeX view of it then moves to `line`. */
async function openSource(file, line) {
  try {
    const answer = await request('latex.open', { sessionId: app.sessionId, file, line })
    if (answer.opened) toast(`Opened ${answer.rel}, line ${line}`)
    else if (answer.reason === 'outside') toast(`${file}, line ${line} (outside this workspace)`)
    else if (answer.reason === 'unsupported' || answer.reason === 'permission_denied' || answer.reason === 'capability_denied') {
      toast(`${file}, line ${line}. To open it from here, allow the plugin to open files in Settings → Plugins.`)
    } else toast(`${file}, line ${line}${answer.message ? ` (could not open it: ${answer.message})` : ''}`)
  } catch (error) {
    toast(`${file}, line ${line} (could not open it: ${error.message})`)
  }
}

// ------------------------------------------------------------------ PDF transfer

function decodeInto(text, into, offset) {
  const binary = atob(text)
  for (let i = 0; i < binary.length; i += 1) into[offset + i] = binary.charCodeAt(i)
  return binary.length
}

async function loadPdf(rev, chunks, size) {
  app.loadingRev = rev
  try {
    const bytes = new Uint8Array(size)
    let offset = 0
    for (let index = 0; index < chunks; index += 1) {
      const { data } = await request('latex.chunk', { sessionId: app.sessionId, rev, index }, 60000)
      if (app.loadingRev !== rev) return
      offset += decodeInto(data, bytes, offset)
    }
    app.bytes = bytes.slice()
    await viewer.show(bytes) // pdf.js takes ownership of `bytes`
    app.shownRev = rev
    showBanner('')
  } catch (error) {
    if (error.code !== 'conflict') showBanner(`Could not load the PDF: ${error.message}`)
  } finally {
    if (app.loadingRev === rev) app.loadingRev = 0
  }
}

// ------------------------------------------------------------------ find in PDF

function showFindResult({ query, count, index, capped }) {
  if (!query.trim()) els.findCount.textContent = ''
  else if (!count) els.findCount.textContent = 'No matches'
  else els.findCount.textContent = `${index + 1} of ${count.toLocaleString()}${capped ? '+' : ''}`
  els.findInput.classList.toggle('none', Boolean(query.trim()) && !count)
  els.findPrev.disabled = els.findNext.disabled = count < 2
}

function openFind() {
  els.findBar.hidden = false
  els.findToggle.setAttribute('aria-expanded', 'true')
  // Start from the text selected in the PDF, if any.
  const selected = window.getSelection()?.toString().trim()
  if (selected && selected.length < 200 && els.viewer.contains(window.getSelection().anchorNode)) els.findInput.value = selected
  els.findInput.focus()
  els.findInput.select()
  if (els.findInput.value) void viewer.find(els.findInput.value)
}

function closeFind() {
  els.findBar.hidden = true
  els.findToggle.setAttribute('aria-expanded', 'false')
  void viewer.clearFind()
  els.viewer.focus()
}

let findTimer = 0
els.findInput.addEventListener('input', () => {
  clearTimeout(findTimer)
  findTimer = setTimeout(() => void viewer.find(els.findInput.value), 200)
})
els.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    clearTimeout(findTimer)
    if (viewer.findQuery !== els.findInput.value) void viewer.find(els.findInput.value)
    else if (event.shiftKey) viewer.findPrevious()
    else viewer.findNext()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    closeFind()
  }
})
els.findToggle.addEventListener('click', () => (els.findBar.hidden ? openFind() : closeFind()))
els.findPrev.addEventListener('click', () => viewer.findPrevious())
els.findNext.addEventListener('click', () => viewer.findNext())
els.findClose.addEventListener('click', closeFind)

// ------------------------------------------------------------------ controls

els.compile.addEventListener('click', () => void recompile())
els.zoomIn.addEventListener('click', () => viewer.stepZoom(1))
els.zoomOut.addEventListener('click', () => viewer.stepZoom(-1))
els.zoomLabel.addEventListener('click', () => viewer.setZoom('fit'))
els.download.addEventListener('click', async () => {
  if (!app.bytes || !orca.files?.saveAs) return
  const name = (app.state?.name ?? 'document.tex').replace(/\.[^.]+$/, '.pdf')
  try {
    await orca.files.saveAs({ suggestedName: name, mimeType: 'application/pdf', data: app.bytes.slice().buffer })
  } catch (error) {
    showBanner(`Could not save: ${error.message}`)
  }
})
if (!orca.files?.saveAs) els.download.hidden = true

window.addEventListener(
  'keydown',
  (event) => {
    const mod = event.ctrlKey || event.metaKey
    if (!mod) return
    if (event.altKey && (event.key === 'j' || event.key === 'J')) {
      event.preventDefault()
      event.stopPropagation()
      void syncForward()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      void recompile()
    } else if (!app.editor?.hasFocus() && !event.altKey && (event.key === 'f' || event.key === 'F')) {
      // In the source, Ctrl+F is CodeMirror's own search; anywhere else it finds in the PDF.
      event.preventDefault()
      event.stopPropagation()
      openFind()
    } else if (!app.editor?.hasFocus() && (event.key === '=' || event.key === '+')) {
      event.preventDefault()
      viewer.stepZoom(1)
    } else if (!app.editor?.hasFocus() && event.key === '-') {
      event.preventDefault()
      viewer.stepZoom(-1)
    } else if (!app.editor?.hasFocus() && event.key === '0') {
      event.preventDefault()
      viewer.setZoom('fit')
    }
  },
  true
)

// The divider between source and PDF, remembered per plugin.
function setupDivider() {
  const app = document.getElementById('app')
  const saved = (() => {
    try {
      return Number(localStorage.getItem('split')) || 50
    } catch {
      return 50
    }
  })()
  const apply = (percent) => app.style.setProperty('--split', `${Math.min(80, Math.max(20, percent))}%`)
  apply(saved)
  let dragging = false
  els.divider.addEventListener('pointerdown', (event) => {
    dragging = true
    els.divider.classList.add('dragging')
    els.divider.setPointerCapture(event.pointerId)
  })
  els.divider.addEventListener('pointermove', (event) => {
    if (!dragging) return
    apply((event.clientX / window.innerWidth) * 100)
  })
  const stop = () => {
    if (!dragging) return
    dragging = false
    els.divider.classList.remove('dragging')
    try {
      localStorage.setItem('split', String(parseFloat(app.style.getPropertyValue('--split'))))
    } catch {
      // Storage unavailable: the split resets next time.
    }
  }
  els.divider.addEventListener('pointerup', stop)
  els.divider.addEventListener('pointercancel', stop)
  els.divider.addEventListener('dblclick', () => apply(50))
  els.divider.addEventListener('keydown', (event) => {
    const current = parseFloat(app.style.getPropertyValue('--split')) || 50
    if (event.key === 'ArrowLeft') apply(current - 2)
    if (event.key === 'ArrowRight') apply(current + 2)
  })
  return apply
}

// ------------------------------------------------------------------ start

async function start() {
  if (!orca.document?.session) {
    setEmpty('This Orca is too old', 'The LaTeX views need Orca 1.4.246 or newer.')
    return
  }
  if (MODE === 'split') {
    app.applySplit = setupDivider()
    const { createSourceEditor } = await import('./source-editor.js')
    app.doc = await orca.document.session({ debounceMs: 200 })
    app.editor = createSourceEditor(els.source, {
      text: app.doc.value,
      readOnly: app.doc.readOnly,
      getProject: () => app.project,
      // Double-click a word: it is selected as usual, and the PDF shows where that line went.
      onDoubleClick: (line) => void syncForward(app.relToRoot, line),
      onChange: (text) => {
        app.doc.change(text)
        textChanged()
      }
    })
    app.doc.onReplace((text) => {
      app.editor.replace(text)
      textChanged()
    })
    requestAnimationFrame(() => app.editor.focus())
  } else {
    app.doc = await orca.document.session()
    app.doc.onReplace(() => textChanged())
  }
  trackPlace()
  if (await attach()) void poll()
}

window.addEventListener('pagehide', () => {
  savePlace()
  app.closed = true
  if (app.sessionId) void request('latex.detach', { sessionId: app.sessionId }).catch(() => undefined)
})

start().catch((error) => {
  setStatus('failed', 'Could not start')
  showBanner(error.message)
})
