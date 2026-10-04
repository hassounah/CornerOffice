import React, { useEffect, useId, useRef, useState } from 'react'
import { useSandboxStore } from '../../stores/sandbox-store'
import type { BuildPhase } from '../../stores/sandbox-store'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { DisabledReason } from '../shared/DisabledReason'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import { AllowlistEditor } from './AllowlistEditor'
import { SandboxActions } from './SandboxActions'
import { isDomainAllowed } from '../../utils/allowlist-validate'
import { LIVE_UPDATE_FAILURE_COPY, STOP_UNCONFIRMED_CHIP, dockerStateCopy, isSessionStopping } from '../../utils/sandbox-copy'
import type { SandboxSettingsView } from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// SandboxSettingsPanel — Sandbox settings (TRD §3.15.2). This file holds the
// Docker, Image and Toolchains sections (step 5.8a) and the Network and
// Sandboxes sections (5.8b). Skin-agnostic logic with a `skin` prop for chrome
// only; the copy is plain and identical in both skins.
//
// Network: the built-in defaults (read-only), the global additions and one
// workspace's additions (both AllowlistEditor), the live-update failure line,
// and the Blocked feed for the picked workspace, headed "Requested by the
// agent". Domains in that feed are chosen by the agent, so the heading says so,
// they render as plain text, and "Allow everywhere" asks first and names the
// workspace.
//
// Build log a11y (UX-M2): the log lines carry NO `aria-live` and the log is
// not a `role="log"` (which is implicitly live), so a long build can't flood
// a screen reader. One separate status line is `aria-live="polite"`, and a
// "Jump to latest" button scrolls the log.
// ---------------------------------------------------------------------------

export interface SandboxSettingsPanelProps {
  skin?: 'office' | 'realm'
  /** Starts the recreate confirm flow for the sandboxes still on the previous image (the dialog itself is 5.4/5.5). */
  onRecreateNow?: (slugs: string[]) => void
  /** The workspace the Network section opens on (the "blocked a network request" notification names one). */
  initialWorkspace?: string
}

const REALM_SECTION_STYLE: React.CSSProperties = {
  background: 'rgba(30,20,10,0.5)',
  border: '1px solid rgba(201,168,76,0.3)',
  color: '#e8dcc8',
  fontFamily: 'serif',
}

const REALM_BUTTON_STYLE: React.CSSProperties = {
  background: 'rgba(201,168,76,0.15)',
  border: '1px solid #c9a84c',
  color: '#c9a84c',
  fontFamily: 'serif',
}

const SECTION_CLASS = 'rounded-lg p-4 space-y-3'
const OFFICE_SECTION = `${SECTION_CLASS} border border-co-border bg-co-bg-secondary text-co-text-primary`
const BUTTON_CLASS = 'rounded px-3 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#c9a84c]'
const OFFICE_BUTTON = `${BUTTON_CLASS} border border-co-border bg-co-bg-tertiary text-co-text-primary hover:bg-co-bg-elevated`
const MUTED = 'text-xs text-co-text-muted'

const IMAGE_COPY = {
  absent: 'Not built yet',
  building: 'Building…',
  ready: 'Ready',
  stale: 'Ready, but out of date',
  failed: 'The last build failed',
} as const

const BUILD_STATUS_COPY: Record<BuildPhase, string> = {
  idle: '',
  running: 'Building…',
  done: 'Image ready',
  failed: 'Build failed',
  cancelled: 'Cancelled',
}

const LOCKED_TOOLCHAINS: readonly { label: string; reason: string }[] = [
  { label: 'Core tools', reason: 'Always included' },
  { label: 'GitHub CLI (gh)', reason: 'Always included' },
  { label: 'Claude Code', reason: 'Always included' },
  { label: 'Python 3.12 + uv + bun', reason: 'Required by the corner-office plugin' },
]

