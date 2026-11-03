// Turns a TeX .log into a list of errors and warnings. The compiler runs with
// -file-line-error and max_print_line=10000, so most errors arrive as `file:line: message`
// on one line.

const FILE_LINE_ERROR = /^(.*?\.(?:tex|ltx|sty|cls|bib|bbl|dtx|clo|def|cfg|fd)):(\d+): (.*)$/i
const BANG_ERROR = /^! (.*)$/
const CONTEXT_LINE = /^l\.(\d+)\s?(.*)$/
const WARNING = /^(?:(LaTeX|Package|Class)\s*(\S*)\s+Warning|LaTeX Font Warning|pdfTeX warning(?: \([^)]*\))?)\s*:?\s*(.*)$/
const INPUT_LINE = /on input line (\d+)/
const BADBOX = /^((?:Overfull|Underfull) \\[hv]box .*?)(?: in paragraph at lines (\d+)--\d+| detected at line (\d+)| has occurred while \\output is active)?\s*$/

const MAX_ISSUES = 200

function normaliseFile(file) {
  return file.replace(/^\.\//, '')
}

/**
 * @param {string} log
 * @returns {{ severity: 'error' | 'warning' | 'badbox', file: string | null, line: number | null, message: string }[]}
 */
export function parseLog(log) {
  const lines = log.split(/\r?\n/)
  const issues = []
  const seen = new Set()
  const push = (issue) => {
    const key = `${issue.severity}|${issue.file}|${issue.line}|${issue.message}`
    if (seen.has(key) || issues.length >= MAX_ISSUES) return
    seen.add(key)
    issues.push(issue)
  }

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]

    let match = FILE_LINE_ERROR.exec(text)
    if (match) {
      let message = match[3].trim()
      // The context line `l.12 \foo` that follows names the offending source.
      for (let j = i + 1; j < Math.min(lines.length, i + 8); j += 1) {
        const context = CONTEXT_LINE.exec(lines[j])
        if (context) {
          if (context[2].trim()) message += `  (near: ${context[2].trim().slice(0, 80)})`
          break
        }
      }
      push({ severity: 'error', file: normaliseFile(match[1]), line: Number(match[2]), message })
      continue
    }

    match = BANG_ERROR.exec(text)
    if (match) {
      let line = null
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j += 1) {
        const context = CONTEXT_LINE.exec(lines[j])
        if (context) {
          line = Number(context[1])
          break
        }
      }
      push({ severity: 'error', file: null, line, message: match[1].trim() })
      continue
    }

    match = WARNING.exec(text)
    if (match) {
      let message = match[3].trim()
      // Continuation lines are indented, or start with the package name in parentheses.
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]
        if (!next.trim() || !/^(\s|\()/.test(next)) break
        message += ` ${next.replace(/^\s*\([^)]*\)\s*/, '').trim()}`
        i = j
      }
      message = message.replace(/\s+/g, ' ').trim()
      const where = INPUT_LINE.exec(message)
      const source = match[2] && match[1] !== 'LaTeX' ? `${match[2]}: ` : ''
      push({
        severity: 'warning',
        file: null,
        line: where ? Number(where[1]) : null,
        message: `${source}${message.replace(/\s*on input line \d+\.?/, '')}`
      })
      continue
    }

    match = BADBOX.exec(text)
    if (match && /^(Overfull|Underfull)/.test(text)) {
      const line = match[2] ?? match[3]
      push({ severity: 'badbox', file: null, line: line ? Number(line) : null, message: match[1].trim() })
    }
  }

  if (/^No pages of output\./m.test(log)) {
    push({ severity: 'error', file: null, line: null, message: 'No pages of output.' })
  }
  const order = { error: 0, warning: 1, badbox: 2 }
  return issues.sort((a, b) => order[a.severity] - order[b.severity])
}

/** True when the log asks for another pass (cross-references, tables of contents, citations). */
export function needsRerun(log) {
  return /Rerun to get|Label\(s\) may have changed|Please rerun|Package rerunfilecheck Warning|There were undefined references|Citation.*undefined|Table widths have changed/i.test(
    log
  )
}
