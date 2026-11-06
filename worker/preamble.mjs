// Precompiled preambles: the part of the main file before \begin{document} is dumped once into a
// format file (with the mylatexformat package), and each build starts from it instead of loading
// every package again. pdfLaTeX only: XeTeX and LuaTeX cannot dump the fonts they load.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const DUMP_TIMEOUT_MS = 120_000
// Packages known to misbehave when dumped: they read the job name or set things up at load
// time that must happen in the real run.
const UNSAFE = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:minted|pythontex|svg|epstopdf|currfile|standalone|subfiles|docmute|bibentry|tikzexternalize)\b/
const LOCAL_INPUT = /\\(?:input|include|usepackage|RequirePackage|documentclass|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g

function run(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => (output = (output + chunk).slice(-8000)))
    child.stderr.on('data', (chunk) => (output = (output + chunk).slice(-8000)))
    const timer = setTimeout(() => child.kill('SIGKILL'), DUMP_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: -1, output: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, output })
    })
  })
}

/** The preamble of `text`, or null when it has none or looks unsafe to dump. */
export function preambleOf(text) {
  const start = text.indexOf('\\begin{document}')
  if (start < 0) return null
  const preamble = text.slice(0, start)
  const code = preamble.replace(/(^|[^\\])%.*$/gm, '$1')
  if (!/\\documentclass/.test(code) || UNSAFE.test(code) || /\\endofdump/.test(code)) return null
  return preamble
}

/** Keeps one format per document up to date and says how to use it. */
export function createPreambleCache() {
  /** document -> { key, fmt, state: 'ready' | 'failed' | 'trusted' } */
  const formats = new Map()
  let available = null // { value, at }: checked again after a while, in case it was installed since

  async function hasPackage(kpsewhich, env, cwd) {
    if (available && (available.value || Date.now() - available.at < 5 * 60_000)) return available.value
    let value = false
    if (kpsewhich) {
      const found = await run(kpsewhich, ['mylatexformat.ltx'], { cwd, env })
      value = found.code === 0 && found.output.trim().length > 0
    }
    available = { value, at: Date.now() }
    return value
  }

  /** What the format depends on: the preamble and the project files it reads. */
  async function keyFor({ engine, preamble, dir, overlayDir }) {
    const hash = createHash('sha256').update(engine).update('\0').update(preamble)
    for (const match of preamble.replace(/(^|[^\\])%.*$/gm, '$1').matchAll(LOCAL_INPUT)) {
      for (const name of match[1].split(',')) {
        const base = name.trim()
        if (!base) continue
        for (const candidate of [base, `${base}.tex`, `${base}.sty`, `${base}.cls`]) {
          for (const root of [overlayDir, dir].filter(Boolean)) {
            try {
              const info = await stat(path.join(root, candidate))
              if (info.isFile()) hash.update(`${candidate}:${info.size}:${info.mtimeMs}\0`)
            } catch {
              // Not a project file (a package from the TeX tree).
            }
          }
        }
      }
    }
    return hash.digest('hex').slice(0, 16)
  }

  return {
    /**
     * Makes sure the format for this preamble exists. Returns the format's name and folder, or
     * null to build the usual way.
     */
    async prepare({ root, engine, tools, env, dir, outDir, overlayDir, text }) {
      if (engine !== 'pdflatex' || !tools.pdflatex) return null
      const preamble = preambleOf(text)
      if (!preamble) return null
      if (!(await hasPackage(tools.kpsewhich, env, dir))) return null
      const key = await keyFor({ engine, preamble, dir, overlayDir })
      const known = formats.get(root)
      const name = `${path.basename(root).replace(/\.[^.]+$/, '')}-preamble`
      if (known?.key === key) return known.state === 'failed' ? null : { name, dir: outDir, entry: known }
      const file = path.basename(root)
      const dumped = await run(
        tools.pdflatex,
        ['-ini', '-interaction=nonstopmode', '-halt-on-error', `-jobname=${name}`, `-output-directory=${outDir}`, '&pdflatex', 'mylatexformat.ltx', file],
        { cwd: dir, env }
      )
      let ok = dumped.code === 0
      if (ok) {
        try {
          ok = (await stat(path.join(outDir, `${name}.fmt`))).size > 0
        } catch {
          ok = false
        }
      }
      const entry = { key, state: ok ? 'ready' : 'failed' }
      formats.set(root, entry)
      return ok ? { name, dir: outDir, entry } : null
    },
    /** The first build with a new format had errors that the usual build did not: stop using it. */
    reject(root) {
      const entry = formats.get(root)
      if (entry) entry.state = 'failed'
    },
    trust(entry) {
      entry.state = 'trusted'
    },
    forget(root) {
      formats.delete(root)
    }
  }
}
