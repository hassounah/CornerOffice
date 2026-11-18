import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { ACTIVITY_CHANNELS, GAMIFICATION_CHANNELS, WORKSPACE_CHANNELS } from '../ipc/channels'
import type { GamificationState } from '../types/gamification'
import type { ActivityFeedItem, HookEvent, StateCache, Workspace } from '../types'
import {
  attributeEventWorkspace,
  attributeSandboxEventWorkspace,
  classifySource,
  hostSessionIdsForWorkspace,
  sandboxEventSlug,
  sourceByLocation,
} from './event-attribution'
import type { EventSource } from './event-attribution'
import type { AppNotification, NotificationTier } from './notification-service'
import { resolveEventWorkspace } from './workspace-registry'
import type { EventOwner, RegistryEntry } from './workspace-registry'

// ---------------------------------------------------------------------------
// event-ingest.ts — turns hook event files into activity feed items, notifications and per-workspace state
// (extracted from index.ts for #0039, TRD §3.6). The new rule: an event is attributed to a REGISTERED
// workspace, or it is unattributed. An unattributed event (`workspace = '?' + key`) reaches the feed and
// the notification history only; it never touches a workspace's unacknowledged counts, status or gamification.
// ---------------------------------------------------------------------------

/** Own-property read of an id-keyed record: an id such as `constructor` must never resolve to a prototype member (Sec M5). */
export function readOwnNumber(record: Readonly<Record<string, number>>, id: string): number {
  return Object.hasOwn(record, id) ? record[id] : 0
}

/** The workspace label of an unattributed event. It can never pass `WorkspaceIdSchema`, so it can never equal an id. */
export const UNATTRIBUTED_PREFIX = '?'

export interface IngestAppState {
  workspaces: Map<string, Workspace>
  activityFeed: ActivityFeedItem[]
  gamificationState: GamificationState
  channelDiscovery: { getSessions(): Parameters<typeof hostSessionIdsForWorkspace>[0] } | null
  sandboxManager: { getSandboxSessionIds(): ReadonlySet<string> } | null
}

export interface EventParserLike {
  parseFromOffset(filePath: string, offset: number): { events: HookEvent[]; newOffset: number }
  generateActivityItem(event: HookEvent, workspaceSlug: string): ActivityFeedItem
}

export interface IngestNotificationService {
  classify(event: HookEvent): NotificationTier
  dispatch(notification: AppNotification): void
}

export interface EventIngestorDeps {
  appState: IngestAppState
  parser: EventParserLike
  notifications: IngestNotificationService
  stateCache: {
    getCache(): StateCache
    updateField<K extends keyof StateCache>(key: K, value: StateCache[K]): void
  }
  /** The event index and the registered ids; read on every call, so a registry change is picked up at once. */
  getEventIndex: () => ReadonlyMap<string, readonly RegistryEntry[]>
  isRegisteredId: (id: string) => boolean
  eventsDir: string
  sandboxStateRoot: string
  sandboxesRoot: string
  /** D23: when containers started writing to their own root. Null = never recorded: every host-root file is legacy. */
  eventsSplitAt: string | null
  eventOffsets: Map<string, number>
  flushEventOffsets: () => void
  isActivityPushSuppressed: () => boolean
  send: (channel: string, payload: unknown) => void
  /** Recompute `ws.status` from the state cache (attention glow). */
  recomputeStatus: (ws: Workspace) => void
  /** The shared gamification recompute (`recomputeGamification`). */
  recomputeGamification: () => GamificationState
}

