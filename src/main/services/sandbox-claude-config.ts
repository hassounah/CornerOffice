import fs from 'fs'
import path from 'path'
import log from 'electron-log/main'
import { z } from 'zod'
import { MAX_FILE_SIZE, readRegularFileCappedSync } from './safe-fs'
import { settingsOverlayPath, sandboxClaudeJsonPath, claudeShadowSource } from './sandbox-spec'
import type { SandboxPaths } from './sandbox-paths'
import type { ClaudeConfigLabel, ClaudeConfigProblem } from '../types/claude-config'

// ---------------------------------------------------------------------------
// sandbox-claude-config.ts — #0030 read-only Claude config for sandboxes
// (TRD §4.2, D1, D4–D8).
//
// Creates any missing `~/.claude` mount source, writes the per-workspace
// settings copy (`permissions.ask` stripped) and seeds the per-sandbox
// `~/.claude.json`. Everything is written in place (never replaced via a temp file: a single-file
// bind mount pins the inode, D4) and nothing here spawns a process.
//
// Logging carries the slug, a fixed label and a reason only — never file
// contents (they hold secrets: `env`, MCP env, account metadata).
// ---------------------------------------------------------------------------

/** `~/.claude.json` grows with project history (120 KB today); D5. */
export const CLAUDE_JSON_SEED_CAP = 16 * 1024 * 1024

export type { ClaudeConfigLabel, ClaudeConfigProblem }

export type ClaudeConfigResult = { ok: true } | { ok: false; label: ClaudeConfigLabel; problem: ClaudeConfigProblem }

export type SanitizeSettingsResult =
  | { ok: true; json: string }
  | { ok: false; reason: 'parse' | 'not-object' | 'permissions-not-object' }

/**
 * Always denied in the sandbox copy. Stripping `ask` removes the human gate, so
 * publishing to the forge stays a host action (ideas.md: the user pushes and
 * opens PRs from the host), even if credentials ever reach the container.
 */
export const SANDBOX_DENY_RULES = ['Bash(*git push*)', 'Bash(*gh pr create*)', 'Bash(*gh pr merge*)', 'Bash(*gh api*)'] as const

const TAG = '[sandbox-claude-config]'
const settingsObjectSchema = z.record(z.string(), z.unknown())

function fail(slug: string, label: ClaudeConfigLabel, problem: ClaudeConfigProblem): ClaudeConfigResult {
  log.warn(`${TAG} ${slug}: ${label} ${problem}`)
  return { ok: false, label, problem }
}

/**
 * Pure transform (D1): drop `permissions.ask`, add `SANDBOX_DENY_RULES` to
 * `permissions.deny`, keep everything else as-is. `null` (no file) is treated
 * as an empty settings object.
 */
export function sanitizeUserSettings(raw: string | null): SanitizeSettingsResult {
  let parsed: unknown
  if (raw === null) raw = '{}'
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'parse' }
  }
  const top = settingsObjectSchema.safeParse(parsed)
  if (!top.success || Array.isArray(parsed)) return { ok: false, reason: 'not-object' }
  const obj = top.data
  const permissions = obj.permissions ?? {}
  if (typeof permissions !== 'object' || permissions === null || Array.isArray(permissions)) {
    return { ok: false, reason: 'permissions-not-object' }
  }
  const perms = permissions as Record<string, unknown>
  delete perms.ask
  if (perms.deny !== undefined && !Array.isArray(perms.deny)) return { ok: false, reason: 'permissions-not-object' }
  const deny: unknown[] = perms.deny ?? []
  perms.deny = [...deny, ...SANDBOX_DENY_RULES.filter((rule) => !deny.includes(rule))]
  obj.permissions = perms
  return { ok: true, json: JSON.stringify(obj, null, 2) + '\n' }
}

/**
 * D4: open without following a final symlink, refuse non-regular files, then
 * truncate and write the same inode. `O_NONBLOCK` keeps a planted FIFO from
 * hanging the open (it fails with ENXIO instead).
 */
function writeInPlace(target: string, data: string | Buffer): void {
  const { O_WRONLY, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  const fd = fs.openSync(target, O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file')
    fs.ftruncateSync(fd, 0)
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    let written = 0
    while (written < buf.length) written += fs.writeSync(fd, buf, written, buf.length - written)
    fs.fsyncSync(fd)
    fs.fchmodSync(fd, 0o600)
  } finally {
    fs.closeSync(fd)
  }
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p)
  } catch {
    return null
  }
}

interface Source {
  label: ClaudeConfigLabel
  path: string
  kind: 'dir' | 'file'
  initial: string
}

/** Every host path under `~/.claude` that is mounted over: the read-only sources and the shadowed targets. */
function sourcesOf(paths: SandboxPaths): Source[] {
  const dirs: Source[] = [...paths.claudeRoDirs, ...paths.claudeShadowDirs].map((p) => ({
    label: path.basename(p) as ClaudeConfigLabel,
    path: p,
    kind: 'dir',
    initial: '',
  }))
  return [
    ...dirs,
    { label: 'CLAUDE.md', path: paths.claudeMd, kind: 'file', initial: '' },
    { label: 'settings.local.json', path: paths.claudeSettingsLocal, kind: 'file', initial: '{}' },
    { label: 'settings.json', path: paths.claudeSettings, kind: 'file', initial: '{}' },
  ]
}

