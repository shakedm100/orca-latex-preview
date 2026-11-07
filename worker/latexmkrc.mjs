// latexmk reads `latexmkrc` / `.latexmkrc` from the folder it runs in, and those files are Perl that
// runs with the user's permissions. Builds start on their own as you type, so opening a .tex file
// from a cloned repository would run that repository's rc file. Unless the user trusts project rc
// files, a build in a folder that has one skips every rc file (-norc) and reads back only the
// user's own and the system's (-r), which the user or an administrator wrote.
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJECT_RC = ['latexmkrc', '.latexmkrc']
const SYSTEM_RC = [
  '/opt/local/share/latexmk/LatexMk',
  '/usr/local/share/latexmk/LatexMk',
  '/usr/local/lib/latexmk/LatexMk',
  '/etc/LatexMk',
  '/etc/latexmk/LatexMk',
  'C:\\latexmk\\LatexMk'
]

/** The rc files latexmk would read for this user and machine, in latexmk's order. */
export function trustedRcFiles({ env = process.env, home = os.homedir(), exists = existsSync } = {}) {
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
  const user = [path.join(config, 'latexmk', 'latexmkrc'), path.join(home, '.latexmkrc')]
  return [...SYSTEM_RC, ...user].filter((file) => exists(file))
}

/** Extra latexmk arguments for a build in `dir`; empty when nothing changes. */
export function latexmkRcArgs({ dir, trustProjectRc, env, home, exists = existsSync }) {
  if (trustProjectRc) return []
  if (!PROJECT_RC.some((name) => exists(path.join(dir, name)))) return []
  return ['-norc', ...trustedRcFiles({ env, home, exists }).flatMap((file) => ['-r', file])]
}
