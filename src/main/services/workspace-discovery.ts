import log from 'electron-log/main'
import path from 'path'
import { glob, escapePath } from 'tinyglobby'
import type { WorkspaceDiscoveryResult } from '../types/workspace'
import { discoveryRoots, isInSandbox } from './app-home'
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
    const roots = discoveryRoots()

    // Validate and merge user exclusions
    const safeUserExclusions = userExclusions.filter((e) => {
      if (!isValidExclusion(e)) {
        log.warn(`[WorkspaceDiscovery] Rejecting unsafe exclusion pattern: "${e}"`)
        return false
      }
      return true
    })

    const allExclusions = [...DEFAULT_EXCLUSIONS, ...safeUserExclusions]

    // Build ignore patterns for tinyglobby (glob syntax)
    const ignorePatterns = allExclusions.map((exc) => `**/${exc}/**`)

    // Explicit SANDBOXES_ROOT exclusion (TRD §3.11), path-anchored rather
    // than a bare-name pattern like the ones above — a `**/sandboxes/**`
    // pattern could also hide an unrelated, legitimately named workspace.
    // tinyglobby matches ignore patterns relative to its cwd, so the pattern
    // is the (always real) sandboxes root relative to each discovery root.
    // Defense in depth on top of the dot:false default (SANDBOXES_ROOT sits
    // under the dot directory ~/.corner-office, so it's already skipped
    // today) — this exclusion still applies if `dot` is ever forced true.
    // Sandbox mode alone skips it (#0038): the discovery root is the worktree,
    // which itself lives under that root.
    const patternsByRoot = new Map<string, string[]>()
    for (const root of roots) {
      const rootPatterns = [...ignorePatterns]
      if (!isInSandbox()) {
        try {
          const { sandboxesRoot } = sandboxPaths(resolveRealHome())
          const rel = path.relative(root, sandboxesRoot)
          if (path.isAbsolute(rel) || rel.startsWith('..')) {
            log.warn(`[WorkspaceDiscovery] Sandboxes root is outside the home directory; not adding an exclusion: ${sandboxesRoot}`)
          } else {
            rootPatterns.push(`${escapePath(rel)}/**`)
          }
        } catch (err) {
          log.warn('[WorkspaceDiscovery] Could not resolve the sandboxes root for exclusion:', err)
        }
      }
      patternsByRoot.set(root, rootPatterns)
    }

    let timedOut = false
    const workspaces: WorkspaceDiscoveryResult[] = []

    try {
      // Run discovery with abort timeout
      const discoveryPromise = Promise.all(roots.map((root) => this._runGlob(root, patternsByRoot.get(root) ?? ignorePatterns, false, isInSandbox()))).then(
        (perRoot) => [...new Set(perRoot.flat())],
      )
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
   * `dot` is false in production; a test can force it true to prove the
   * SANDBOXES_ROOT ignore pattern above excludes it on its own, independent
   * of the dot:false default (§3.11). Results are absolute paths. `includeRoot` (sandbox mode) also
   * matches a `.rix` directly in the root, which the recursive pattern alone never does.
   */
  private async _runGlob(home: string, ignorePatterns: string[], dot = false, includeRoot = false): Promise<string[]> {
    // Search for .rix directories; followSymbolicLinks: false per spec
    return glob(includeRoot ? ['.rix', '**/.rix'] : '**/.rix', {
      cwd: home,
      onlyDirectories: true,
      followSymbolicLinks: false,
      ignore: ignorePatterns,
      absolute: true,
      dot,
      expandDirectories: false,
    })
  }
}
