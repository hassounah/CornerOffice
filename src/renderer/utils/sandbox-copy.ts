import { tokenizeNameToText } from './name-safety'
import { TRUST_PROMPT_COPY } from '@main/agents/claude/descriptor'
import { AGENT_DESCRIPTORS, LEGACY_AGENT_ID } from '@main/agents/descriptors'
import type { ReadinessCopy } from '@main/agents/types'
import type {
  DockerState,
  EligibilityReason,
  EligibilityWarning,
  StartResult,
  HandOffResult,
  DeleteResult,
  RecreateResult,
  RecreatePlan,
  SandboxStatus,
  SessionState,
} from '@main/types/sandbox'

// ---------------------------------------------------------------------------
// sandbox-copy.ts — every user-facing sandbox string that depends on a typed
// code (TRD §3.11, §3.15.3, §3.16, §14.5). Both skins read the same table,
// the copy is fixed (never raw stderr or anything an agent chose), and each
// map is an exhaustive `Record<Code, …>`: adding a code to `types/sandbox.ts`
// without a copy row fails to compile (UX-H2). The tone is plain and short
// throughout, so the eligibility reasons, the warnings and the §14.5 reason
// read as one voice (UX-L2).
// ---------------------------------------------------------------------------

export type StartFailureCode = Extract<StartResult, { ok: false }>['code']
export type HandOffFailureCode = Extract<HandOffResult, { ok: false }>['code']
export type DeleteFailureCode = Extract<DeleteResult, { ok: false }>['code']
export type RecreateFailureCode = Extract<RecreateResult, { ok: false }>['code']

// ── Eligibility (§3.11, §14.5) ──────────────────────────────────────────────

export const ELIGIBILITY_COPY: Record<EligibilityReason, string> = {
  'sandbox-disabled': 'Sandbox is disabled in this build.',
  'sandbox-off-in-profile': 'Sandbox sessions are off in this profile. Use the installed app, or make dev PROFILE=.',
  'docker-not-installed': "Docker isn't installed. Install Docker Engine 28 or newer, then press Check again.",
  'docker-daemon-down': "The Docker daemon isn't running. Start it, then press Check again.",
  'docker-no-permission': "Your user can't access Docker. Add it to the docker group and log in again.",
  'docker-rootless': "Rootless Docker isn't supported yet. Use a rootful Docker Engine, then press Check again.",
  'docker-podman': "Podman isn't supported yet. Install Docker Engine, then press Check again.",
  'docker-too-old': 'Sandbox needs Docker 28 or newer. Update Docker, then press Check again.',
  'docker-unsupported-daemon': "Sandbox needs a local Docker Engine. Remote and Docker Desktop daemons aren't supported. Switch to a local one.",
  'repo-unsafe': 'Workspace folder is missing or unsafe. Check that it exists and is a plain folder you own, then try again.',
  'not-git': 'Sandbox needs a git repository. This workspace is host-only.',
  'git-dir-not-directory': "Sandbox needs the repository's main checkout. Add the main clone, not a linked worktree or submodule.",
  'unsupported-name': 'Rename the folder to use only letters, digits, - or _.',
  'unsafe-path': "A path contains a comma or a double quote, which Docker mounts can't use. Rename it and try again.",
  'git-config-unsafe': "This repo's git config (worktreeConfig, hooksPath or include) can't be protected. Remove it and try again.",
  'no-base-branch': 'No local main or master branch. Create one (git branch main), then try again.',
  'docs-root-unsafe': "docs_root can't be the repository, its .git folder, or overlap another sandbox mount. Choose another docs folder.",
  'inside-sandboxes-root': 'This folder is a sandbox worktree. Add the original repository as the workspace instead.',
}

// ── Docker status (Settings reads the same rows as the chooser) ─────────────

const DOCKER_STATE_REASON: Record<Exclude<DockerState, 'ok'>, EligibilityReason> = {
  'not-installed': 'docker-not-installed',
  'daemon-down': 'docker-daemon-down',
  'no-permission': 'docker-no-permission',
  'rootless-unsupported': 'docker-rootless',
  'podman-unsupported': 'docker-podman',
  'too-old': 'docker-too-old',
  'unsupported-daemon': 'docker-unsupported-daemon',
}

