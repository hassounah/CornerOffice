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
