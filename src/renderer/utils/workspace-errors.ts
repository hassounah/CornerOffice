import type { CreateWarning } from '@main/services/workspace-registry'
import type { IpcErrorCode } from '@main/types/ipc'
import type { StoreName } from '@main/services/store-files'
import type { Availability } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// workspace-errors.ts — every sentence the workspace registry UI shows for a failure, in one place (#0039, TRD §3.7,
// §4.2, §4.5, §4.9, UX H-8).
//
// Main sends only a fixed error CODE (never a path, a name or a thrown message). This table turns a code into copy.
// A name in a sentence ("Already added as <name>") is looked up here, in the renderer, from the workspace list.
// ---------------------------------------------------------------------------

/** Where an error is being shown: `TIMEOUT` reads differently on "Check again" than on add/validate. */
export type WorkspaceErrorContext = 'add' | 'check' | 'rename' | 'docs-root'

export interface WorkspaceErrorOptions {
  context?: WorkspaceErrorContext
  /** The registered workspace's display name, for `WORKSPACE_DUPLICATE`. */
  existingName?: string | null
  /** `~/.config/corner-office` (or the profile's equivalent), for `CONFIG_WRITE_FAILED`. */
  configDirDisplay?: string | null
}

/** Shown for any code the table does not know. Never carries the thrown message. */
export const UNKNOWN_ERROR_COPY = 'Something went wrong. Nothing was changed.'

const TIMEOUT_COPY = "That folder isn't responding. It may be on a slow or unmounted drive."
const TIMEOUT_CHECK_COPY = 'Still not responding.'

type CopyFn = (options: WorkspaceErrorOptions) => string
const fixed =
  (text: string): CopyFn =>
  () =>
    text

/**
 * Every IPC error code, minus the four that never carry workspace copy and so fall to `UNKNOWN_ERROR_COPY` on purpose:
 *  - `PERMISSION_DENIED`: the sender/origin check; it only fires for a foreign frame, never for something the user did.
 *  - `LOCK_TIMEOUT`: a config-lock timeout from the retired `ConfigManager`; no registry channel produces it.
 *  - `STALE_WRITE`: a docs/code file changed on disk; the docs and code editors have their own copy.
 *  - `SANDBOX_OFF_IN_PROFILE`: a sandbox channel in a profile with sandboxes off; the sandbox UI has its own copy.
 * Anything else main can send needs a sentence here, or `tsc` fails (see the `satisfies` below).
 */
export type RequiredCopyCode = Exclude<IpcErrorCode, 'PERMISSION_DENIED' | 'LOCK_TIMEOUT' | 'STALE_WRITE' | 'SANDBOX_OFF_IN_PROFILE'>

/**
 * An exhaustive `Record` over `RequiredCopyCode`: adding a code to main's `IPC_ERROR_CODES` without copy here is a
 * compile error (and so is copy for a code main does not have). The §3.7 sentences are verbatim.
 */
export const WORKSPACE_ERROR_COPY = {
  WORKSPACE_PATH_NOT_FOUND: fixed("That folder doesn't exist anymore."),
  WORKSPACE_NOT_A_DIRECTORY: fixed("That's a file, not a folder."),
  WORKSPACE_UNSAFE_ROOT: fixed("Corner Office can't use your home folder or a folder above it. Pick a project folder."),
  WORKSPACE_APP_FOLDER: fixed('That folder holds Corner Office or Claude data. Pick a project folder.'),
  WORKSPACE_DUPLICATE: ({ existingName }) => (existingName ? `Already added as ${existingName}.` : 'This folder is already in your workspaces.'),
  WORKSPACE_EXISTS: fixed('A folder with that name already exists here.'),
  WORKSPACE_NAME_INVALID: fixed('Use letters, numbers, spaces, dots, dashes or underscores (up to 64), starting with a letter or number.'),
  WORKSPACE_BUSY_TERMINAL: fixed('A session is running in this workspace. End it first.'),
  WORKSPACE_BUSY_SANDBOX: fixed('Its sandbox is running. End the sandbox session first.'),
  WORKSPACE_LIMIT: fixed("You've reached the limit of 500 workspaces. Remove some first."),
  // Not shown as an error: the Discover dialog attaches to the running scan. Copy exists so the table stays exhaustive.
  DISCOVERY_BUSY: fixed('A scan is already running.'),
  CONFIG_INVALID: fixed('Corner Office refused to save an invalid change. Nothing was written. Please report this.'),
  CONFIG_WRITE_FAILED: ({ configDirDisplay }) =>
    `Couldn't save to ${configDirDisplay || 'the settings folder'}. Check that the folder is writable and the disk isn't full.`,
  NOT_READY: fixed('Corner Office is still starting. Try again in a moment.'),
  TIMEOUT: ({ context }) => (context === 'check' ? TIMEOUT_CHECK_COPY : TIMEOUT_COPY),
  NOT_FOUND: fixed("That workspace isn't in your list any more."),
  VALIDATION_ERROR: ({ context }) =>
    context === 'rename'
      ? 'Use up to 64 characters, without slashes or control characters.'
      : context === 'docs-root'
        ? 'Enter a full path starting with /, or use Browse…'
        : "That input isn't valid.",
  INTERNAL_ERROR: fixed(UNKNOWN_ERROR_COPY),
} as const satisfies Record<RequiredCopyCode, CopyFn>