/** True when the reason is about the Docker daemon itself: pressing Check again can change it. */
export function isDockerReason(reason: EligibilityReason): boolean {
  return Object.values(DOCKER_STATE_REASON).includes(reason)
}

/** One table for both surfaces: the Settings Docker line is the eligibility reason a chooser would show. */
export function dockerStateCopy(state: DockerState): string {
  return state === 'ok' ? 'Docker is running' : ELIGIBILITY_COPY[DOCKER_STATE_REASON[state]]
}

/** Non-blocking chooser warnings, in the same tone as the eligibility copy. */
export const WARNING_COPY: Record<EligibilityWarning, string> = {
  'base-not-main': "This repository's base branch isn't main. The sandbox starts from it.",
  'docs-root-missing': "The docs folder doesn't exist yet, so it won't be shared with the sandbox.",
  'docs-root-untrusted': 'docs_root points outside the repository and comes from .rix/memory.md. The sandbox can write there.',
  'image-stale': 'The sandbox image is out of date. Rebuild it in Sandbox settings to apply changes.',
}

// ── Vocabulary per skin (UX-M5) ─────────────────────────────────────────────

/** Office calls the place "Sandbox settings"; in Realm it is The Armory. Copy is written once, with the Office name. */
export function forSkin(text: string, skin: 'office' | 'realm'): string {
  return skin === 'realm' ? text.replace(/Sandbox settings/g, 'The Armory') : text
}

// ── Failure copy (§3.15.3) ──────────────────────────────────────────────────

/** Where "details" live: the README section that names the log file. Only honest because failures log a cause. */
export const APP_LOG_HINT = 'Details are in the app log (README, Sandbox Sessions, Troubleshooting).'

/** Badge chip while a stop couldn't be confirmed and the app keeps retrying it. */
export const STOP_UNCONFIRMED_CHIP = 'Still stopping, retrying.'

/** Next steps for the degraded Badge chips (shown as a tooltip and read as the chip's description). */
export const BADGE_HINT_COPY = {
  stopUnconfirmed: "Docker hasn't confirmed that the sandbox stopped. Start stays blocked until it does.",
  dockerUnavailable: 'Start Docker, then press Check again in Sandbox settings.',
  channelUnavailable: "The sandbox's channel was rejected, so messages can't reach this session. End it and start a new one.",
  channelPluginOutdated: 'Update the Corner Office plugin in Claude Code, then start a new session.',
  stoppedUnexpectedly: `The session ended on its own. Start it again. ${APP_LOG_HINT}`,
} as const

/** `ending`, or a stop that couldn't be confirmed yet — Start and the other lifecycle actions stay blocked. */
export function isSessionStopping(state: SessionState | undefined): boolean {
  return state === 'ending' || state === 'stop-unconfirmed'
}

export const STILL_STOPPING = 'The sandbox is still stopping. Try again in a few seconds.'
/** After a recreate: the new container is ready, and Start is still the user's. */
export const RECREATED_COPY = 'The sandbox was recreated. Press Start to begin the session.'
const COULDNT_FINISH = `Couldn't finish. Some sandbox files may remain. ${APP_LOG_HINT}`
/** An agent's display name for copy that applies to every agent; the legacy agent when none (or an unknown one) is given. */
export function agentDisplayName(agentId?: string): string {
  return (AGENT_DESCRIPTORS.find((d) => d.id === (agentId ?? LEGACY_AGENT_ID)) ?? AGENT_DESCRIPTORS[0]).displayName
}

// #0030: the detail main sends already names the file and the fix, so no log hint.
const configCopy = (agentId?: string): string => `Your ${agentDisplayName(agentId)} configuration couldn't be prepared for the sandbox, so nothing was started.`
const configRecreateCopy = (agentId?: string): string =>
  `Your ${agentDisplayName(agentId)} configuration couldn't be prepared for the sandbox, so it wasn't recreated. Your existing sandbox is unchanged.`
