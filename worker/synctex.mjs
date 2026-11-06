// A small SyncTeX reader: maps a source line to boxes on a PDF page and a point on a page back to
// a source line, from the .synctex.gz the engine writes with -synctex=1. Coordinates come back in
// PDF points from the page's top-left corner, the space pdf.js draws in at scale 1.
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

const SP_PER_BP = 65781.76 // scaled points per PostScript point

/** Windows paths are case-insensitive, and TeX may log `c:` where Orca says `C:`. */
export const samePath = (a, b) =>
  process.platform === 'win32' ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b)

// Record kinds: [ vbox, ( hbox, h void hbox, v void vbox, x current point, k kern, g glue, $ math.
const RECORD = /^([[(hvxkg$])(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/

/** Parses a synctex file into inputs and per-page records. */
export function parseSynctex(text) {
  const inputs = new Map() // tag -> path as TeX saw it
  let unit = 1
  let xOffset = 0
  let yOffset = 0
  let magnification = 1000
  const pages = new Map() // page -> records
  let page = 0
  let records = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('Input:')) {
      const match = /^Input:(\d+):(.*)$/.exec(line)
      if (match) inputs.set(Number(match[1]), match[2])
      continue
    }
    if (line.startsWith('{')) {
      page = Number(line.slice(1))
      records = []
      pages.set(page, records)
      continue
    }
    if (line.startsWith('}')) {
      records = null
      continue
    }
    if (!records) {
      if (line.startsWith('Unit:')) unit = Number(line.slice(5)) || 1
      else if (line.startsWith('X Offset:')) xOffset = Number(line.slice(9)) || 0
      else if (line.startsWith('Y Offset:')) yOffset = Number(line.slice(9)) || 0
      else if (line.startsWith('Magnification:')) magnification = Number(line.slice(14)) || 1000
      continue
    }
    const match = RECORD.exec(line)
    if (!match) continue
    const factor = (unit * magnification) / 1000 / SP_PER_BP
    records.push({
      kind: match[1],
      tag: Number(match[2]),
      line: Number(match[3]),
      x: (Number(match[4]) + xOffset) * factor,
      y: (Number(match[5]) + yOffset) * factor,
      w: match[6] !== undefined ? Number(match[6]) * factor : 0,
      h: match[7] !== undefined ? Number(match[7]) * factor : 0,
      d: match[8] !== undefined ? Number(match[8]) * factor : 0
    })
  }
  return { inputs, pages }
}

/**
 * Loads (and caches by mtime) the synctex of a build, with input paths mapped back to the
 * project: TeX read unsaved buffers from `overlayDir`, which stand for the same paths under
 * `rootDir`.
 */
export function createSynctex({ synctexPath, rootDir, overlayDir }) {
  let cached = null

  const toProject = (input) => {
    let file = path.isAbsolute(input) ? input : path.resolve(rootDir, input)
    file = path.normalize(file)
    if (overlayDir && file.startsWith(overlayDir + path.sep)) file = path.join(rootDir, path.relative(overlayDir, file))
    if (!path.extname(file)) file += '.tex'
    return file
  }

  async function load() {
    const info = await stat(synctexPath).catch(() => null)
    if (!info) return null
    if (cached && cached.mtime === info.mtimeMs) return cached.data
    const data = parseSynctex(gunzipSync(await readFile(synctexPath)).toString('utf8'))
    data.files = new Map([...data.inputs].map(([tag, input]) => [tag, toProject(input)]))
    cached = { mtime: info.mtimeMs, data }
    return data
  }

  /** Groups records into visual lines: shared baseline, with the height of their boxes. */
  function visualLines(records) {
    const lines = []
    for (const record of records) {
      if (record.kind === '[' || record.kind === 'v') continue
      let line = lines.find((candidate) => Math.abs(candidate.y - record.y) < 0.5)
      if (!line) {
        line = { y: record.y, x0: Infinity, x1: -Infinity, h: 0, d: 0, records: [] }
        lines.push(line)
      }
      line.records.push(record)
      line.x0 = Math.min(line.x0, record.x)
      line.x1 = Math.max(line.x1, record.x + (record.w || 0))
      if (record.kind === '(' || record.kind === 'h') {
        line.h = Math.max(line.h, record.h)
        line.d = Math.max(line.d, record.d)
      }
    }
    for (const line of lines) {
      if (!line.h) line.h = 8
      if (!line.d) line.d = 2.5
    }
    return lines
  }

  return {
    /** Where `line` of `file` landed: the page and a strip per visual line it made there. */
    async forward(file, line) {
      const data = await load()
      if (!data) return null
      const target = path.normalize(file)
      const tags = new Set([...data.files].filter(([, input]) => samePath(input, target)).map(([tag]) => tag))
      if (tags.size === 0) return null
      // The nearest line at or after the cursor that produced output, else the nearest before.
      let best = null
      for (const [page, records] of data.pages) {
        for (const record of records) {
          if (!tags.has(record.tag) || record.kind === '[' || record.kind === 'v') continue
          const distance = record.line >= line ? record.line - line : (line - record.line) * 1000
          if (!best || distance < best.distance || (distance === best.distance && page < best.page)) {
            best = { distance, page, line: record.line }
          }
        }
      }
      if (!best) return null
      const mine = data.pages.get(best.page).filter((record) => tags.has(record.tag) && record.line === best.line)
      const boxes = visualLines(mine)
        .sort((a, b) => a.y - b.y)
        .slice(0, 12)
        .map((strip) => ({
          x: strip.x0,
          y: strip.y - strip.h,
          w: Math.max(12, strip.x1 - strip.x0),
          h: strip.h + strip.d
        }))
      return { page: best.page, line: best.line, boxes }
    },

    /** The source line under a point of a page (1-based page, PDF points from the top-left). */
    async inverse(page, x, y) {
      const data = await load()
      const records = data?.pages.get(page)
      if (!records || records.length === 0) return null
      const lines = visualLines(records)
      // The visual line under the point, else the nearest one vertically.
      let line = null
      let bestGap = Infinity
      for (const candidate of lines) {
        const top = candidate.y - candidate.h
        const bottom = candidate.y + candidate.d
        const gap = y < top ? top - y : y > bottom ? y - bottom : 0
        if (gap < bestGap || (gap === bestGap && line && candidate.records.length > line.records.length)) {
          bestGap = gap
          line = candidate
        }
      }
      if (!line) return null
      // Along that line: the last record starting at or before the point, else the first one.
      const ordered = line.records.slice().sort((a, b) => a.x - b.x)
      const precise = ordered.filter((record) => record.kind !== '(' && record.kind !== 'h')
      const pool = precise.length ? precise : ordered
      let hit = pool[0]
      for (const record of pool) if (record.x <= x + 0.5) hit = record
      return { file: data.files.get(hit.tag) ?? null, line: hit.line }
    }
  }
}
