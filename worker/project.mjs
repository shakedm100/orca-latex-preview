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
const BIBITEM = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
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
  const bibItems = []

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

    for (const match of text.matchAll(LABEL)) {
      labels.push({ name: match[1].trim(), file, line: lineAt(text, match.index), context: labelContext(text, match.index) })
    }
    for (const match of text.matchAll(BIBITEM)) {
      bibItems.push({ key: match[1].trim(), type: 'bibitem', title: '', author: '', year: '', venue: '', file, line: lineAt(text, match.index) })
    }
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
  const bibFound = []
  for (const bib of bibFiles) {
    const entries = await readBib(bib, read)
    if (entries) {
      bibFound.push(bib)
      citations.push(...entries)
    }
  }
  citations.push(...bibItems)
  // Numbers from the last build: \newlabel and \bibcite in the .aux files.
  const aux = build.outDir ? await readAux(build.outDir) : { labels: new Map(), cites: new Map() }
  for (const label of labels) {
    const found = aux.labels.get(label.name)
    if (found) Object.assign(label, found)
  }
  for (const entry of citations) {
    const number = aux.cites.get(entry.key)
    if (number) entry.number = number
  }

  return {
    outline,
    labels,
    commands: [...commands.values()],
    environments: [...environments.values()],
    packages: [...packages].filter(Boolean),
    citations,
    // Whether the bibliography could be read, so a key it lacks can be called undefined.
    citationSources: bibFound.length + (bibItems.length ? 1 : 0),
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

/** Keys, titles, authors and venues of a .bib file; null when it cannot be read. */
async function readBib(file, read) {
  const text = await read(file)
  if (text === null || text === undefined) return null
  const entries = []
  const ENTRY = /@(\w+)\s*[{(]\s*([^,\s{}]+)\s*,/g
  for (const match of text.matchAll(ENTRY)) {
    const type = match[1].toLowerCase()
    if (type === 'comment' || type === 'string' || type === 'preamble') continue
    // Up to the next entry, so a field this entry lacks is not taken from the one after it.
    const start = match.index + match[0].length
    const next = text.slice(start, start + 4000).search(/\n\s*@\w+\s*[{(]/)
    const body = text.slice(start, next === -1 ? start + 4000 : start + next)
    const field = (name) => {
      const found = new RegExp(`\\b${name}\\s*=\\s*[{"]((?:[^{}"]|\\{[^{}]*\\})*)[}"]`, 'i').exec(body)
      return found ? found[1].replace(/[{}]/g, '').replace(/\s+/g, ' ').trim() : ''
    }
    entries.push({
      key: match[2],
      type,
      title: field('title'),
      author: field('author'),
      year: field('year') || field('date').slice(0, 4),
      venue: field('journal') || field('journaltitle') || field('booktitle') || field('publisher') || field('school') || field('institution') || field('howpublished')
    })
  }
  return entries
}

/**
 * What a \label names, for a hover: its environment with the caption (`figure: Results`), or the
 * heading it follows (`section: Method`).
 */
export function labelContext(text, index) {
  const before = text.slice(Math.max(0, index - 3000), index)
  const heading = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g
  let lastHeading = null
  for (const match of before.matchAll(heading)) lastHeading = match
  // The innermost environment still open at the label.
  const stack = []
  for (const match of before.matchAll(/\\(begin|end)\s*\{([^}]+)\}/g)) {
    if (match[1] === 'begin') stack.push({ name: match[2], at: match.index })
    else if (stack.length && stack[stack.length - 1].name === match[2]) stack.pop()
  }
  const env = stack.filter((entry) => entry.name !== 'document').pop()
  // A label within a few lines of a heading names that heading.
  if (lastHeading && (!env || lastHeading.index > env.at) && before.length - lastHeading.index < 400) {
    const title = groupAt(before, lastHeading.index + lastHeading[0].length - 1)
    if (title !== null) return `${lastHeading[1]}: ${plainTitle(title)}`
  }
  if (env) {
    // The caption inside the environment, before or after the label.
    const start = Math.max(0, index - 3000) + env.at
    const close = text.indexOf(`\\end{${env.name}}`, index)
    const body = text.slice(start, close === -1 ? index + 1500 : close)
    const caption = /\\caption\*?\s*(?:\[[^\]]*\])?\s*\{/.exec(body)
    const title = caption ? groupAt(body, caption.index + caption[0].length - 1) : null
    return title ? `${env.name}: ${plainTitle(title)}` : env.name
  }
  const lineStart = text.lastIndexOf('\n', index) + 1
  const lineEnd = text.indexOf('\n', index)
  return plainTitle(text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)).slice(0, 120)
}

/** \newlabel numbers and pages, and \bibcite numbers, from the .aux files of the last build. */
async function readAux(outDir) {
  const labels = new Map()
  const cites = new Map()
  const queue = [{ dir: outDir, depth: 0 }]
  while (queue.length) {
    const { dir, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 4) queue.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.name.endsWith('.aux')) continue
      const text = await readFile(full, 'utf8').catch(() => '')
      for (const match of text.matchAll(/\\newlabel\{([^}]+)\}\{\{((?:[^{}]|\{[^{}]*\})*)\}\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
        if (match[1].endsWith('@cref')) continue
        labels.set(match[1], { number: plainTitle(match[2]) || null, page: plainTitle(match[3]) || null })
      }
      // \bibcite{key}{1}, or natbib's \bibcite{key}{{1}{2020}{{Author}}{{}}}.
      for (const match of text.matchAll(/\\bibcite\{([^}]+)\}\{(\{?)([^{}]*)/g)) cites.set(match[1], match[3])
    }
  }
  return { labels, cites }
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
