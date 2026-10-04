import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  planMounts,
  specHash,
  diffMountPlans,
  hasMemoryMdMount,
  worktreePath,
  cardDir,
} from '../main/services/sandbox-spec'
import type {
  PlanMountsFacts,
  Mount,
  DocsRootFacts,
  SpecHashInput,
  OldMount,
} from '../main/services/sandbox-spec'
import { sandboxPaths } from '../main/services/sandbox-paths'

// ---------------------------------------------------------------------------
// sandbox-spec-mounts.test.ts (TRD §3.5, §3.6.3, D11, D12, M2, C2, H1, H3,
// B-M2, B-H2)
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
  paths: ReturnType<typeof sandboxPaths>
  wt: string
  gwt: string
  baseFacts: PlanMountsFacts
}

/**
 * Builds a real, on-disk home/repo/worktree tree with every path the
 * "always" mounts touch already created — assertMountSafe requires each one
 * to actually resolve. `baseFacts` has indexExists/hooksPathInsideGit/
 * eventsEnabled/worktreesOverlay all off and a missing docs_root, so a test
 * only needs to layer on what it specifically wants to exercise.
 */
function makeFixture(): Fixture {
  const home = mkTmp('co-spec-mounts-home-')
  const repo = mkTmp('co-spec-mounts-repo-')
  const slug = 'my-workspace'
  const paths = sandboxPaths(home)
  const wt = worktreePath(paths, slug)
  const gwt = path.join(repo, '.git', 'worktrees', slug)

  mkdir(paths.claudeDir)
  touch(paths.claudeJson, '{}')
  mkdir(cardDir(paths, slug))
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

  mkdir(path.join(paths.eventsRoot, slug))

  const baseFacts: PlanMountsFacts = {
    home,
    repo,
    wt,
    slug,
    gwt,
    indexExists: false,
    hooksPathInsideGit: null,
    eventsEnabled: false,
    docsRoot: { path: path.join(repo, 'docs'), source: 'default', exists: false, inRepoRel: 'docs', ignored: false },
    worktreesOverlay: false,
  }

  return { home, repo, slug, paths, wt, gwt, baseFacts }
}

function targetsOf(mounts: Mount[]): string[] {
  return mounts.map((m) => m.target)
}

// ── planMounts: always-present overlays ─────────────────────────────────────

