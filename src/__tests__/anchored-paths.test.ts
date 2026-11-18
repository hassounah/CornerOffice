import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('../main/services/sandbox-paths', async (importActual) => ({
  ...(await importActual<typeof import('../main/services/sandbox-paths')>()),
  resolveRealHome: () => state.home,
}))

import { resetActiveProfileForTests, resolveProfile, setActiveProfile } from '../main/services/app-home'
import { isAppFolder, isRefusedAsWorkspace, overlapsAnchored } from '../main/services/anchored-paths'
import { realDataRoot } from '../main/services/sandbox-paths'

let home: string

function useProfile(env: NodeJS.ProcessEnv): void {
  resetActiveProfileForTests()
  setActiveProfile(resolveProfile(env, { isPackaged: false, realHome: home, appPath: '/work/tree' }))
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'anchored-')))
  state.home = home
  vi.stubEnv('CORNER_OFFICE_SANDBOX', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetActiveProfileForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

const mk = (...parts: string[]) => {
  const p = path.join(home, ...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}

describe('realDataRoot', () => {
  it('is <realHome>/.corner-office', () => {
    expect(realDataRoot('/home/u')).toBe('/home/u/.corner-office')
  })
})

describe('overlapsAnchored (normal mode)', () => {
  beforeEach(() => {
    useProfile({})
  })

  it.each([
    ['the data dir', ['.corner-office']],
    ['the config dir', ['.config', 'corner-office']],
    ['the claude dir', ['.claude']],
  ])('is true for %s: equal, inside and ancestor', (_name, parts) => {
    const anchor = mk(...parts)
    expect(overlapsAnchored(anchor)).toBe(true)
    expect(overlapsAnchored(path.join(anchor, 'deep', 'er'))).toBe(true)
    expect(overlapsAnchored(path.dirname(anchor))).toBe(true)
  })

  it('treats the data-dir worktrees and profiles as anchored', () => {
    mk('.corner-office')
    expect(overlapsAnchored(path.join(home, '.corner-office', 'sandboxes', 'foo'))).toBe(true)
    expect(overlapsAnchored(path.join(home, '.corner-office', 'profiles', 'dev'))).toBe(true)
  })

  it('is false for an unrelated path and for a name that merely shares a prefix', () => {
    mk('.corner-office')
    mk('.claude')
    expect(overlapsAnchored(mk('projects', 'app'))).toBe(false)
    expect(overlapsAnchored(path.join(home, '.claude-other'))).toBe(false)
    expect(overlapsAnchored(path.join(home, '.corner-office-x'))).toBe(false)
  })

  it('still works when the anchors do not exist yet', () => {
    expect(overlapsAnchored(path.join(home, '.claude', 'x'))).toBe(true)
    expect(overlapsAnchored(path.join(home, 'projects'))).toBe(false)
  })

  it('compares against the anchor realpath when an anchor is a symlink', () => {
    const elsewhere = mk('elsewhere', 'real-claude')
    fs.symlinkSync(elsewhere, path.join(home, '.claude'))
    expect(overlapsAnchored(elsewhere)).toBe(true)
    expect(overlapsAnchored(path.join(elsewhere, 'sub'))).toBe(true)
  })

  it('a non-hidden XDG_CONFIG_HOME and its ancestor are anchored', () => {
    const cfg = path.join(home, 'cfg')
    useProfile({ XDG_CONFIG_HOME: cfg })
    const anchor = mk('cfg', 'corner-office')
    expect(overlapsAnchored(anchor)).toBe(true)
    expect(overlapsAnchored(path.join(anchor, 'x'))).toBe(true)
    expect(overlapsAnchored(cfg)).toBe(true)
    expect(overlapsAnchored(mk('cfg-sibling'))).toBe(false)
  })

  it('the filesystem root is an ancestor of every anchor', () => {
    expect(overlapsAnchored('/')).toBe(true)
  })
})

describe('overlapsAnchored (sandbox mode)', () => {
  beforeEach(() => {
    vi.stubEnv('CORNER_OFFICE_SANDBOX', '1')
    useProfile({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_SANDBOX: '1' })
  })

  it('does not anchor a worktree under sandboxes/', () => {
    mk('.corner-office', 'profiles', 'dev')
    const worktree = mk('.corner-office', 'sandboxes', 'foo')
    expect(overlapsAnchored(worktree)).toBe(false)
    expect(overlapsAnchored(path.join(worktree, 'src'))).toBe(false)
  })

  it('anchors the profile home, its config dir and its claude home', () => {
    const profileHome = mk('.corner-office', 'profiles', 'dev')
    expect(overlapsAnchored(profileHome)).toBe(true)
    expect(overlapsAnchored(path.join(profileHome, 'electron'))).toBe(true)
    expect(overlapsAnchored(path.join(profileHome, 'claude', 'plugins'))).toBe(true)
  })

  it('does not anchor the real ~/.claude', () => {
    expect(overlapsAnchored(mk('.claude'))).toBe(false)
  })
})

describe('isAppFolder (sandbox mode carve-out)', () => {
  beforeEach(() => {
    vi.stubEnv('CORNER_OFFICE_SANDBOX', '1')
    useProfile({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_SANDBOX: '1' })
  })

  it('a worktree under ~/.corner-office/sandboxes/ is a valid workspace, but isAppFolder stays strict', () => {
    const worktree = mk('.corner-office', 'sandboxes', 'foo')
    expect(isRefusedAsWorkspace(worktree, home)).toBe(false)
    expect(isRefusedAsWorkspace(path.join(worktree, 'src'), home)).toBe(false)
    expect(isAppFolder(worktree, home)).toBe(true)
  })

  it('the profile home, ~/.codex and ~/.claude.json are still app folders', () => {
    expect(isAppFolder(mk('.corner-office', 'profiles', 'dev'), home)).toBe(true)
    expect(isAppFolder(path.join(home, '.codex'), home)).toBe(true)
    expect(isAppFolder(path.join(home, '.claude.json'), home)).toBe(true)
  })
})

describe('isAppFolder', () => {
  beforeEach(() => {
    useProfile({})
  })

  it.each(['.codex', '.claude.json', '.claude', '.corner-office'])('is true for ~/%s', (name) => {
    expect(isAppFolder(path.join(home, name), home)).toBe(true)
  })

  it('is true inside a hidden home entry', () => {
    expect(isAppFolder(path.join(home, '.codex', 'sessions'), home)).toBe(true)
  })

  it('is true when overlapsAnchored is, even outside the hidden segments', () => {
    const cfg = path.join(home, 'cfg')
    useProfile({ XDG_CONFIG_HOME: cfg })
    expect(isAppFolder(path.join(cfg, 'corner-office'), home)).toBe(true)
  })

  it('is false for an unrelated path and for a prefix-sharing name', () => {
    expect(isAppFolder(mk('projects', 'app'), home)).toBe(false)
    expect(isAppFolder(path.join(home, '.codexish'), home)).toBe(false)
  })
})
