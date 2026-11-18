import log from 'electron-log/main'
import fs from 'fs'
import path from 'path'
import { configDir, configDirDisplay, coHome, coHomeDisplay, ensureConfigDir, ensureDataDir } from './app-home'
import type { WorkspaceRuntime } from './workspace-runtime'
import type { WorkspaceRegistry } from './workspace-registry'

// ---------------------------------------------------------------------------
// startup-registry.ts — the registry half of startup (#0039, TRD §3.11), pulled out of `index.ts` so it can be
// tested without an Electron app.
//
//   prepareConfig()  Phase 3: the fatal config/data dir checks, the config dir log line, the legacy
//                    config.json line, the userData mismatch check, and the pure store reads.
//   startRegistry()  Phases 3-5: `await registry.reconcile()`, then `runtime.init(...)`, which returns at once
//                    with `checking` stubs. READY is therefore never held up by a slow mount.
// ---------------------------------------------------------------------------

/** What startup noticed that the UI should explain (read by `config:getStoreHealth`). */
export interface StartupFlags {
  /** `<coHome>/config.json` exists. It is ignored, never read or modified. */
  legacyConfigPresent: boolean
  /** Electron's `userData` differs from `configDir()` (a changed `XDG_CONFIG_HOME`, for example). */
  configDirMismatch: boolean
}

let flags: StartupFlags = { legacyConfigPresent: false, configDirMismatch: false }

export function getStartupFlags(): Readonly<StartupFlags> {
  return flags
}

/** Test seam. */
export function resetStartupFlagsForTests(): void {
  flags = { legacyConfigPresent: false, configDirMismatch: false }
}

export interface PrepareConfigDeps {
  /** `app.getPath('userData')`. */
  userDataPath: string
  /** Pure reads of the settings and registry stores (they never write). */
  readStores: () => void
  /** `stateCacheService.load()`. */
  loadState: () => void
}

/**
 * Phase 3. `ensureConfigDir()` and `ensureDataDir()` run first and are fatal on a symlinked or foreign-owned
 * folder. Nothing here writes a store file, and the legacy `config.json` is only ever stat'ed.
 */
export function prepareConfig(deps: PrepareConfigDeps): StartupFlags {
  ensureConfigDir()
  ensureDataDir()
  log.info(`[Config] Config dir: ${configDir()}`)

  const legacyConfigPresent = fs.existsSync(path.join(coHome(), 'config.json'))
  if (legacyConfigPresent) {
    log.info(`[Config] Ignoring legacy ${coHomeDisplay()}/config.json; settings now live in ${configDirDisplay()} (#0039). It is not read or modified.`)
  }

  const configDirMismatch = path.resolve(deps.userDataPath) !== path.resolve(configDir())
  if (configDirMismatch) {
    log.warn(`[Config] Electron's userData (${deps.userDataPath}) differs from the config dir (${configDir()}). Check XDG_CONFIG_HOME.`)
  }

  deps.readStores()
  deps.loadState()
  flags = { legacyConfigPresent, configDirMismatch }
  return flags
}

export interface StartRegistryDeps {
  registry: Pick<WorkspaceRegistry, 'reconcile' | 'list'>
  runtime: Pick<WorkspaceRuntime, 'init'>
}

/**
 * Prune registry-keyed state, then hand the entries to the runtime. `reconcile` is skipped inside the registry
 * unless the registry file was read cleanly, so corruption never cascades into deleting sandbox allowlists.
 * A reconcile failure is logged and never blocks startup.
 */
export async function startRegistry(deps: StartRegistryDeps): Promise<void> {
  try {
    await deps.registry.reconcile()
  } catch (err) {
    log.warn('[Registry] reconcile failed:', err instanceof Error ? err.name : 'error')
  }
  await deps.runtime.init(deps.registry.list())
}