describe('planMounts — always-present overlays', () => {
  it('always includes .git/modules (M2) and HEAD (H3), the three C2 overlays, and $WT/.git read-only', () => {
    const { repo, gwt, wt, baseFacts } = makeFixture()
    const result = planMounts(baseFacts)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const byTarget = new Map(result.mounts.map((m) => [m.target, m]))
    expect(byTarget.get(path.join(repo, '.git', 'modules'))).toMatchObject({ readonly: true })
    expect(byTarget.get(path.join(repo, '.git', 'HEAD'))).toMatchObject({ readonly: true })
    expect(byTarget.get(path.join(gwt, 'gitdir'))).toMatchObject({ readonly: true })
    expect(byTarget.get(path.join(gwt, 'commondir'))).toMatchObject({ readonly: true })
    expect(byTarget.get(path.join(wt, '.git'))).toMatchObject({ readonly: true })
    // Conditional: absent when indexExists is false.
    expect(byTarget.has(path.join(repo, '.git', 'index'))).toBe(false)
  })

  it('includes .git/index only when indexExists is true (H3)', () => {
    const fixture = makeFixture()
    touch(path.join(fixture.repo, '.git', 'index'))
    const result = planMounts({ ...fixture.baseFacts, indexExists: true })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(targetsOf(result.mounts)).toContain(path.join(fixture.repo, '.git', 'index'))
    expect(result.mounts.find((m) => m.target === path.join(fixture.repo, '.git', 'index'))).toMatchObject({
      readonly: true,
    })
  })

  it('adds a read-only overlay for hooksPathInsideGit when set (D11)', () => {
    const fixture = makeFixture()
    const hp = path.join(fixture.repo, '.git', 'custom-hooks')
    mkdir(hp)
    const result = planMounts({ ...fixture.baseFacts, hooksPathInsideGit: hp })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mounts).toContainEqual({ source: hp, target: hp, readonly: true, provenance: 'app' })
  })

  it('adds .git/worktrees (ro) and $GWT (rw) only when worktreesOverlay is true (G1)', () => {
    const fixture = makeFixture()
    const withoutOverlay = planMounts(fixture.baseFacts)
    expect(withoutOverlay.ok).toBe(true)
    if (withoutOverlay.ok) {
      expect(targetsOf(withoutOverlay.mounts)).not.toContain(path.join(fixture.repo, '.git', 'worktrees'))
    }

    const withOverlay = planMounts({ ...fixture.baseFacts, worktreesOverlay: true })
    expect(withOverlay.ok).toBe(true)
    if (!withOverlay.ok) return
    const byTarget = new Map(withOverlay.mounts.map((m) => [m.target, m]))
    expect(byTarget.get(path.join(fixture.repo, '.git', 'worktrees'))).toMatchObject({ readonly: true })
    expect(byTarget.get(fixture.gwt)).toMatchObject({ readonly: false })
  })

  it('mounts $REPO/.rix at $WT/.rix (source and target differ)', () => {
    const { repo, wt, baseFacts } = makeFixture()
    const result = planMounts(baseFacts)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mounts).toContainEqual({
      source: path.join(repo, '.rix'),
      target: path.join(wt, '.rix'),
      readonly: false,
      provenance: 'app',
    })
  })

  it('mounts the per-workspace events directory read-write, and events/enabled read-only only when eventsEnabled', () => {
    const fixture = makeFixture()
    const withoutEvents = planMounts(fixture.baseFacts)
    expect(withoutEvents.ok).toBe(true)
    if (withoutEvents.ok) {
      expect(withoutEvents.mounts).toContainEqual({
        source: path.join(fixture.paths.eventsRoot, fixture.slug),
        target: path.join(fixture.paths.eventsRoot, fixture.slug),
        readonly: false,
        provenance: 'app',
      })
      expect(targetsOf(withoutEvents.mounts)).not.toContain(path.join(fixture.paths.eventsRoot, 'enabled'))
    }

    touch(path.join(fixture.paths.eventsRoot, 'enabled'))
    const withEvents = planMounts({ ...fixture.baseFacts, eventsEnabled: true })
    expect(withEvents.ok).toBe(true)
    if (!withEvents.ok) return
    expect(withEvents.mounts).toContainEqual({
      source: path.join(fixture.paths.eventsRoot, 'enabled'),
      target: path.join(fixture.paths.eventsRoot, 'enabled'),
      readonly: true,
      provenance: 'app',
    })
  })
})

// ── planMounts: docs_root (§3.6.3, D12, H1) ─────────────────────────────────