const spawnFailedCopy = (agentId?: string): string =>
  `The sandbox started, but ${agentDisplayName(agentId)} couldn't be launched in it. The container was stopped. Try Start again. ${APP_LOG_HINT}`

/** `null` means "not an error": the flow continues (`NOT_ELIGIBLE` shows the eligibility reason instead). */
export const START_FAILURE_COPY: Record<StartFailureCode, string | null> = {
  NOT_ELIGIBLE: null,
  SESSION_EXISTS: 'A session is already running for this workspace.',
  SESSION_ENDING: STILL_STOPPING,
  IMAGE_MISSING: null,
  RECREATE_REQUIRED: null,
  WORKTREE_FAILED: `Couldn't prepare the sandbox's git worktree. Try again. ${APP_LOG_HINT}`,
  CONTAINER_FAILED: `Couldn't create the sandbox container. Try again. ${APP_LOG_HINT}`,
  PORT_CONFLICT: "Another program is using the sandbox's channel port. Recreate the sandbox with a new port? Container caches will be reset.",
  DOCKER_UNAVAILABLE: 'Docker stopped responding. Check that the Docker daemon is running.',
  FIREWALL_FAILED: `The sandbox firewall couldn't start, so the session wasn't started. Nothing ran unprotected. Try Start again. ${APP_LOG_HINT}`,
  SPAWN_FAILED: spawnFailedCopy(), // the legacy agent's wording; startFailureMessage names the session's own agent
  AGENT_CONFIG_INVALID: configCopy(),
  AGENT_NOT_READY: null, // the message comes from the agent's descriptor (agentReadinessMessage)
}

export const HAND_OFF_FAILURE_COPY: Record<HandOffFailureCode, string | null> = {
  DIRTY: null, // the confirm dialog in SandboxActions
  NOT_ON_BRANCH: "The sandbox isn't on a branch, so there's nothing to hand off.",
  NO_WORKTREE: 'This workspace has no sandbox worktree.',
  LOCKED: 'The agent is using git right now. Try again in a moment.',
  SESSION_ENDING: STILL_STOPPING,
}

export const DELETE_FAILURE_COPY: Record<DeleteFailureCode, string> = {
  SESSION_RUNNING: 'End the sandbox session before deleting it.',
  // The UI prevents this; it only shows when the state changed between preview and delete.
  DIRTY_NOT_ACKNOWLEDGED: 'Confirm that the uncommitted changes will be lost.',
  FAILED: COULDNT_FINISH,
}

export const RECREATE_FAILURE_COPY: Record<RecreateFailureCode, string> = {
  SESSION_RUNNING: 'End the sandbox session first.',
  PLAN_CHANGED: 'The sandbox settings changed again. Review them before recreating.',
  AGENT_CONFIG_INVALID: configRecreateCopy(),
  DOCKER_UNAVAILABLE: 'Docker stopped responding. Check that the Docker daemon is running.',
  FAILED: COULDNT_FINISH,
}

export const LIVE_UPDATE_FAILURE_COPY = 'Firewall update failed — the previous rules are still active.'

/** Shown when main isn't reachable or not ready (the store's "not available" error). */
export const SANDBOX_UNAVAILABLE_COPY = "The sandbox isn't available right now. Try again in a moment."

/** The dev app's debug port (Dev app access) is taken. A new channel port would not help, so no recreate is offered. */
export const DEBUG_PORT_CONFLICT_COPY = 'Another program is using the dev app debug port. Close it, or turn off Dev app access in Settings > Sandbox, and try again.'

/** The channel port is taken and there is no plan to recreate with: say what to do instead of asking a question with no button. */
export const PORT_CONFLICT_NO_RECREATE_COPY = "Another program is using the sandbox's channel port. Close it and try again."

