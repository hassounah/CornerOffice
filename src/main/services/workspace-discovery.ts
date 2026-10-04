import log from 'electron-log/main'
import path from 'path'
import os from 'os'
import fg from 'fast-glob'
import type { WorkspaceDiscoveryResult } from '../types/workspace'
import { resolveRealHome, sandboxPaths } from './sandbox-paths'

const DEFAULT_EXCLUSIONS = [
  'node_modules',
  '.cache',
  '.local/share',
  'snap',
  '.npm',
  '.nvm',
  '.git',
  '.vscode',
  '.idea',
  '__pycache__',
  '.tox',
  '.venv',
  '.cargo',
  '.rustup',
  '.go',
  '.gradle',
  '.m2',
]

// Characters that make an exclusion pattern dangerous
const FORBIDDEN_CHARS_REGEX = /[/\\;|&$`(){}*?]/

/**
 * Validates a user-supplied exclusion entry.
 * Returns true if safe (simple directory name only), false if it contains
 * path separators or shell metacharacters.
 */
function isValidExclusion(entry: string): boolean {
  return !FORBIDDEN_CHARS_REGEX.test(entry)
}

export interface DiscoveryOptions {
  userExclusions?: string[]
  timeoutMs?: number
}

export interface DiscoveryResult {
  workspaces: WorkspaceDiscoveryResult[]
  timedOut: boolean
}

export class WorkspaceDiscoveryService {
  async discover(options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
    const { userExclusions = [], timeoutMs = 5000 } = options
    const home = os.homedir()

    // Validate and merge user exclusions
    const safeUserExclusions = userExclusions.filter((e) => {
      if (!isValidExclusion(e)) {
        log.warn(`[WorkspaceDiscovery] Rejecting unsafe exclusion pattern: "${e}"`)
        return false
      }
      return true
    })

    const allExclusions = [...DEFAULT_EXCLUSIONS, ...safeUserExclusions]

    // Build ignore patterns for fast-glob (glob syntax)
    const ignorePatterns = allExclusions.map((exc) => `**/${exc}/**`)

    // Explicit SANDBOXES_ROOT exclusion (TRD §3.11), path-anchored rather
    // than a bare-name pattern like the ones above — a `**/sandboxes/**`
    // pattern could also hide an unrelated, legitimately named workspace.
    // Defense in depth on top of fast-glob's dot:false default (SANDBOXES_ROOT
    // sits under the dot directory ~/.corner-office, so it's already skipped
    // today) — this exclusion still applies if `dot` is ever forced true.
    try {
      const { sandboxesRoot } = sandboxPaths(resolveRealHome())
      ignorePatterns.push(`${fg.escapePath(sandboxesRoot)}/**`)
    } catch (err) {
      log.warn('[WorkspaceDiscovery] Could not resolve the sandboxes root for exclusion:', err)
    }

    let timedOut = false
    const workspaces: WorkspaceDiscoveryResult[] = []

    try {
      // Run discovery with abort timeout
      const discoveryPromise = this._runGlob(home, ignorePatterns)
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => {
          timedOut = true
          resolve(null)
        }, timeoutMs)
      )

      const result = await Promise.race([discoveryPromise, timeoutPromise])

      if (result !== null) {
        for (const rixDir of result) {
          const workspacePath = path.dirname(rixDir)
          const slug = path.basename(workspacePath)
          workspaces.push({ path: workspacePath, slug })
        }
      }

      if (timedOut) {
        log.warn('[WorkspaceDiscovery] Discovery timed out; returning partial results')
      }
    } catch (err) {
      log.error('[WorkspaceDiscovery] Discovery error:', err)
    }

    return { workspaces, timedOut }
  }

  /**
   * `dot` defaults to fast-glob's own default (false) in production; a test
   * can force it true to prove the SANDBOXES_ROOT ignore pattern above
   * excludes it on its own, independent of the dot:false default (§3.11).
   */
  private async _runGlob(home: string, ignorePatterns: string[], dot = false): Promise<string[]> {
    // Search for .rix directories; followSymbolicLinks: false per spec
    const pattern = `${fg.escapePath(home)}/**/.rix`
    return fg(pattern, {
      onlyDirectories: true,
      followSymbolicLinks: false,
      ignore: ignorePatterns,
      suppressErrors: true,
      absolute: true,
      dot,
    })
  }
}
