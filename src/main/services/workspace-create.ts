import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { WORKSPACE_NAME_RE } from '../types/slugs'
import { GitDisabled, gitRunnerSettings } from './git-runner'
import type { GitService, RepoCtx } from './git-runner'
import { bounded, idBase, validatePath, WorkspaceError } from './workspace-registry'
import type { CreateWarning, RegistryEntry, WorkspaceRegistry } from './workspace-registry'

// ---------------------------------------------------------------------------
// workspace-create.ts — "Create new" (#0039, TRD §3.9): a new folder under a chosen parent, as a plain
// folder or as a Rix workspace (`.rix/` scaffold plus `git init -b main`, `.gitignore` and a first commit).
//
// Nothing is ever rolled back or deleted. Once the folder exists the workspace is registered whatever
// happens next; git trouble is reported as fixed warning tokens, never as stderr.
// ---------------------------------------------------------------------------

export type CreateMode = 'plain' | 'rix'

export interface CreateInput {
  parentPath: string
  name: string
  mode: CreateMode
}

export interface CreateResult {
  entry: RegistryEntry
  warnings: CreateWarning[]
}

export interface CreateDeps {
  registry: Pick<WorkspaceRegistry, 'list' | 'addCreated' | 'rename'>
  /** git-runner's hardened `runGit`, injected so tests can count and fail calls. */
  runGit: GitService['runGit']
}

/** Bounds a `commit.gpgsign` pinentry prompt or any other hang. */
export const COMMIT_TIMEOUT_MS = 15_000
const COMMIT_MESSAGE = 'chore: initialize workspace'
const DIR_MODE = 0o755

function memoryMd(docsRoot: string): string {
  return [
    '# Rix Memory',
    '',
    '## Settings',
    `- docs_root: ${docsRoot}`,
    '- next_feature_id: 1',
    '',
    '## Project Context',
    '',
    '## Decisions Log',
    '',
    '## Backlog',
    '',
    '## Learned Conventions',
    '',
  ].join('\n')
}

/** Every file is created with `wx` (never overwrites); directories are 0755 and non-recursive. */
async function writeRixScaffold(target: string): Promise<void> {
  const mkdir = (...parts: string[]) => fs.promises.mkdir(path.join(target, ...parts), { mode: DIR_MODE })
  await mkdir('.rix')
  await fs.promises.writeFile(path.join(target, '.rix', 'memory.md'), memoryMd(path.join(target, 'docs')), { flag: 'wx' })
  await fs.promises.writeFile(path.join(target, '.rix', 'history.md'), '# Shipped Features\n', { flag: 'wx' })
  await mkdir('.rix', 'pipelines')
  await mkdir('docs')
  await mkdir('docs', 'TODO')
  await mkdir('docs', 'IN_PROGRESS')
  await mkdir('docs', 'DONE')
}

/** `runGit` rejects with `GitDisabled`, or with a `reason` when no usable git binary exists. */
function isGitUnavailable(err: unknown): boolean {
  if (err instanceof GitDisabled) return true
  const reason = (err as { reason?: unknown } | null)?.reason
  return reason === 'not-found' || reason === 'inside-workspace'
}

/**
 * The git steps, each gated on the one before (Sec L7). Returns the warnings; never throws.
 * git-runner has no verb allowlist, and its invariant prefix (`core.hooksPath=/dev/null`,
 * `GIT_TERMINAL_PROMPT=0`, ceiling dirs) applies to every call. The commit uses the user's own git identity.
 */
async function initGit(deps: CreateDeps, target: string): Promise<CreateWarning[]> {
  // The kill switch is known up front: no call is made at all.
  if (gitRunnerSettings.executionDisabled) return ['git-unavailable']
  const ctx: RepoCtx = { root: target, workspaceRoots: [...deps.registry.list().map((e) => e.path), target] }

  try {
    await deps.runGit(ctx, ['init'])
  } catch (err) {
    return [isGitUnavailable(err) ? 'git-unavailable' : 'git-init-failed']
  }
  try {
    await deps.runGit(ctx, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  } catch {
    return ['git-init-failed']
  }

  try {
    await fs.promises.writeFile(path.join(target, '.gitignore'), '.rix/\n', { flag: 'wx' })
    await deps.runGit(ctx, ['add', '--', '.gitignore'])
    await deps.runGit(ctx, ['commit', '-m', COMMIT_MESSAGE], { timeoutMs: COMMIT_TIMEOUT_MS })
  } catch (err) {
    log.warn('[WorkspaceCreate] the initial commit did not complete', err instanceof Error ? err.name : 'error')
    return ['git-commit-failed']
  }
  return []
}

export function createWorkspaceCreator(deps: CreateDeps): (input: CreateInput) => Promise<CreateResult> {
  return async ({ parentPath, name, mode }) => {
    // Before any write: the name, then the parent (a parent of $HOME is fine; control characters are not).
    if (typeof name !== 'string' || !WORKSPACE_NAME_RE.test(name)) throw new WorkspaceError('WORKSPACE_NAME_INVALID')
    const parent = await validatePath(parentPath, { allowUnsafeRoot: true })

    // Non-recursive: an existing folder (or a symlink of that name) is `WORKSPACE_EXISTS`, and nothing is touched.
    const target = path.join(parent.real, name)
    try {
      await bounded(fs.promises.mkdir(target, { mode: DIR_MODE }))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new WorkspaceError('WORKSPACE_EXISTS')
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new WorkspaceError('WORKSPACE_PATH_NOT_FOUND')
      throw err
    }

    // The full candidate validation on the new folder; a refusal leaves the (empty) folder in place.
    const validated = await validatePath(target)

    const warnings: CreateWarning[] = []
    if (mode === 'rix') {
      await writeRixScaffold(validated.real)
      warnings.push(...(await initGit(deps, validated.real)))
    }

    // "My App" gets the id `MyApp`: keep what the user typed as the display name (UX H5).
    const entry = await deps.registry.addCreated(validated.real, { displayName: name === idBase(validated.selected) ? null : name })
    if (entry.displayName === null && entry.id !== name) {
      // A collision suffix (`api-2`) also hides the typed name.
      return { entry: await deps.registry.rename(entry.id, name), warnings }
    }
    return { entry, warnings }
  }
}