/** The message for a failed start, or `null` when the code isn't an error (build / recreate flows). */
export function startFailureMessage(
  code: StartFailureCode,
  eligibilityReason?: EligibilityReason | null,
  detail?: string | null,
  agent?: { agentId?: string; readiness?: string },
): string | null {
  if (code === 'NOT_ELIGIBLE') return eligibilityReason ? ELIGIBILITY_COPY[eligibilityReason] : "Sandbox isn't available for this workspace."
  if (code === 'AGENT_NOT_READY') {
    return (agent?.readiness && agentReadinessMessage(agent.agentId ?? LEGACY_AGENT_ID, agent.readiness)) || "This agent isn't ready to run in the sandbox yet."
  }
  if (code === 'PORT_CONFLICT' && detail === 'debug-port') return DEBUG_PORT_CONFLICT_COPY
  // The wording that names the agent follows the session's own agent, not a fixed one.
  const message = code === 'SPAWN_FAILED' ? spawnFailedCopy(agent?.agentId) : code === 'AGENT_CONFIG_INVALID' ? configCopy(agent?.agentId) : START_FAILURE_COPY[code]
  return code === 'AGENT_CONFIG_INVALID' && message !== null && detail ? `${detail} ${message}` : message
}

/**
 * The one source of an agent's readiness message (UX-M8): the descriptor's copy for a handler readiness code.
 * `null` for an unknown agent or code. The chooser's Sandbox reason and the Start refusal both read it.
 */
export function agentReadinessMessage(agentId: string, code: string): string | null {
  const readiness: Readonly<Record<string, ReadinessCopy>> | undefined = AGENT_DESCRIPTORS.find((d) => d.id === agentId)?.copy.readiness
  return readiness?.[code]?.message ?? null
}

/** The command that fixes a readiness problem (for example `codex login`), shown with a copy button; `null` when there is none. */
export function agentReadinessCommand(agentId: string, code: string): string | null {
  const readiness: Readonly<Record<string, ReadinessCopy>> | undefined = AGENT_DESCRIPTORS.find((d) => d.id === agentId)?.copy.readiness
  return readiness?.[code]?.command ?? null
}

/** The few words between a readiness message and its command ("Run:", or "After that, run:" when the message names a step first). */
export function agentReadinessCommandLead(agentId: string, code: string): string {
  const readiness: Readonly<Record<string, ReadinessCopy>> | undefined = AGENT_DESCRIPTORS.find((d) => d.id === agentId)?.copy.readiness
  return readiness?.[code]?.commandLead ?? 'Run:'
}

/** The message for a failed recreate. `detail` is the fixed copy main built for `AGENT_CONFIG_INVALID`, e.g. "~/.claude/commands exists but isn't a folder." */
export function recreateFailureMessage(code: RecreateFailureCode, detail?: string | null, agentId?: string): string {
  const message = code === 'AGENT_CONFIG_INVALID' ? configRecreateCopy(agentId) : RECREATE_FAILURE_COPY[code]
  return code === 'AGENT_CONFIG_INVALID' && detail ? `${detail} ${message}` : message
}

// ── Chooser copy (§3.15.2, UX-C, D10) ───────────────────────────────────────

/** The one place the image size is stated (phase0-results.md measured 1.40 GB with every toolchain). */
export const IMAGE_SIZE_COPY = 'About 1.4 GB'
export const BUILD_CONFIRM_COPY = `${IMAGE_SIZE_COPY}, takes several minutes. The session won't start by itself: you'll press Start when the image is ready.`
export const IMAGE_READY_COPY = "Image ready. Press Start when you're ready."
export const IMAGE_BUILDING_REASON = 'The image is still building.'
export const BUILD_FAILED_COPY = 'The image build did not finish. Start again to build it.'
/** Shown in sandbox mode: the first session in a new sandbox stops at Claude Code's folder-trust prompt (README, First-run prompts). Lives in the Claude descriptor. */
export { TRUST_PROMPT_COPY }
/** The Sandbox option while the status is still loading. */
export const CHECKING_COPY = 'Checking…'
/** How long "Checking…" may last before the chooser gives up and offers Check again. */
export const STATUS_CHECK_TIMEOUT_MS = 10_000
/** How long a remembered Sandbox choice waits for the status before the chooser opens and falls back as it does for an unknown status. */
export const SANDBOX_CHOICE_WAIT_MS = 3_000
export const UNRESTRICTED_WARNING = 'Unrestricted network: the sandbox can reach any site on the internet. The firewall is off for this session.'