/** Build the ingest function. `ingestEvents(file)` reads new lines from `file` and routes each one. */
export function createEventIngestor(deps: EventIngestorDeps): (filePath: string) => void {
  const { appState, parser, notifications, stateCache, send } = deps

  const inSandboxRoot = (filePath: string): boolean => sandboxEventSlug(deps.sandboxStateRoot, filePath) !== null

  /** Host cards inside one workspace: their short ids and session ids (SEC-H1, SEC-H3). */
  function hostSessionIds(id: string): Set<string> {
    return hostSessionIdsForWorkspace(appState.channelDiscovery?.getSessions() ?? [], appState.workspaces.get(id)?.path)
  }

  return function ingestEvents(filePath: string): void {
    const offset = deps.eventOffsets.get(filePath) ?? 0
    const { events, newOffset } = parser.parseFromOffset(filePath, offset)
    deps.eventOffsets.set(filePath, newOffset)

    // Provenance is computed once per file and id: both lookups are cheap but the initial ingestion replays every line.
    const hasSandboxCache = new Map<string, boolean>()
    const hostIdsCache = new Map<string, Set<string>>()
    // D23: the root a file lives under decides its source; the event's own `agent` field plays no part.
    const root = inSandboxRoot(filePath) ? 'sandbox' : 'host'
    let fileMtimeMs: number | null = null
    if (root === 'host') {
      try {
        fileMtimeMs = fs.statSync(filePath).mtimeMs
      } catch {
        fileMtimeMs = null
      }
    }
    const sourceFor = (id: string, sessionId: string): EventSource => {
      let hasSandbox = hasSandboxCache.get(id)
      if (hasSandbox === undefined) {
        hasSandbox = fs.existsSync(path.join(deps.sandboxesRoot, id))
        hasSandboxCache.set(id, hasSandbox)
      }
      let hostIds = hostIdsCache.get(id)
      if (hostIds === undefined) {
        hostIds = hostSessionIds(id)
        hostIdsCache.set(id, hostIds)
      }
      const workspaceHasSandbox = hasSandbox
      return sourceByLocation({
        root,
        workspaceHasSandbox,
        eventsSplitAt: deps.eventsSplitAt,
        fileMtimeMs,
        legacyClassify: () =>
          classifySource({
            workspaceHasSandbox,
            sessionId,
            hostSessionIds: hostIds,
            sandboxSessionIds: appState.sandboxManager?.getSandboxSessionIds() ?? new Set<string>(),
          }),
      })
    }

    for (const event of events) {
      // SEC-H2: the workspace comes from where the file lives, not from the line itself.
      const attribution =
        root === 'sandbox'
          ? attributeSandboxEventWorkspace(deps.sandboxStateRoot, filePath, event.workspace)
          : attributeEventWorkspace(deps.eventsDir, filePath, event.workspace)
      if (!attribution.ok) {
        log.warn(`[EventPipeline] Dropped an event line (${attribution.reason}) from ${path.basename(path.dirname(filePath))}`)
        continue
      }

      // Registered, or unattributed. The host root names an event KEY (the plugin's directory name), resolved to an id
      // through the registry and the event's cwd; the sandbox root names a sandbox slug, which must itself be an id (Sec L2).
      let owner: EventOwner
      if (root === 'sandbox') {
        owner = deps.isRegisteredId(attribution.workspace) ? { kind: 'id', id: attribution.workspace } : { kind: 'unattributed', key: attribution.workspace }
      } else {
        owner = resolveEventWorkspace(deps.getEventIndex(), attribution.workspace, typeof event.cwd === 'string' ? event.cwd : undefined)
      }

      if (owner.kind === 'unattributed') {
        ingestUnattributed(event, owner.key, root)
        continue
      }
      ingestOwned(event, owner.id, sourceFor(owner.id, event.sessionId))
    }

    // Cap activity feed at 1000 items
    if (appState.activityFeed.length > 1000) {
      appState.activityFeed = appState.activityFeed.slice(-1000)
    }

    // Persist offsets after live ingestion (skipped during startup batch, which flushes once at the end).
    if (!deps.isActivityPushSuppressed()) {
      deps.flushEventOffsets()
    }
  }

  /** Feed and notification history only: no workspace state is read or written (the `?` label never matches an id). */
  function ingestUnattributed(event: HookEvent, key: string, root: 'host' | 'sandbox'): void {
    const label = `${UNATTRIBUTED_PREFIX}${key}`
    const source: EventSource | undefined = root === 'sandbox' ? 'sandbox' : undefined
    const activityItem = { ...parser.generateActivityItem(event, label), ...(source ? { source } : {}) }
    appState.activityFeed.push(activityItem)
    if (!deps.isActivityPushSuppressed()) send(ACTIVITY_CHANNELS.NEW_ITEM, activityItem)
    notifications.dispatch({
      id: activityItem.id,
      workspace: label,
      tier: notifications.classify(event),
      summary: activityItem.title,
      detail: activityItem.detail,
      timestamp: activityItem.timestamp,
      autoDismissMs: null,
      ...(source ? { source } : {}),
    })
  }

  function ingestOwned(event: HookEvent, id: string, source: EventSource): void {
    const activityItem = { ...parser.generateActivityItem(event, id), ...(source === 'sandbox' ? { source } : {}) }
    appState.activityFeed.push(activityItem)
    log.info(`[Activity] push type=${activityItem.type} workspace=${id} event=${event.event} title=${activityItem.title}`)
    if (!deps.isActivityPushSuppressed()) send(ACTIVITY_CHANNELS.NEW_ITEM, activityItem)

    // Classify notification tier first: needed to decide whether to clear attention.
    const tier = notifications.classify(event)

    // Clear attention on follow-up activity, but NOT if this event itself requires action
    // (a Notification "permission_prompt" reinforces attention).
    if (activityItem.type !== 'input_required' && tier !== 'requiresAction') {
      const cache = stateCache.getCache()
      if (readOwnNumber(cache.unacknowledgedAttentionEvents, id) > 0) {
        stateCache.updateField('unacknowledgedAttentionEvents', { ...cache.unacknowledgedAttentionEvents, [id]: 0 })
        const ws = appState.workspaces.get(id)
        if (ws) {
          deps.recomputeStatus(ws)
          send(WORKSPACE_CHANNELS.STATUS_CHANGED, { slug: id })
        }
      }
    }

    notifications.dispatch({
      id: activityItem.id,
      workspace: id,
      tier,
      summary: activityItem.title,
      detail: activityItem.detail,
      timestamp: activityItem.timestamp,
      autoDismissMs: null,
      ...(source === 'sandbox' ? { source } : {}),
    })

    // Ship events: the gamification overlay, then the shared recompute.
    if (activityItem.type === 'feature_shipped') {
      send('feature:shipped', activityItem)
      send(GAMIFICATION_CHANNELS.UPDATED, deps.recomputeGamification())
    }
  }
}
