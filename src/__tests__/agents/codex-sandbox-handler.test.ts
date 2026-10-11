import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { CODEX_HANDLER } from '../../main/agents/codex/handler'
import { CLAUDE_HANDLER } from '../../main/agents/claude/handler'
import { GUARD_BASELINE_FILE } from '../../main/agents/codex/guard'
import { codexStatePaths } from '../../main/agents/codex/sandbox-config'
import type { SandboxCtx } from '../../main/agents/handler'
import { sandboxPaths } from '../../main/services/sandbox-paths'
import { assertMountSafe, planMounts, sandboxEventsDir, sessionExecArgv, worktreePath, cardDir } from '../../main/services/sandbox-spec'
import type { PlanMountsFacts } from '../../main/services/sandbox-spec'
import { DEFAULT_ALLOWLIST } from '../../main/services/sandbox-allowlist'

// ---------------------------------------------------------------------------
// Codex's sandbox handler (#0037 D10): mounts, launch, hooks and cleanup, and how
// its plan compares with Claude's. Real temp home.
// ---------------------------------------------------------------------------

const SLUG = 'ws'
const roots: string[] = []
let home: string
let ctx: SandboxCtx
let H: string

function sandbox(): NonNullable<typeof CODEX_HANDLER.sandbox> {
  if (!CODEX_HANDLER.sandbox) throw new Error('codex has no sandbox half')
  return CODEX_HANDLER.sandbox
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-codex-h-')))
  roots.push(home)
  const paths = sandboxPaths(home)
  ctx = { paths, slug: SLUG, workTree: worktreePath(paths, SLUG) }
  H = paths.codexDir
  fs.mkdirSync(H)
  fs.writeFileSync(path.join(H, 'auth.json'), '{}')
})

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const summary = (mounts: readonly { target: string; readonly: boolean }[]): Record<string, boolean> =>
  Object.fromEntries(mounts.map((m) => [path.relative(home, m.target), m.readonly]))

describe('codex sandbox handler: mounts', () => {
  it('mounts ~/.codex read-write with read-only overlays, shadows and a read-write sqlite home', () => {
    const s = codexStatePaths(ctx.paths, SLUG)
    const mounts = sandbox().mounts(ctx)

    expect(summary(mounts)).toEqual({
      '.codex': false,
      '.codex/config.toml': true,
      '.codex/.env': true,
      '.codex/plugins': true,
      '.codex/skills': true,
      '.codex/prompts': true,
      '.codex/agents': true,
      '.codex/packages': true,
      '.codex/AGENTS.md': true,
      '.codex/rules': true,
      '.codex/app-server-daemon': true,
      '.codex/log': false,
      '.codex/tmp': false,
      '.codex/.tmp': false,
      '.codex/shell_snapshots': false,
      [path.relative(home, s.sqlite)]: false,
    })
    // The overlays and shadows come from the per-workspace state, never from the host's own files.
    const bySource = Object.fromEntries(mounts.map((m) => [path.relative(home, m.target), m.source]))
    expect(bySource['.codex/config.toml']).toBe(s.configOverlay)
    expect(bySource['.codex/.env']).toBe(s.env)
    expect(bySource['.codex/rules']).toBe(s.rulesDir)
    expect(bySource['.codex/app-server-daemon']).toBe(s.daemon)
    expect(bySource['.codex/log']).toBe(s.log)
    expect(bySource['.codex/tmp']).toBe(path.join(s.state, 'codex-tmp'))
    expect(bySource['.codex/.tmp']).toBe(path.join(s.state, 'codex-dottmp'))
    expect(bySource['.codex/shell_snapshots']).toBe(path.join(s.state, 'codex-shell-snapshots'))
    // packages is the host's own directory, mounted read-only over itself.
    expect(bySource['.codex/packages']).toBe(path.join(H, 'packages'))
  })

  it('refuses a symlinked ~/.codex/packages at prepare and at mounts()', () => {
    const real = path.join(home, 'real-packages')
    fs.mkdirSync(real)
    fs.symlinkSync(real, path.join(H, 'packages'))

    expect(sandbox().prepare(ctx, 'plan')).toEqual({
      ok: false,
      detail: '~/.codex/packages is a symbolic link. Replace it with a real file or folder, then Start again.',
    })
    expect(() => sandbox().mounts(ctx)).toThrow('~/.codex/packages is a symbolic link')
  })

  it('also mounts every pre-existing name-set file read-only over itself, but not absent names', () => {
    for (const name of ['AGENTS.override.md', 'hooks.json', 'x.config.toml', '.env.local']) fs.writeFileSync(path.join(H, name), 'x')

    const mounts = summary(sandbox().mounts(ctx))

    for (const name of ['AGENTS.override.md', 'hooks.json', 'x.config.toml', '.env.local']) expect(mounts[`.codex/${name}`]).toBe(true)
    expect(mounts['.codex/another.config.toml']).toBeUndefined()
  })

  it('has no duplicate target (Docker would refuse the mount)', () => {
    fs.writeFileSync(path.join(H, '.env'), 'x')
    fs.writeFileSync(path.join(H, 'config.toml'), 'x')
    const targets = sandbox().mounts(ctx).map((m) => m.target)
    expect(new Set(targets).size).toBe(targets.length)
  })
})