function formatSize(bytes: number | null): string | null {
  if (bytes === null) return null
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

function formatBuiltAt(builtAt: string | null): string | null {
  if (!builtAt) return null
  const date = new Date(builtAt)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString()
}

interface SectionProps {
  skin: 'office' | 'realm'
}

function Section({ skin, title, children }: SectionProps & { title: string; children: React.ReactNode }): React.ReactElement {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className={skin === 'realm' ? SECTION_CLASS : OFFICE_SECTION} style={skin === 'realm' ? REALM_SECTION_STYLE : undefined}>
      <h3 id={headingId} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Button({ skin, onClick, children, ...rest }: SectionProps & React.ButtonHTMLAttributes<HTMLButtonElement>): React.ReactElement {
  return (
    <button
      type="button"
      className={skin === 'realm' ? BUTTON_CLASS : OFFICE_BUTTON}
      style={skin === 'realm' ? REALM_BUTTON_STYLE : undefined}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  )
}

// ── Docker ──────────────────────────────────────────────────────────────────

function DockerSection({ skin }: SectionProps): React.ReactElement {
  const environment = useSandboxStore((s) => s.environment)
  const fetchEnvironment = useSandboxStore((s) => s.fetchEnvironment)

  return (
    <Section skin={skin} title="Docker">
      <p>
        {environment ? dockerStateCopy(environment.docker) : 'Checking Docker…'}
        {environment?.dockerVersion ? <span className={MUTED}> · version {environment.dockerVersion}</span> : null}
      </p>
      <Button skin={skin} onClick={() => void fetchEnvironment(true)}>
        Check again
      </Button>
    </Section>
  )
}

// ── Image ───────────────────────────────────────────────────────────────────

function ImageSection({ skin, onRecreateNow }: SectionProps & { onRecreateNow?: (slugs: string[]) => void }): React.ReactElement {
  const environment = useSandboxStore((s) => s.environment)
  const build = useSandboxStore((s) => s.build)
  const status = useSandboxStore((s) => s.status)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const buildImage = useSandboxStore((s) => s.buildImage)
  const cancelBuild = useSandboxStore((s) => s.cancelBuild)
  const [confirming, setConfirming] = useState<null | { rebuild: boolean }>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const imageState = environment?.image.state ?? null
  const building = build.running || imageState === 'building'
  const rebuild = imageState === 'ready' || imageState === 'stale'
  const builtAt = formatBuiltAt(environment?.image.builtAt ?? null)
  const size = formatSize(environment?.image.sizeBytes ?? null)
  const pendingSlugs = Object.values(status)
    .filter((s) => s.recreatePending)
    .map((s) => s.workspaceSlug)

  function start(): void {
    const request = confirming
    setConfirming(null)
    if (request) void buildImage(request.rebuild).catch(() => undefined)
  }

  return (
    <Section skin={skin} title="Image">
      <p>
        {imageState ? IMAGE_COPY[imageState] : 'Checking the image…'}
        {builtAt ? <span className={MUTED}> · built {builtAt}</span> : null}
        {size ? <span className={MUTED}> · {size}</span> : null}
      </p>

      {imageState === 'stale' && (
        <p role="status" className="text-sm">
          The image is out of date. Rebuild to apply.
        </p>
      )}

      {pendingSlugs.length > 0 && (
        <div className="space-y-2">
          <p>
            {pendingSlugs.length} {pendingSlugs.length === 1 ? 'sandbox uses' : 'sandboxes use'} the previous image. Recreate now?
          </p>
          {onRecreateNow ? (
            <Button skin={skin} onClick={() => onRecreateNow(pendingSlugs)}>
              Recreate now
            </Button>
          ) : (
            // No caller-supplied flow: each sandbox recreates through its own confirm-first dialog (§3.16).
            <ul className="space-y-1">
              {pendingSlugs.map((slug) => {
                const name = workspaces.find((w) => w.slug === slug)?.displayName ?? slug
                return (
                  <li key={slug} className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{name}</span>
                    <SandboxActions slug={slug} skin={skin} recreateOnly label={name} />
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <DisabledReason reason={building ? 'A build is already running' : null} skin={skin}>
          {(props) => (
            <Button skin={skin} onClick={() => setConfirming({ rebuild })} {...props}>
              {rebuild ? 'Rebuild image' : 'Build image'}
            </Button>
          )}
        </DisabledReason>
        {building && (
          <Button skin={skin} onClick={() => void cancelBuild()}>
            Cancel build
          </Button>
        )}
      </div>

      <p aria-live="polite" className="text-sm">
        {BUILD_STATUS_COPY[build.phase]}
      </p>

      {build.lines.length > 0 && (
        <div className="space-y-1">
          <div
            ref={logRef}
            tabIndex={0}
            role="region"
            aria-label="Build log"
            className="max-h-48 overflow-auto rounded border border-co-border bg-co-bg-primary p-2 font-mono text-[11px]"
          >
            {build.lines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          <Button
            skin={skin}
            onClick={() => {
              const el = logRef.current
              if (el) el.scrollTop = el.scrollHeight
            }}
          >
            Jump to latest
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.rebuild ? 'Rebuild the sandbox image?' : 'Build the sandbox image?'}
        message={
          confirming?.rebuild
            ? 'This pulls the latest base image and a newer Claude Code, and takes several minutes. Sandboxes on the previous image need to be recreated afterwards.'
            : 'About 1.4 GB, takes several minutes. No session will start by itself: you press Start when the image is ready.'
        }
        confirmLabel={confirming?.rebuild ? 'Rebuild' : 'Build'}
        cancelLabel="Cancel"
        onConfirm={start}
        onCancel={() => setConfirming(null)}
        skin={skin}
      />
    </Section>
  )
}

// ── Toolchains ──────────────────────────────────────────────────────────────

const TOGGLEABLE: readonly { key: 'node' | 'go' | 'buildBase'; label: string }[] = [
  { key: 'node', label: 'Node 22 + pnpm' },
  { key: 'go', label: 'Go' },
  { key: 'buildBase', label: 'build-base (C toolchain)' },
]

function ToolchainsSection({ skin }: SectionProps): React.ReactElement {
  const settings = useSandboxStore((s) => s.settings)
  const updateSettings = useSandboxStore((s) => s.updateSettings)
  const [error, setError] = useState(false)

  function toggle(key: 'node' | 'go' | 'buildBase', checked: boolean): void {
    if (!settings) return
    setError(false)
    updateSettings({ toolchains: { ...settings.toolchains, [key]: checked } }).catch(() => setError(true))
  }

  return (
    <Section skin={skin} title="Toolchains">
      <ul className="space-y-1">
        {TOGGLEABLE.map(({ key, label }) => (
          <li key={key}>
            {settings ? (
              <label className="inline-flex items-center gap-2">
                <input type="checkbox" checked={settings.toolchains[key]} onChange={(e) => toggle(key, e.target.checked)} />
                {label}
              </label>
            ) : (
              // Not loaded yet: focusable and explained, never a bare `disabled` input (§3.15.1).
              <DisabledReason reason="Loading settings…" skin={skin}>
                {(props) => (
                  <span className="inline-flex items-center gap-2">
                    <span role="checkbox" aria-checked="false" aria-label={label} tabIndex={0} {...props}>
                      ☐
                    </span>
                    <span aria-hidden="true">{label}</span>
                  </span>
                )}
              </DisabledReason>
            )}
          </li>
        ))}
        {LOCKED_TOOLCHAINS.map(({ label, reason }) => (
          <li key={label}>
            <DisabledReason reason={reason} skin={skin}>
              {(props) => (
                // A real <input> would flip on click even with the injected no-op handler (React's controlled
                // checkbox restore fights preventDefault), so a locked row is a focusable, always-checked
                // role="checkbox" instead.
                <span className="inline-flex items-center gap-2">
                  <span role="checkbox" aria-checked="true" aria-label={label} tabIndex={0} {...props}>
                    ☑
                  </span>
                  <span aria-hidden="true">{label}</span>
                  {label.startsWith('Python') ? <span className={MUTED}> — {reason}</span> : null}
                </span>
              )}
            </DisabledReason>
          </li>
        ))}
      </ul>
      <p className={MUTED}>Changing a toolchain marks the image out of date until you rebuild it.</p>
      {error && (
        <p role="alert" className="text-sm">
          Could not save the toolchain settings.
        </p>
      )}
    </Section>
  )
}

// ── Network ─────────────────────────────────────────────────────────────────

const L6_NOTE = 'Removing a site stops new connections to it right away. Connections that are already open stay open until the session ends.'

interface BlockedAllow {
  domain: string
  everywhere: boolean
}

function NetworkSection({ skin, initialWorkspace }: SectionProps & { initialWorkspace?: string }): React.ReactElement {
  const settings = useSandboxStore((s) => s.settings)
  const settingsError = useSandboxStore((s) => s.settingsError)
  const fetchSettings = useSandboxStore((s) => s.fetchSettings)
  const updateSettings = useSandboxStore((s) => s.updateSettings)
  const fetchBlocked = useSandboxStore((s) => s.fetchBlocked)
  const fetchStatus = useSandboxStore((s) => s.fetchStatus)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const [picked, setPicked] = useState<string | null>(initialWorkspace ?? null)
  const [error, setError] = useState(false)
  const [confirmEverywhere, setConfirmEverywhere] = useState<string | null>(null)
  const pickerId = useId()
  const writes = useRef<Promise<void>>(Promise.resolve())

  const slug = picked !== null && workspaces.some((w) => w.slug === picked) ? picked : (workspaces[0]?.slug ?? null)
  const workspaceName = workspaces.find((w) => w.slug === slug)?.displayName ?? slug ?? ''
  const blocked = useSandboxStore((s) => (slug ? s.blocked[slug] : undefined)) ?? []
  const liveUpdate = useSandboxStore((s) => (slug ? s.status[slug]?.liveUpdate : null))

  useEffect(() => {
    if (!slug) return
    void fetchBlocked(slug)
    void fetchStatus(slug)
  }, [slug, fetchBlocked, fetchStatus])

  // Every edit is a read-modify-write of a whole list, so writes run one at a time and each one is built from
  // the settings the previous write returned: two quick clicks both end up saved instead of the second
  // overwriting the first.
  function save(build: (current: SandboxSettingsView) => Parameters<typeof updateSettings>[0]): void {
    setError(false)
    writes.current = writes.current
      .then(async () => {
        const latest = useSandboxStore.getState().settings
        if (latest) await updateSettings(build(latest))
      })
      .catch(() => setError(true))
  }

  function addGlobal(entry: string): void {
    save((current) => ({ globalAllowlist: current.globalAllowlist.includes(entry) ? current.globalAllowlist : [...current.globalAllowlist, entry] }))
  }

  function removeGlobal(entry: string): void {
    save((current) => ({ globalAllowlist: current.globalAllowlist.filter((e) => e !== entry) }))
  }

  function workspaceEntries(view: SandboxSettingsView): string[] {
    return slug ? (view.workspaceAllowlists[slug] ?? []) : []
  }

  function editWorkspace(edit: (entries: string[]) => string[]): void {
    if (!slug) return
    save((current) => ({ workspaceAllowlist: { workspaceSlug: slug, entries: edit(workspaceEntries(current)) } }))
  }

  function allow({ domain, everywhere }: BlockedAllow): void {
    if (everywhere) addGlobal(domain)
    else editWorkspace((entries) => (entries.includes(domain) ? entries : [...entries, domain]))
  }

  return (
    <Section skin={skin} title="Network">
      {!settings ? (
        settingsError ? (
          <div className="space-y-2">
            <p role="alert">Could not load the sandbox settings.</p>
            <Button skin={skin} onClick={() => void fetchSettings()}>
              Retry
            </Button>
          </div>
        ) : (
          <p>Loading settings…</p>
        )
      ) : (
        <>
          <details>
            <summary className="cursor-pointer text-sm">Always allowed ({settings.defaultAllowlist.length} sites)</summary>
            <ul className="mt-1 text-xs">
              {settings.defaultAllowlist.map((domain) => (
                <li key={domain}>{domain}</li>
              ))}
            </ul>
          </details>

          <div className="space-y-1">
            <h4 className="text-sm font-medium">Allowed in every sandbox</h4>
            <AllowlistEditor entries={settings.globalAllowlist} onAdd={addGlobal} onRemove={removeGlobal} skin={skin} />
          </div>

          <div className="space-y-2">
            <label htmlFor={pickerId} className="block text-sm font-medium">
              Workspace
            </label>
            {workspaces.length === 0 ? (
              <p className={MUTED}>No workspaces yet.</p>
            ) : (
              <select
                id={pickerId}
                value={slug ?? ''}
                onChange={(e) => setPicked(e.target.value)}
                className={`rounded px-2 py-1 text-sm ${skin === 'realm' ? '' : 'border border-co-border bg-co-bg-tertiary text-co-text-primary'}`}
                style={skin === 'realm' ? REALM_BUTTON_STYLE : undefined}
              >
                {workspaces.map((w) => (
                  <option key={w.slug} value={w.slug}>
                    {w.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>

          {slug && (
            <>
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Also allowed in {workspaceName}</h4>
                <AllowlistEditor
                  entries={workspaceEntries(settings)}
                  onAdd={(entry) => editWorkspace((entries) => (entries.includes(entry) ? entries : [...entries, entry]))}
                  onRemove={(entry) => editWorkspace((entries) => entries.filter((e) => e !== entry))}
                  skin={skin}
                />
              </div>

              {liveUpdate === 'failed' && (
                <p role="alert" className="text-sm">
                  {LIVE_UPDATE_FAILURE_COPY}
                </p>
              )}

              <div className="space-y-1">
                <h4 className="text-sm font-medium">Requested by the agent</h4>
                {blocked.length === 0 ? (
                  <p className={MUTED}>Nothing was blocked in {workspaceName}.</p>
                ) : (
                  <>
                    <p className={MUTED}>The sandbox agent chose these names. Only allow a site you recognise.</p>
                    <ul className="space-y-1">
                      {blocked.map((entry) => {
                        const allowed = isDomainAllowed(entry.domain, [...settings.defaultAllowlist, ...settings.globalAllowlist, ...workspaceEntries(settings)])
                        return (
                          <li key={entry.domain} className="flex flex-wrap items-center gap-2">
                            <code className="text-xs">{entry.domain}</code>
                            <span className={MUTED}>
                              {entry.count} {entry.count === 1 ? 'request' : 'requests'}
                            </span>
                            {allowed ? (
                              <span className="text-xs">Allowed</span>
                            ) : (
                              <>
                                <Button skin={skin} aria-label={`Allow for this workspace: ${entry.domain}`} onClick={() => allow({ domain: entry.domain, everywhere: false })}>
                                  Allow for this workspace
                                </Button>
                                <Button skin={skin} aria-label={`Allow everywhere: ${entry.domain}`} onClick={() => setConfirmEverywhere(entry.domain)}>
                                  Allow everywhere
                                </Button>
                              </>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}
              </div>
            </>
          )}

          <p className={MUTED}>{L6_NOTE}</p>
        </>
      )}

      {error && (
        <p role="alert" className="text-sm">
          Could not save the allowlist.
        </p>
      )}

      <ConfirmDialog
        open={confirmEverywhere !== null}
        title="Allow for every sandbox?"
        message={`Allow ${confirmEverywhere ?? ''} for every sandbox? This site was requested by the agent in ${workspaceName}.`}
        confirmLabel="Allow everywhere"
        cancelLabel="Cancel"
        onConfirm={() => {
          const domain = confirmEverywhere
          setConfirmEverywhere(null)
          if (domain) allow({ domain, everywhere: true })
        }}
        onCancel={() => setConfirmEverywhere(null)}
        skin={skin}
      />
    </Section>
  )
}

// ── Sandboxes ───────────────────────────────────────────────────────────────

function SandboxesSection({ skin }: SectionProps): React.ReactElement {
  const summaries = useSandboxStore((s) => s.summaries)
  const status = useSandboxStore((s) => s.status)
  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const slugs = Object.keys(summaries).filter((slug) => summaries[slug]?.exists)

  function stateCopy(slug: string): string {
    const state = status[slug]?.session.state
    if (state === 'stop-unconfirmed') return STOP_UNCONFIRMED_CHIP
    if (isSessionStopping(state)) return 'Ending…'
    if (state === 'running' || state === 'preparing' || summaries[slug]?.running) return 'Running'
    return 'Stopped'
  }

  return (
    <Section skin={skin} title="Sandboxes">
      {slugs.length === 0 ? (
        <p className={MUTED}>No sandboxes yet. Start a sandbox session from a workspace to create one.</p>
      ) : (
        <ul className="space-y-2">
          {slugs.map((slug) => {
            const name = workspaces.find((w) => w.slug === slug)?.displayName ?? slug
            const unmerged = summaries[slug]?.unmergedBranches.length ?? 0
            return (
              <li key={slug} aria-label={name} className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium">{name}</span>
                <span className={MUTED}>
                  {stateCopy(slug)}
                  {unmerged > 0 ? ` · ${unmerged} unmerged ${unmerged === 1 ? 'branch' : 'branches'}` : ''}
                </span>
                <SandboxActions slug={slug} skin={skin} deleteOnly label={name} />
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

// ── Panel ───────────────────────────────────────────────────────────────────

export function SandboxSettingsPanel({ skin = 'office', onRecreateNow, initialWorkspace }: SandboxSettingsPanelProps): React.ReactElement {
  const fetchEnvironment = useSandboxStore((s) => s.fetchEnvironment)
  const fetchSettings = useSandboxStore((s) => s.fetchSettings)
  const fetchSummaries = useSandboxStore((s) => s.fetchSummaries)
  const fetchStatus = useSandboxStore((s) => s.fetchStatus)
  const sandboxSlugs = useSandboxStore((s) => Object.keys(s.summaries).join('\u0000'))

  useEffect(() => {
    void fetchEnvironment(true)
    void fetchSettings()
    void fetchSummaries()
  }, [fetchEnvironment, fetchSettings, fetchSummaries])

  // The "N sandboxes use the previous image" prompt needs each sandbox's recreatePending flag.
  useEffect(() => {
    for (const slug of sandboxSlugs.split('\u0000').filter(Boolean)) void fetchStatus(slug)
  }, [sandboxSlugs, fetchStatus])

  return (
    <div className="space-y-4">
      <DockerSection skin={skin} />
      <ImageSection skin={skin} onRecreateNow={onRecreateNow} />
      <ToolchainsSection skin={skin} />
      <NetworkSection skin={skin} initialWorkspace={initialWorkspace} />
      <SandboxesSection skin={skin} />
    </div>
  )
}