describe('planMounts — docs_root', () => {
  it('missing: no mount, docs-root-missing warning', () => {
    const { baseFacts } = makeFixture()
    const result = planMounts(baseFacts) // baseFacts.docsRoot.exists === false
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toContain('docs-root-missing')
  })

  it('outside REPO from Settings: mounted at its own path', () => {
    const fixture = makeFixture()
    const outside = mkTmp('co-spec-mounts-docs-')
    const docsRoot: DocsRootFacts = { path: outside, source: 'settings', exists: true, inRepoRel: null, ignored: false }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mounts).toContainEqual({ source: outside, target: outside, readonly: false, provenance: 'settings' })
  })

  it('outside REPO from Settings, but failing assertMountSafe: dropped with a docs-root-unsafe warning (not a hard failure)', () => {
    const fixture = makeFixture()
    const outsideParent = mkTmp('co-spec-mounts-docs-parent-')
    const outsideDirty = path.join(outsideParent, 'bad,name')
    mkdir(outsideDirty)
    const docsRoot: DocsRootFacts = { path: outsideDirty, source: 'settings', exists: true, inRepoRel: null, ignored: false }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toContain('docs-root-unsafe')
    expect(targetsOf(result.mounts)).not.toContain(outsideDirty)
  })

  it('outside REPO from Settings, equal to an existing mount target ($WT): ineligible (docs-root-unsafe)', () => {
    const fixture = makeFixture()
    const docsRoot: DocsRootFacts = { path: fixture.wt, source: 'settings', exists: true, inRepoRel: null, ignored: false }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result).toEqual({ ok: false, reason: 'docs-root-unsafe' })
  })

  it('outside REPO from Settings, an ancestor of an existing mount target (SANDBOXES_ROOT, ancestor of $WT): ineligible (docs-root-unsafe)', () => {
    const fixture = makeFixture()
    const docsRoot: DocsRootFacts = {
      path: fixture.paths.sandboxesRoot,
      source: 'settings',
      exists: true,
      inRepoRel: null,
      ignored: false,
    }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result).toEqual({ ok: false, reason: 'docs-root-unsafe' })
  })

  it('outside REPO from Settings, a descendant of an existing mount target ($WT/<subdir>): ineligible (docs-root-unsafe)', () => {
    const fixture = makeFixture()
    const descendant = path.join(fixture.wt, 'some-subdir')
    const docsRoot: DocsRootFacts = { path: descendant, source: 'settings', exists: true, inRepoRel: null, ignored: false }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result).toEqual({ ok: false, reason: 'docs-root-unsafe' })
  })

  it('outside REPO from memory.md: not mounted, docs-root-untrusted warning', () => {
    const fixture = makeFixture()
    const outside = mkTmp('co-spec-mounts-docs-')
    const docsRoot: DocsRootFacts = { path: outside, source: 'memory.md', exists: true, inRepoRel: null, ignored: false }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toContain('docs-root-untrusted')
    expect(targetsOf(result.mounts)).not.toContain(outside)
  })

  it('backstop: a crafted inRepoRel escaping the repo is docs-root-unsafe (SEC-M1)', () => {
    const fixture = makeFixture()
    for (const inRepoRel of ['..', path.join('..', 'other'), '/etc']) {
      const docsRoot: DocsRootFacts = { path: fixture.repo, source: 'settings', exists: true, inRepoRel, ignored: false }
      const result = planMounts({ ...fixture.baseFacts, docsRoot })
      expect(result).toEqual({ ok: false, reason: 'docs-root-unsafe' })
    }
  })

  it('inside REPO, equal to REPO itself: ineligible (docs-root-unsafe)', () => {
    const fixture = makeFixture()
    const docsRoot: DocsRootFacts = { path: fixture.repo, source: 'settings', exists: true, inRepoRel: '', ignored: false }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result).toEqual({ ok: false, reason: 'docs-root-unsafe' })
  })

  it('inside REPO, inside .git: ineligible (docs-root-unsafe)', () => {
    const fixture = makeFixture()
    const docsPath = path.join(fixture.repo, '.git', 'hooks')
    const docsRoot: DocsRootFacts = { path: docsPath, source: 'settings', exists: true, inRepoRel: '.git/hooks', ignored: false }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result).toEqual({ ok: false, reason: 'docs-root-unsafe' })
  })

  it('inside REPO, gitignored: mounted at its own path (source === target)', () => {
    const fixture = makeFixture()
    const docsDir = path.join(fixture.repo, 'ignored-docs')
    mkdir(docsDir)
    const docsRoot: DocsRootFacts = { path: docsDir, source: 'default', exists: true, inRepoRel: 'ignored-docs', ignored: true }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mounts).toContainEqual({ source: docsDir, target: docsDir, readonly: false, provenance: 'app' })
  })

  it('inside REPO, gitignored, but failing assertMountSafe: dropped with a docs-root-unsafe warning (not a hard failure)', () => {
    const fixture = makeFixture()
    const dirtyRel = 'bad,ignored-docs'
    const docsDir = path.join(fixture.repo, dirtyRel)
    mkdir(docsDir)
    const docsRoot: DocsRootFacts = { path: docsDir, source: 'default', exists: true, inRepoRel: dirtyRel, ignored: true }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toContain('docs-root-unsafe')
    expect(targetsOf(result.mounts)).not.toContain(docsDir)
  })

  it('inside REPO, tracked: source=$WT/<rel>, target=$REPO/<rel>', () => {
    const fixture = makeFixture()
    const rel = 'tracked-docs'
    mkdir(path.join(fixture.repo, rel))
    mkdir(path.join(fixture.wt, rel))
    const docsRoot: DocsRootFacts = {
      path: path.join(fixture.repo, rel),
      source: 'memory.md',
      exists: true,
      inRepoRel: rel,
      ignored: false,
    }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.mounts).toContainEqual({
      source: path.join(fixture.wt, rel),
      target: path.join(fixture.repo, rel),
      readonly: false,
      provenance: 'memory.md',
    })
  })

  it('inside REPO, tracked, but the worktree copy is missing: dropped with a docs-root-unsafe warning (not a hard failure)', () => {
    const fixture = makeFixture()
    const rel = 'tracked-missing-docs'
    mkdir(path.join(fixture.repo, rel)) // the repo's own copy exists...
    // ...but the worktree's copy (the actual mount source) was never created.
    const docsRoot: DocsRootFacts = {
      path: path.join(fixture.repo, rel),
      source: 'memory.md',
      exists: true,
      inRepoRel: rel,
      ignored: false,
    }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toContain('docs-root-unsafe')
    expect(targetsOf(result.mounts)).not.toContain(path.join(fixture.repo, rel))
  })

  it('inside REPO, tracked, where only the target ($REPO/<rel>) fails assertMountSafe (the worktree-side source is fine): dropped with a docs-root-unsafe warning', () => {
    const fixture = makeFixture()
    const rel = 'target-only-missing-docs'
    // Deliberately do NOT create fixture.repo/rel (so the target fails Rule 1's
    // realpath check) — only the worktree-side copy (the source) exists.
    mkdir(path.join(fixture.wt, rel))
    const docsRoot: DocsRootFacts = {
      path: path.join(fixture.repo, rel),
      source: 'memory.md',
      exists: true,
      inRepoRel: rel,
      ignored: false,
    }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings).toContain('docs-root-unsafe')
    expect(targetsOf(result.mounts)).not.toContain(path.join(fixture.repo, rel))
  })

  it("a 'default'-sourced docs_root is reported with provenance 'app' (Appendix C item 7)", () => {
    const fixture = makeFixture()
    const rel = 'docs'
    mkdir(path.join(fixture.repo, rel))
    mkdir(path.join(fixture.wt, rel))
    const docsRoot: DocsRootFacts = {
      path: path.join(fixture.repo, rel),
      source: 'default',
      exists: true,
      inRepoRel: rel,
      ignored: false,
    }
    const result = planMounts({ ...fixture.baseFacts, docsRoot })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const docsMount = result.mounts.find((m) => m.target === path.join(fixture.repo, rel))
    expect(docsMount?.provenance).toBe('app')
  })
})

