import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  SANDBOX_IMAGE,
  SANDBOX_SLUG_RE,
  CHANNEL_PORT_RANGE,
  STOP_TIMEOUT_S,
  SANDBOX_KILL_TIMEOUT_MS,
  LABEL,
  ROOT_EXEC_ENV,
  containerName,
  worktreePath,
  cardDir,
  assertMountSafe,
  validateEnvValue,
  validateBuildIds,
  worktreePin,
  pickChannelPort,
} from '../main/services/sandbox-spec'
import { sandboxPaths } from '../main/services/sandbox-paths'

// ---------------------------------------------------------------------------
// sandbox-spec-naming.test.ts (TRD §3.2, §3.6.4, §10.4, D13, H1, SEC-M2)
// ---------------------------------------------------------------------------

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// ── Constants ────────────────────────────────────────────────────────────

describe('constants', () => {
  it('SANDBOX_KILL_TIMEOUT_MS is 15000 (H-B1: stop timeout + slack)', () => {
    expect(SANDBOX_KILL_TIMEOUT_MS).toBe(15000)
  })

  it('SANDBOX_IMAGE, CHANNEL_PORT_RANGE, STOP_TIMEOUT_S, LABEL and ROOT_EXEC_ENV match §3.2', () => {
    expect(SANDBOX_IMAGE).toBe('claude-sandbox:latest')
    expect(CHANNEL_PORT_RANGE).toEqual([20000, 32767])
    expect(STOP_TIMEOUT_S).toEqual({ endSession: 10, quit: 5 })
    expect(LABEL.sandbox).toBe('co.sandbox')
    expect(LABEL.workspace).toBe('co.sandbox.workspace')
    expect(LABEL.spec).toBe('co.sandbox.spec')
    expect(LABEL.build).toBe('co.sandbox.build-hash')
    expect(LABEL.toolchains).toBe('co.sandbox.toolchains')
    expect(ROOT_EXEC_ENV).toEqual(['--env', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', '--env', 'HOME=/root'])
  })
})

// ── Naming: containerName, worktreePath, cardDir ────────────────────────────

describe('naming', () => {
  const paths = sandboxPaths(path.join(path.sep, 'home', 'test'))

  it('containerName is docker-valid by construction', () => {
    expect(containerName('my-workspace')).toBe('co-sandbox-my-workspace')
  })

  it('worktreePath and cardDir derive from the sandboxPaths(realHome) object (SEC-M2)', () => {
    expect(worktreePath(paths, 'my-workspace')).toBe(path.join(paths.sandboxesRoot, 'my-workspace'))
    expect(cardDir(paths, 'my-workspace')).toBe(path.join(paths.sandboxStateRoot, 'my-workspace', 'channels'))
  })
})

// ── Slug table (D13) ─────────────────────────────────────────────────────

describe('SANDBOX_SLUG_RE', () => {
  it.each(['a', 'A1', 'my-workspace', 'my_workspace_2', '0', 'x'.repeat(64)])('%s is valid', (slug) => {
    expect(SANDBOX_SLUG_RE.test(slug)).toBe(true)
  })

  it.each([
    ['-abc', 'leading -'],
    ['_abc', 'leading _'],
    ['x'.repeat(65), '65 chars'],
    ['a.b', 'contains .'],
    ['a b', 'contains a space'],
    ['wörk', 'contains Unicode'],
    ['', 'empty'],
  ])('%s is invalid (%s)', (slug) => {
    expect(SANDBOX_SLUG_RE.test(slug)).toBe(false)
  })
})

// ── assertMountSafe (§3.2) ───────────────────────────────────────────────

describe('assertMountSafe', () => {
  it('rejects a relative path and a non-normalized path', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    expect(assertMountSafe('relative/path', { home })).toBe(false)
    // Built by string concatenation, not path.join (which would normalize
    // it away), so this actually exercises the p !== normalize(p) rule.
    expect(assertMountSafe(`${home}/foo/../bar`, { home })).toBe(false)
  })

  it('rejects a symlink anywhere in the chain (real temp dir)', () => {
    const target = makeTmpDir('co-sandbox-spec-target-')
    const linkParent = makeTmpDir('co-sandbox-spec-link-')
    const symlink = path.join(linkParent, 'link')
    fs.symlinkSync(target, symlink)

    const home = makeTmpDir('co-sandbox-spec-home-')
    expect(assertMountSafe(symlink, { home })).toBe(false)
  })

  it('rejects a missing path (no realpath to compare against)', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    expect(assertMountSafe(path.join(home, 'does-not-exist'), { home })).toBe(false)
  })

  // Linux permits `,` `"` `\n` and `\r` in a real filename, so each of these
  // must actually be rejected by Rule 2 (FORBIDDEN_MOUNT_CHARS_RE) — a path
  // that merely doesn't exist would be rejected by Rule 1 regardless of what
  // Rule 2 does, which wouldn't prove Rule 2 works at all.
  it.each([',', '"', '\n', '\r'])('rejects a real path containing %j', (char) => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    const dirty = path.join(home, `bad${char}name`)
    fs.mkdirSync(dirty)
    expect(assertMountSafe(dirty, { home })).toBe(false)
  })

  it('rejects a path containing \\0 (which cannot exist on disk, so Rule 1 rejects it)', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    expect(assertMountSafe(path.join(home, 'bad\0name'), { home })).toBe(false)
  })

  it('rejects "/"', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    expect(assertMountSafe(path.parse(home).root, { home })).toBe(false)
  })

  it('rejects $HOME itself', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    expect(assertMountSafe(home, { home })).toBe(false)
  })

  it('rejects an ancestor of $HOME', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    expect(assertMountSafe(path.dirname(home), { home })).toBe(false)
  })

  it('rejects ~/.config/autostart and ~/.local/bin (v2 hidden-$HOME rule, H1)', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    const autostart = path.join(home, '.config', 'autostart')
    fs.mkdirSync(autostart, { recursive: true })
    const localBin = path.join(home, '.local', 'bin')
    fs.mkdirSync(localBin, { recursive: true })

    expect(assertMountSafe(autostart, { home })).toBe(false)
    expect(assertMountSafe(localBin, { home })).toBe(false)
  })

  it('accepts ~/.claude, ~/.claude.json and ~/.corner-office/x', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    const claudeDir = path.join(home, '.claude')
    fs.mkdirSync(claudeDir)
    const claudeJson = path.join(home, '.claude.json')
    fs.writeFileSync(claudeJson, '{}')
    const cornerOfficeX = path.join(home, '.corner-office', 'x')
    fs.mkdirSync(cornerOfficeX, { recursive: true })

    expect(assertMountSafe(claudeDir, { home })).toBe(true)
    expect(assertMountSafe(claudeJson, { home })).toBe(true)
    expect(assertMountSafe(cornerOfficeX, { home })).toBe(true)
  })

  it('accepts a path nested under ~/.claude, not just ~/.claude itself (the §3.5 card-dir mount target, ~/.claude/channels)', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    const channels = path.join(home, '.claude', 'channels')
    fs.mkdirSync(channels, { recursive: true })
    expect(assertMountSafe(channels, { home })).toBe(true)
  })

  it('rejects a first path segment that merely starts with an allowed name (~/.claude-evil, ~/.claudeX) — exact match only', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    const claudeEvil = path.join(home, '.claude-evil')
    fs.mkdirSync(claudeEvil, { recursive: true })
    const claudeX = path.join(home, '.claudeX')
    fs.mkdirSync(claudeX, { recursive: true })

    expect(assertMountSafe(claudeEvil, { home })).toBe(false)
    expect(assertMountSafe(claudeX, { home })).toBe(false)
  })

  it('accepts a non-hidden path under $HOME', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    const repo = path.join(home, 'projects', 'my-repo')
    fs.mkdirSync(repo, { recursive: true })
    expect(assertMountSafe(repo, { home })).toBe(true)
  })

  it('accepts a safe path entirely outside $HOME (the v2 hidden-$HOME rule only applies under $HOME)', () => {
    const home = makeTmpDir('co-sandbox-spec-home-')
    const outside = makeTmpDir('co-sandbox-spec-outside-')
    expect(assertMountSafe(outside, { home })).toBe(true)
  })

  it('accepts a mount path built from a symlinked home once resolved to its realHome, while a literal symlink in the chain is still rejected (SEC-M2)', () => {
    const target = makeTmpDir('co-sandbox-spec-target-')
    const linkParent = makeTmpDir('co-sandbox-spec-link-')
    const symlinkedHome = path.join(linkParent, 'home')
    fs.symlinkSync(target, symlinkedHome)

    const realHome = fs.realpathSync(symlinkedHome)
    fs.mkdirSync(path.join(realHome, '.claude'))

    // Built from realHome (as sandbox-paths.ts always does): accepted.
    expect(assertMountSafe(path.join(realHome, '.claude'), { home: realHome })).toBe(true)

    // Built from the symlink itself, not pre-resolved: still rejected — the
    // realpath-equality rule (Rule 1) is never relaxed for a symlinked home.
    expect(assertMountSafe(path.join(symlinkedHome, '.claude'), { home: realHome })).toBe(false)
  })
})

