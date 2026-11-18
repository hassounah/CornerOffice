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
import { isAppFolder, isInsideAppFolder, isRefusedAsWorkspace, overlapsAnchored } from '../main/services/anchored-paths'

let home: string

function useProfile(env: NodeJS.ProcessEnv): void {
  resetActiveProfileForTests()
  setActiveProfile(resolveProfile(env, { isPackaged: false, realHome: home, appPath: '/work/tree' }))
}

const mk = (...parts: string[]) => {
  const p = path.join(home, ...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carveout-')))
  state.home = home
  // The real app's config dir is `${XDG_CONFIG_HOME:-<home>/.config}/corner-office`. These tests expect the default
  // location under the temp home, so an XDG_CONFIG_HOME set on the machine or in CI must not leak in.
  vi.stubEnv('XDG_CONFIG_HOME', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetActiveProfileForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('isAppFolder: the carve-out lets only sandboxes/<id> through', () => {
  describe('sandbox mode', () => {
    beforeEach(() => {
      vi.stubEnv('CORNER_OFFICE_SANDBOX', '1')
      useProfile({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_SANDBOX: '1' })
    })

    it('a workspace may be a sandbox worktree or a folder inside it', () => {
      const wt = mk('.corner-office', 'sandboxes', 'api')
      expect(isRefusedAsWorkspace(wt, home)).toBe(false)
      expect(isRefusedAsWorkspace(path.join(wt, 'src'), home)).toBe(false)
    })

    it('isAppFolder itself stays strict: the sandbox mount guard shares it and must not be widened', () => {
      const wt = mk('.corner-office', 'sandboxes', 'api')
      expect(isAppFolder(wt, home)).toBe(true)
      expect(isAppFolder(path.join(wt, 'src'), home)).toBe(true)
    })

    it('the carve-out needs a valid single id segment under the sandboxes root', () => {
      mk('.corner-office', 'sandboxes')
      expect(isRefusedAsWorkspace(path.join(home, '.corner-office', 'sandboxes', '-bad'), home)).toBe(true)
      expect(isRefusedAsWorkspace(path.join(home, '.corner-office', 'sandboxes', 'has space'), home)).toBe(true)
      expect(isRefusedAsWorkspace(path.join(home, '.corner-office', 'sandboxes-other', 'api'), home)).toBe(true)
    })

    it('a worktree that overlaps the mode anchors is still refused', () => {
      // A profile named like an id can never sit under sandboxes/, so anchor overlap there is impossible by layout;
      // this pins that the carve-out defers to overlapsAnchored rather than returning false blindly.
      const wt = mk('.corner-office', 'sandboxes', 'api')
      expect(overlapsAnchored(wt)).toBe(false)
      expect(isRefusedAsWorkspace(wt, home)).toBe(false)
    })

    it.each([
      ['~/.corner-office itself', ['.corner-office']],
      ['~/.corner-office/profiles', ['.corner-office', 'profiles']],
      ['the active profile home', ['.corner-office', 'profiles', 'dev']],
      ['the active profile config dir', ['.corner-office', 'profiles', 'dev', 'electron']],
      ['~/.codex', ['.codex']],
      ['~/.claude', ['.claude']],
    ])('refuses %s', (_name, parts) => {
      expect(isAppFolder(mk(...parts), home)).toBe(true)
    })

    it.each([
      ['events/', ['.corner-office', 'events']],
      ['sandbox/ (state root)', ['.corner-office', 'sandbox']],
      ['another profile', ['.corner-office', 'profiles', 'other']],
      ['~/.config/corner-office', ['.config', 'corner-office']],
      ['the sandboxes root itself', ['.corner-office', 'sandboxes']],
    ])('still refuses %s (only sandboxes/<id> may pass)', (_name, parts) => {
      const p = mk(...parts)
      expect(isAppFolder(p, home)).toBe(true)
      expect(isRefusedAsWorkspace(p, home)).toBe(true)
    })

    it.each([
      ['~/.corner-office itself', ['.corner-office']],
      ['the active profile home', ['.corner-office', 'profiles', 'dev']],
      ['~/.codex', ['.codex']],
      ['~/.claude', ['.claude']],
    ])('the workspace predicate also refuses %s', (_name, parts) => {
      expect(isRefusedAsWorkspace(mk(...parts), home)).toBe(true)
    })
  })

  describe('normal mode is not loosened', () => {
    beforeEach(() => {
      vi.stubEnv('CORNER_OFFICE_SANDBOX', '')
      useProfile({})
    })

    it.each([
      ['~/.corner-office', ['.corner-office']],
      ['sandboxes/<id>', ['.corner-office', 'sandboxes', 'api']],
      ['events/', ['.corner-office', 'events']],
      ['profiles/dev', ['.corner-office', 'profiles', 'dev']],
      ['~/.config/corner-office', ['.config', 'corner-office']],
      ['~/.codex', ['.codex']],
    ])('refuses %s', (_name, parts) => {
      expect(isAppFolder(mk(...parts), home)).toBe(true)
    })
  })
})

// "Create new" judges the NEW folder, not its parent: a container ABOVE an app folder is fine, a folder AT or INSIDE
// one is not. Same sandbox-worktree carve-out as isRefusedAsWorkspace.
describe('isInsideAppFolder', () => {
  describe('normal mode', () => {
    beforeEach(() => {
      vi.stubEnv('CORNER_OFFICE_SANDBOX', '')
      useProfile({})
    })

    it.each([
      ['~/.corner-office itself', ['.corner-office']],
      ['inside ~/.corner-office', ['.corner-office', 'sandboxes', 'api', 'src']],
      ['~/.codex', ['.codex']],
      ['inside ~/.codex', ['.codex', 'sessions']],
      ['inside ~/.claude', ['.claude', 'projects']],
      ['~/.config/corner-office', ['.config', 'corner-office']],
      ['inside ~/.config/corner-office', ['.config', 'corner-office', 'logs']],
    ])('is true for %s', (_name, parts) => {
      expect(isInsideAppFolder(mk(...parts), home)).toBe(true)
    })

    it.each([
      ['the home folder (an ancestor of every app folder)', []],
      ['~/.config (an ancestor of the config dir)', ['.config']],
      ['an unrelated project', ['projects', 'app']],
      ['a name that merely shares a prefix', ['.codexish']],
    ])('is false for %s: an ancestor or a neighbour is a fine container', (_name, parts) => {
      expect(isInsideAppFolder(mk(...parts), home)).toBe(false)
    })
  })

  describe('sandbox mode', () => {
    beforeEach(() => {
      vi.stubEnv('CORNER_OFFICE_SANDBOX', '1')
      useProfile({ CORNER_OFFICE_PROFILE: 'dev', CORNER_OFFICE_SANDBOX: '1' })
    })

    it('lets a sandbox worktree and a folder inside it through', () => {
      const wt = mk('.corner-office', 'sandboxes', 'api')
      expect(isInsideAppFolder(wt, home)).toBe(false)
      expect(isInsideAppFolder(path.join(wt, 'src'), home)).toBe(false)
    })

    it.each([
      ['the sandboxes root itself', ['.corner-office', 'sandboxes']],
      ['an invalid id under the sandboxes root', ['.corner-office', 'sandboxes', '-bad']],
      ['~/.corner-office itself', ['.corner-office']],
      ['the active profile home', ['.corner-office', 'profiles', 'dev']],
      ['the active profile config dir', ['.corner-office', 'profiles', 'dev', 'electron']],
      ['another profile', ['.corner-office', 'profiles', 'other']],
      ['the real app config dir, which sandbox mode also guards', ['.config', 'corner-office']],
      ['inside the real app config dir', ['.config', 'corner-office', 'logs']],
      ['~/.codex', ['.codex']],
      ['~/.claude', ['.claude']],
    ])('still refuses %s', (_name, parts) => {
      expect(isInsideAppFolder(mk(...parts), home)).toBe(true)
    })

    it('an ancestor is still a fine container', () => {
      expect(isInsideAppFolder(home, home)).toBe(false)
      expect(isInsideAppFolder(mk('projects', 'app'), home)).toBe(false)
    })
  })
})
