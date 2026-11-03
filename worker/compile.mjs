// Runs one build of a LaTeX document: latexmk when available, otherwise the engine with
// BibTeX or Biber and reruns until the cross-references settle.
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { needsRerun, parseLog } from './logparse.mjs'

const STEP_TIMEOUT_MS = 180_000
const MAX_ENGINE_RUNS = 4
const LOG_TAIL_BYTES = 12 * 1024

function run(command, args, { cwd, env, signal }) {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const collect = (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > 4 * LOG_TAIL_BYTES) output = output.slice(-2 * LOG_TAIL_BYTES)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), STEP_TIMEOUT_MS)
    const onAbort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: -1, output: `${output}\n${error.message}`, timedOut: false })
    })
    child.on('close', (code, killedBy) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code: code ?? -1, output, timedOut: killedBy === 'SIGKILL' && !signal?.aborted })
    })
  })
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

async function exists(file) {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/**
 * @param {object} options
 * @param {string} options.root        absolute path of the main .tex file
 * @param {string} options.engine      pdflatex | xelatex | lualatex
 * @param {Record<string, string | null>} options.tools  from detectTools
 * @param {string[]} options.searchDirs folders put first on the PATH of the child processes
 * @param {boolean} options.useLatexmk
 * @param {string} options.outDir      absolute output folder
 * @param {string} [options.overlayDir] folder searched before the project: unsaved editor buffers
 * @param {boolean} options.shellEscape
 * @param {AbortSignal} [options.signal]
 */
export async function compileDocument(options) {
  const started = Date.now()
  const dir = path.dirname(options.root)
  const file = path.basename(options.root)
  const base = file.replace(/\.[^.]+$/, '')
  const outDir = options.outDir
  const pdfPath = path.join(outDir, `${base}.pdf`)
  const logPath = path.join(outDir, `${base}.log`)
  await mkdir(outDir, { recursive: true })

  const env = {
    ...process.env,
    PATH: [...options.searchDirs, process.env.PATH ?? ''].join(path.delimiter),
    // One message per log line, so the log parser sees whole file:line: errors.
    max_print_line: '10000',
    error_line: '254',
    half_error_line: '238',
    // Unsaved buffers come first, then the project folder, then TeX's own tree (the trailing
    // empty entry). BibTeX runs inside the output folder but its .bib files sit with the sources.
    TEXINPUTS: [options.overlayDir, dir, ''].filter((entry) => entry !== undefined).join(path.delimiter),
    BIBINPUTS: [options.overlayDir, dir, ''].filter((entry) => entry !== undefined).join(path.delimiter),
    BSTINPUTS: [options.overlayDir, dir, ''].filter((entry) => entry !== undefined).join(path.delimiter)
  }
  const common = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1']
  if (options.shellEscape) common.push('-shell-escape')
  if (outDir !== dir) common.push(`-output-directory=${outDir}`)

  const before = (await exists(pdfPath)) ? (await stat(pdfPath)).mtimeMs : 0
  const steps = []
  let toolError = null

  const engineCommand = options.tools[options.engine]
  if (options.useLatexmk && options.tools.latexmk) {
    const flag = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }[options.engine]
    const args = [flag, '-f', ...common.filter((arg) => !arg.startsWith('-output-directory'))]
    if (outDir !== dir) args.push(`-outdir=${outDir}`)
    args.push(file)
    const result = await run(options.tools.latexmk, args, { cwd: dir, env, signal: options.signal })
    steps.push({ tool: 'latexmk', code: result.code, timedOut: result.timedOut })
    if (result.code !== 0 && !(await exists(logPath))) toolError = result.output.trim().slice(-2000)
  } else if (!engineCommand) {
    toolError = `${options.engine} was not found. Install TeX Live, or set "Extra TeX bin folder" in the plugin settings.`
  } else {
    let runs = 0
    let bibDone = false
    for (;;) {
      if (options.signal?.aborted) break
      const result = await run(engineCommand, [...common, file], { cwd: dir, env, signal: options.signal })
      runs += 1
      steps.push({ tool: options.engine, code: result.code, timedOut: result.timedOut })
      if (result.timedOut) {
        toolError = `${options.engine} took longer than ${STEP_TIMEOUT_MS / 1000} s and was stopped.`
        break
      }
      if (result.code === -1 && !(await exists(logPath))) {
        toolError = result.output.trim().slice(-2000)
        break
      }
      const log = await readIfExists(logPath)
      if (/^! Emergency stop|Fatal error occurred/m.test(log) && !(await exists(pdfPath))) break

      if (!bibDone) {
        bibDone = true
        const bcf = path.join(outDir, `${base}.bcf`)
        const aux = await readIfExists(path.join(outDir, `${base}.aux`))
        let bibTool = null
        let bibArgs = []
        if (await exists(bcf)) {
          bibTool = 'biber'
          bibArgs = [`--input-directory=${dir}`, `--output-directory=${outDir}`, base]
        } else if (/\\bibdata\{/.test(aux)) {
          bibTool = 'bibtex'
          bibArgs = [base]
        }
        if (bibTool) {
          if (!options.tools[bibTool]) {
            steps.push({ tool: bibTool, code: -1, missing: true })
          } else {
            const bib = await run(options.tools[bibTool], bibArgs, { cwd: outDir, env, signal: options.signal })
            steps.push({ tool: bibTool, code: bib.code, output: bib.output.slice(-2000) })
            if (runs < MAX_ENGINE_RUNS) continue
          }
        }
      }
      if (runs >= MAX_ENGINE_RUNS || !needsRerun(log)) break
    }
  }

  const log = await readIfExists(logPath)
  const issues = parseLog(log).map((issue) => {
    if (!issue.file) return issue
    const absolute = path.resolve(dir, issue.file)
    const relative = path.relative(dir, absolute)
    return { ...issue, file: relative.startsWith('..') ? absolute : relative }
  })
  for (const step of steps) {
    if (step.missing) {
      issues.unshift({ severity: 'warning', file: null, line: null, message: `${step.tool} is needed for the bibliography but was not found.` })
    } else if ((step.tool === 'bibtex' || step.tool === 'biber') && step.code !== 0) {
      const detail = (step.output ?? '').split('\n').filter((line) => /error|ERROR|I couldn't|I found no/.test(line)).slice(0, 5).join(' ')
      issues.unshift({ severity: 'warning', file: null, line: null, message: `${step.tool} failed${detail ? `: ${detail}` : '.'}` })
    }
  }
  if (toolError) issues.unshift({ severity: 'error', file: null, line: null, message: toolError })

  let pdfMtime = 0
  let pdfSize = 0
  if (await exists(pdfPath)) {
    const info = await stat(pdfPath)
    pdfMtime = info.mtimeMs
    pdfSize = info.size
  }
  const produced = pdfMtime > 0 && pdfMtime >= before && pdfSize > 0
  const errors = issues.filter((issue) => issue.severity === 'error').length
  return {
    ok: produced && errors === 0,
    produced,
    pdfPath: pdfMtime > 0 ? pdfPath : null,
    pdfSize,
    pdfMtime,
    issues,
    steps,
    engine: options.engine,
    usedLatexmk: Boolean(options.useLatexmk && options.tools.latexmk),
    durationMs: Date.now() - started,
    logTail: log.slice(-LOG_TAIL_BYTES)
  }
}

/** Extensions whose changes should never trigger a rebuild: everything the build writes. */
export const GENERATED = new Set([
  '.aux', '.log', '.fls', '.fdb_latexmk', '.synctex', '.gz', '.bbl', '.blg', '.bcf', '.xml', '.toc',
  '.lof', '.lot', '.out', '.nav', '.snm', '.vrb', '.xdv', '.dvi', '.idx', '.ind', '.ilg', '.glo',
  '.gls', '.glg', '.ist', '.acn', '.acr', '.alg', '.loa', '.lol', '.thm', '.run', '.pyg', '.swp', '.tmp'
])
