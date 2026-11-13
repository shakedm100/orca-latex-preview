// What a build read, from TeX's recorder file (`-recorder` writes <name>.fls): a digest of the
// project files' contents, so two builds from the same files can be told apart from a real change
// without comparing PDFs, which carry the build time.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/** The INPUT paths of a .fls file, made absolute (they are relative to its PWD line). */
export function recordedInputs(fls) {
  let pwd = ''
  const inputs = new Set()
  for (const line of fls.split(/\r?\n/)) {
    if (line.startsWith('PWD ')) pwd = line.slice(4)
    else if (line.startsWith('INPUT ')) {
      const file = line.slice(6)
      inputs.add(path.isAbsolute(file) ? path.normalize(file) : path.resolve(pwd, file))
    }
  }
  return [...inputs]
}

const inside = (file, dir) => Boolean(dir) && (file === dir || file.startsWith(dir + path.sep))

/**
 * A digest of what the build read: each project file by its path in the project and its content
 * (an unsaved buffer read from `overlayDir` counts as the file it stands for), and any format
 * file, which holds a precompiled preamble. TeX's own files are left out, and so are files in
 * `outDir` (.aux, .toc), which the same sources always rebuild alike. Null without a .fls.
 */
export async function inputsDigest({ flsPath, projectDir, rootDir, overlayDir, outDir, extra = '' }) {
  const fls = await readFile(flsPath, 'utf8').catch(() => null)
  if (fls === null) return null
  const entries = []
  for (const file of recordedInputs(fls)) {
    let name
    if (inside(file, overlayDir)) name = path.join(rootDir, path.relative(overlayDir, file))
    else if (file.endsWith('.fmt')) name = path.basename(file)
    else if (inside(file, outDir)) continue
    else if (inside(file, projectDir)) name = file
    else continue
    const content = await readFile(file).catch(() => null)
    if (content === null) continue
    const label = name.endsWith('.fmt') ? name : path.relative(projectDir, name).split(path.sep).join('/')
    entries.push(`${label}\0${createHash('sha256').update(content).digest('hex')}`)
  }
  entries.sort()
  return createHash('sha256').update(`${extra}\n${entries.join('\n')}`).digest('hex')
}
