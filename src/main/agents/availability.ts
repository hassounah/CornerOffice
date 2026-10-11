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

/**
 * `found-in-writable-root:<real path>` means found, but the binary's real path lies inside a directory the sandbox
 * container can write (SEC-M3): an agent in the sandbox could replace what the host then runs. It is a warning, not
 * a refusal; every consumer treats it as found.
 */
export type HostAvailability = 'found' | 'not-found' | `found-in-writable-root:${string}`

/** Directories agents commonly install into that a GUI-launched app's PATH often lacks. */
const EXTRA_DIRS = ['.local/bin', '.npm-global/bin', '.bun/bin', '.local/share/pnpm'] as const
const SYSTEM_EXTRA_DIRS = ['/usr/local/bin', '/opt/homebrew/bin'] as const

const EXECUTE_BITS = 0o111

export interface PathDeps {
  /** The PATH value to scan; the process's own by default. */
  pathEnv?: string
  home?: string
  /** Directories the sandbox container can write. A found binary whose real path is inside one is flagged. */
  writableRoots?: readonly string[]
}

function candidateDirs({ pathEnv = process.env.PATH ?? '', home = os.homedir() }: PathDeps): string[] {
  const dirs = [
    ...pathEnv.split(path.delimiter),
    ...EXTRA_DIRS.map((d) => path.join(home, d)),
    ...SYSTEM_EXTRA_DIRS,
  ]
  return dirs.filter((d) => d !== '' && path.isAbsolute(d))
}

/** The first regular file named `binary` with an execute bit in a PATH dir or fixed extra dir, or `null`. */
function findOnHostPath(binary: string, deps: PathDeps): string | null {
  for (const dir of candidateDirs(deps)) {
    const candidate = path.join(dir, binary)
    try {
      const stat = fs.statSync(candidate)
      if (stat.isFile() && (stat.mode & EXECUTE_BITS) !== 0) return candidate
    } catch {
      // not here: keep scanning
    }
  }
  return null
}

/** True when a regular file named `binary` with an execute bit exists in any PATH dir or fixed extra dir. */
export function isOnHostPath(binary: string, deps: PathDeps = {}): boolean {
  return findOnHostPath(binary, deps) !== null
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

function availabilityOf(binary: string, deps: PathDeps, realRoots: readonly string[]): HostAvailability {
  const found = findOnHostPath(binary, deps)
  if (found === null) return 'not-found'
  const real = realpathOrNull(found)
  const inside = real !== null && realRoots.some((root) => real === root || real.startsWith(root + path.sep))
  return inside ? `found-in-writable-root:${real}` : 'found'
}

export function getHostAvailability(deps: PathDeps = {}): Record<AgentId, HostAvailability> {
  const realRoots = (deps.writableRoots ?? []).map(realpathOrNull).filter((r): r is string => r !== null)
  return Object.fromEntries(AGENT_DESCRIPTORS.map((d) => [d.id, availabilityOf(d.binaryName, deps, realRoots)])) as Record<AgentId, HostAvailability>
}