export type WorkspaceErrorCode = keyof typeof WORKSPACE_ERROR_COPY

export function isWorkspaceErrorCode(code: unknown): code is WorkspaceErrorCode {
  return typeof code === 'string' && Object.hasOwn(WORKSPACE_ERROR_COPY, code)
}

/** The sentence for `code`. An unknown or missing code gets `UNKNOWN_ERROR_COPY`; a thrown message is never rendered. */
export function workspaceErrorMessage(code: string | undefined | null, options: WorkspaceErrorOptions = {}): string {
  return isWorkspaceErrorCode(code) ? WORKSPACE_ERROR_COPY[code](options) : UNKNOWN_ERROR_COPY
}

// ---------------------------------------------------------------------------
// Availability (§4.5). The five states are used verbatim; `checking` is the transient stub.
// ---------------------------------------------------------------------------

export const CHECKING_COPY = 'Checking this folder…'

/** What Remove and add again costs, said where a user would reach for it (UX M4). */
export const MOVED_FOLDER_COPY = 'If you moved it, remove it and add the new location. Its name, docs-root setting and sandbox allowlist will be reset.'

/** Why Browse Docs and Browse Code are off while the folder is not usable. */
export const BROWSE_UNAVAILABLE_COPY = "This folder isn't available right now"

export const AVAILABILITY_COPY: Readonly<Record<Exclude<Availability, 'ok'>, (path: string) => string>> = {
  checking: () => CHECKING_COPY,
  missing: (path) => `Folder not found: ${path}. It may be on an unmounted drive. ${MOVED_FOLDER_COPY}`,
  unreachable: () => 'Folder not responding. It may be on an unmounted or slow drive.',
  'not-a-directory': () => 'This path is now a file, not a folder.',
  unsafe: () => "Corner Office can't use this folder: it is your home folder, a folder above it, or one of the app's own folders.",
  moved: () => `This folder now points somewhere else. ${MOVED_FOLDER_COPY}`,
  // Not the folder's fault: other slow folders are using up the checks. "Check again" retries it.
  budget: () => 'Not checked yet: too many folders are still responding slowly. This folder may be fine. Check again in a moment.',
}

/** The short badge name for a non-`ok` state. */
export const AVAILABILITY_BADGE: Readonly<Record<Exclude<Availability, 'ok'>, string>> = {
  checking: 'Checking',
  missing: 'Missing',
  unreachable: 'Not responding',
  'not-a-directory': 'Not a folder',
  unsafe: 'Unavailable',
  moved: 'Moved',
  budget: 'Not checked yet',
}

/** A few words for where there is little room (a realm building's label): "folder not found". */
export const AVAILABILITY_SHORT: Readonly<Record<Exclude<Availability, 'ok'>, string>> = {
  checking: 'checking folder',
  missing: 'folder not found',
  unreachable: 'folder not responding',
  'not-a-directory': 'now a file, not a folder',
  unsafe: 'folder not usable',
  moved: 'folder moved',
  budget: 'not checked yet',
}

// ---------------------------------------------------------------------------
// Create warnings (§4.2): fixed tokens from main, expanded here. `path` is the new folder.
// ---------------------------------------------------------------------------

export const CREATE_WARNING_COPY: Readonly<Record<CreateWarning, (path: string) => string>> = {
  'git-unavailable': () => "Created. Git wasn't found, so the folder isn't a git repository yet.",
  'git-init-failed': (path) => `Created, but \`git init\` failed. Run it yourself in ${path}.`,
  'git-commit-failed': (path) => `Created, but the first commit failed: set \`user.name\` and \`user.email\`, then commit in ${path}.`,
}

// ---------------------------------------------------------------------------
// Store health (§4.9). `file` is the store's file name; the damaged copy is kept as `<file>.corrupt-…`.
// ---------------------------------------------------------------------------

export type DamagedStoreHealth = 'recovered-from-backup' | 'recovered-partial' | 'reset-to-defaults' | 'unreadable'

