// Runs one build of a LaTeX document: latexmk when available, otherwise the engine with
// BibTeX or Biber and reruns until the cross-references settle.
import { spawn } from 'node:child_process'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { needsRerun, parseLog } from './logparse.mjs'
import { findRequirements } from './requirements.mjs'

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
 * @param {ReturnType<import('./preamble.mjs').createPreambleCache>} [options.preambleCache]  precompiled preambles, when on
 * @param {AbortSignal} [options.signal]
 */
export async function compileDocument(options) {
  const started = Date.now()
  let format = null
  if (options.preambleCache) {
    const dir = path.dirname(options.root)
    const overlayRoot = options.overlayDir ? path.join(options.overlayDir, path.basename(options.root)) : null
    const text = (overlayRoot && (await readIfExists(overlayRoot))) || (await readIfExists(options.root))
    try {
      await mkdir(options.outDir, { recursive: true })
      format = await options.preambleCache.prepare({
        root: options.root,
        engine: options.engine,
        tools: options.tools,
        env: buildEnv(options, dir),
        dir,
        outDir: options.outDir,
        overlayDir: options.overlayDir,
        text
      })
    } catch {
      format = null
    }
  }
  const result = await compileOnce(options, format)
  if (format && format.entry.state === 'ready') {
    // The first build with a new format: if it has errors, check them against a usual build,
    // and keep the format only when it was not the cause.
    const errors = result.issues.filter((issue) => issue.severity === 'error').length
    if (errors === 0) options.preambleCache.trust(format.entry)
    else {
      const plain = await compileOnce(options, null)
      const plainErrors = plain.issues.filter((issue) => issue.severity === 'error').length
      if (plainErrors < errors) options.preambleCache.reject(options.root)
      else options.preambleCache.trust(format.entry)
      return { ...plain, durationMs: Date.now() - started }
    }
  }
  return { ...result, durationMs: Date.now() - started }
}

/** The child processes' environment: TeX's search paths with the unsaved buffers first. */
function buildEnv(options, dir) {
  return {
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
    BSTINPUTS: [options.overlayDir, dir, ''].filter((entry) => entry !== undefined).join(path.delimiter),
    // A precompiled preamble sits in the output folder.
    TEXFORMATS: [options.outDir, ''].join(path.delimiter)
  }
}

async function compileOnce(options, format) {
  const started = Date.now()
  const dir = path.dirname(options.root)
  const file = path.basename(options.root)
  const base = file.replace(/\.[^.]+$/, '')
  const outDir = options.outDir
  const pdfPath = path.join(outDir, `${base}.pdf`)
  const logPath = path.join(outDir, `${base}.log`)
  await mkdir(outDir, { recursive: true })

  const env = buildEnv(options, dir)
  const common = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1']
  if (options.shellEscape) common.push('-shell-escape')
  if (outDir !== dir) common.push(`-output-directory=${outDir}`)

  const before = (await exists(pdfPath)) ? (await stat(pdfPath)).mtimeMs : 0
  const steps = []
  let toolError = null

  const engineCommand = options.tools[options.engine]
  // latexmk runs the engine too, so a missing engine stops the build either way.
  const missingEngine = engineCommand ? null : options.engine
  if (missingEngine) {
    toolError = `${options.engine} is not installed.`
  } else if (options.useLatexmk && options.tools.latexmk) {
    const flag = { pdflatex: '-pdf', xelatex: '-pdfxe', lualatex: '-pdflua' }[options.engine]
    const args = [flag, '-f', ...common.filter((arg) => !arg.startsWith('-output-directory'))]
    // latexmk runs this command line for pdfLaTeX, with its own options (%O) and the file (%S).
    if (format) args.push(`-pdflatex="${engineCommand}" -fmt=${format.name} %O %S`)
    if (outDir !== dir) args.push(`-outdir=${outDir}`)
    args.push(file)
    const result = await run(options.tools.latexmk, args, { cwd: dir, env, signal: options.signal })
    steps.push({ tool: 'latexmk', code: result.code, timedOut: result.timedOut })
    if (result.code !== 0 && !(await exists(logPath))) toolError = result.output.trim().slice(-2000)
  } else {
    let runs = 0
    let bibDone = false
    for (;;) {
      if (options.signal?.aborted) break
      const result = await run(engineCommand, [...common, ...(format ? [`-fmt=${format.name}`] : []), file], { cwd: dir, env, signal: options.signal })
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
    let absolute = path.resolve(dir, issue.file)
    // An unsaved buffer is read from the overlay folder: report it as the project file it stands for.
    if (options.overlayDir) {
      const inOverlay = path.relative(options.overlayDir, absolute)
      if (!inOverlay.startsWith('..') && !path.isAbsolute(inOverlay)) absolute = path.join(dir, inOverlay)
    }
    const relative = path.relative(dir, absolute)
    return { ...issue, file: relative.startsWith('..') || path.isAbsolute(relative) ? absolute : relative.split(path.sep).join('/') }
  })
  for (const step of steps) {
    if (step.missing) {
      continue // reported as a requirement below
    } else if ((step.tool === 'bibtex' || step.tool === 'biber') && step.code !== 0) {
      const detail = (step.output ?? '').split('\n').filter((line) => /error|ERROR|I couldn't|I found no/.test(line)).slice(0, 5).join(' ')
      issues.unshift({ severity: 'warning', file: null, line: null, message: `${step.tool} failed${detail ? `: ${detail}` : '.'}` })
    }
  }
  if (toolError && !missingEngine) issues.unshift({ severity: 'error', file: null, line: null, message: toolError })
  // What must be installed, with the command for this system; listed first among the issues too.
  const requirements = await findRequirements({ log, steps, missingEngine, tools: options.tools, tex: options.tex, engine: options.engine, shellEscape: options.shellEscape })
  for (const requirement of [...requirements].reverse()) {
    const how = requirement.install[0] ? ` To install: ${requirement.install[0]}` : ''
    issues.unshift({ severity: 'error', file: null, line: null, message: `${requirement.title}.${how}`, requirement: requirement.key })
  }

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
    requirements,
    steps,
    engine: options.engine,
    usedLatexmk: Boolean(options.useLatexmk && options.tools.latexmk),
    usedPreamble: Boolean(format),
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
