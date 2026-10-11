import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import * as nodePty from 'node-pty'
import {
  specHash,
  createArgv,
  containerName,
  worktreePath,
  cardDir,
  sandboxEventsDir,
  settingsOverlayPath,
  sandboxClaudeJsonPath,
  claudeShadowSource,
} from '../main/services/sandbox-spec'
import type { PlanMountsFacts, Mount, DocsRootFacts } from '../main/services/sandbox-spec'
// #0037 A5: planMounts/sessionExecArgv take the session agent's handler output; these adapters feed Claude's.
import { planClaudeMounts as planMounts, claudeSessionExecArgv as sessionExecArgv } from './helpers/claude-mounts'
import { sandboxPaths } from '../main/services/sandbox-paths'
import { TerminalManagerService } from '../main/services/terminal-manager'
import type { AppState } from '../main/ipc/handlers'
import type { Workspace } from '../main/types/workspace'

// ---------------------------------------------------------------------------
// sandbox-phase-a-golden.test.ts (#0037 A0, TRD §10.1, BE-H2)
//
// Pins the Claude sandbox plan, spec hash, create/exec argv, container name and
// host spawn args as they were at 4cbd703. Phase A is a byte-identical
// refactor: this file must stay green and unedited through it.
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true })
}

function touch(p: string, content = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

interface Fixture {
  home: string
  repo: string
  slug: string
  wt: string
  gwt: string
  baseFacts: PlanMountsFacts
}

const SLUG = 'my-workspace'
const cleanups: string[] = []

/** Real on-disk home/repo/worktree tree; every "always" mount source exists. */
function makeFixture(): Fixture {
  const home = mkTmp('co-golden-home-')
  const repo = mkTmp('co-golden-repo-')
  cleanups.push(home, repo)
  const paths = sandboxPaths(home)
  const wt = worktreePath(paths, SLUG)
  const gwt = path.join(repo, '.git', 'worktrees', SLUG)

  mkdir(paths.claudeDir)
  touch(paths.claudeJson, '{}')
  touch(paths.claudeSettings, '{}')
  touch(settingsOverlayPath(paths, SLUG), '{}')
  touch(sandboxClaudeJsonPath(paths, SLUG), '{}')
  touch(paths.claudeMd)
  touch(paths.claudeSettingsLocal, '{}')
  for (const d of paths.claudeRoDirs) mkdir(d)
  for (const d of paths.claudeShadowDirs) {
    mkdir(d)
    mkdir(claudeShadowSource(paths, SLUG, d))
  }
  mkdir(cardDir(paths, SLUG))
  mkdir(sandboxEventsDir(paths, SLUG)) // D7: the events mount source is now S/events
  mkdir(path.join(paths.claudeDir, 'channels'))

  mkdir(path.join(repo, '.git', 'hooks'))
  touch(path.join(repo, '.git', 'config'))
  mkdir(path.join(repo, '.git', 'modules'))
  touch(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n')

  mkdir(gwt)
  touch(path.join(gwt, 'gitdir'))
  touch(path.join(gwt, 'commondir'))

  mkdir(wt)
  mkdir(path.join(wt, '.git'))
  mkdir(path.join(repo, '.rix'))
  mkdir(path.join(wt, '.rix'))
  mkdir(path.join(paths.eventsRoot, SLUG))
  mkdir(path.join(paths.eventsRoot, 'enabled'))

  const baseFacts: PlanMountsFacts = {
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
  }
  return { home, repo, slug: SLUG, wt, gwt, baseFacts }
}

/** Replaces the temp roots with stable placeholders so output can be pinned. */
function norm(value: string, fx: { home: string; repo: string }): string {
  return value.split(fx.home).join('$HOME').split(fx.repo).join('$REPO')
}

function planOf(facts: PlanMountsFacts, fx: Fixture): { mounts: string[]; warnings: string[] } | { reason: string } {
  const result = planMounts(facts)
  if (!result.ok) return { reason: result.reason }
  return {
    mounts: result.mounts.map((m) => `${m.readonly ? 'ro' : 'rw'} ${m.provenance} ${norm(m.source, fx)} -> ${norm(m.target, fx)}`),
    warnings: result.warnings,
  }
}

afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

// ── planMounts ──────────────────────────────────────────────────────────────

const BASE_PLAN_HEAD = [
  'rw app $HOME/.claude -> $HOME/.claude',
  'ro app $HOME/.corner-office/sandbox/my-workspace/claude-settings.json -> $HOME/.claude/settings.json',
  'ro app $HOME/.claude/plugins -> $HOME/.claude/plugins',
  'ro app $HOME/.claude/commands -> $HOME/.claude/commands',
  'ro app $HOME/.claude/agents -> $HOME/.claude/agents',
  'ro app $HOME/.claude/skills -> $HOME/.claude/skills',
  'ro app $HOME/.claude/hooks -> $HOME/.claude/hooks',
  'ro app $HOME/.claude/CLAUDE.md -> $HOME/.claude/CLAUDE.md',
  'ro app $HOME/.claude/settings.local.json -> $HOME/.claude/settings.local.json',
]

describe('golden: planMounts (Claude)', () => {
  it('pins the full ordered plan with docs_root unset', () => {
    const fx = makeFixture()
    const plan = planOf(fx.baseFacts, fx)
    expect(plan).toMatchObject({ warnings: ['docs-root-missing'] })
    if (!('mounts' in plan)) return
    expect(plan.mounts.slice(0, BASE_PLAN_HEAD.length)).toEqual(BASE_PLAN_HEAD)
    expect(plan.mounts).toMatchSnapshot()
  })

  it('docs_root in the repo mounts at both repo and worktree paths', () => {
    const fx = makeFixture()
    mkdir(path.join(fx.repo, 'docs'))
    const docsRoot: DocsRootFacts = { path: path.join(fx.repo, 'docs'), source: 'default', exists: true, inRepoRel: 'docs' }
    expect(planOf({ ...fx.baseFacts, docsRoot }, fx)).toMatchSnapshot()
  })

  it('docs_root outside the repo from settings mounts at its absolute path', () => {
    const fx = makeFixture()
    const outside = path.join(fx.home, 'notes')
    mkdir(outside)
    const docsRoot: DocsRootFacts = { path: outside, source: 'settings', exists: true, inRepoRel: null }
    expect(planOf({ ...fx.baseFacts, docsRoot }, fx)).toMatchSnapshot()
  })

  it('docs_root sourced from memory.md carries memory.md provenance', () => {
    const fx = makeFixture()
    const outside = path.join(fx.home, 'memdocs')
    mkdir(outside)
    const docsRoot: DocsRootFacts = { path: outside, source: 'memory.md', exists: true, inRepoRel: null }
    expect(planOf({ ...fx.baseFacts, docsRoot }, fx)).toMatchSnapshot()
  })

  it('.git/index is mounted only when it exists', () => {
    const fx = makeFixture()
    touch(path.join(fx.repo, '.git', 'index'))
    const absent = planOf(fx.baseFacts, fx)
    const present = planOf({ ...fx.baseFacts, indexExists: true }, fx)
    expect(absent).toMatchSnapshot()
    expect(present).toMatchSnapshot()
    expect(JSON.stringify(absent)).not.toContain('.git/index')
    expect(JSON.stringify(present)).toContain('.git/index')
  })

  it('a custom hooksPath inside .git adds one read-only overlay', () => {
    const fx = makeFixture()
    const hp = path.join(fx.repo, '.git', 'custom-hooks')
    mkdir(hp)
    expect(planOf({ ...fx.baseFacts, hooksPathInsideGit: hp }, fx)).toMatchSnapshot()
  })

  it('events enabled adds the enabled marker mount; disabled does not', () => {
    const fx = makeFixture()
    expect(planOf({ ...fx.baseFacts, eventsEnabled: false }, fx)).toMatchSnapshot()
    expect(planOf({ ...fx.baseFacts, eventsEnabled: true }, fx)).toMatchSnapshot()
  })

  it('worktreesOverlay adds .git/worktrees ro and the worktree admin dir rw', () => {
    const fx = makeFixture()
    expect(planOf({ ...fx.baseFacts, worktreesOverlay: true }, fx)).toMatchSnapshot()
  })

  it('a symlinked ~/.claude fails the plan with unsafe-path', () => {
    const fx = makeFixture()
    const real = mkTmp('co-golden-realclaude-')
    cleanups.push(real)
    const claude = path.join(fx.home, '.claude')
    fs.rmSync(claude, { recursive: true, force: true })
    fs.symlinkSync(real, claude)
    expect(planMounts(fx.baseFacts)).toEqual({ ok: false, reason: 'unsafe-path' })
  })
})

// ── specHash (pure: fixed inputs, no filesystem) ───────────────────────────

describe('golden: specHash', () => {
  const plan: Mount[] = [
    { source: '/h/.claude', target: '/h/.claude', readonly: false, provenance: 'app' },
    { source: '/r/docs', target: '/r/docs', readonly: false, provenance: 'memory.md' },
    { source: '/r/.git/HEAD', target: '/r/.git/HEAD', readonly: true, provenance: 'app' },
  ]
  const input = { plan, port: 23456, uid: 1000, gid: 1000, home: '/h', base: 'main', imageId: 'sha256:abc' }

  it('pins the hash for a fixed input', () => {
    expect(specHash(input)).toMatchSnapshot()
  })

  it('is independent of plan order', () => {
    expect(specHash({ ...input, plan: [...plan].reverse() })).toBe(specHash(input))
  })

  it('changes with provenance and imageId', () => {
    const changed = plan.map((m, i) => (i === 1 ? { ...m, provenance: 'settings' as const } : m))
    expect(specHash({ ...input, plan: changed })).not.toBe(specHash(input))
    expect(specHash({ ...input, imageId: 'sha256:def' })).not.toBe(specHash(input))
  })
})

// ── argv builders ───────────────────────────────────────────────────────────

describe('golden: containerName and argv', () => {
  it('containerName', () => {
    expect(containerName('x')).toBe('co-sandbox-x')
  })

  it('createArgv', () => {
    const fx = makeFixture()
    const result = planMounts({ ...fx.baseFacts, eventsEnabled: true })
    if (!result.ok) throw new Error('plan failed')
    const argv = createArgv({
      c: containerName(SLUG),
      slug: SLUG,
      uid: 1000,
      gid: 1000,
      port: 23456,
      home: fx.home,
      base: 'main',
      specHash: 'deadbeef',
      mounts: result.mounts,
      workTree: fx.wt,
    })
    expect(argv.map((a) => norm(a, fx))).toMatchSnapshot()
  })

  it('sessionExecArgv for skip and auto, with and without git identity', () => {
    const common = { c: 'co-sandbox-x', uid: 1000, gid: 1000, workTree: '/wt' }
    const identity = { name: 'Ada', email: 'ada@example.com' }
    expect(sessionExecArgv({ ...common, permMode: 'skip', gitIdentity: identity })).toMatchSnapshot()
    expect(sessionExecArgv({ ...common, permMode: 'auto', gitIdentity: identity })).toMatchSnapshot()
    expect(sessionExecArgv({ ...common, permMode: 'skip', gitIdentity: null })).toMatchSnapshot()
    expect(sessionExecArgv({ ...common, permMode: 'auto', gitIdentity: null })).toMatchSnapshot()
  })
})

// ── host spawn ──────────────────────────────────────────────────────────────

describe('golden: host spawn args', () => {
  beforeEach(() => {
    vi.mocked(nodePty.spawn).mockClear()
  })

  it('spawns the user shell as a login shell running the Claude command', () => {
    const repo = mkTmp('co-golden-host-')
    cleanups.push(repo)
    const ws = { slug: 'p', path: repo } as unknown as Workspace
    const appState = {
      workspaces: new Map([['p', ws]]),
      sandboxManager: null,
    } as unknown as AppState
    const svc = new TerminalManagerService(() => null, appState)

    svc.spawn({ workspaceSlug: 'p', cols: 80, rows: 24 })

    const [file, args, opts] = vi.mocked(nodePty.spawn).mock.calls[0]
    expect(file).toBe(process.env.SHELL || '/bin/bash')
    expect(args).toEqual([
      '--login',
      '-i',
      '-c',
      'claude --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process',
    ])
    expect(opts).toMatchObject({ cols: 80, rows: 24, cwd: repo })
    expect((opts as { env: Record<string, string> }).env.TERM).toBe('xterm-256color')
  })
})
