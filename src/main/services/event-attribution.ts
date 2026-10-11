import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// event-attribution.ts — who an event or notification really belongs to
// (TRD §3.17, SEC-H2, SEC-H3). A sandbox agent writes into its own events
// directory and chooses every byte it puts there, so neither the workspace
// named inside a line nor the session id it claims can be taken at face value.
// ---------------------------------------------------------------------------

export type EventSource = 'host' | 'sandbox'

const WORKSPACE_DIR_RE = /^[a-zA-Z0-9_-]+$/

/**
 * SEC-H2: the workspace an event file belongs to, taken from where the file
 * lives (`<eventsRoot>/<workspace>/<file>`), never from the payload. `null`
 * for anything else — a legacy flat file directly under the root, a file
 * nested deeper, or a path outside the root — so the caller decides whether
 * a legacy file may fall back to the payload.
 */
export function workspaceFromEventPath(eventsRoot: string, filePath: string): string | null {
  const relative = path.relative(eventsRoot, filePath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const parts = relative.split(path.sep)
  if (parts.length !== 2) return null
  const [workspace] = parts
  return WORKSPACE_DIR_RE.test(workspace) ? workspace : null
}

/**
 * D23: the workspace a container-written event file belongs to, from its location alone:
 * `<stateRoot>/<slug>/events/<name>.jsonl`. `null` for anything else (a deeper path, another directory in the slug's
 * state, a non-`.jsonl` name, a path outside the root), so the second watcher root accepts nothing but event files.
 */
export function sandboxEventSlug(sandboxStateRoot: string, filePath: string): string | null {
  const relative = path.relative(sandboxStateRoot, filePath)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null
  const parts = relative.split(path.sep)
  if (parts.length !== 3) return null
  const [slug, dir, name] = parts
  if (dir !== 'events' || !WORKSPACE_DIR_RE.test(slug) || !name.endsWith('.jsonl') || name === '.jsonl') return null
  return slug
}

/**
 * D23: attributes one line of a container-written file. The workspace is the slug in the path; a line claiming a
 * different one is dropped, exactly as for the host root.
 */
export function attributeSandboxEventWorkspace(sandboxStateRoot: string, filePath: string, claimedWorkspace: string): EventAttribution {
  const fromPath = sandboxEventSlug(sandboxStateRoot, filePath)
  if (fromPath === null) return { ok: false, reason: 'bad-location' }
  return fromPath === claimedWorkspace ? { ok: true, workspace: fromPath } : { ok: false, reason: 'workspace-mismatch' }
}

/** `*.jsonl` regular files in `<stateRoot>/<slug>/events/` for every slug (no symlinks), for the initial ingestion. */
export function listSandboxEventFiles(sandboxStateRoot: string): string[] {
  const files: string[] = []
  let slugs: string[]
  try {
    slugs = fs.readdirSync(sandboxStateRoot)
  } catch {
    return files
  }
  for (const slug of slugs) {
    if (!WORKSPACE_DIR_RE.test(slug)) continue
    const dir = path.join(sandboxStateRoot, slug, 'events')
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const file = path.join(dir, name)
      if (sandboxEventSlug(sandboxStateRoot, file) === null) continue
      try {
        if (fs.lstatSync(file).isFile()) files.push(file)
      } catch {
        // vanished between the listing and the stat
      }
    }
  }
  return files
}

export interface LocationSourceInput {
  /** Which watched root the file came from. */
  root: 'host' | 'sandbox'
  /** The workspace has a sandbox: its worktree exists or its card source is registered. */
  workspaceHasSandbox: boolean
  /** `sandbox.eventsSplitAt` (ISO), or `null` when it was never recorded. */
  eventsSplitAt: string | null
  /** The file's mtime, or `null` when it could not be read. */
  fileMtimeMs: number | null
  /** The legacy card rule (SEC-H3), evaluated lazily because it reads the card caches. */
  legacyClassify: () => EventSource
}

