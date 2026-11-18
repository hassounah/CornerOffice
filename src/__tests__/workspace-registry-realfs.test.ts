import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '', fail: false }))
vi.mock('electron', () => ({ app: { exit: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('../main/services/sandbox-paths', async (importActual) => ({
  ...(await importActual<typeof import('../main/services/sandbox-paths')>()),
  resolveRealHome: () => {
    if (state.fail) throw new Error('no home')
    return state.home
  },
}))

import { resetActiveProfileForTests } from '../main/services/app-home'
import { WorkspaceError, allocateId } from '../main/services/workspace-registry'

// Fabricated sandbox trees: a worktree is `<sandboxes>/<id>/.git` containing `gitdir: <repo>/.git/worktrees/<id>`.
let home: string
let sandboxes: string
let sandboxState: string

const mk = (...parts: string[]) => {
  const p = path.join(...parts)
  fs.mkdirSync(p, { recursive: true })
  return p
}

function makeRepo(name: string, adminIds: string[] = []): string {
  const repo = mk(home, 'projects', name)
  mk(repo, '.git')
  for (const id of adminIds) mk(repo, '.git', 'worktrees', id)
  return repo
}

function makeWorktree(id: string, repo: string, pointerId = id): string {
  const wt = mk(sandboxes, id)
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', pointerId)}\n`)
  return wt
}

beforeEach(() => {
  resetActiveProfileForTests()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ws-registry-real-')))
  state.home = home
  state.fail = false
  sandboxes = path.join(home, '.corner-office', 'sandboxes')
  sandboxState = path.join(home, '.corner-office', 'sandbox')
})
afterEach(() => {
  resetActiveProfileForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

describe('allocateId', () => {
  it('returns the base when nothing collides', async () => {
    const repo = makeRepo('api')
    expect(await allocateId(repo, repo, [])).toBe('api')
  })

  it('a registered id collides case-insensitively', async () => {
    const repo = makeRepo('api')
    expect(await allocateId(repo, repo, ['API'])).toBe('api-2')
    expect(await allocateId(repo, repo, ['API', 'api-2'])).toBe('api-3')
  })

  it('strips a leading underscore, and falls back to workspace', async () => {
    expect(await allocateId('/x/_hidden', '/x/_hidden', [])).toBe('hidden')
    expect(await allocateId('/x/日本', '/x/日本', [])).toBe('workspace')
  })

  it('accepts constructor as an id', async () => {
    expect(await allocateId('/x/constructor', '/x/constructor', [])).toBe('constructor')
  })

  it('truncates within 64 characters when it adds a suffix', async () => {
    const long = 'a'.repeat(64)
    const id = await allocateId(`/x/${long}`, `/x/${long}`, [long])
    expect(id).toHaveLength(64)
    expect(id).toBe(`${'a'.repeat(62)}-2`)
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  })

  it('refuses with WORKSPACE_LIMIT when every id fails the check', async () => {
    state.fail = true
    await expect(allocateId('/x/api', '/x/api', [])).rejects.toMatchObject({ code: 'WORKSPACE_LIMIT' })
    await expect(allocateId('/x/api', '/x/api', [])).rejects.toBeInstanceOf(WorkspaceError)
  })

  describe('taken-check (fail closed)', () => {
    it('same repo keeps its id', async () => {
      const repo = makeRepo('api', ['api'])
      makeWorktree('api', repo)
      expect(await allocateId(repo, repo, [])).toBe('api')
    })

    it('same repo with a plain state dir keeps its id', async () => {
      const repo = makeRepo('api', ['api'])
      makeWorktree('api', repo)
      mk(sandboxState, 'api')
      expect(await allocateId(repo, repo, [])).toBe('api')
    })

    it('same repo whose state entry is a file -> -2', async () => {
      const repo = makeRepo('api', ['api'])
      makeWorktree('api', repo)
      mk(sandboxState)
      fs.writeFileSync(path.join(sandboxState, 'api'), 'x')
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('same repo whose state entry is a symlink -> -2', async () => {
      const repo = makeRepo('api', ['api'])
      makeWorktree('api', repo)
      mk(sandboxState)
      fs.symlinkSync(mk(home, 'elsewhere'), path.join(sandboxState, 'api'))
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('a different repo with the same name -> -2', async () => {
      const mine = makeRepo('api', ['api'])
      const other = mk(home, 'other', 'api')
      mk(other, '.git', 'worktrees', 'api')
      makeWorktree('api', other)
      expect(await allocateId(mine, mine, [])).toBe('api-2')
    })

    it('an empty worktree dir -> -2', async () => {
      const repo = makeRepo('api', ['api'])
      mk(sandboxes, 'api')
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('a garbage .git file -> -2', async () => {
      const repo = makeRepo('api', ['api'])
      mk(sandboxes, 'api')
      fs.writeFileSync(path.join(sandboxes, 'api', '.git'), 'not a pointer')
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('a .git directory -> -2', async () => {
      const repo = makeRepo('api', ['api'])
      mk(sandboxes, 'api', '.git')
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('a missing worktrees/<id> in the repo -> -2', async () => {
      const repo = makeRepo('api')
      mk(repo, '.git', 'worktrees', 'other')
      makeWorktree('api', repo)
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('a pointer to a path that does not exist -> -2', async () => {
      const repo = makeRepo('api', ['api'])
      makeWorktree('api', repo, 'gone')
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('a state dir with no worktree -> -2', async () => {
      const repo = makeRepo('api')
      mk(sandboxState, 'api')
      expect(await allocateId(repo, repo, [])).toBe('api-2')
    })

    it('skips every taken suffix', async () => {
      const repo = makeRepo('api')
      mk(sandboxes, 'api')
      mk(sandboxes, 'api-2')
      mk(sandboxState, 'api-3')
      expect(await allocateId(repo, repo, [])).toBe('api-4')
    })

    it('a symlinked selected path keeps the id of its repo', async () => {
      const repo = makeRepo('api', ['api'])
      makeWorktree('api', repo)
      const link = path.join(home, 'link-api')
      fs.symlinkSync(repo, link)
      expect(await allocateId(path.join(link), fs.realpathSync(link), [])).toBe('link-api')
    })
  })
})
