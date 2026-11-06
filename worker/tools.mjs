// Finds the TeX executables and works out which TeX distribution they belong to. Orca may be
// started from a desktop launcher (Dock, Start menu, a .desktop file) whose PATH lacks TeX, so
// the usual install locations of every distribution are searched too.
import { access, constants, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const NAMES = ['latexmk', 'pdflatex', 'xelatex', 'lualatex', 'bibtex', 'biber', 'kpsewhich', 'tlmgr', 'miktex', 'mpm']
const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
const home = os.homedir()
// Windows runs .exe, and TeX Live's tlmgr is a .bat.
const WINDOWS_SUFFIXES = ['.exe', '.bat', '.cmd']

async function isExecutable(file) {
  try {
    await access(file, isWindows ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `<root>/<year>/bin/<arch>` folders of TeX Live installed from tug.org, newest year first. */
async function texLiveBinDirs() {
  const roots = isWindows
    ? ['C:\\texlive', path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'texlive')]
    : ['/usr/local/texlive', '/opt/texlive', path.join(home, 'texlive'), path.join(home, '.local', 'texlive')]
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
        for (const arch of await readdir(path.join(root, year, 'bin'))) dirs.push(path.join(root, year, 'bin', arch))
      } catch {
        // No bin folder in this year's tree.
      }
    }
  }
  return dirs
}

/** TinyTeX: ~/.TinyTeX on Linux, ~/Library/TinyTeX on macOS, %APPDATA%\TinyTeX on Windows. */
async function tinyTexBinDirs() {
  const bases = isWindows
    ? [path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'TinyTeX', 'bin')]
    : isMac
      ? [path.join(home, 'Library', 'TinyTeX', 'bin')]
      : [path.join(home, '.TinyTeX', 'bin')]
  const dirs = []
  for (const base of bases) {
    try {
      for (const arch of await readdir(base)) dirs.push(path.join(base, arch))
    } catch {
      // Not installed here.
    }
  }
  return dirs
}

/** MiKTeX installs for all users or for one, on every system. */
function mikTexBinDirs() {
  if (isWindows) {
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return [path.join(programFiles, 'MiKTeX', 'miktex', 'bin', 'x64'), path.join(local, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64')]
  }
  if (isMac) return ['/Applications/MiKTeX Console.app/Contents/bin', path.join(home, 'bin')]
  return [path.join(home, 'bin')] // MiKTeX's per-user install links its programs into ~/bin
}

/** The folders to search, in order: the user's setting, PATH, then known install locations. */
export async function searchDirs(extraDir) {
  const dirs = []
  if (extraDir) dirs.push(extraDir)
  dirs.push(...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean))
  if (isMac) dirs.push('/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin')
  if (!isWindows) {
    dirs.push('/usr/bin', '/usr/local/bin', '/bin')
    // Nix and Guix profiles, which a desktop launcher's PATH often lacks.
    dirs.push(path.join(home, '.nix-profile', 'bin'), '/run/current-system/sw/bin', '/nix/var/nix/profiles/default/bin', path.join(home, '.guix-profile', 'bin'))
  }
  dirs.push(...(await texLiveBinDirs()), ...(await tinyTexBinDirs()), ...mikTexBinDirs())
  return [...new Set(dirs)]
}

/** Maps each tool name to its absolute path, or null when it is not installed. */
export async function detectTools(extraDir) {
  const dirs = await searchDirs(extraDir)
  const found = {}
  for (const name of NAMES) {
    found[name] = null
    search: for (const dir of dirs) {
      for (const suffix of isWindows ? WINDOWS_SUFFIXES : ['']) {
        const candidate = path.join(dir, `${name}${suffix}`)
        if (await isExecutable(candidate)) {
          found[name] = candidate
          break search
        }
      }
    }
  }
  return { tools: found, dirs, tex: await describeTex(found) }
}

/**
 * Which TeX distribution the engines come from, since that decides how to add a package:
 * MiKTeX and TeX Live from tug.org (TinyTeX, MacTeX) have their own package managers, while a
 * Linux distribution's TeX is extended with the system's package manager.
 */
async function describeTex(tools) {
  const engine = tools.pdflatex ?? tools.xelatex ?? tools.lualatex ?? tools.latexmk
  if (!engine) return { kind: 'none' }
  const where = engine.replace(/\\/g, '/')
  if (/miktex/i.test(where) || ((tools.miktex || tools.mpm) && !tools.tlmgr)) return { kind: 'miktex', bin: path.dirname(engine) }
  if (/tinytex/i.test(where)) return { kind: 'tinytex', bin: path.dirname(engine), userWritable: true }
  if (/\/Library\/TeX\//.test(where) || (isMac && /\/texlive\//.test(where))) return { kind: 'mactex', bin: path.dirname(engine), userWritable: false }
  if (/\/texlive\/\d{4}\//.test(where)) {
    // A tug.org TeX Live: tlmgr needs sudo unless the tree belongs to this user.
    let userWritable = false
    try {
      await access(path.dirname(engine), constants.W_OK)
      userWritable = true
    } catch {
      // Installed for all users.
    }
    return { kind: 'texlive', bin: path.dirname(engine), userWritable }
  }
  if (/\/nix\/|\/\.nix-profile\/|\/run\/current-system\//.test(where)) return { kind: 'nix', bin: path.dirname(engine) }
  return { kind: 'system', bin: path.dirname(engine) }
}
