// What a build needs that the plugin cannot ship: TeX itself, bibliography tools, LaTeX packages,
// fonts, Pygments. Each requirement says what is missing, why, and the command that installs it
// on this system, so a person (or an agent reading `orca plugin logs`) can act on it directly.
import { readFile } from 'node:fs/promises'

let systemPromise = null

/** The OS, and on Linux the distribution family from /etc/os-release. */
export function detectSystem() {
  systemPromise ??= (async () => {
    if (process.platform === 'darwin') return { os: 'macos', family: 'macos', name: 'macOS' }
    if (process.platform === 'win32') return { os: 'windows', family: 'windows', name: 'Windows' }
    let release = ''
    try {
      release = await readFile('/etc/os-release', 'utf8')
    } catch {
      // Unknown Linux.
    }
    const field = (key) => (new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm').exec(release)?.[1] ?? '').toLowerCase()
    const ids = `${field('ID')} ${field('ID_LIKE')}`
    const name = new RegExp('^PRETTY_NAME="?([^"\\n]*)"?$', 'm').exec(release)?.[1] ?? 'Linux'
    for (const [family, pattern] of [
      ['fedora', /\b(fedora|rhel|centos|rocky|almalinux)\b/],
      ['debian', /\b(debian|ubuntu|linuxmint|pop|elementary)\b/],
      ['arch', /\b(arch|manjaro|endeavouros)\b/],
      ['suse', /\b(suse|opensuse)\b/]
    ]) {
      if (pattern.test(ids)) return { os: 'linux', family, name }
    }
    return { os: 'linux', family: 'linux', name }
  })()
  return systemPromise
}

const TEX_INSTALL = {
  fedora: ['sudo dnf install texlive-scheme-medium texlive-latexmk'],
  debian: ['sudo apt install texlive-latex-recommended texlive-latex-extra latexmk'],
  arch: ['sudo pacman -S texlive-basic texlive-latex texlive-latexrecommended texlive-latexextra'],
  suse: ['sudo zypper install texlive-scheme-medium texlive-latexmk'],
  macos: ['brew install --cask mactex-no-gui', 'or download MacTeX from https://tug.org/mactex/'],
  windows: ['Install MiKTeX from https://miktex.org/download (or TeX Live from https://tug.org/texlive/windows.html)'],
  linux: ['Install TeX Live from your package manager, or from https://tug.org/texlive/']
}

const ENGINE_PACKAGES = {
  xelatex: { fedora: 'texlive-xetex', debian: 'texlive-xetex', arch: 'texlive-xetex', suse: 'texlive-xetex' },
  lualatex: { fedora: 'texlive-luatex', debian: 'texlive-luatex', arch: 'texlive-luatex', suse: 'texlive-luatex' },
  pdflatex: { fedora: 'texlive-pdftex', debian: 'texlive-latex-base', arch: 'texlive-basic', suse: 'texlive-pdftex' },
  bibtex: { fedora: 'texlive-bibtex', debian: 'texlive-binaries', arch: 'texlive-basic', suse: 'texlive-bibtex' },
  biber: { fedora: 'biber', debian: 'biber', arch: 'biber', suse: 'biber' }
}

const PACKAGE_MANAGER = { fedora: 'sudo dnf install', debian: 'sudo apt install', arch: 'sudo pacman -S', suse: 'sudo zypper install' }

function toolInstall(system, tool) {
  const pkg = ENGINE_PACKAGES[tool]?.[system.family]
  if (pkg) return [`${PACKAGE_MANAGER[system.family]} ${pkg}`]
  if (system.family === 'macos') return [`sudo tlmgr install ${tool}`, 'MacTeX includes it; if it is missing, reinstall MacTeX']
  if (system.family === 'windows') return [`In the MiKTeX Console, install the ${tool} package (or run: miktex packages install ${tool})`]
  return [`tlmgr install ${tool}`]
}

/** How to install the LaTeX package that provides `file` (such as enumitem.sty). */
function packageInstall(system, file) {
  const base = file.replace(/\.[^.]+$/, '')
  switch (system.family) {
    case 'fedora':
      return [`sudo dnf install 'tex(${file})'`]
    case 'suse':
      return [`sudo zypper install 'tex(${file})'`]
    case 'debian':
      return [`apt-file search ${file}   # names the texlive-* package that has it, then: sudo apt install <that package>`, 'most packages are in: sudo apt install texlive-latex-extra']
    case 'arch':
      return [`pacman -F ${file}   # names the texlive-* package that has it, then: sudo pacman -S <that package>`]
    case 'macos':
      return [`sudo tlmgr install ${base}`]
    case 'windows':
      return [`MiKTeX installs missing packages on first use when "Install missing packages" is on in the MiKTeX Console; or run: miktex packages install ${base}`]
    default:
      return [`tlmgr install ${base}`]
  }
}

const PACKAGE_FILE = /\.(sty|cls|def|cfg|fd|clo|ldf|bbx|cbx|lbx|tfm|enc|map|pfb)$/i

/**
 * Requirements a build revealed. `steps` are the tools that ran (or were missing), `log` the
 * TeX log, `missingEngine` the engine that could not be found at all.
 */
export async function findRequirements({ log, steps, missingEngine, tools, engine, shellEscape }) {
  const system = await detectSystem()
  const out = []
  const seen = new Set()
  const add = (requirement) => {
    if (seen.has(requirement.key)) return
    seen.add(requirement.key)
    out.push({ ...requirement, system: system.name })
  }

  if (missingEngine) {
    const anyEngine = tools.pdflatex || tools.xelatex || tools.lualatex
    if (!anyEngine) {
      add({
        key: 'tex',
        title: 'TeX is not installed',
        detail: 'The plugin compiles with the TeX installation on this computer, and none was found on Orca’s PATH or in the usual install folders. If TeX is installed somewhere else, set “Extra TeX bin folder” in the plugin settings.',
        install: TEX_INSTALL[system.family] ?? TEX_INSTALL.linux
      })
    } else {
      const why = engine === 'xelatex' || engine === 'lualatex' ? ` This document needs ${engine} (a “% !TEX program” comment or a package such as fontspec asks for it); you can also pick another engine in the plugin settings.` : ''
      add({ key: `engine:${missingEngine}`, title: `${missingEngine} is not installed`, detail: `TeX is installed, but not ${missingEngine}.${why}`, install: toolInstall(system, missingEngine) })
    }
  }

  for (const step of steps) {
    if (step.missing) {
      add({
        key: `tool:${step.tool}`,
        title: `${step.tool} is not installed`,
        detail: step.tool === 'biber' ? 'This document uses biblatex, whose bibliography is built by Biber.' : 'This document has a bibliography (\\bibliography), which BibTeX builds.',
        install: toolInstall(system, step.tool)
      })
    }
  }

  // LaTeX's own message, and the graphics drivers' ("Package pdftex.def Error: File `x.png' not found").
  for (const match of log.matchAll(/(?:LaTeX|Package [\w.-]+) Error: File `([^']+)' not found/g)) {
    const file = match[1]
    if (PACKAGE_FILE.test(file)) {
      add({ key: `package:${file}`, title: `LaTeX package file ${file} is not installed`, detail: `The document loads ${file}, which is not in this TeX installation.`, install: packageInstall(system, file) })
    } else {
      add({ key: `file:${file}`, title: `${file} was not found`, detail: 'The document includes this file (\\input, \\include or \\includegraphics) but it is not in the project. Check the name and path, relative to the main .tex file.', install: [] })
    }
  }

  // Older fontspec: 'The font "X" cannot be found'. Current XeTeX/LuaTeX: 'Font ...="X" ... not loadable'.
  const fonts = [
    ...[...log.matchAll(/fontspec Error: The font "([^"]+)" cannot be\s*found/g)].map((m) => m[1]),
    ...[...log.matchAll(/^.*Font [^\n]*?="([^":\n]+)[^"\n]*"[^\n]*not loadable: Metric \(TFM\) file or installed font not found/gm)].map((m) => m[1])
  ]
  for (const font of fonts) {
    add({
      key: `font:${font}`,
      title: `Font “${font}” is not installed`,
      detail: 'The document asks fontspec for a system font that this computer does not have.',
      install: system.family === 'macos' ? ['Install the font with Font Book'] : system.family === 'windows' ? ['Install the font (right-click the font file, Install)'] : [`fc-list | grep -i "${font}"   # empty means it is missing; install the font, then: fc-cache -f`]
    })
  }

  if (/must invoke LaTeX with the\s*-shell-escape flag/i.test(log) && !shellEscape) {
    add({ key: 'shell-escape', title: 'This document needs shell escape', detail: 'A package such as minted runs a program while compiling. Turn on “Allow shell escape” in the plugin settings, for documents you trust.', install: [] })
  }
  if (/You must have [`']pygmentize['`] installed|pygmentize: (command )?not found/i.test(log)) {
    add({
      key: 'pygments',
      title: 'Pygments is not installed',
      detail: 'The minted package highlights code with Pygments (the pygmentize command).',
      install: system.family === 'fedora' ? ['sudo dnf install python3-pygments'] : system.family === 'debian' ? ['sudo apt install python3-pygments'] : system.family === 'arch' ? ['sudo pacman -S python-pygments'] : ['pip install Pygments']
    })
  }
  return out
}
