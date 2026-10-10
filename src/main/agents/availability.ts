import fs from 'fs'
import os from 'os'
import path from 'path'
import { AGENT_DESCRIPTORS } from './descriptors'
import type { AgentId } from './descriptors'

// ---------------------------------------------------------------------------
// agents/availability.ts — is an agent's binary on the host PATH? (#0037 C3,
// TRD §4.7, D19). Advisory only: the chooser warns on a miss but never swaps the
// agent or blocks a start, because the shell a session runs through (`$SHELL
// --login -i`) may find the binary where this process's PATH does not. No cache,
// no nvm glob, no symlink handling beyond what `statSync` follows.
// ---------------------------------------------------------------------------

export type HostAvailability = 'found' | 'not-found'

/** Directories agents commonly install into that a GUI-launched app's PATH often lacks. */
const EXTRA_DIRS = ['.local/bin', '.npm-global/bin', '.bun/bin', '.local/share/pnpm'] as const
const SYSTEM_EXTRA_DIRS = ['/usr/local/bin', '/opt/homebrew/bin'] as const

const EXECUTE_BITS = 0o111

export interface PathDeps {
  /** The PATH value to scan; the process's own by default. */
  pathEnv?: string
  home?: string
}

function candidateDirs({ pathEnv = process.env.PATH ?? '', home = os.homedir() }: PathDeps): string[] {
  const dirs = [
    ...pathEnv.split(path.delimiter),
    ...EXTRA_DIRS.map((d) => path.join(home, d)),
    ...SYSTEM_EXTRA_DIRS,
  ]
  return dirs.filter((d) => d !== '' && path.isAbsolute(d))
}

/** True when a regular file named `binary` with an execute bit exists in any PATH dir or fixed extra dir. */
export function isOnHostPath(binary: string, deps: PathDeps = {}): boolean {
  return candidateDirs(deps).some((dir) => {
    try {
      const stat = fs.statSync(path.join(dir, binary))
      return stat.isFile() && (stat.mode & EXECUTE_BITS) !== 0
    } catch {
      return false
    }
  })
}

export function getHostAvailability(deps: PathDeps = {}): Record<AgentId, HostAvailability> {
  return Object.fromEntries(
    AGENT_DESCRIPTORS.map((d) => [d.id, isOnHostPath(d.binaryName, deps) ? 'found' : 'not-found']),
  ) as Record<AgentId, HostAvailability>
}
