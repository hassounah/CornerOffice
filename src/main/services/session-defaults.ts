import log from 'electron-log/main'
import { AGENT_DESCRIPTORS, LEGACY_AGENT_ID } from '../agents/descriptors'
import type { SessionChoice } from '../types/config'
import type { JsonStore } from './json-store'
import type { SessionDefaultsFile } from './stores'

// ---------------------------------------------------------------------------
// session-defaults.ts — the remembered Start Session options (#0037 TRD §5.5,
// D16). Main records only values it validated itself, never a renderer-supplied
// SessionChoice (SEC-L7), and skips the fields the chooser's resolution
// replaced without the user touching them (UX-C1).
// ---------------------------------------------------------------------------

export type SessionLocationKind = 'host' | 'sandbox'
export type FallbackField = 'agentId' | 'location' | 'permissionMode'
export type DefaultsSource = 'workspace' | 'last' | 'builtin'

/** What a successful start actually used. `networkMode` is only meaningful for the sandbox. */
export interface SessionStart {
  workspaceSlug: string
  agentId: string
  location: SessionLocationKind
  permissionMode: string
  networkMode?: 'allowlist' | 'open'
  fallbackFields: readonly FallbackField[]
}

export interface SessionDefaultsView {
  /** `null` when nothing is remembered; the renderer then resolves from the built-in choice. */
  choice: SessionChoice | null
  source: DefaultsSource
}

/** The built-in choice, used as the base when a scope has nothing remembered yet. */
function builtinBase(): SessionChoice {
  const d = AGENT_DESCRIPTORS.find((x) => x.id === LEGACY_AGENT_ID) ?? AGENT_DESCRIPTORS[0]
  return {
    agentId: d.id,
    location: 'host',
    hostPermissionMode: d.permissionModes.host[0]?.mode ?? 'default',
    sandboxPermissionMode: d.permissionModes.sandbox[0]?.mode ?? 'skip',
    networkMode: 'allowlist',
  }
}

/** The remembered choice for `workspaceSlug` (a registry id), else the last start, else nothing. Id lookups use `Object.hasOwn`. */
export function getSessionDefaults(file: SessionDefaultsFile, workspaceSlug: string): SessionDefaultsView {
  if (Object.hasOwn(file.workspaces, workspaceSlug)) return { choice: file.workspaces[workspaceSlug], source: 'workspace' }
  if (file.last) return { choice: file.last, source: 'last' }
  return { choice: null, source: 'builtin' }
}

/** Is `mode` one of `agentId`'s modes for `location`? Also false for an unknown agent. */
function isValidMode(agentId: string, location: SessionLocationKind, mode: string): boolean {
  const d = AGENT_DESCRIPTORS.find((x) => x.id === agentId)
  return d !== undefined && d.permissionModes[location].some((m) => m.mode === mode)
}

/** The choice to store for one scope: `base` with every validated, non-fallback start value applied. */
function mergeStart(base: SessionChoice, start: SessionStart): SessionChoice {
  const skip = new Set<FallbackField>(start.fallbackFields)
  const agentKnown = AGENT_DESCRIPTORS.some((d) => d.id === start.agentId)
  const next: SessionChoice = { ...base }

  if (!skip.has('agentId') && agentKnown) next.agentId = start.agentId
  if (!skip.has('location')) next.location = start.location

  // The mode is validated against the agent that was actually started.
  if (!skip.has('permissionMode') && agentKnown && isValidMode(start.agentId, start.location, start.permissionMode)) {
    if (start.location === 'host') next.hostPermissionMode = start.permissionMode
    else next.sandboxPermissionMode = start.permissionMode
  }
  if (start.location === 'sandbox' && start.networkMode) next.networkMode = start.networkMode
  return next
}

/**
 * Pure: the defaults after a successful start. Updates the workspace entry and
 * `last`, and drops entries for slugs that aren't known workspaces.
 */
export function applySessionStart(
  current: SessionDefaultsFile,
  start: SessionStart,
  knownIds: ReadonlySet<string>,
): SessionDefaultsFile {
  const workspaces: Record<string, SessionChoice> = {}
  for (const [id, choice] of Object.entries(current.workspaces)) {
    if (knownIds.has(id)) workspaces[id] = choice
  }
  if (knownIds.has(start.workspaceSlug)) {
    const base = Object.hasOwn(workspaces, start.workspaceSlug) ? workspaces[start.workspaceSlug] : (current.last ?? builtinBase())
    workspaces[start.workspaceSlug] = mergeStart(base, start)
  }
  return { version: 1, last: mergeStart(current.last ?? builtinBase(), start), workspaces }
}

/**
 * Fire-and-forget: records `start` through the session-defaults store's serialized `mutate`.
 * `getKnownIds` is the registry's ids. A failure is logged and never affects the session that already started.
 */
export function recordSessionStart(
  store: Pick<JsonStore<SessionDefaultsFile>, 'mutate'>,
  getKnownIds: () => ReadonlySet<string>,
  start: SessionStart,
): void {
  store
    .mutate((file) => applySessionStart(file, start, getKnownIds()))
    .catch((err: unknown) => {
      log.warn(`[session-defaults] Could not record the session start: ${err instanceof Error ? err.message : String(err)}`)
    })
}
