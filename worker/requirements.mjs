// What a build needs that the plugin cannot ship: TeX itself, bibliography tools, LaTeX packages,
// fonts, Pygments. Each requirement says what is missing, why, and how to install it on this
// computer, so a person (or an agent reading `orca plugin logs`) can act on it directly.
//
// How to install depends on two things: the system (Windows, macOS, which Linux) and where TeX
// came from. MiKTeX and TeX Live from tug.org (TinyTeX, MacTeX) add packages with their own
// managers on any system; only a Linux distribution's own TeX uses the system package manager.
import { access, readFile } from 'node:fs/promises'

let systemPromise = null

/** The OS, the Linux distribution family, and whether Orca runs sandboxed (Flatpak, Snap). */
export function detectSystem() {
  systemPromise ??= (async () => {
    const sandbox = process.env.FLATPAK_ID || (await exists('/.flatpak-info')) ? 'flatpak' : process.env.SNAP ? 'snap' : null
    if (process.platform === 'darwin') return { os: 'macos', family: 'macos', name: 'macOS', sandbox }
    if (process.platform === 'win32') return { os: 'windows', family: 'windows', name: 'Windows', sandbox }
    let release = ''
    for (const file of ['/etc/os-release', '/usr/lib/os-release', '/run/host/os-release']) {
      try {
        release = await readFile(file, 'utf8')
        if (release) break
      } catch {
        // Try the next location.
      }
    }
    const field = (key) => (new RegExp(`^${key}="?([^"\\n]*)"?$`, 'm').exec(release)?.[1] ?? '').toLowerCase()
    const ids = `${field('ID')} ${field('ID_LIKE')}`
    const name = new RegExp('^PRETTY_NAME="?([^"\\n]*)"?$', 'm').exec(release)?.[1] ?? 'Linux'
    // Image-based systems install with rpm-ostree, not dnf.
    const atomic = (await exists('/run/ostree-booted')) || /silverblue|kinoite|sericea|onyx|atomic|bazzite|bluefin|aurora/.test(field('VARIANT_ID'))
    const families = [
      ['nixos', /\bnixos\b/],
      ['fedora', /\b(fedora|rhel|centos|rocky|almalinux|ol|amzn)\b/],
      ['debian', /\b(debian|ubuntu|linuxmint|pop|elementary|zorin|kali|raspbian|neon|deepin)\b/],
      ['arch', /\b(arch|manjaro|endeavouros|garuda|artix|cachyos|steamos)\b/],
      ['suse', /\b(suse|opensuse|opensuse-leap|opensuse-tumbleweed|sles)\b/],
      ['gentoo', /\b(gentoo|funtoo|calculate)\b/],
      ['alpine', /\balpine\b/],
      ['void', /\bvoid\b/],
      ['solus', /\bsolus\b/]
    ]
    for (const [family, pattern] of families) {
      if (pattern.test(ids)) return { os: 'linux', family: family === 'fedora' && atomic ? 'fedora-atomic' : family, name, sandbox }
    }
    return { os: 'linux', family: 'linux', name, sandbox }
  })()
  return systemPromise
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ installing TeX itself

const TINYTEX_UNIX = 'wget -qO- "https://yihui.org/tinytex/install-bin-unix.sh" | sh'

/** Ways to get a TeX distribution, best first, for each system. */
const TEX_INSTALL = {
  fedora: ['sudo dnf install texlive-scheme-medium texlive-latexmk'],
  'fedora-atomic': ['rpm-ostree install texlive-scheme-medium texlive-latexmk   # then restart', `or, without changing the system image: ${TINYTEX_UNIX}`],
  debian: ['sudo apt install texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended latexmk'],
  arch: ['sudo pacman -S texlive-basic texlive-latex texlive-latexrecommended texlive-latexextra texlive-fontsrecommended texlive-binextra'],
  suse: ['sudo zypper install texlive-scheme-medium texlive-latexmk'],
  gentoo: ['sudo emerge --ask app-text/texlive dev-tex/latexmk'],
  alpine: ['sudo apk add texlive texmf-dist-latexrecommended texmf-dist-latexextra texmf-dist-fontsrecommended'],
  void: ['sudo xbps-install texlive texlive-latexextra'],
  solus: ['sudo eopkg install texlive'],
  nixos: ['nix-env -iA nixos.texliveMedium   # or add texliveMedium to environment.systemPackages'],
  linux: [`${TINYTEX_UNIX}   # TinyTeX, any Linux, no root`, 'or TeX Live from https://tug.org/texlive/'],
  macos: ['brew install --cask mactex-no-gui', 'or download MacTeX from https://tug.org/mactex/ (BasicTeX, smaller: brew install --cask basictex)'],
  windows: ['winget install MiKTeX.MiKTeX', 'or download MiKTeX from https://miktex.org/download, or TeX Live from https://tug.org/texlive/windows.html']
}

// System package names for one tool, where a distribution splits TeX into parts.
const SYSTEM_TOOL_PACKAGES = {
  xelatex: { fedora: 'texlive-xetex', 'fedora-atomic': 'texlive-xetex', debian: 'texlive-xetex', arch: 'texlive-xetex', suse: 'texlive-xetex', alpine: 'texlive-xetex', void: 'texlive-xetex' },
  lualatex: { fedora: 'texlive-luatex', 'fedora-atomic': 'texlive-luatex', debian: 'texlive-luatex', arch: 'texlive-luatex', suse: 'texlive-luatex', alpine: 'texlive-luatex', void: 'texlive-luatex' },
  pdflatex: { fedora: 'texlive-pdftex', 'fedora-atomic': 'texlive-pdftex', debian: 'texlive-latex-base', arch: 'texlive-basic', suse: 'texlive-pdftex', alpine: 'texlive', gentoo: 'app-text/texlive', void: 'texlive' },
  bibtex: { fedora: 'texlive-bibtex', 'fedora-atomic': 'texlive-bibtex', debian: 'texlive-binaries', arch: 'texlive-basic', suse: 'texlive-bibtex', alpine: 'texlive', gentoo: 'app-text/texlive', void: 'texlive' },
  biber: { fedora: 'biber', 'fedora-atomic': 'biber', debian: 'biber', arch: 'biber', suse: 'biber', alpine: 'biber', gentoo: 'dev-tex/biber', void: 'biber', solus: 'biber' },
  latexmk: { fedora: 'texlive-latexmk', 'fedora-atomic': 'texlive-latexmk', debian: 'latexmk', arch: 'texlive-binextra', suse: 'texlive-latexmk', alpine: 'texmf-dist-binextra', gentoo: 'dev-tex/latexmk', void: 'latexmk' }
}

const SYSTEM_INSTALL = {
  fedora: 'sudo dnf install',
  'fedora-atomic': 'rpm-ostree install',
  debian: 'sudo apt install',
  arch: 'sudo pacman -S',
  suse: 'sudo zypper install',
  gentoo: 'sudo emerge --ask',
  alpine: 'sudo apk add',
  void: 'sudo xbps-install',
  solus: 'sudo eopkg install'
}

/** `tlmgr` with or without sudo, for a tug.org tree (TinyTeX, MacTeX, TeX Live). */
function tlmgr(tex, system) {
  if (system.os === 'windows') return 'tlmgr' // from a Command Prompt; "Run as administrator" if TeX Live is installed for all users
  return tex.userWritable ? 'tlmgr' : 'sudo tlmgr'
}

// tlmgr names: the TeX Live package that holds each engine or tool.
const TLMGR_TOOL = { xelatex: 'xetex', lualatex: 'luatex', pdflatex: 'pdftex', bibtex: 'bibtex', biber: 'biber', latexmk: 'latexmk' }

/** How to add one engine or tool to the TeX that is installed. */
function toolInstall(system, tex, tool) {
  switch (tex.kind) {
    case 'miktex':
      return tool === 'biber' || tool === 'latexmk'
        ? [`miktex packages install ${tool}`, `or in the MiKTeX Console: Packages, search "${tool}", install`]
        : ['MiKTeX includes it: run the MiKTeX Console, Updates, Check for updates; or reinstall MiKTeX']
    case 'tinytex':
    case 'mactex':
    case 'texlive':
      return [`${tlmgr(tex, system)} install ${TLMGR_TOOL[tool] ?? tool}`]
    case 'nix':
      return ['Use a larger TeX Live set, such as texliveFull or texliveMedium, or texlive.withPackages with the package added']
    default: {
      // Gentoo builds XeTeX and LuaTeX into app-text/texlive through USE flags.
      if (system.family === 'gentoo' && (tool === 'xelatex' || tool === 'lualatex')) {
        const flag = tool === 'xelatex' ? 'xetex' : 'luatex'
        return [`echo "app-text/texlive ${flag}" | sudo tee -a /etc/portage/package.use/texlive && sudo emerge --ask --changed-use app-text/texlive`]
      }
      // Homebrew's texlive formula is the whole of TeX Live, without a working tlmgr.
      if (system.os === 'macos') return ['brew upgrade texlive   # Homebrew’s TeX Live includes it; or install MacTeX: brew install --cask mactex-no-gui']
      const pkg = SYSTEM_TOOL_PACKAGES[tool]?.[system.family]
      if (pkg && SYSTEM_INSTALL[system.family]) return [`${SYSTEM_INSTALL[system.family]} ${pkg}`]
      return [`Install ${tool} with your system's package manager (its package is usually named texlive-${TLMGR_TOOL[tool] ?? tool} or ${tool})`]
    }
  }
}

// ------------------------------------------------------------------ LaTeX packages

/**
 * How to add the package that provides `file` (such as enumitem.sty). The file's base name is
 * the package name for most packages; the search commands find the rest (tikz.sty is in pgf).
 */
function packageInstall(system, tex, file) {
  const base = file.replace(/\.[^.]+$/, '')
  switch (tex.kind) {
    case 'miktex':
      return [
        'MiKTeX installs missing packages itself when "Always install missing packages on-the-fly" is on (MiKTeX Console, Settings)',
        `or: miktex packages install ${base}   # if no package has that name, search for "${file}" in the MiKTeX Console`
      ]
    case 'tinytex':
      return [`tlmgr install ${base}   # if that name is unknown: tlmgr search --global --file "/${file}"`]
    case 'mactex':
    case 'texlive':
      return [`${tlmgr(tex, system)} install ${base}   # if that name is unknown: tlmgr search --global --file "/${file}"`]
    case 'nix':
      return [`Add the package to your TeX Live set: texlive.withPackages (ps: [ ps.${base} ])   # or use texliveFull`]
    default:
      break
  }
  switch (system.family) {
    case 'fedora':
      return [`sudo dnf install 'tex(${file})'`]
    case 'fedora-atomic':
      return [`rpm-ostree install 'tex(${file})'   # then restart`]
    case 'suse':
      return [`sudo zypper install 'tex(${file})'`]
    case 'debian':
      return [
        `apt-file search /${file}   # names the texlive-* package that has it, then: sudo apt install <that package>`,
        'sudo apt install apt-file && sudo apt-file update   # once, if apt-file is not installed',
        'or: sudo apt install texlive-latex-extra   # holds most LaTeX packages'
      ]
    case 'arch':
      return [
        `pacman -F ${file}   # names the texlive-* package that has it, then: sudo pacman -S <that package>`,
        'sudo pacman -Fy   # once, to download the file lists pacman -F searches',
        'or: sudo pacman -S texlive-latexextra   # holds most LaTeX packages'
      ]
    case 'gentoo':
      return [`e-file ${file}   # (from app-portage/pfl) names the package, then: sudo emerge --ask <that package>`, 'or: sudo emerge --ask dev-texlive/texlive-latexextra   # holds most LaTeX packages']
    case 'alpine':
      return ['sudo apk add texmf-dist-latexextra   # most LaTeX packages; texmf-dist-full has every one']
    case 'void':
      return ['sudo xbps-install texlive-latexextra   # most LaTeX packages; texlive-full has every one']
    case 'macos':
      return ['brew upgrade texlive   # Homebrew’s TeX Live has every package; or install MacTeX: brew install --cask mactex-no-gui']
    default:
      return [`Install the LaTeX package that provides ${file} with your system's package manager (often a package named texlive-latexextra), or use tlmgr if your TeX came from tug.org`]
  }
}

// ------------------------------------------------------------------ the requirements

const PACKAGE_FILE = /\.(sty|cls|def|cfg|fd|clo|ldf|bbx|cbx|lbx|tfm|enc|map|pfb|otf|ttf)$/i

/**
 * Requirements a build revealed. `steps` are the tools that ran (or were missing), `log` the
 * TeX log, `missingEngine` the engine that could not be found, `tex` from detectTools.
 */
export async function findRequirements({ log, steps, missingEngine, tools, tex = { kind: 'none' }, engine, shellEscape, system: given }) {
  const system = given ?? (await detectSystem())
  const out = []
  const seen = new Set()
  const add = (requirement) => {
    if (seen.has(requirement.key)) return
    seen.add(requirement.key)
    out.push({ ...requirement, system: system.name })
  }

  if (missingEngine) {
    const anyEngine = tools.pdflatex || tools.xelatex || tools.lualatex
    if (!anyEngine && system.sandbox) {
      add({
        key: 'sandbox',
        title: `Orca runs as a ${system.sandbox === 'flatpak' ? 'Flatpak' : 'Snap'} and cannot see TeX`,
        detail: `A ${system.sandbox === 'flatpak' ? 'Flatpak' : 'Snap'} app sees only its own files, so TeX installed on the system is out of its reach. Install Orca from its .deb, .rpm or AppImage instead, or install TeX in your home folder (TinyTeX) and set “Extra TeX bin folder” in the plugin settings to its bin folder.`,
        install: [`${TINYTEX_UNIX}   # then set "Extra TeX bin folder" to ~/.TinyTeX/bin/x86_64-linux`]
      })
    } else if (!anyEngine) {
      add({
        key: 'tex',
        title: 'TeX is not installed',
        detail: 'The plugin compiles with the TeX installation on this computer, and none was found on Orca’s PATH or in the usual install folders. If TeX is installed somewhere else, set “Extra TeX bin folder” in the plugin settings.',
        install: TEX_INSTALL[system.family] ?? TEX_INSTALL.linux
      })
    } else {
      const why = engine === 'xelatex' || engine === 'lualatex' ? ` This document needs ${engine} (a “% !TEX program” comment or a package such as fontspec asks for it); you can also pick another engine in the plugin settings.` : ''
      add({ key: `engine:${missingEngine}`, title: `${missingEngine} is not installed`, detail: `TeX is installed, but not ${missingEngine}.${why}`, install: toolInstall(system, tex, missingEngine) })
    }
  }

  for (const step of steps) {
    if (step.missing) {
      add({
        key: `tool:${step.tool}`,
        title: `${step.tool} is not installed`,
        detail: step.tool === 'biber' ? 'This document uses biblatex, whose bibliography is built by Biber.' : 'This document has a bibliography (\\bibliography), which BibTeX builds.',
        install: toolInstall(system, tex, step.tool)
      })
    }
  }

  // LaTeX's own message, and the graphics drivers' ("Package pdftex.def Error: File `x.png' not found").
  for (const match of log.matchAll(/(?:LaTeX|Package [\w.-]+) Error: File `([^']+)' not found/g)) {
    const file = match[1]
    if (PACKAGE_FILE.test(file)) {
      add({ key: `package:${file}`, title: `LaTeX package file ${file} is not installed`, detail: `The document loads ${file}, which is not in this TeX installation.`, install: packageInstall(system, tex, file) })
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
      detail: 'The document asks for a system font that this computer does not have.',
      install:
        system.os === 'macos'
          ? ['Install the font with Font Book (double-click the font file), then press Recompile']
          : system.os === 'windows'
            ? ['Install the font (right-click the font file, Install for all users), then restart Orca so TeX sees it']
            : [`fc-list | grep -i "${font}"   # empty means it is missing; put the font file in ~/.local/share/fonts, then: fc-cache -f`]
    })
  }

  if (/must invoke LaTeX with the\s*-shell-escape flag/i.test(log) && !shellEscape) {
    add({ key: 'shell-escape', title: 'This document needs shell escape', detail: 'A package such as minted runs a program while compiling. Turn on “Allow shell escape” in the plugin settings, for documents you trust.', install: [] })
  }
  if (/You must have [`']pygmentize['`] installed|pygmentize: (command )?not found|'pygmentize' is not recognized/i.test(log)) {
    const pygments = {
      fedora: 'sudo dnf install python3-pygments',
      'fedora-atomic': 'rpm-ostree install python3-pygments',
      debian: 'sudo apt install python3-pygments',
      arch: 'sudo pacman -S python-pygments',
      suse: 'sudo zypper install python3-Pygments',
      gentoo: 'sudo emerge --ask dev-python/pygments',
      alpine: 'sudo apk add py3-pygments',
      void: 'sudo xbps-install python3-Pygments',
      nixos: 'nix-env -iA nixos.python3Packages.pygments',
      macos: 'brew install pygments',
      windows: 'py -m pip install Pygments'
    }
    add({ key: 'pygments', title: 'Pygments is not installed', detail: 'The minted package highlights code with Pygments (the pygmentize command).', install: [pygments[system.family] ?? 'python3 -m pip install --user Pygments'] })
  }
  return out
}
