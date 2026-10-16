import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { resolveRealHome } from './sandbox-paths'

// ---------------------------------------------------------------------------
// app-home.ts — which "home" this Corner Office instance uses (#0038, TRD §3.1).
//
// The default profile behaves exactly as before. A named profile
// (CORNER_OFFICE_PROFILE=dev) gets its own directory under
// `~/.corner-office/profiles/<name>`. This module is the ONLY reader of
// CORNER_OFFICE_SANDBOX, CORNER_OFFICE_PROFILE and CORNER_OFFICE_DEBUG_PORT.
//
// No filesystem access happens at import time (`security.test.ts` imports
// `main/index.ts` with a partial `fs` mock).
// ---------------------------------------------------------------------------

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

const PACKAGED_WARNING = 'CORNER_OFFICE_PROFILE/CORNER_OFFICE_DEBUG_PORT are ignored in packaged builds.'

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

export interface Profile {
  /** null = the default profile (today's behaviour). */
  name: string | null
  /** `<realHome>/.corner-office` | `<realHome>/.corner-office/profiles/<name>`. */
  home: string
  /** `~/.corner-office` | `~/.corner-office/profiles/<name>`, for display only. */
  homeDisplay: string
  /** null = Electron default | `<home>/electron`. */
  userDataDir: string | null
  /** null = electron-log default | `<home>/logs/main.log`. */
  logFile: string | null
  /** CORNER_OFFICE_DEBUG_PORT; unpackaged only. */
  debugPort: number | null
  /** Sandbox mode: `<home>/claude`; otherwise `<realHome>/.claude`. */
  claudeHome: string
  /** Sandbox mode: `[appPath]`; otherwise `[realHome]`. */
  discoveryRoots: string[]
  /** Set when the env vars were present in a packaged build and ignored. */
  warning: string | null
}

export function isInSandbox(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CORNER_OFFICE_SANDBOX === '1'
}

export interface ResolveOptions {
  isPackaged: boolean
  realHome: string
  appPath: string
}

export function resolveProfile(env: NodeJS.ProcessEnv, opts: ResolveOptions): Profile {
  const { isPackaged, realHome, appPath } = opts
  const baseHome = path.join(realHome, '.corner-office')
  const rawName = env.CORNER_OFFICE_PROFILE ?? ''
  const rawPort = env.CORNER_OFFICE_DEBUG_PORT ?? ''

  let name: string | null = null
  let debugPort: number | null = null
  let warning: string | null = null

  if (isPackaged) {
    if (rawName !== '' || rawPort !== '') warning = `Corner Office: ${PACKAGED_WARNING}`
  } else {
    if (rawName !== '' && rawName !== 'default') {
      if (!PROFILE_NAME_RE.test(rawName)) {
        throw new ProfileError(
          `CORNER_OFFICE_PROFILE="${rawName}" is invalid. Use 1-32 lowercase letters, digits or '-', starting with a letter or digit. Example: CORNER_OFFICE_PROFILE=dev`,
        )
      }
      name = rawName
    }
    if (rawPort !== '') {
      const port = /^\d+$/.test(rawPort) ? Number(rawPort) : NaN
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new ProfileError(
          `CORNER_OFFICE_DEBUG_PORT="${rawPort}" is invalid. Use a port from 1024 to 65535, or unset it. Example: CORNER_OFFICE_DEBUG_PORT=9223`,
        )
      }
      debugPort = port
    }
  }

  const sandbox = isInSandbox(env)
  if (sandbox && name === null) {
    throw new ProfileError(
      'refusing to start with the default profile inside a sandbox (CORNER_OFFICE_SANDBOX=1): it would rotate your live session\'s events and connect to its own channel. Run: make dev-sandbox',
    )
  }

  const home = name === null ? baseHome : path.join(baseHome, 'profiles', name)
  const realClaudeHome = path.join(realHome, '.claude')
  const claudeHomeDir = sandbox ? path.join(home, 'claude') : realClaudeHome
  if (sandbox && claudeHomeDir === realClaudeHome) {
    throw new ProfileError(`sandbox mode must not use the real Claude home (${realClaudeHome})`)
  }

  return {
    name,
    home,
    homeDisplay: name === null ? '~/.corner-office' : `~/.corner-office/profiles/${name}`,
    userDataDir: name === null ? null : path.join(home, 'electron'),
    logFile: name === null ? null : path.join(home, 'logs', 'main.log'),
    debugPort,
    claudeHome: claudeHomeDir,
    discoveryRoots: sandbox ? [appPath] : [realHome],
    warning,
  }
}

let active: Profile | null = null
let fallbackRead = false

function current(): Profile {
  if (active) return active
  fallbackRead = true
  const realHome = resolveRealHome()
  return {
    name: null,
    home: path.join(realHome, '.corner-office'),
    homeDisplay: '~/.corner-office',
    userDataDir: null,
    logFile: null,
    debugPort: null,
    claudeHome: path.join(realHome, '.claude'),
    discoveryRoots: [realHome],
    warning: null,
  }
}

/**
 * Install the profile for this process. Throws if a path getter already
 * answered through the default fallback: something froze the default home
 * at import time, before the profile was known.
 */
export function setActiveProfile(p: Profile): void {
  if (fallbackRead) {
    throw new Error('setActiveProfile called after coHome()/claudeHome()/coHomeDisplay() was read with no active profile')
  }
  active = p
}

/** The active profile, or the default one. */
export function activeProfile(): Profile {
  return current()
}

export function coHome(): string {
  return current().home
}

/**
 * The active profile's home, or `fallback` when none is set. Unlike `coHome()` it
 * never consults `resolveRealHome()` and never trips the freeze tripwire: for callers
 * that already hold their own `realHome` (`sandboxPaths(realHome)`).
 */
export function coHomeOr(fallback: string): string {
  return active ? active.home : fallback
}

/** True when a named (non-default) profile is active. Never consults the real home and never trips the freeze tripwire. */
export function isNonDefaultProfile(): boolean {
  return active !== null && active.name !== null
}

export function coHomeDisplay(): string {
  return current().homeDisplay
}

export function claudeHome(): string {
  return current().claudeHome
}

export function discoveryRoots(): string[] {
  return current().discoveryRoots
}

/** Test seam: forget the active profile and the tripwire. */
export function resetActiveProfileForTests(): void {
  active = null
  fallbackRead = false
}

/** Write one line to stderr (synchronously: the process may be about to exit), then exit. */
export function fatalProfileError(msg: string, code = 1): never {
  fs.writeSync(2, `Corner Office: ${msg}\n`)
  app.exit(code)
  process.exit(code)
}

/** Create a non-default profile's home (0700), tighten an existing looser one, and refuse a symlink or a directory owned by someone else. */
export function ensureProfileHome(p: Profile): void {
  if (p.name === null) return
  fs.mkdirSync(p.home, { recursive: true, mode: 0o700 })
  const st = fs.lstatSync(p.home)
  if (st.isSymbolicLink() || !st.isDirectory()) {
    fatalProfileError(`profile home ${p.home} is not a plain directory (it is a symlink or a file). Remove it, or pick another CORNER_OFFICE_PROFILE.`)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== uid) {
    fatalProfileError(`profile home ${p.home} is owned by uid ${st.uid}, not you (uid ${uid}). Remove it, or pick another CORNER_OFFICE_PROFILE.`)
  }
  // mkdirSync leaves an existing directory (for example one electron-log created) at its old mode.
  if ((st.mode & 0o077) !== 0) fs.chmodSync(p.home, 0o700)
}