// ── planMounts: fails closed on an unsafe path ──────────────────────────────

describe('planMounts — unsafe-path', () => {
  it('rejects the whole plan when a mount path contains a comma, before any mount is built', () => {
    const parent = mkTmp('co-spec-mounts-parent-')
    const home = path.join(parent, 'ho,me')
    mkdir(path.join(home, '.claude'))
    fs.writeFileSync(path.join(home, '.claude.json'), '{}')

    const facts: PlanMountsFacts = {
      home,
      repo: path.join(parent, 'repo'), // never reached: the comma fails on the very first mount
      wt: path.join(parent, 'wt'),
      slug: 'ws',
      gwt: path.join(parent, 'repo', '.git', 'worktrees', 'ws'),
      indexExists: false,
      hooksPathInsideGit: null,
      eventsEnabled: false,
      docsRoot: { path: path.join(parent, 'repo', 'docs'), source: 'default', exists: false, inRepoRel: 'docs', ignored: false },
      worktreesOverlay: false,
    }

    expect(planMounts(facts)).toEqual({ ok: false, reason: 'unsafe-path' })
  })

  it('rejects the whole plan when a required mount source is missing on disk', () => {
    const fixture = makeFixture()
    fs.rmSync(path.join(fixture.repo, '.git', 'modules'), { recursive: true, force: true })
    expect(planMounts(fixture.baseFacts)).toEqual({ ok: false, reason: 'unsafe-path' })
  })
})

// ── specHash (§3.5) ──────────────────────────────────────────────────────────

describe('specHash', () => {
  const mountA: Mount = { source: '/a', target: '/a', readonly: false, provenance: 'app' }
  const mountB: Mount = { source: '/b', target: '/b', readonly: true, provenance: 'app' }

  function baseInput(mounts: readonly Mount[]): SpecHashInput {
    return { plan: mounts, port: 20001, uid: 1000, gid: 1000, home: '/home/test', base: 'main', imageId: 'sha256:aaa' }
  }

  it('is stable under input reordering', () => {
    expect(specHash(baseInput([mountA, mountB]))).toBe(specHash(baseInput([mountB, mountA])))
  })

  it('changes when the docs_root source (provenance) changes', () => {
    const settings: Mount = { ...mountA, provenance: 'settings' }
    const memoryMd: Mount = { ...mountA, provenance: 'memory.md' }
    expect(specHash(baseInput([settings]))).not.toBe(specHash(baseInput([memoryMd])))
  })

  it.each([
    ['port', { port: 20002 }],
    ['uid', { uid: 1001 }],
    ['gid', { gid: 1001 }],
    ['base', { base: 'master' }],
    ['imageId', { imageId: 'sha256:bbb' }],
  ])('changes when %s changes', (_label, override) => {
    const base = baseInput([mountA])
    expect(specHash({ ...base, ...override })).not.toBe(specHash(base))
  })

  it('changes when a mount is added', () => {
    expect(specHash(baseInput([mountA]))).not.toBe(specHash(baseInput([mountA, mountB])))
  })

  it('changes when index appears', () => {
    const indexMount: Mount = { source: '/repo/.git/index', target: '/repo/.git/index', readonly: true, provenance: 'app' }
    expect(specHash(baseInput([mountA, indexMount]))).not.toBe(specHash(baseInput([mountA])))
  })
})