// ── validateEnvValue (§10.4) ─────────────────────────────────────────────

describe('validateEnvValue', () => {
  it('accepts an empty string and an ordinary value', () => {
    expect(validateEnvValue('')).toBe(true)
    expect(validateEnvValue('main')).toBe(true)
  })

  it('accepts exactly 1024 chars and rejects 1025', () => {
    expect(validateEnvValue('a'.repeat(1024))).toBe(true)
    expect(validateEnvValue('a'.repeat(1025))).toBe(false)
  })

  it.each(['\x00', '\x01', '\n', '\r', '\x1f', '\x7f'])('rejects a control character (%j)', (ch) => {
    expect(validateEnvValue(`value${ch}here`)).toBe(false)
  })
})

// ── validateBuildIds (§10.4) ─────────────────────────────────────────────

describe('validateBuildIds', () => {
  it('accepts uid/gid exactly at the 1000 floor', () => {
    expect(validateBuildIds({ uid: 1000, gid: 1000 })).toBe(true)
  })

  it('accepts uid/gid well above the floor', () => {
    expect(validateBuildIds({ uid: 501000, gid: 1000000 })).toBe(true)
  })

  it('refuses uid 0 explicitly', () => {
    expect(validateBuildIds({ uid: 0, gid: 1000 })).toBe(false)
  })

  it('rejects below-floor uid or gid', () => {
    expect(validateBuildIds({ uid: 999, gid: 1000 })).toBe(false)
    expect(validateBuildIds({ uid: 1000, gid: 999 })).toBe(false)
  })

  it('rejects a non-integer', () => {
    expect(validateBuildIds({ uid: 1000.5, gid: 1000 })).toBe(false)
  })
})

