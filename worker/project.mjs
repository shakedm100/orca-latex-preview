// Reads a LaTeX project the way the document does: the main file, then each \input, \include
// and \subfile in place, using the editors' unsaved text where there is some. From that it builds
// the outline, the labels, the user's commands and environments, the bibliography keys and the
// files an \includegraphics or \input could name.
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const SECTION_LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 }
const SECTION = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g
const INCLUDE = /\\(input|include|subfile|InputIfFileExists)\s*\{([^}]+)\}/g
const IMPORT = /\\(?:sub)?import\s*\{([^}]*)\}\s*\{([^}]+)\}/g
const LABEL = /\\label\s*\{([^}]+)\}/g
const NEWCOMMAND = /\\(?:new|renew|provide)command\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*(?:\[(\d)\])?/g
const DEF = /\\(?:def|gdef|edef|let)\s*\\([A-Za-z@]+)/g
const MATHOP = /\\DeclareMathOperator\*?\s*\{\s*\\([A-Za-z]+)\s*\}/g
const NEWENV = /\\(?:new|renew)environment\s*\{([^}]+)\}\s*(?:\[(\d)\])?/g
const NEWTHEOREM = /\\newtheorem\*?\s*\{([^}]+)\}/g
const BIBLIOGRAPHY = /\\bibliography\s*\{([^}]+)\}/g
const ADDBIB = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
const USEPACKAGE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.pdf', '.eps', '.svg', '.gif', '.tif', '.tiff'])
const MAX_FILES = 200
const MAX_LIST = 3000

/** Removes comments, keeping line breaks so positions still map to lines. */
export function stripComments(text) {
  return text.replace(/(^|[^\\])%.*$/gm, '$1')
}

/** The text of a balanced {...} group starting at `open` (the index of `{`). */
function groupAt(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\\') {
      i += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
    if (char === '\n' && text[i + 1] === '\n') return null // a paragraph break: unbalanced
  }
  return null
}

/** Makes a section title readable: drops commands, keeps their text. */
function plainTitle(title) {
  return title
    .replace(/\\(?:label|index|footnote|cite\w*)\s*\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z@]+\*?\s*(?:\[[^\]]*\])?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

function resolveTex(base, name) {
  const file = path.resolve(base, name.trim())
  return path.extname(file) ? file : `${file}.tex`
}

/**
 * @param {{ root: string, rootDir: string, overlays: Map<string, string> }} build
 */
