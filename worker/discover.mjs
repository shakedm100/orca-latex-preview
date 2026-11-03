// Finds the LaTeX documents in a workspace and works out which file is the one to compile.
import { open, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'out', 'target', 'vendor', '__pycache__'])
const MAX_DEPTH = 6
const MAX_ENTRIES = 20000
const MAX_DOCS = 300

const DOCUMENTCLASS = /^[^%\n]*\\documentclass\b/m
const MAGIC_ROOT = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im
const MAGIC_PROGRAM = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)\s*$/im
const UNICODE_PACKAGES = /^[^%\n]*\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:fontspec|unicode-math|polyglossia|xeCJK|luaotfload)\b/m

/** Reads at most `limit` bytes from the start of a file, as text. */
async function readHead(file, limit = 256 * 1024) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(limit)
    const { bytesRead } = await handle.read(buffer, 0, limit, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function isMainDocument(file) {
  try {
    return DOCUMENTCLASS.test(await readHead(file))
  } catch {
    return false
  }
}

/**
 * The .tex files under `root`, nearest the root first: only those with a \documentclass unless
 * `all` is set. Also returns every folder that holds one, for mirroring into the output folder.
 */
export async function findDocuments(root, { all = false } = {}) {
  const { docs } = await scanTex(root, all)
  return docs
}

export async function scanTex(root, all = true) {
  const dirs = new Set()
  const docs = []
  let visited = 0
  const queue = [{ dir: root, depth: 0 }]
  while (queue.length > 0 && docs.length < MAX_DOCS && visited < MAX_ENTRIES) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      visited += 1
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) {
          queue.push({ dir: full, depth: depth + 1 })
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tex')) {
        dirs.add(dir)
        if (all || (await isMainDocument(full))) {
          docs.push({ path: full, rel: path.relative(root, full) })
        }
      }
    }
  }
  return { docs, dirs: [...dirs] }
}

/**
 * The file to compile for `file`: the target of a `% !TEX root = ...` comment, the file itself
 * when it has a \documentclass, or else the nearest main document in the same or a parent folder.
 */
export async function resolveRoot(file, stopAt) {
  let head = ''
  try {
    head = await readHead(file, 64 * 1024)
  } catch {
    return file
  }
  const magic = MAGIC_ROOT.exec(head)
  if (magic) {
    const target = path.resolve(path.dirname(file), magic[1])
    try {
      if ((await stat(target)).isFile()) return target
    } catch {
      // Fall through to the other rules.
    }
  }
  if (DOCUMENTCLASS.test(head)) return file
  let dir = path.dirname(file)
  const limit = stopAt ? path.resolve(stopAt) : path.parse(dir).root
  for (;;) {
    let names = []
    try {
      names = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.tex')).sort()
    } catch {
      // Unreadable folder: keep walking up.
    }
    const preferred = ['main.tex', 'thesis.tex', 'paper.tex', 'report.tex']
    names.sort((a, b) => (preferred.includes(b) ? 1 : 0) - (preferred.includes(a) ? 1 : 0))
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (candidate !== file && (await isMainDocument(candidate))) return candidate
    }
    if (dir === limit || path.dirname(dir) === dir) break
    dir = path.dirname(dir)
  }
  return file
}

/** Picks the engine for a main document: the setting, a magic comment, then the preamble. */
export async function chooseEngine(file, setting) {
  if (setting && setting !== 'auto') return setting
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return 'pdflatex'
  }
  const magic = MAGIC_PROGRAM.exec(text)
  if (magic) {
    const name = magic[1].toLowerCase()
    if (name.startsWith('xe')) return 'xelatex'
    if (name.startsWith('lua')) return 'lualatex'
    if (name.startsWith('pdf')) return 'pdflatex'
  }
  const preamble = text.split(/\\begin\s*\{document\}/)[0]
  return UNICODE_PACKAGES.test(preamble) ? 'xelatex' : 'pdflatex'
}
