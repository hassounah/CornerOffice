import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { exit: vi.fn() }, ipcMain: { handle: vi.fn() }, dialog: {}, shell: {}, clipboard: {}, Menu: {} }))
vi.mock('electron-log/main', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import * as nodePty from 'node-pty'
import { buildRealHandlers } from '../main/ipc/handlers'
import type { AppState } from '../main/ipc/handlers'
import { createSandboxManager, sandboxSettings } from '../main/services/sandbox-manager'
import { getAvailableWorkspace, requireAvailableWorkspace, resolveCodeRoot, resolveRepoRoot } from '../main/services/repo-path'
import { TerminalManagerService } from '../main/services/terminal-manager'
import type { Availability, Workspace } from '../main/types/workspace'
import { cleanupHarness, prepareRepo, setup } from './helpers/sandbox-session-harness'
import { makeHandlerDeps } from './helpers/handler-deps'
import { fakeRuntime, makeWorkspace } from './helpers/workspace-fixture'

// ---------------------------------------------------------------------------
// Availability is enforced at every consumer of a workspace's path (#0039 3.6, Sec H1): terminal create,
// code:*, docs:*, sandbox start and the channel resolver all fail closed for a workspace that is not `ok`.
// ---------------------------------------------------------------------------

const BLOCKED: Array<Exclude<Availability, 'ok'>> = ['moved', 'missing', 'unsafe', 'checking']
const CODES: Record<Exclude<Availability, 'ok'>, string> = {
  missing: 'WORKSPACE_PATH_NOT_FOUND',
  'not-a-directory': 'WORKSPACE_NOT_A_DIRECTORY',
  unsafe: 'WORKSPACE_UNSAFE_ROOT',
  unreachable: 'TIMEOUT',
  moved: 'NOT_FOUND',
  checking: 'NOT_FOUND',
  budget: 'NOT_FOUND',
}

let tmp: string
let repo: string
let rechecks: number

function stateWith(...workspaces: Workspace[]): AppState {
  const map = new Map(workspaces.map((w) => [w.slug, w]))
  return {
    workspaces: map,
    activityFeed: [],
    notifications: [],
    gamificationState: {} as AppState['gamificationState'],
    homunculusState: null,
    registry: {} as AppState['registry'],
    runtime: fakeRuntime(map, () => {
      rechecks += 1
    }),
    channelDiscovery: null,
    channelConnection: null,
    terminalManager: null,
    sandboxManager: null,
  }
}

const ws = (availability: Availability, extra: Partial<Workspace> = {}): Workspace =>
  makeWorkspace({ slug: 'ws', path: repo, docsRoot: path.join(repo, 'docs'), availability, ...extra })

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string | undefined> {
  try {
    await (typeof p === 'function' ? p() : p)
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

beforeEach(() => {
  rechecks = 0
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'avail-')))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'docs', 'a.md'), '# a')
  vi.mocked(nodePty.spawn).mockClear()
})
afterEach(() => {
  cleanupHarness()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('requireAvailableWorkspace', () => {
  it('returns an available workspace without a recheck', () => {
    const state = stateWith(ws('ok'))
    expect(requireAvailableWorkspace('ws', state).slug).toBe('ws')
    expect(rechecks).toBe(0)
  })

  it('an unknown id is denied, including ids that are prototype members', async () => {
    const state = stateWith(ws('ok'))
    for (const id of ['nope', 'constructor', 'toString', '__proto__']) expect(await codeOf(() => requireAvailableWorkspace(id, state)), id).toBe('PERMISSION_DENIED')
    expect(rechecks).toBe(0) // nothing to recheck for an id the registry does not hold
  })

  it.each(Object.entries(CODES))('%s -> %s', async (availability, code) => {
    const state = stateWith(ws(availability as Availability))
    expect(await codeOf(() => requireAvailableWorkspace('ws', state))).toBe(code)
  })

  it('a refusal carries a fixed message with no path', () => {
    const state = stateWith(ws('missing'))
    expect(() => requireAvailableWorkspace('ws', state)).toThrow('Workspace path not found')
    try {
      requireAvailableWorkspace('ws', state)
    } catch (err) {
      expect((err as Error).message).not.toContain(repo)
    }
  })

  it('a refusal triggers a non-blocking recheck', () => {
    const state = stateWith(ws('missing'))
    expect(() => requireAvailableWorkspace('ws', state)).toThrow()
    expect(rechecks).toBe(1)
  })

  it('a recheck that throws or rejects does not change the answer', async () => {
    const state = stateWith(ws('missing'))
    state.runtime.recheck = () => {
      throw new Error('boom')
    }
    expect(await codeOf(() => requireAvailableWorkspace('ws', state))).toBe('WORKSPACE_PATH_NOT_FOUND')
    state.runtime.recheck = () => Promise.reject(new Error('later'))
    expect(await codeOf(() => requireAvailableWorkspace('ws', state))).toBe('WORKSPACE_PATH_NOT_FOUND')
  })

  it('an ok entry whose probe is in flight is treated as checking', async () => {
    const state = stateWith(ws('ok'))
    state.runtime.isAvailable = () => false
    expect(await codeOf(() => requireAvailableWorkspace('ws', state))).toBe('NOT_FOUND')
    expect(rechecks).toBe(1)
  })

  it('getAvailableWorkspace answers undefined instead of throwing, and does not recheck', () => {
    expect(getAvailableWorkspace('ws', stateWith(ws('ok')))?.slug).toBe('ws')
    for (const a of BLOCKED) expect(getAvailableWorkspace('ws', stateWith(ws(a)))).toBeUndefined()
    expect(getAvailableWorkspace('constructor', stateWith(ws('ok')))).toBeUndefined()
    expect(rechecks).toBe(0)
  })
})

describe.each(BLOCKED)('a %s workspace', (availability) => {
  it('terminal create is refused, and no pty is spawned in $HOME', () => {
    const state = stateWith(ws(availability))
    const svc = new TerminalManagerService(() => null, state)
    expect(() => svc.spawn({ workspaceSlug: 'ws', cols: 80, rows: 24 })).toThrow()
    expect(nodePty.spawn).not.toHaveBeenCalled()
  })

  it('code:* roots resolve to a fixed error', async () => {
    const state = stateWith(ws(availability))
    expect(await codeOf(resolveRepoRoot('ws', state))).toBe(CODES[availability])
    expect(await codeOf(resolveCodeRoot('ws', 'workspace', state))).toBe(CODES[availability])
    expect(await codeOf(resolveCodeRoot('ws', 'sandbox', state))).toBeDefined()
  })

  it('docs:* returns a fixed error', async () => {
    const state = stateWith(ws(availability))
    const handlers = buildRealHandlers(state, () => null, makeHandlerDeps().deps)
    const event = { sender: {} } as unknown as Electron.IpcMainInvokeEvent
    for (const channel of ['docs:listTree', 'docs:readFile']) {
      const input = channel === 'docs:listTree' ? { dirPath: path.join(repo, 'docs'), workspaceSlug: 'ws' } : { filePath: path.join(repo, 'docs', 'a.md'), workspaceSlug: 'ws' }
      const result = (await handlers[channel]?.(event, input)) as { data: unknown; error: { code: string; message: string } | null }
      expect(result.data, channel).toBeNull()
      expect(result.error?.code, channel).toBe(CODES[availability])
      expect(result.error?.message, channel).not.toContain(repo)
    }
  })

  it('sandbox start is refused: the manager does not know the workspace', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const state = stateWith(makeWorkspace({ slug: 'myslug', path: h.repo, availability }))
    const deps = h.makeDeps({
      appState: {
        getWorkspace: (slug) => {
          const w = getAvailableWorkspace(slug, state)
          return w ? { path: w.path, repoRootStatus: w.repoRootStatus } : undefined
        },
        getWorkspaceRoots: () => [h.repo],
      },
    })
    const result = await createSandboxManager(deps).startSession(h.opts())
    expect(result.ok).toBe(false)
    expect(h.terminal.spawnCalls).toHaveLength(0)
    expect(h.docker.calls.some((c) => c.args[0] === 'create')).toBe(false)
  })

  it('a refusal triggers a recheck', async () => {
    const state = stateWith(ws(availability))
    await codeOf(resolveRepoRoot('ws', state))
    expect(rechecks).toBe(1)
  })
})

describe('an available workspace still works', () => {
  it('resolveRepoRoot returns the real path', async () => {
    expect(await resolveRepoRoot('ws', stateWith(ws('ok')))).toBe(repo)
  })

  it('the sandbox start gets past the workspace lookup', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    const state = stateWith(makeWorkspace({ slug: 'myslug', path: h.repo, availability: 'ok' }))
    const deps = h.makeDeps({
      appState: {
        getWorkspace: (slug) => {
          const w = getAvailableWorkspace(slug, state)
          return w ? { path: w.path, repoRootStatus: w.repoRootStatus } : undefined
        },
        getWorkspaceRoots: () => [h.repo],
      },
    })
    expect((await createSandboxManager(deps).startSession(h.opts())).ok).toBe(true)
  })
})

describe('a folder swapped for a symlink after a successful check', () => {
  it('resolveRepoRoot denies, because the realpath no longer equals the registered path', async () => {
    const state = stateWith(ws('ok'))
    expect(await resolveRepoRoot('ws', state)).toBe(repo)

    const elsewhere = path.join(tmp, 'elsewhere')
    fs.mkdirSync(elsewhere)
    fs.renameSync(repo, path.join(tmp, 'repo-moved'))
    fs.symlinkSync(elsewhere, repo)

    expect(await codeOf(resolveRepoRoot('ws', state))).toBe('PERMISSION_DENIED')
  })
})