// ── worktreePin (C2, §3.6.4) ─────────────────────────────────────────────

describe('worktreePin', () => {
  it('builds gitDir/commonDir from repoReal and workTree from worktreePath(paths, slug)', () => {
    const repoReal = path.join(path.sep, 'home', 'test', 'projects', 'my-repo')
    const paths = sandboxPaths(path.join(path.sep, 'home', 'test'))
    const pin = worktreePin(repoReal, 'my-workspace', paths)

    expect(pin.gitDir).toBe(path.join(repoReal, '.git', 'worktrees', 'my-workspace'))
    expect(pin.commonDir).toBe(path.join(repoReal, '.git'))
    expect(pin.workTree).toBe(worktreePath(paths, 'my-workspace'))
  })
})

// ── pickChannelPort (§3.5) ────────────────────────────────────────────────

function randomFor(port: number): number {
  const [min, max] = CHANNEL_PORT_RANGE
  const span = max - min + 1
  return (port - min + 0.5) / span
}

describe('pickChannelPort', () => {
  it('returns a candidate accepted by isFree', async () => {
    const random = () => randomFor(20010)
    const port = await pickChannelPort({ isFree: () => true, taken: [], random })
    expect(port).toBe(20010)
  })

  it('skips a port stored for another workspace without probing it', async () => {
    const sequence = [randomFor(20005), randomFor(20006)]
    let i = 0
    const isFree = vi.fn().mockReturnValue(true)
    const port = await pickChannelPort({ isFree, taken: new Set([20005]), random: () => sequence[i++] })

    expect(port).toBe(20006)
    expect(isFree).toHaveBeenCalledTimes(1)
    expect(isFree).toHaveBeenCalledWith(20006)
  })

  it('retries when isFree rejects a candidate', async () => {
    const sequence = [randomFor(20010), randomFor(20011)]
    let i = 0
    const isFree = vi.fn((port: number) => port === 20011)
    const port = await pickChannelPort({ isFree, taken: [], random: () => sequence[i++] })

    expect(port).toBe(20011)
    expect(isFree).toHaveBeenCalledTimes(2)
  })

  it('gives up after 20 tries and returns null', async () => {
    const isFree = vi.fn().mockReturnValue(false)
    const port = await pickChannelPort({ isFree, taken: [], random: () => randomFor(20000) })

    expect(port).toBeNull()
    expect(isFree).toHaveBeenCalledTimes(20)
  })

  it('accepts an async isFree probe', async () => {
    const sequence = [randomFor(20010), randomFor(20011)]
    let i = 0
    const port = await pickChannelPort({ isFree: async (p) => p === 20011, taken: [], random: () => sequence[i++] })
    expect(port).toBe(20011)
  })

  it('defaults to Math.random and stays within CHANNEL_PORT_RANGE', async () => {
    const port = await pickChannelPort({ isFree: () => true, taken: [] })
    expect(port).not.toBeNull()
    expect(port as number).toBeGreaterThanOrEqual(CHANNEL_PORT_RANGE[0])
    expect(port as number).toBeLessThanOrEqual(CHANNEL_PORT_RANGE[1])
  })
})