type SourceCheck = { ok: true; missing: Source[] } | { ok: false; label: ClaudeConfigLabel; problem: ClaudeConfigProblem }

function checkSources(paths: SandboxPaths): SourceCheck {
  const missing: Source[] = []
  for (const s of sourcesOf(paths)) {
    const st = lstatOrNull(s.path)
    if (st === null) {
      missing.push(s)
      continue
    }
    if (st.isSymbolicLink()) return { ok: false, label: s.label, problem: 'symlink' }
    if (s.kind === 'dir' ? !st.isDirectory() : !st.isFile()) return { ok: false, label: s.label, problem: 'wrong-type' }
  }
  return { ok: true, missing }
}

/**
 * Read-only check for eligibility (lstat only: no writes, no parsing), so a
 * symlinked or wrong-type source is reported before Start rather than at it.
 * A missing source is fine here: `prepareClaudeConfig` creates it.
 */
export function checkClaudeConfigSources(paths: SandboxPaths): ClaudeConfigResult {
  const check = checkSources(paths)
  return check.ok ? { ok: true } : check
}

/** D8: validate every existing source first so a wrong type writes nothing; then create the missing ones. */
function ensureSources(paths: SandboxPaths, slug: string): ClaudeConfigResult {
  const check = checkSources(paths)
  if (!check.ok) return fail(slug, check.label, check.problem)
  for (const s of check.missing) {
    try {
      if (s.kind === 'dir') {
        fs.mkdirSync(s.path, { mode: 0o700 })
      } else {
        const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants
        const fd = fs.openSync(s.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        try {
          fs.writeSync(fd, s.initial)
        } finally {
          fs.closeSync(fd)
        }
      }
    } catch {
      return fail(slug, s.label, 'write-failed')
    }
  }
  return { ok: true }
}

/** The per-slug state dir holds both copies and the shadow dirs; each must be a real directory (D3, C1). */
function ensureStateDir(paths: SandboxPaths, slug: string): ClaudeConfigResult {
  const dir = path.dirname(settingsOverlayPath(paths, slug))
  const shadows = paths.claudeShadowDirs.map((d) => claudeShadowSource(paths, slug, d))
  for (const d of [dir, path.dirname(shadows[0]), ...shadows]) {
    try {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    } catch {
      return fail(slug, 'sandbox-state', 'write-failed')
    }
    const st = lstatOrNull(d)
    if (st === null || st.isSymbolicLink() || !st.isDirectory()) return fail(slug, 'sandbox-state', 'wrong-type')
  }
  return { ok: true }
}

function writeSettingsCopy(paths: SandboxPaths, slug: string): ClaudeConfigResult {
  const read = readRegularFileCappedSync(paths.claudeSettings, MAX_FILE_SIZE)
  if (read === null) return fail(slug, 'settings.json', 'unreadable')
  if (read.size > MAX_FILE_SIZE) return fail(slug, 'settings.json', 'too-large')
  const sanitized = sanitizeUserSettings(read.buf.toString('utf8'))
  if (!sanitized.ok) return fail(slug, 'settings.json', 'invalid-json')
  try {
    writeInPlace(settingsOverlayPath(paths, slug), sanitized.json)
  } catch {
    return fail(slug, 'settings.json', 'write-failed')
  }
  return { ok: true }
}

/** D6(ii): byte copy of the host `~/.claude.json`, written in place. */
export function seedClaudeJson(paths: SandboxPaths, slug: string): ClaudeConfigResult {
  const state = ensureStateDir(paths, slug)
  if (!state.ok) return state
  const read = readRegularFileCappedSync(paths.claudeJson, CLAUDE_JSON_SEED_CAP)
  if (read === null) return fail(slug, '.claude.json', 'unreadable')
  if (read.size > CLAUDE_JSON_SEED_CAP) return fail(slug, '.claude.json', 'too-large')
  try {
    writeInPlace(sandboxClaudeJsonPath(paths, slug), read.buf)
  } catch {
    return fail(slug, '.claude.json', 'write-failed')
  }
  return { ok: true }
}

/**
 * Runs on every create, reuse and recreate: ensures the mount sources exist,
 * rewrites the settings copy, and seeds `claude.json` only when it is absent.
 */
export function prepareClaudeConfig(paths: SandboxPaths, slug: string): ClaudeConfigResult {
  const sources = ensureSources(paths, slug)
  if (!sources.ok) return sources
  const state = ensureStateDir(paths, slug)
  if (!state.ok) return state
  const settings = writeSettingsCopy(paths, slug)
  if (!settings.ok) return settings
  if (lstatOrNull(sandboxClaudeJsonPath(paths, slug)) === null) return seedClaudeJson(paths, slug)
  return { ok: true }
}
