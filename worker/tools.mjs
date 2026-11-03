// Finds the TeX executables. Orca may be started from a desktop launcher whose PATH lacks a
// user-installed TeX Live, so the usual install locations are searched as well.
import { access, constants, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const NAMES = ['latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber']
const isWindows = process.platform === 'win32'

async function isExecutable(file) {
  try {
    await access(file, isWindows ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function texLiveBinDirs() {
  const roots = isWindows ? ['C:\\texlive'] : ['/usr/local/texlive', path.join(os.homedir(), 'texlive')]
  const dirs = []
  for (const root of roots) {
    let years
    try {
      years = (await readdir(root)).filter((name) => /^\d{4}$/.test(name)).sort().reverse()
    } catch {
      continue
    }
    for (const year of years) {
      try {
        for (const arch of await readdir(path.join(root, year, 'bin'))) {
          dirs.push(path.join(root, year, 'bin', arch))
        }
      } catch {
        // No bin folder in this year's tree.
      }
    }
  }
  return dirs
}

async function tinyTexBinDirs() {
  const base = path.join(os.homedir(), '.TinyTeX', 'bin')
  try {
    return (await readdir(base)).map((arch) => path.join(base, arch))
  } catch {
    return []
  }
}

/** The folders to search, in order: the user's setting, PATH, then known install locations. */
export async function searchDirs(extraDir) {
  const dirs = []
  if (extraDir) dirs.push(extraDir)
  dirs.push(...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
  if (process.platform === 'darwin') dirs.push('/Library/TeX/texbin', '/opt/homebrew/bin')
  if (!isWindows) dirs.push('/usr/bin', '/usr/local/bin')
  dirs.push(...(await texLiveBinDirs()), ...(await tinyTexBinDirs()))
  return [...new Set(dirs)]
}

/** Maps each tool name to its absolute path, or null when it is not installed. */
export async function detectTools(extraDir) {
  const dirs = await searchDirs(extraDir)
  const found = {}
  for (const name of NAMES) {
    found[name] = null
    for (const dir of dirs) {
      const candidate = path.join(dir, isWindows ? `${name}.exe` : name)
      if (await isExecutable(candidate)) {
        found[name] = candidate
        break
      }
    }
  }
  return { tools: found, dirs }
}
