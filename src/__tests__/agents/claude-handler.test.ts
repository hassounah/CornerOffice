import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { CLAUDE_HANDLER } from '../../main/agents/claude/handler'
import type { SandboxCtx } from '../../main/agents/handler'
import { sandboxPaths } from '../../main/services/sandbox-paths'
import {
  planMounts,
  sessionExecArgv,
  worktreePath,
  cardDir,
  settingsOverlayPath,
  sandboxClaudeJsonPath,
  claudeShadowSource,
} from '../../main/services/sandbox-spec'
import type { PlanMountsFacts } from '../../main/services/sandbox-spec'

const SLUG = 'my-workspace'
const cleanups: string[] = []

function mkTmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  cleanups.push(dir)
  return dir
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}

function touch(p: string, content = ''): void {
  mkdir(path.dirname(p))
  fs.writeFileSync(p, content)
}

afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

/** A home with a complete `~/.claude` and every mount source in place. */
function makeHome(): { home: string; ctx: SandboxCtx } {
  const home = mkTmp('co-claude-handler-')
  const paths = sandboxPaths(home)
  mkdir(paths.claudeDir)
  touch(paths.claudeJson, '{}')
  touch(paths.claudeSettings, '{}')
  touch(paths.claudeMd)
  touch(paths.claudeSettingsLocal, '{}')
  for (const d of paths.claudeRoDirs) mkdir(d)
  for (const d of paths.claudeShadowDirs) mkdir(d)
  return { home, ctx: { paths, slug: SLUG, workTree: worktreePath(paths, SLUG) } }
}

const sandbox = CLAUDE_HANDLER.sandbox!

describe('claude host argv', () => {
  const GOLDEN = 'claude --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process'

  it('default is the golden command', () => {
    expect(CLAUDE_HANDLER.host.argv({ permissionMode: 'default' }).join(' ')).toBe(GOLDEN)
  })

  it('auto appends --permission-mode auto', () => {
    expect(CLAUDE_HANDLER.host.argv({ permissionMode: 'auto' }).join(' ')).toBe(`${GOLDEN} --permission-mode auto`)
  })

  it('rejects skip on the host', () => {
    expect(() => CLAUDE_HANDLER.host.argv({ permissionMode: 'skip' })).toThrow(/no skip permission mode/)
  })
})

describe('claude sandbox handler: readiness', () => {
  it('reports home-missing when ~/.claude is absent', () => {
    const home = mkTmp('co-claude-empty-')
    expect(sandbox.readiness(sandboxPaths(home))).toEqual({ ok: false, code: 'home-missing' })
  })

  it('reports config-invalid for a symlinked source', () => {
    const { ctx } = makeHome()
    fs.rmSync(ctx.paths.claudeMd, { force: true })
    fs.symlinkSync('/etc/hostname', ctx.paths.claudeMd)
    expect(sandbox.readiness(ctx.paths)).toEqual({ ok: false, code: 'config-invalid' })
  })

  it('is ok for a complete home', () => {
    expect(sandbox.readiness(makeHome().ctx.paths)).toEqual({ ok: true })
  })
})