export async function scanProject(build) {
  const read = async (file) => build.overlays.get(file) ?? (await readFile(file, 'utf8').catch(() => null))
  const outline = []
  const labels = []
  const commands = new Map()
  const environments = new Map()
  const packages = new Set()
  const bibFiles = new Set()
  const visited = new Set()
  const texts = []

  async function walk(file, depth, base) {
    if (visited.has(file) || visited.size >= MAX_FILES || depth > 12) return
    visited.add(file)
    const raw = await read(file)
    if (raw === null) return
    texts.push(raw)
    const text = stripComments(raw)

    // Sections and includes interleaved in document order, so the outline follows the PDF.
    const events = []
    for (const match of text.matchAll(SECTION)) events.push({ kind: 'section', index: match.index, match })
    for (const match of text.matchAll(INCLUDE)) events.push({ kind: 'include', index: match.index, match })
    for (const match of text.matchAll(IMPORT)) events.push({ kind: 'import', index: match.index, match })
    events.sort((a, b) => a.index - b.index)
    for (const event of events) {
      if (event.kind === 'section') {
        const open = event.match.index + event.match[0].length - 1
        const title = groupAt(text, open)
        // A section inside a macro definition (\newcommand{\x}[2]{\section{#1}}) is not one.
        if (title === null || /#\d/.test(title)) continue
        outline.push({
          level: SECTION_LEVELS[event.match[1]],
          kind: event.match[1],
          title: plainTitle(title) || '(untitled)',
          file,
          line: lineAt(text, event.index)
        })
      } else if (event.kind === 'include') {
        for (const name of event.match[2].split(',')) await walk(resolveTex(base, name), depth + 1, base)
      } else {
        const dir = path.resolve(path.dirname(file), event.match[1])
        await walk(resolveTex(dir, event.match[2]), depth + 1, dir)
      }
    }

    for (const match of text.matchAll(LABEL)) labels.push({ name: match[1].trim(), file, line: lineAt(text, match.index) })
    for (const match of text.matchAll(NEWCOMMAND)) commands.set(match[1], { name: match[1], args: Number(match[2] ?? 0), file })
    for (const match of text.matchAll(DEF)) if (!commands.has(match[1])) commands.set(match[1], { name: match[1], args: 0, file })
    for (const match of text.matchAll(MATHOP)) commands.set(match[1], { name: match[1], args: 0, file })
    for (const match of text.matchAll(NEWENV)) environments.set(match[1].trim(), { name: match[1].trim(), args: Number(match[2] ?? 0) })
    for (const match of text.matchAll(NEWTHEOREM)) environments.set(match[1].trim(), { name: match[1].trim(), args: 0 })
    for (const match of text.matchAll(USEPACKAGE)) for (const name of match[1].split(',')) packages.add(name.trim())
    for (const match of text.matchAll(BIBLIOGRAPHY)) {
      for (const name of match[1].split(',')) {
        const bib = path.resolve(build.rootDir, name.trim())
        bibFiles.add(path.extname(bib) ? bib : `${bib}.bib`)
      }
    }
    for (const match of text.matchAll(ADDBIB)) bibFiles.add(path.resolve(build.rootDir, match[1].trim()))
  }

  await walk(build.root, 0, build.rootDir)

  const files = await listFiles(build.rootDir)
  const ownPdf = `${path.basename(build.root).replace(/\.[^.]+$/, '')}.pdf`
  files.images = files.images.filter((file) => file !== ownPdf)
  // No \bibliography found (a template, or one set by a macro): offer every .bib nearby.
  if (bibFiles.size === 0) for (const file of files.bib) bibFiles.add(path.join(build.rootDir, file))
  const citations = []
  for (const bib of bibFiles) citations.push(...(await readBib(bib, read)))

  return {
    outline,
    labels,
    commands: [...commands.values()],
    environments: [...environments.values()],
    packages: [...packages].filter(Boolean),
    citations,
    files: { tex: files.tex, images: files.images, bib: files.bib },
    sources: [...visited],
    words: countWords(texts)
  }
}

async function listFiles(rootDir) {
  const tex = []
  const images = []
  const bib = []
  const queue = [{ dir: rootDir, depth: 0 }]
  let seen = 0
  while (queue.length && seen < MAX_LIST) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      seen += 1
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 4) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      const rel = path.relative(rootDir, full).split(path.sep).join('/')
      const ext = path.extname(entry.name).toLowerCase()
      if (ext === '.tex') tex.push(rel.replace(/\.tex$/i, ''))
      else if (ext === '.bib') bib.push(rel)
      else if (IMAGE_EXTS.has(ext)) images.push(rel)
    }
  }
  return { tex, images, bib }
}

/** Keys, titles and authors of a .bib file. */
async function readBib(file, read) {
  const text = await read(file)
  if (!text) return []
  const entries = []
  const ENTRY = /@(\w+)\s*[{(]\s*([^,\s{}]+)\s*,/g
  for (const match of text.matchAll(ENTRY)) {
    const type = match[1].toLowerCase()
    if (type === 'comment' || type === 'string' || type === 'preamble') continue
    const body = text.slice(match.index + match[0].length, match.index + match[0].length + 2000)
    const field = (name) => {
      const found = new RegExp(`\\b${name}\\s*=\\s*[{"]((?:[^{}"]|\\{[^{}]*\\})*)[}"]`, 'i').exec(body)
      return found ? found[1].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : ''
    }
    entries.push({ key: match[2], type, title: field('title'), author: field('author'), year: field('year') })
  }
  return entries
}

/** Words in the body of a document, from the outline sources: text between \begin{document} and \end{document}. */
export function countWords(texts) {
  let words = 0
  for (const text of texts) {
    let body = stripComments(text)
    const start = body.indexOf('\\begin{document}')
    if (start >= 0) body = body.slice(start + 16)
    const end = body.indexOf('\\end{document}')
    if (end >= 0) body = body.slice(0, end)
    body = body
      .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\$[^$]*\$|\\\([\s\S]*?\\\)/g, ' ')
      .replace(/\\begin\{(equation|align|gather|multline|eqnarray|displaymath|math|verbatim|lstlisting|minted|tikzpicture)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
      .replace(/\\(?:label|ref|eqref|cref|Cref|cite\w*|includegraphics|input|include|bibliography\w*|usepackage|documentclass|begin|end|vspace|hspace|newcommand|renewcommand|setlength|addcontentsline)\*?\s*(?:\[[^\]]*\])*\s*(?:\{[^}]*\})*/g, ' ')
      .replace(/\\[a-zA-Z@]+\*?/g, ' ')
      .replace(/[{}[\]&~\\#^_]/g, ' ')
    words += (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length
  }
  return words
}