describe('codex sandbox handler: fail-closed mount sources (SM-1)', () => {
  it('a symlinked ~/.codex/skills refuses the start naming the file, and is never mounted', () => {
    const real = path.join(home, 'real-skills')
    fs.mkdirSync(real)
    fs.symlinkSync(real, path.join(H, 'skills'))

    expect(sandbox().prepare(ctx, 'plan')).toEqual({
      ok: false,
      detail: '~/.codex/skills is a symbolic link. Replace it with a real file or folder, then Start again.',
    })
    expect(fs.existsSync(codexStatePaths(ctx.paths, SLUG).state)).toBe(false)
    // ...and even if mounts() is reached, it hands nothing over.
    expect(() => sandbox().mounts(ctx)).toThrow('~/.codex/skills is a symbolic link')
    // assertMountSafe independently refuses a symlink as a mount source.
    expect(assertMountSafe(path.join(H, 'skills'), { home })).toBe(false)
  })

  it.each(['plugins', 'prompts', 'agents'])('a symlinked ~/.codex/%s is refused the same way', (name) => {
    fs.mkdirSync(path.join(home, 'elsewhere'))
    fs.symlinkSync(path.join(home, 'elsewhere'), path.join(H, name))
    expect(sandbox().prepare(ctx, 'plan')).toMatchObject({ ok: false, detail: expect.stringContaining(`~/.codex/${name} is a symbolic link`) })
  })

  it('a symlinked AGENTS.md, and a wrong-type one, are refused', () => {
    fs.writeFileSync(path.join(home, 'real.md'), '')
    fs.symlinkSync(path.join(home, 'real.md'), path.join(H, 'AGENTS.md'))
    expect(sandbox().prepare(ctx, 'plan')).toMatchObject({ ok: false, detail: expect.stringContaining('~/.codex/AGENTS.md is a symbolic link') })
    fs.rmSync(path.join(H, 'AGENTS.md'))
    fs.mkdirSync(path.join(H, 'AGENTS.md'))
    expect(sandbox().prepare(ctx, 'plan')).toMatchObject({ ok: false, detail: expect.stringContaining("~/.codex/AGENTS.md isn't a regular file") })
  })

  it('a pre-existing symlinked guarded file (hooks.json) is refused rather than left un-mounted', () => {
    fs.writeFileSync(path.join(home, 'real.json'), '{}')
    fs.symlinkSync(path.join(home, 'real.json'), path.join(H, 'hooks.json'))
    expect(sandbox().prepare(ctx, 'plan')).toMatchObject({ ok: false, detail: expect.stringContaining('~/.codex/hooks.json is a symbolic link') })
    expect(() => sandbox().mounts(ctx)).toThrow('hooks.json')
  })

  it('a ~/.codex on a case-insensitive filesystem is refused', () => {
    const realLstat = fs.lstatSync.bind(fs)
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      // A case-insensitive filesystem resolves CONFIG.TOML to the very same file.
      const target = String(p).endsWith(`${path.sep}CONFIG.TOML`) ? String(p).replace('CONFIG.TOML', 'config.toml') : p
      return (realLstat as (...args: unknown[]) => fs.Stats)(target, ...rest)
    }) as typeof fs.lstatSync)

    expect(sandbox().prepare(ctx, 'plan')).toEqual({ ok: false, detail: 'Codex in the sandbox needs ~/.codex on a case-sensitive filesystem.' })
    expect(fs.existsSync(codexStatePaths(ctx.paths, SLUG).state)).toBe(false)
    vi.restoreAllMocks()
  })

  it('a case-sensitive ~/.codex passes the probe', () => {
    expect(sandbox().prepare(ctx, 'plan')).toEqual({ ok: true })
  })
})