describe('claude sandbox handler: prepare and cleanup', () => {
  it('plan creates the per-sandbox sources, create re-seeds claude.json, cleanup removes them', () => {
    const { ctx } = makeHome()
    expect(sandbox.prepare(ctx, 'plan')).toEqual({ ok: true })
    const json = sandboxClaudeJsonPath(ctx.paths, SLUG)
    expect(fs.existsSync(settingsOverlayPath(ctx.paths, SLUG))).toBe(true)
    expect(fs.readFileSync(json, 'utf8')).toBe('{}')

    fs.writeFileSync(ctx.paths.claudeJson, '{"a":1}')
    expect(sandbox.prepare(ctx, 'create')).toEqual({ ok: true })
    expect(fs.readFileSync(json, 'utf8')).toBe('{"a":1}')

    sandbox.cleanup(ctx)
    expect(fs.existsSync(json)).toBe(false)
    expect(fs.existsSync(settingsOverlayPath(ctx.paths, SLUG))).toBe(false)
    expect(fs.existsSync(claudeShadowSource(ctx.paths, SLUG, ctx.paths.claudeShadowDirs[0]))).toBe(false)
  })

  it('maps a config failure to fixed detail copy', () => {
    const { ctx } = makeHome()
    fs.rmSync(ctx.paths.claudeMd, { force: true })
    fs.symlinkSync('/etc/hostname', ctx.paths.claudeMd)
    const result = sandbox.prepare(ctx, 'plan')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('CLAUDE.md')
  })

  it('create reports a failure when the host claude.json is missing', () => {
    const { ctx } = makeHome()
    sandbox.prepare(ctx, 'plan')
    fs.rmSync(ctx.paths.claudeJson, { force: true })
    expect(sandbox.prepare(ctx, 'create').ok).toBe(false)
  })
})

describe('claude sandbox handler: mounts', () => {
  it('equals the Claude entries of the planMounts output, in the same order', () => {
    const { home, ctx } = makeHome()
    const repo = mkTmp('co-claude-repo-')
    const gwt = path.join(repo, '.git', 'worktrees', SLUG)
    mkdir(path.join(repo, '.git', 'hooks'))
    mkdir(path.join(repo, '.git', 'modules'))
    touch(path.join(repo, '.git', 'config'))
    touch(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    mkdir(gwt)
    touch(path.join(gwt, 'gitdir'))
    touch(path.join(gwt, 'commondir'))
    mkdir(ctx.workTree)
    mkdir(path.join(ctx.workTree, '.git'))
    mkdir(path.join(ctx.workTree, '.rix'))
    mkdir(path.join(repo, '.rix'))
    mkdir(path.join(ctx.paths.eventsRoot, SLUG))
    mkdir(path.join(ctx.paths.eventsRoot, 'enabled'))
    mkdir(path.join(ctx.paths.claudeDir, 'channels'))
    sandbox.prepare(ctx, 'plan')
    mkdir(cardDir(ctx.paths, SLUG))
    const facts: PlanMountsFacts = {
      home,
      repo,
      wt: ctx.workTree,
      slug: SLUG,
      gwt,
      indexExists: false,
      hooksPathInsideGit: null,
      eventsEnabled: false,
      docsRoot: { path: path.join(repo, 'docs'), source: 'default', exists: false, inRepoRel: null },
      worktreesOverlay: false,
    }
    const plan = planMounts(facts, sandbox.mounts(ctx))
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const key = (m: { source: string; target: string; readonly: boolean }): string => `${m.readonly} ${m.source} ${m.target}`
    const handlerMounts = sandbox.mounts(ctx)
    const wanted = new Set(handlerMounts.map(key))
    expect(plan.mounts.filter((m) => wanted.has(key(m))).map(key)).toEqual(handlerMounts.map(key))
  })
})

describe('claude sandbox handler: launch', () => {
  const ctx = { paths: sandboxPaths('/nonexistent-home'), slug: SLUG, workTree: '/wt' }

  it.each(['skip', 'auto'] as const)('argv for %s is the tail of the golden exec argv', (mode) => {
    const launch = sandbox.launch(ctx, { permissionMode: mode })
    expect(launch.env).toEqual([])
    const exec = sessionExecArgv({
      c: 'co-sandbox-x',
      uid: 1000,
      gid: 1000,
      workTree: '/wt',
      agentEnv: launch.env,
      agentArgv: launch.argv,
      gitIdentity: null,
    })
    expect(exec.slice(exec.indexOf('claude'))).toEqual(launch.argv)
  })

  it('refuses the host-only default mode', () => {
    expect(() => sandbox.launch(ctx, { permissionMode: 'default' })).toThrow(/no default permission mode/)
  })
})