// ── Channel badge copy (§3.15.2, SEC-H4) ────────────────────────────────────

export const CHANNEL_COPY: Record<SandboxStatus['channel'], string | null> = {
  connected: null,
  connecting: null,
  none: null,
  'plugin-outdated': 'Channel: plugin update needed',
  unavailable: 'Channel: unavailable',
}

// ── Recreate dialog (§3.16, B-H2, UX-M1) ────────────────────────────────────

/** "Create the Codex sandbox?" / "Recreate the Claude Code sandbox?": the dialog names the agent whose container it changes (UX-M5). */
export function recreateTitle(creating: boolean, agentId?: string): string {
  return `${creating ? 'Create' : 'Recreate'} the ${agentDisplayName(agentId)} sandbox?`
}

/** The Delete confirm's lead line: it removes every agent's container for the workspace, and says what stays (UX-M5). */
export function deleteConfirmCopy(): string {
  const names = AGENT_DESCRIPTORS.map((d) => d.displayName)
  const others = AGENT_DESCRIPTORS.filter((d) => d.id !== LEGACY_AGENT_ID).map((d) => d.displayName)
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0]
  const signIn = others.length > 0 ? ` Your ${others.join(' and ')} sign-in stays on this computer.` : ''
  return `Deletes the sandbox worktree and its ${list} containers.${signIn}`
}

/** Added to the build prompt when an agent's start needs an image that predates it: a one-time rebuild. */
export function imageUpdatedForAgentCopy(agentId?: string): string {
  return `The sandbox image was updated to include ${agentDisplayName(agentId)}. This is a one-time rebuild of a few minutes.`
}

export const RECREATE_REASON_COPY: Record<RecreatePlan['reason'], string> = {
  image: 'The sandbox image was updated.',
  'mount-plan': 'The folders shared with the sandbox changed.',
  port: "The sandbox's channel port changed.",
  'new-container': "This sandbox doesn't exist yet. Nothing will be removed.",
}

export const READ_ONLY_PROTECTIONS_COPY = 'Only read-only protections were added.'
export const MEMORY_MD_WARNING_COPY = 'This path came from .rix/memory.md, which the sandbox agent can edit. Only continue if you set it yourself.'
export const CACHES_RESET_COPY = 'Container caches will be reset.'
/** #0035: an existing sandbox gains a folder set in .rix/memory.md — the agent may have changed it since you last approved. */
export const MEMORY_MD_CHANGED_COPY =
  "A folder set in .rix/memory.md has changed since you last approved this sandbox. The sandbox agent can edit that file, so this may not be your change. Only continue if you changed it yourself."

export interface RecreateDescription {
  reasonLine: string
  /** Added after the reason when a dev-app publish change comes with other changes; null otherwise. */
  devCdpLine: string | null
  /** Every new mount is read-only: say so and list nothing else (B-H2). */
  readOnlyOnly: boolean
  /** Each new read-write host mount, with its full path, its source and whether it needs the memory.md warning. */
  readWriteMounts: { path: string; source: RecreatePlan['newHostMounts'][number]['source']; memoryMdWarning: boolean }[]
  removedMounts: string[]
  /** A recreate resets the container's caches; a `new-container` plan removes nothing. */
  cachesReset: boolean
  /** An existing sandbox gains a read-write memory.md mount: show the louder change warning (#0035). */
  memoryMdChanged: boolean
}

export interface DescribeRecreateOptions {
  /** The host port dev app access publishes on, for the "enabled" line. */
  devCdpPort?: number | null
  /** The recreate also picks a new channel port (PORT_CONFLICT): the channel-port reason still applies. */
  newPort?: boolean
}

