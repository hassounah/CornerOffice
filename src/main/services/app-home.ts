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
  /** Settings and registry files (#0039): `${XDG_CONFIG_HOME:-~/.config}/corner-office` | `<home>/electron`. */
  configDir: string
  /** `configDir` with the home directory shown as `~`, for display only. */
  configDirDisplay: string
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

/** The default profile's config dir. A relative XDG_CONFIG_HOME is ignored (Sec L3). */
function defaultConfigDirs(env: NodeJS.ProcessEnv, realHome: string): { dir: string; display: string } {
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && path.isAbsolute(xdg)) {
    const dir = path.join(xdg, 'corner-office')
    return { dir, display: dir }
  }
  return { dir: path.join(realHome, '.config', 'corner-office'), display: '~/.config/corner-office' }
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
      'refusing to start with the default profile inside a sandbox (CORNER_OFFICE_SANDBOX=1): it would rotate your live session\'s events and connect to its own channel. Run: make dev',
    )
  }

  const home = name === null ? baseHome : path.join(baseHome, 'profiles', name)
  const realClaudeHome = path.join(realHome, '.claude')
  const claudeHomeDir = sandbox ? path.join(home, 'claude') : realClaudeHome
  if (sandbox && claudeHomeDir === realClaudeHome) {
    throw new ProfileError(`sandbox mode must not use the real Claude home (${realClaudeHome})`)
  }

  const defaults = defaultConfigDirs(env, realHome)
  return {
    name,
    home,
    homeDisplay: name === null ? '~/.corner-office' : `~/.corner-office/profiles/${name}`,
    userDataDir: name === null ? null : path.join(home, 'electron'),
    configDir: name === null ? defaults.dir : path.join(home, 'electron'),
    configDirDisplay: name === null ? defaults.display : `~/.corner-office/profiles/${name}/electron`,
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
  const defaults = defaultConfigDirs(process.env, realHome)
  return {
    name: null,
    home: path.join(realHome, '.corner-office'),
    homeDisplay: '~/.corner-office',
    userDataDir: null,
    configDir: defaults.dir,
    configDirDisplay: defaults.display,
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

/** Where settings and the workspace registry live. Same freeze tripwire as `coHome()`. */
export function configDir(): string {
  return current().configDir
}

export function configDirDisplay(): string {
  return current().configDirDisplay
}

/**
 * The default profile's config dir for `realHome` (an absolute `XDG_CONFIG_HOME` is honoured), whatever profile is
 * active. In sandbox mode the real app's settings live here, and a workspace must never be or contain them.
 */
export function defaultConfigDir(realHome: string, env: NodeJS.ProcessEnv = process.env): string {
  return defaultConfigDirs(env, realHome).dir
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

/** Why `dir` is unsafe to keep settings in (a symlink, a non-directory, a foreign owner), or null. A missing dir is not unsafe. */
function configDirProblem(dir: string): string | null {
  let st: fs.Stats
  try {
    st = fs.lstatSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    // Any other failure (EACCES, ENOTDIR, ELOOP...) is not "safe": a typed error with a fixed message, never the raw
    // fs error, which carries the path.
    throw new ProfileError(`the settings folder cannot be inspected (${typeof code === 'string' ? code : 'unknown error'}). Check its permissions, or point XDG_CONFIG_HOME somewhere else.`)
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return `config folder ${dir} is not a plain directory (it is a symlink or a file). Remove it, or point XDG_CONFIG_HOME somewhere else.`
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  if (uid !== null && st.uid !== uid) {
    return `config folder ${dir} is owned by uid ${st.uid}, not you (uid ${uid}). Remove it, or point XDG_CONFIG_HOME somewhere else.`
  }
  return null
}

/**
 * Create the config dir (0700), tighten a looser one, and exit fatally on a symlink, a
 * non-directory or a foreign owner: the app never runs on a config dir it does not own.
 */
export function ensureConfigDir(): void {
  const dir = configDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let problem: string | null
  try {
    problem = configDirProblem(dir)
  } catch (err) {
    // A folder that cannot even be inspected is as unusable as a symlinked one: say so (fixed, path-free message) and exit.
    if (!(err instanceof ProfileError)) throw err
    problem = err.message
  }
  if (problem) fatalProfileError(problem)
  const st = fs.lstatSync(dir)
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
}

/** The same ownership checks as `ensureConfigDir`, for use after startup: throws a plain error and never exits. */
export function assertConfigDirSafe(): void {
  const problem = configDirProblem(configDir())
  if (problem) throw new Error(problem)
}

/** Create the data dir (`coHome()`) and its `events/` dir, both 0700. */
export function ensureDataDir(): void {
  const dir = coHome()
  for (const d of [dir, path.join(dir, 'events')]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    } else {
      fs.chmodSync(d, 0o700)
    }
  }
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