/**
 * D23: provenance by location. The sandbox root is `sandbox` and the host root is `host`, for every agent, and the
 * event's own `agent` field plays no part. The one exception is history written before the cutover: in a workspace
 * that has a sandbox, a host-root file whose mtime is at or before `eventsSplitAt` (or any host-root file when the
 * split was never recorded, or its mtime is unknown) keeps the old card rule, so old sandbox-written events are not
 * relabeled as host. After the cutover a container can no longer write to the host root.
 */
export function sourceByLocation(input: LocationSourceInput): EventSource {
  if (input.root === 'sandbox') return 'sandbox'
  if (!input.workspaceHasSandbox) return 'host'
  const split = input.eventsSplitAt === null ? Number.NaN : Date.parse(input.eventsSplitAt)
  const legacy = Number.isNaN(split) || input.fileMtimeMs === null || input.fileMtimeMs <= split
  return legacy ? input.legacyClassify() : 'host'
}

export interface ClassifySourceInput {
  /** The workspace has a sandbox: its worktree exists or its card source is registered. */
  workspaceHasSandbox: boolean
  sessionId: string | undefined
  /** Ids (short id and session id) of cards discovered from the host source. */
  hostSessionIds: ReadonlySet<string>
  /** Ids of cards discovered from any sandbox source this app session. */
  sandboxSessionIds: ReadonlySet<string>
}

/**
 * SEC-H3: provenance fails closed. In a workspace that has a sandbox, an item
 * is `host` ONLY when its session id belongs to a host card and not to a
 * sandbox card; everything else is `sandbox`. The bias toward Sandbox is
 * deliberate: a host session that has no card yet will occasionally be tagged
 * Sandbox, which is harmless, while the reverse would let sandbox-originated
 * content pass as the user's own. Do not "fix" this by defaulting to host.
 * Workspaces without a sandbox are unchanged (`host`).
 */
export function classifySource(input: ClassifySourceInput): EventSource {
  if (!input.workspaceHasSandbox) return 'host'
  const { sessionId, hostSessionIds, sandboxSessionIds } = input
  if (sessionId && hostSessionIds.has(sessionId) && !sandboxSessionIds.has(sessionId)) return 'host'
  return 'sandbox'
}

export type EventAttribution =
  | { ok: true; workspace: string }
  | { ok: false; reason: 'workspace-mismatch' | 'bad-location' }

/**
 * SEC-H2: decides which workspace one event line is attributed to. A file in
 * `<eventsRoot>/<workspace>/` belongs to that workspace and a line claiming a
 * different one is dropped, so a sandbox agent can't raise activity,
 * notifications or attention for another workspace. A legacy flat file
 * directly under the root has no directory to trust and keeps the payload's
 * workspace. Anything else (nested deeper, outside the root, an odd name) is
 * rejected.
 */
export function attributeEventWorkspace(eventsRoot: string, filePath: string, claimedWorkspace: string): EventAttribution {
  if (path.dirname(path.resolve(filePath)) === path.resolve(eventsRoot)) return { ok: true, workspace: claimedWorkspace }
  const fromDir = workspaceFromEventPath(eventsRoot, filePath)
  if (fromDir === null) return { ok: false, reason: 'bad-location' }
  return fromDir === claimedWorkspace ? { ok: true, workspace: fromDir } : { ok: false, reason: 'workspace-mismatch' }
}

export interface HostCardRef {
  shortId: string
  sessionId?: string
  workspaceDir: string
  sandboxSlug?: string | null
}

/**
 * SEC-H1 minimum: the ids of host cards that belong to one workspace, so a live
 * host session id from workspace B can't vouch for an event in workspace A. A
 * card counts when its directory is the workspace path or inside it. Sandbox
 * cards never count.
 */
export function hostSessionIdsForWorkspace(cards: readonly HostCardRef[], workspacePath: string | undefined): Set<string> {
  const ids = new Set<string>()
  if (!workspacePath) return ids
  const root = path.resolve(workspacePath)
  for (const card of cards) {
    if (card.sandboxSlug) continue
    const rel = path.relative(root, path.resolve(card.workspaceDir))
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    ids.add(card.shortId)
    if (card.sessionId) ids.add(card.sessionId)
  }
  return ids
}
