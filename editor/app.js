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
  outline: $('outline')
}

const request = (name, input = {}, timeoutMs = 30000) =>
  orca.plugin?.request
    ? orca.plugin.request(name, input, { timeoutMs })
    : orca.host.call('plugin.request', { name, input, timeoutMs }).then((answer) => answer.output)

const viewer = createViewer({
  scroller: els.viewer,
  pageInput: $('pageInput'),
  pageCount: $('pageCount'),
  zoomLabel: els.zoomLabel,
  onChange: () => {
    els.empty.hidden = true
    els.download.disabled = false
  },
  onDoubleClick: (point) => void syncInverse(point)
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

async function attach(choice) {
  if (app.attaching) return app.attaching
  app.attaching = (async () => {
    setStatus('compiling', 'Finding this file in your workspaces…')
    const input = { text: app.doc.value }
    if (choice) Object.assign(input, choice)
    const answer = await request('latex.attach', input, 60000)
    if (!answer.sessionId) {
      showChoices(answer.candidates)
      return false
    }
    app.sessionId = answer.sessionId
    app.file = answer.file
    app.relToRoot = answer.relToRoot
    els.compile.disabled = false
    applyState(answer.state)
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

function showChoices(candidates) {
  setStatus('', 'Which file is this?')
  els.empty.hidden = false
  els.empty.querySelector('.title').textContent = candidates.length ? 'Which file is this?' : 'File not found'
  els.empty.querySelector('.muted').textContent = candidates.length
    ? 'Orca does not tell plugin editors where a file lives, and this text matches more than one file (or has unsaved edits). Pick it:'
    : 'No .tex file in your local workspaces matches this text. Save the file, then reopen this view.'
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
      await request('latex.update', { sessionId: app.sessionId, text: app.doc.value })
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
    await request('latex.update', { sessionId: app.sessionId, text: app.doc.value })
    applyState(await request('latex.compile', { sessionId: app.sessionId }))
  } catch (error) {
    showBanner(error.message)
  }
}

// ------------------------------------------------------------------ build state

function applyState(state) {
  if (!state) return
  app.state = state
  app.since = state.version
  const result = state.result
  const engine = result?.usedLatexmk ? `latexmk with ${state.engine}` : state.engine
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
    setStatus(state.status, label, `${state.root}\n${engine}, ${formatMs(result.durationMs)}\nOutput: ${state.outDir}`)
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

function issueTargetsThisFile(issue) {
  if (!app.relToRoot) return false
  if (!issue.file) return app.relToRoot === app.state?.name // an unnamed file is the main one
  return issue.file.replace(/^\.\//, '') === app.relToRoot || issue.file === app.file
}

function renderIssues(result) {
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
    if (app.editor && issue.line && issueTargetsThisFile(issue)) {
      row.classList.add('jump')
      row.title = `Go to line ${issue.line}`
      row.addEventListener('click', () => app.editor.goToLine(issue.line))
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
      void syncForward(rel, item.line)
    })
    list.append(button)
  }
}

function relToRoot(file) {
  const rootDir = app.state?.root?.replace(/[\\/][^\\/]*$/, '') ?? ''
  return file.startsWith(rootDir + '/') ? file.slice(rootDir.length + 1) : file
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
    else toast(`${hit.rel}, line ${hit.line}`)
  } catch (error) {
    toast(`Could not map that point to the source: ${error.message}`)
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
}

// ------------------------------------------------------------------ start

async function start() {
  if (!orca.document?.session) {
    setEmpty('This Orca is too old', 'The LaTeX views need Orca 1.4.246 or newer.')
    return
  }
  if (MODE === 'split') {
    setupDivider()
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
  if (await attach()) void poll()
}

window.addEventListener('pagehide', () => {
  app.closed = true
  if (app.sessionId) void request('latex.detach', { sessionId: app.sessionId }).catch(() => undefined)
})

start().catch((error) => {
  setStatus('failed', 'Could not start')
  showBanner(error.message)
})