// ── diffMountPlans (Appendix C item 6, B-M2) ────────────────────────────────

describe('diffMountPlans', () => {
  it('reports a new read-write host path with its source, and no removals when nothing dropped', () => {
    const oldMounts: OldMount[] = [{ source: '/repo/.git', target: '/repo/.git', readonly: false }]
    const newPlan: Mount[] = [
      { source: '/repo/.git', target: '/repo/.git', readonly: false, provenance: 'app' },
      { source: '/settings/docs', target: '/settings/docs', readonly: false, provenance: 'settings' },
    ]
    const diff = diffMountPlans(oldMounts, newPlan)
    expect(diff.newHostMounts).toEqual([{ path: '/settings/docs', readonly: false, source: 'settings' }])
    expect(diff.removedHostMounts).toEqual([])
  })

  it('reports a removed host mount', () => {
    const oldMounts: OldMount[] = [
      { source: '/repo/.git', target: '/repo/.git', readonly: false },
      { source: '/old/docs', target: '/old/docs', readonly: false },
    ]
    const newPlan: Mount[] = [{ source: '/repo/.git', target: '/repo/.git', readonly: false, provenance: 'app' }]
    const diff = diffMountPlans(oldMounts, newPlan)
    expect(diff.removedHostMounts).toEqual(['/old/docs'])
    expect(diff.newHostMounts).toEqual([])
  })

  it('reports a source that flipped from read-only to read-write, even though it already existed', () => {
    const oldMounts: OldMount[] = [{ source: '/repo/docs', target: '/repo/docs', readonly: true }]
    const newPlan: Mount[] = [{ source: '/repo/docs', target: '/repo/docs', readonly: false, provenance: 'settings' }]
    const diff = diffMountPlans(oldMounts, newPlan)
    expect(diff.newHostMounts).toEqual([{ path: '/repo/docs', readonly: false, source: 'settings' }])
  })

  it('does NOT report a source that flipped from read-write to read-only (a restriction, not a new capability)', () => {
    const oldMounts: OldMount[] = [{ source: '/repo/docs', target: '/repo/docs', readonly: false }]
    const newPlan: Mount[] = [{ source: '/repo/docs', target: '/repo/docs', readonly: true, provenance: 'settings' }]
    const diff = diffMountPlans(oldMounts, newPlan)
    expect(diff.newHostMounts).toEqual([])
  })

  it('does not report a source whose readonly flag is unchanged', () => {
    const oldMounts: OldMount[] = [{ source: '/repo/.git', target: '/repo/.git', readonly: false }]
    const newPlan: Mount[] = [{ source: '/repo/.git', target: '/repo/.git', readonly: false, provenance: 'app' }]
    const diff = diffMountPlans(oldMounts, newPlan)
    expect(diff.newHostMounts).toEqual([])
  })

  it('reports an added index overlay as readonly: true', () => {
    const indexMount: Mount = { source: '/repo/.git/index', target: '/repo/.git/index', readonly: true, provenance: 'app' }
    const diff = diffMountPlans([], [indexMount])
    expect(diff.newHostMounts).toEqual([{ path: '/repo/.git/index', readonly: true, source: 'app' }])
  })
})

// ── hasMemoryMdMount ─────────────────────────────────────────────────────────

describe('hasMemoryMdMount', () => {
  it('is true only for a plan with a memory.md-sourced mount', () => {
    const withMemoryMd: Mount[] = [{ source: '/a', target: '/a', readonly: false, provenance: 'memory.md' }]
    const withoutMemoryMd: Mount[] = [{ source: '/a', target: '/a', readonly: false, provenance: 'settings' }]
    expect(hasMemoryMdMount(withMemoryMd)).toBe(true)
    expect(hasMemoryMdMount(withoutMemoryMd)).toBe(false)
    expect(hasMemoryMdMount([])).toBe(false)
  })
})