/** One sentence per store and state, each with the next step. */
const STORE_HEALTH_SENTENCES: Readonly<Record<StoreName, Readonly<Record<DamagedStoreHealth, string>>>> = {
  workspaces: {
    'recovered-from-backup': "Your workspace list was damaged, so the last backup was restored. Recent changes may be missing: check the list, then run Discover or Add folder for anything that's gone.",
    'recovered-partial': 'Some workspaces in your list were unreadable and were left out. Run Discover or Add folder to bring them back.',
    'reset-to-defaults': "Your workspace list couldn't be read, so it was reset and is empty. Run Discover or Add folder to rebuild it.",
    unreadable: "Your workspace list couldn't be read just now, so it may look empty. Nothing was changed. Check that the settings folder is readable; it is tried again on its own.",
  },
  settings: {
    'recovered-from-backup': 'Your settings were damaged, so the last backup was restored. Recent changes may be missing: check them in Settings.',
    'recovered-partial': 'Some of your settings were unreadable and were reset. Check them in Settings.',
    'reset-to-defaults': "Your settings couldn't be read, so they were reset to the defaults. Set them again in Settings.",
    unreadable: "Your settings couldn't be read just now, so the defaults are showing. Nothing was changed. Check that the settings folder is readable; it is tried again on its own.",
  },
  sandbox: {
    'recovered-from-backup': 'Your sandbox settings were damaged, so the last backup was restored. Recent changes may be missing: check them in the Armory.',
    'recovered-partial': 'Some of your sandbox settings were unreadable and were reset. Check them in the Armory.',
    'reset-to-defaults': "Your sandbox settings couldn't be read. Allowlists, ports and extra packages were reset to the defaults. Re-enter them in the Armory.",
    unreadable: "Your sandbox settings couldn't be read just now, so the defaults are showing. Nothing was changed. Check that the settings folder is readable; it is tried again on its own.",
  },
  sessionDefaults: {
    'recovered-from-backup': 'Your remembered session choices were damaged, so the last backup was restored. Check them the next time you start a session.',
    'recovered-partial': 'Some remembered session choices were unreadable and were forgotten. Pick them again when you start a session.',
    'reset-to-defaults': "Your remembered session choices couldn't be read and were reset. Pick them again when you start a session.",
    unreadable: "Your remembered session choices couldn't be read just now. Nothing was changed. Check that the settings folder is readable; it is tried again on its own.",
  },
}

/**
 * The notice line for a damaged store. `corruptName` is the real `<file>.corrupt-<ts>` basename main kept (when it has
 * set the damaged file aside yet): it is named so the user can find it. An `unreadable` file was not touched.
 */
export function storeHealthMessage(store: StoreName, state: DamagedStoreHealth, corruptName?: string): string {
  const sentence = STORE_HEALTH_SENTENCES[store][state]
  return corruptName && state !== 'unreadable' ? `${sentence} The damaged file was kept as ${corruptName}.` : sentence
}

// ---------------------------------------------------------------------------
// Empty states (§4.7)
// ---------------------------------------------------------------------------

export const EMPTY_COPY = {
  office: 'No workspaces yet. Try Discover to look for projects, or add a folder.',
  realm: 'Your realm has no lands yet. Try Discover to look for projects, or add a folder to found the first one.',
} as const

// Discover dialog (UX M1, M2).
export const DISCOVER_SUBTITLE = 'Looking for folders that contain .rix in your home folder. Nothing is changed.'
export const DISCOVER_NO_RESULTS_COPY = 'No Rix projects found. Use Add folder to add any folder, or New workspace to start one.'

/**
 * The one-time upgrade notice, shown while an old `config.json` is still in the data folder and the user has not
 * dismissed it (UX H1). Neither the workspace list nor the sandbox settings are migrated.
 */
export const LEGACY_NOTICE_COPY =
  "Your earlier workspace list and sandbox settings weren't carried over. Run Discover to find your projects. Sandbox network allowlists, ports and extra packages were reset to safe defaults. Only add back what you still need, in the Armory."

/** A workspace without a `.rix` folder opens normally; its Rix panels say why they are empty (TRD §4.1). */
export const NOT_RIX_COPY = 'Not a Rix workspace yet. Rix creates `.rix/` the first time it runs here.'

export const NO_DOCS_FOLDER_COPY = 'No docs folder'

/** The repo's chosen docs folder is one of the app's own folders (for example `~/.claude`), and so is `<path>/docs`. */
export const DOCS_ROOT_REFUSED_COPY = "Docs are off: the chosen docs folder is one of the app's own folders. Pick another docs folder."

/** Why Start session is unavailable while the folder is not usable. */
export const START_UNAVAILABLE_COPY = "This folder isn't available right now. Check it again, or remove it."

export const CONFIG_DIR_MISMATCH_COPY =(configDirDisplay: string): string =>
  `Settings are saved in ${configDirDisplay}, which differs from Electron's data folder. Check \`XDG_CONFIG_HOME\`.`

const DAMAGED_HEALTH: ReadonlySet<string> = new Set<DamagedStoreHealth>(['recovered-from-backup', 'recovered-partial', 'reset-to-defaults', 'unreadable'])

export function isDamagedStoreHealth(health: string): health is DamagedStoreHealth {
  return DAMAGED_HEALTH.has(health)
}