describe('codex sandbox handler: launch', () => {
  it('sets a per-sandbox sqlite home and launches with no daemon, trusted hooks and no approvals', () => {
    const launch = sandbox().launch(ctx, { permissionMode: 'skip' })
    expect(launch.env).toEqual([`CODEX_SQLITE_HOME=${codexStatePaths(ctx.paths, SLUG).sqlite}`])
    expect(launch.argv).toEqual([
      'codex',
      '--no-alt-screen',
      '--no-daemon',
      '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
  })

  it('offers skip only', () => {
    expect(() => sandbox().launch(ctx, { permissionMode: 'auto' })).toThrow(/only offers skip/)
    expect(() => sandbox().launch(ctx, { permissionMode: 'default' })).toThrow(/only offers skip/)
  })

  it('the exec argv carries the sqlite env and no Claude flags', () => {
    const launch = sandbox().launch(ctx, { permissionMode: 'skip' })
    const argv = sessionExecArgv({ c: 'co-sandbox-ws.codex', uid: 1000, gid: 1000, workTree: ctx.workTree, agentEnv: launch.env, agentArgv: launch.argv, gitIdentity: null })
    expect(argv).toContain(`CODEX_SQLITE_HOME=${codexStatePaths(ctx.paths, SLUG).sqlite}`)
    expect(argv.slice(-5)).toEqual(launch.argv.slice(-5))
    expect(argv.join(' ')).not.toContain('--dangerously-load-development-channels')
  })
})

describe('codex sandbox handler: hooks', () => {
  it('defines openSession (inside prepare) and afterStop, the guard contract (SH-3)', () => {
    expect(typeof sandbox().afterStop).toBe('function')
    expect(sandbox().prepare(ctx, 'plan')).toEqual({ ok: true })
    const baseline = JSON.parse(fs.readFileSync(path.join(codexStatePaths(ctx.paths, SLUG).state, GUARD_BASELINE_FILE), 'utf8'))
    expect(baseline.state).toBe('open')
  })

  it('prepare("create") changes nothing', () => {
    expect(sandbox().prepare(ctx, 'create')).toEqual({ ok: true })
    expect(fs.existsSync(codexStatePaths(ctx.paths, SLUG).state)).toBe(false)
  })

  it('afterStop sweeps a file the session left and closes the baseline', () => {
    sandbox().prepare(ctx, 'plan')
    fs.writeFileSync(path.join(H, 'AGENTS.override.md'), 'x')

    const outcome = sandbox().afterStop?.(ctx)

    expect(outcome).toMatchObject({ quarantined: 1, shown: 'AGENTS.override.md' })
    expect(fs.existsSync(path.join(H, 'AGENTS.override.md'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(codexStatePaths(ctx.paths, SLUG).state, GUARD_BASELINE_FILE), 'utf8')).state).toBe('closed')
  })

  it('readiness is Codex readiness', () => {
    expect(sandbox().readiness(ctx.paths)).toEqual({ ok: true })
    fs.rmSync(path.join(H, 'auth.json'))
    expect(sandbox().readiness(ctx.paths)).toEqual({ ok: false, code: 'not-signed-in' })
  })
})

describe('codex sandbox handler: cleanup', () => {
  it('removes the Codex state without following a planted symlink, and keeps the quarantine', () => {
    sandbox().prepare(ctx, 'plan')
    const s = codexStatePaths(ctx.paths, SLUG)
    const victim = path.join(home, 'victim')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'precious'), 'keep')
    fs.rmSync(s.sqlite, { recursive: true })
    fs.symlinkSync(victim, s.sqlite)
    fs.writeFileSync(path.join(s.quarantine, 'kept'), 'moved earlier')

    sandbox().cleanup(ctx)

    for (const gone of [s.configOverlay, s.env, s.rulesDir, s.daemon, s.log, s.sqlite, ...['codex-tmp', 'codex-dottmp', 'codex-shell-snapshots'].map((d) => path.join(s.state, d)), path.join(s.state, GUARD_BASELINE_FILE)]) expect(fs.existsSync(gone)).toBe(false)
    expect(fs.readFileSync(path.join(victim, 'precious'), 'utf8')).toBe('keep')
    expect(fs.readFileSync(path.join(s.quarantine, 'kept'), 'utf8')).toBe('moved earlier')
  })

  it('is a no-op when nothing was ever prepared', () => {
    expect(() => sandbox().cleanup(ctx)).not.toThrow()
  })
})