export function describeRecreatePlan(plan: RecreatePlan, opts: DescribeRecreateOptions = {}): RecreateDescription {
  const readWrite = plan.newHostMounts.filter((m) => !m.readonly)
  const devCdpLine = plan.devCdpChange ? devCdpChangeCopy(plan.devCdpChange, opts.devCdpPort) : null
  // A dev-app-only change arrives as reason 'port': its own sentence replaces the channel-port one.
  const cdpOnly = devCdpLine !== null && plan.reason === 'port' && !opts.newPort
  return {
    reasonLine: cdpOnly ? devCdpLine : RECREATE_REASON_COPY[plan.reason],
    devCdpLine: cdpOnly ? null : devCdpLine,
    readOnlyOnly: plan.newHostMounts.length > 0 && readWrite.length === 0,
    readWriteMounts: readWrite.map((m) => ({ path: m.path, source: m.source, memoryMdWarning: m.source === 'memory.md' })),
    removedMounts: plan.removedHostMounts,
    cachesReset: plan.reason !== 'new-container',
    memoryMdChanged: plan.reason !== 'new-container' && readWrite.some((m) => m.source === 'memory.md'),
  }
}

// ── Unmerged work line (§3.15.2, UX-M3) ─────────────────────────────────────

const MAX_NAMED_BRANCHES = 3

/**
 * "Unmerged sandbox work: a, b, c, +N more" as plain text, for a tooltip or a title attribute (which can't
 * hold elements). Branch names are agent-writable (SEC-L5), so each goes through `tokenizeNameToText`:
 * invisible and bidi-control characters are made visible.
 */
export function unmergedLine(branches: readonly string[]): string {
  const named = branches.slice(0, MAX_NAMED_BRANCHES).map(tokenizeNameToText)
  const more = branches.length - named.length
  return `Unmerged sandbox work: ${named.join(', ')}${more > 0 ? `, +${more} more` : ''}`
}

// ── Dev app access (#0038 3a) ───────────────────────────────────────────────

export const DEV_ACCESS_TITLE = 'Dev app access'
export const DEV_ACCESS_TOGGLE = 'Publish the dev app debug port on 127.0.0.1'
export const DEV_ACCESS_APPLIES = 'Applies to Claude sessions in this workspace.'
export const DEV_ACCESS_HELP =
  `Anything on this computer can then run commands in this sandbox and use your Claude sign-in. That includes other user accounts. ${DEV_ACCESS_APPLIES} The port is served from inside the sandbox, so treat what it shows as coming from the agent.`
export const DEV_ACCESS_NEXT_START = 'Takes effect when your Claude session next starts.'
export const DEV_ACCESS_SAVE_FAILED = 'Your setting was not changed. Try again.'
export const DEV_ACCESS_ROUTINE_USE =
  'For routine agent use, run make dev-sandbox and co_dev_shot.mjs inside the session. Use this port only from DevTools you drive yourself.'

/** The enabled state: where the host port goes. */
export function devAccessRouteCopy(port: number): string {
  return `This computer 127.0.0.1:${port} → dev app port 9222 in the sandbox. ${DEV_ACCESS_APPLIES}`
}

/** The off-but-still-open state: which port is still published, and until when. */
export function devAccessStillPublishedCopy(published: number): string {
  return `Off. 127.0.0.1:${published} stays open until your Claude session next starts.`
}

/** The persistent indicator in the sandbox header while the container publishes a debug port. */
export function debugPortOpenCopy(published: number): string {
  return `Debug port open: 127.0.0.1:${published}`
}

export function devAccessInspectCopy(port: number): string {
  return `In Chrome: chrome://inspect → Configure… → add 127.0.0.1:${port}.`
}

/** The recreate dialog's line for a dev-app publish change. `port` is the configured host port; absent when disabling. */
export function devCdpChangeCopy(change: 'enabled' | 'disabled', port: number | null | undefined): string {
  if (change === 'disabled') return 'Dev app debug port closed.'
  const where = port ? `127.0.0.1:${port}` : '127.0.0.1'
  return `Dev app debug port on ${where}. Anything on this computer can control the dev app and run commands in this sandbox.`
}

// ── Electron dev runtime (#0038 D9) ─────────────────────────────────────────

/** The size reads "shown after the first build" until the host spike (H.3) supplies the number. */
export const ELECTRON_TOOLCHAIN_COPY =
  'Electron dev runtime (Xvfb + GUI libraries, size shown after the first build), for make dev-sandbox. Rebuilds the shared sandbox image for all workspaces. Also add electronjs.org to this workspace’s allowlist.'