describe('plans: Codex vs Claude', () => {
  /** A real on-disk tree for the neutral mounts, as the manager would have precreated. */
  function facts(): PlanMountsFacts {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-codex-r-')))
    roots.push(repo)
    const paths = ctx.paths
    const wt = worktreePath(paths, SLUG)
    const gwt = path.join(repo, '.git', 'worktrees', SLUG)
    const mk = (p: string): void => {
      fs.mkdirSync(p, { recursive: true })
    }
    const touch = (p: string): void => {
      mk(path.dirname(p))
      fs.writeFileSync(p, '')
    }
    mk(path.join(repo, '.git', 'hooks'))
    mk(path.join(repo, '.git', 'modules'))
    touch(path.join(repo, '.git', 'config'))
    touch(path.join(repo, '.git', 'HEAD'))
    mk(gwt)
    touch(path.join(gwt, 'gitdir'))
    touch(path.join(gwt, 'commondir'))
    mk(path.join(wt, '.git'))
    mk(path.join(wt, '.rix'))
    mk(path.join(repo, '.rix'))
    mk(path.join(paths.eventsRoot, SLUG))
    mk(sandboxEventsDir(paths, SLUG))
    return {
      home,
      repo,
      wt,
      slug: SLUG,
      gwt,
      indexExists: false,
      hooksPathInsideGit: null,
      eventsEnabled: false,
      docsRoot: { path: path.join(repo, 'docs'), source: 'default', exists: false, inRepoRel: null },
      worktreesOverlay: false,
      homunculusDir: null,
    }
  }

  /** Everything Claude's `prepare` makes, so its mount sources exist. */
  function prepareBoth(): void {
    fs.mkdirSync(ctx.paths.claudeDir)
    fs.writeFileSync(ctx.paths.claudeJson, '{}')
    fs.writeFileSync(ctx.paths.claudeSettings, '{}')
    fs.writeFileSync(ctx.paths.claudeMd, '')
    fs.writeFileSync(ctx.paths.claudeSettingsLocal, '{}')
    for (const d of [...ctx.paths.claudeRoDirs, ...ctx.paths.claudeShadowDirs]) fs.mkdirSync(d)
    fs.mkdirSync(cardDir(ctx.paths, SLUG), { recursive: true })
    expect(CLAUDE_HANDLER.sandbox?.prepare(ctx, 'plan')).toMatchObject({ ok: true })
    expect(sandbox().prepare(ctx, 'plan')).toMatchObject({ ok: true })
  }

  function plan(handler: typeof CODEX_HANDLER, f: PlanMountsFacts) {
    const result = planMounts(f, handler.sandbox?.mounts(ctx) ?? [])
    if (!result.ok) throw new Error(`plan failed: ${result.reason}`)
    return result.mounts
  }

  it('a Codex plan has no ~/.claude entries, and no channel card mount', () => {
    prepareBoth()
    const targets = plan(CODEX_HANDLER, facts()).map((m) => m.target)
    expect(targets.filter((t) => t === ctx.paths.claudeDir || t.startsWith(ctx.paths.claudeDir + path.sep))).toEqual([])
    expect(targets.some((t) => t.includes('/channels'))).toBe(false)
    expect(targets).not.toContain(ctx.paths.claudeJson)
  })

  it('a Claude plan has no ~/.codex entry', () => {
    prepareBoth()
    const targets = plan(CLAUDE_HANDLER, facts()).map((m) => m.target)
    expect(targets.filter((t) => t === ctx.paths.codexDir || t.startsWith(ctx.paths.codexDir + path.sep))).toEqual([])
  })

  it('a Codex plan gets only the homunculus subtree of ~/.claude, and only when it is a real directory', () => {
    prepareBoth()
    const homunculus = path.join(ctx.paths.claudeDir, 'homunculus')
    fs.mkdirSync(homunculus)

    const withIt = plan(CODEX_HANDLER, { ...facts(), homunculusDir: homunculus })
    expect(withIt.filter((m) => m.target.startsWith(ctx.paths.claudeDir))).toEqual([{ source: homunculus, target: homunculus, readonly: false, provenance: 'app' }])

    expect(plan(CODEX_HANDLER, { ...facts(), homunculusDir: null }).some((m) => m.target === homunculus)).toBe(false)
  })

  it("a Claude plan doesn't mount homunculus separately: its ~/.claude mount already covers it", () => {
    prepareBoth()
    const homunculus = path.join(ctx.paths.claudeDir, 'homunculus')
    fs.mkdirSync(homunculus)
    const targets = plan(CLAUDE_HANDLER, { ...facts(), homunculusDir: homunculus }).map((m) => m.target)
    expect(targets.filter((t) => t === homunculus)).toEqual([])
  })

  it('the neutral mount set is identical for both agents', () => {
    prepareBoth()
    const f = facts()
    const neutral = (handler: typeof CODEX_HANDLER) => {
      const own = new Set((handler.sandbox?.mounts(ctx) ?? []).map((m) => m.target))
      return plan(handler, f).filter((m) => !own.has(m.target))
    }
    // Homunculus aside (Claude's own mount covers it), every other neutral mount matches exactly.
    expect(neutral(CODEX_HANDLER)).toEqual(neutral(CLAUDE_HANDLER))
  })
})

describe('default allowlist', () => {
  it('includes the three OpenAI hosts Codex needs, for every sandbox', () => {
    for (const host of ['api.openai.com', 'chatgpt.com', 'auth.openai.com']) expect(DEFAULT_ALLOWLIST).toContain(host)
  })
})
