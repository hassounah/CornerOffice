import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildSandboxHandlers, createSandboxPushSenders } from '../main/ipc/sandbox-handlers'
import type { BuildSandboxHandlersDeps } from '../main/ipc/sandbox-handlers'
import { SANDBOX_CHANNELS } from '../main/ipc/channels'
import { createSandboxManager, sandboxSettings } from '../main/services/sandbox-manager'
import { DEFAULT_ALLOWLIST } from '../main/services/sandbox-allowlist'
import type { SandboxManagerService } from '../main/services/sandbox-manager'
import type { SandboxConfig } from '../main/types/config'
import { IPC_ERROR_CODES } from '../main/types/ipc'
import { makeEvent, makeWrapDeps, foreignFrame } from './helpers/code-ipc-harness'
import { cleanupHarness, setup, prepareRepo } from './helpers/sandbox-session-harness'

afterEach(cleanupHarness)

// ---------------------------------------------------------------------------
// sandbox-ipc.test.ts — step 4.4 (TRD 4.3 part, §3.13, §10.6). The 13
// sandbox:* handlers: every channel goes through wrapCodeHandler (sender
// check, strict schema, fixed-copy errors), updateSettings is serialized and
// validated, and a failed start never leaks docker stderr.
// ---------------------------------------------------------------------------

const SLUG = 'myslug'
const HASH = 'a'.repeat(64)
const LEAKY = new Error('boom at /home/amer/secret/path stderr: token=abc')

/** A valid input for every request channel. */
const VALID_INPUT: Record<string, unknown> = {
  [SANDBOX_CHANNELS.GET_ENVIRONMENT]: { refresh: false },
  [SANDBOX_CHANNELS.GET_STATUS]: { workspaceSlug: SLUG },
  [SANDBOX_CHANNELS.GET_SUMMARIES]: {},
  [SANDBOX_CHANNELS.START_SESSION]: { workspaceSlug: SLUG, cols: 80, rows: 24, permissionMode: 'skip', networkMode: 'allowlist' },
  [SANDBOX_CHANNELS.HAND_OFF]: { workspaceSlug: SLUG, allowDirty: false },
  [SANDBOX_CHANNELS.PREVIEW_DELETE]: { workspaceSlug: SLUG },
  [SANDBOX_CHANNELS.DELETE]: { workspaceSlug: SLUG, acknowledgeDirty: false },
  [SANDBOX_CHANNELS.RECREATE]: { workspaceSlug: SLUG, newPort: false, confirmedSpecHash: HASH },
  [SANDBOX_CHANNELS.BUILD_IMAGE]: { rebuild: false },
  [SANDBOX_CHANNELS.CANCEL_BUILD]: {},
  [SANDBOX_CHANNELS.GET_SETTINGS]: {},
  [SANDBOX_CHANNELS.UPDATE_SETTINGS]: { toolchains: { node: true, go: false, buildBase: true } },
  [SANDBOX_CHANNELS.GET_BLOCKED]: { workspaceSlug: SLUG },
}

const REQUEST_CHANNELS = Object.keys(VALID_INPUT)

function baseConfig(): SandboxConfig {
  return { toolchains: { node: true, go: true, buildBase: true }, globalAllowlist: ['example.org'], workspaces: { other: { channelPort: 4242, allowlist: ['a.dev'] } } }
}

function makeManager(fail = false): SandboxManagerService {
  const impl = <T>(value: T) =>
    vi.fn(async () => {
      if (fail) throw LEAKY
      return value
    })
  return {
    getEnvironment: impl({ docker: 'ok', dockerVersion: '28.0.0', image: { state: 'ready', builtAt: null, sizeBytes: null } }),
    getStatus: impl({ workspaceSlug: SLUG }),
    getSummaries: impl({}),
    startSession: impl({ ok: true, workspaceSlug: SLUG, kind: 'sandbox' }),
    handOff: impl({ ok: true }),
    previewDelete: impl({ sessionRunning: false, dirtyCount: 0, unmergedBranches: [] }),
    delete: impl({ ok: true }),
    recreate: impl({ ok: true }),
    getBlocked: vi.fn(() => {
      if (fail) throw LEAKY
      return []
    }),
    onSettingsChanged: vi.fn(),
  } as unknown as SandboxManagerService
}

interface Rig {
  manager: SandboxManagerService
  deps: BuildSandboxHandlersDeps
  saved: SandboxConfig[]
  handlers: ReturnType<typeof buildSandboxHandlers>
}

function makeRig(opts: { fail?: boolean; save?: (next: SandboxConfig) => Promise<void> } = {}): Rig {
  const manager = makeManager(opts.fail)
  const saved: SandboxConfig[] = []
  let current = baseConfig()
  const deps: BuildSandboxHandlersDeps = {
    ...makeWrapDeps(),
    image: {
      build: vi.fn(async () => {
        if (opts.fail) throw LEAKY
        return { ok: true as const, imageId: 'sha256:x', recreatePendingNames: ['co-sandbox-a'] }
      }),
      cancel: vi.fn(() => {
        if (opts.fail) throw LEAKY
      }),
    },
    config: {
      get: () => {
        if (opts.fail) throw LEAKY
        return current
      },
      update: async (mutator) => {
        if (opts.fail) throw LEAKY
        const next = mutator(current)
        await (opts.save ??
          (async (written: SandboxConfig) => {
            saved.push(written)
            current = written
          }))(next)
        return next
      },
    },
    workspaceSlugs: () => [SLUG, 'other'],
    noteBuildRequester: vi.fn(),
  }
  return { manager, deps, saved, handlers: buildSandboxHandlers(manager, deps) }
}

describe('buildSandboxHandlers', () => {
  it('has exactly one entry per SANDBOX_CHANNELS request channel (key parity)', () => {
    const { handlers } = makeRig()
    const requestChannels = [
      SANDBOX_CHANNELS.GET_ENVIRONMENT,
      SANDBOX_CHANNELS.GET_STATUS,
      SANDBOX_CHANNELS.GET_SUMMARIES,
      SANDBOX_CHANNELS.START_SESSION,
      SANDBOX_CHANNELS.HAND_OFF,
      SANDBOX_CHANNELS.PREVIEW_DELETE,
      SANDBOX_CHANNELS.DELETE,
      SANDBOX_CHANNELS.RECREATE,
      SANDBOX_CHANNELS.BUILD_IMAGE,
      SANDBOX_CHANNELS.CANCEL_BUILD,
      SANDBOX_CHANNELS.GET_SETTINGS,
      SANDBOX_CHANNELS.UPDATE_SETTINGS,
      SANDBOX_CHANNELS.GET_BLOCKED,
    ]
    const pushChannels: string[] = [SANDBOX_CHANNELS.CHANGED, SANDBOX_CHANNELS.BUILD_PROGRESS, SANDBOX_CHANNELS.BLOCKED]
    expect(Object.keys(handlers).sort()).toEqual([...requestChannels].sort())
    expect(Object.keys(SANDBOX_CHANNELS).length).toBe(requestChannels.length + pushChannels.length)
    for (const channel of pushChannels) expect(handlers[channel]).toBeUndefined()
  })

  describe.each(REQUEST_CHANNELS)('%s', (channel) => {
    it('a valid call from the main frame succeeds', async () => {
      const { handlers } = makeRig()
      const res = await handlers[channel](makeEvent(), VALID_INPUT[channel])
      expect(res.error).toBeNull()
    })

    it('denies a foreign sender', async () => {
      const { handlers } = makeRig()
      const res = await handlers[channel](makeEvent(foreignFrame), VALID_INPUT[channel])
      expect(res.error?.code).toBe(IPC_ERROR_CODES.PERMISSION_DENIED)
      expect(res.data).toBeNull()
    })

    it('denies a null sender frame', async () => {
      const { handlers } = makeRig()
      const res = await handlers[channel](makeEvent(null), VALID_INPUT[channel])
      expect(res.error?.code).toBe(IPC_ERROR_CODES.PERMISSION_DENIED)
    })

    it('rejects an extra key as VALIDATION_ERROR', async () => {
      const { handlers } = makeRig()
      const res = await handlers[channel](makeEvent(), { ...(VALID_INPUT[channel] as object), extra: 1 })
      expect(res.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
    })

    it('maps an injected throw to INTERNAL_ERROR without leaking the message or a path', async () => {
      const { handlers } = makeRig({ fail: true })
      const res = await handlers[channel](makeEvent(), VALID_INPUT[channel])
      expect(res.error?.code).toBe(IPC_ERROR_CODES.INTERNAL_ERROR)
      const text = JSON.stringify(res)
      expect(text).not.toContain('/home')
      expect(text).not.toContain('token')
      expect(text).not.toContain('boom')
    })
  })

  it('passes arguments through to the manager', async () => {
    const { handlers, manager } = makeRig()
    await handlers[SANDBOX_CHANNELS.START_SESSION](makeEvent(), VALID_INPUT[SANDBOX_CHANNELS.START_SESSION])
    expect(manager.startSession).toHaveBeenCalledWith({ slug: SLUG, cols: 80, rows: 24, permissionMode: 'skip', networkMode: 'allowlist' })
    await handlers[SANDBOX_CHANNELS.RECREATE](makeEvent(), VALID_INPUT[SANDBOX_CHANNELS.RECREATE])
    expect(manager.recreate).toHaveBeenCalledWith(SLUG, false, HASH)
    await handlers[SANDBOX_CHANNELS.HAND_OFF](makeEvent(), { workspaceSlug: SLUG, allowDirty: true })
    expect(manager.handOff).toHaveBeenCalledWith(SLUG, true)
    await handlers[SANDBOX_CHANNELS.DELETE](makeEvent(), { workspaceSlug: SLUG, acknowledgeDirty: true })
    expect(manager.delete).toHaveBeenCalledWith(SLUG, true)
    await handlers[SANDBOX_CHANNELS.GET_ENVIRONMENT](makeEvent(), { refresh: true })
    expect(manager.getEnvironment).toHaveBeenCalledWith({ refresh: true })
  })

  it('returns user-facing failures as typed data, not as an error', async () => {
    const { handlers, manager } = makeRig()
    vi.mocked(manager.startSession).mockResolvedValueOnce({ ok: false, code: 'IMAGE_MISSING', detail: null })
    const res = await handlers[SANDBOX_CHANNELS.START_SESSION](makeEvent(), VALID_INPUT[SANDBOX_CHANNELS.START_SESSION])
    expect(res).toEqual({ data: { ok: false, code: 'IMAGE_MISSING', detail: null }, error: null })
  })

  describe('buildImage and cancelBuild', () => {
    it('reduces the build result to the outcome only', async () => {
      const { handlers, deps } = makeRig()
      const res = await handlers[SANDBOX_CHANNELS.BUILD_IMAGE](makeEvent(), { rebuild: true })
      expect(deps.image.build).toHaveBeenCalledWith({ rebuild: true })
      expect(res.data).toEqual({ ok: true })
    })

    it('notes the requesting workspace before building, and null for an unknown one', async () => {
      const { handlers, deps } = makeRig()
      await handlers[SANDBOX_CHANNELS.BUILD_IMAGE](makeEvent(), { rebuild: false, requestedFor: SLUG })
      expect(deps.noteBuildRequester).toHaveBeenLastCalledWith(SLUG)
      await handlers[SANDBOX_CHANNELS.BUILD_IMAGE](makeEvent(), { rebuild: false, requestedFor: 'not-a-workspace' })
      expect(deps.noteBuildRequester).toHaveBeenLastCalledWith(null)
      await handlers[SANDBOX_CHANNELS.BUILD_IMAGE](makeEvent(), { rebuild: false })
      expect(deps.noteBuildRequester).toHaveBeenLastCalledWith(null)
    })

    it('passes a failed or cancelled build through with its fixed detail', async () => {
      const { handlers, deps } = makeRig()
      vi.mocked(deps.image.build).mockResolvedValueOnce({ ok: false, cancelled: true, detail: null })
      const res = await handlers[SANDBOX_CHANNELS.BUILD_IMAGE](makeEvent(), { rebuild: false })
      expect(res.data).toEqual({ ok: false, cancelled: true, detail: null })
    })

    it('cancelBuild calls the image service and returns null', async () => {
      const { handlers, deps } = makeRig()
      const res = await handlers[SANDBOX_CHANNELS.CANCEL_BUILD](makeEvent(), {})
      expect(deps.image.cancel).toHaveBeenCalledTimes(1)
      expect(res).toEqual({ data: null, error: null })
    })
  })

  describe('getSettings', () => {
    it('returns the view with the built-in default allowlist and per-workspace lists', async () => {
      const { handlers } = makeRig()
      const res = await handlers[SANDBOX_CHANNELS.GET_SETTINGS](makeEvent(), {})
      expect(res.data).toEqual({
        toolchains: { node: true, go: true, buildBase: true },
        defaultAllowlist: DEFAULT_ALLOWLIST,
        globalAllowlist: ['example.org'],
        workspaceAllowlists: { other: ['a.dev'] },
      })
    })
  })

  describe('updateSettings', () => {
    it('writes toolchains through the config store, keeps the rest, and does not touch the firewall', async () => {
      const { handlers, saved, manager } = makeRig()
      const res = await handlers[SANDBOX_CHANNELS.UPDATE_SETTINGS](makeEvent(), { toolchains: { node: false, go: true, buildBase: true } })
      expect(saved).toHaveLength(1)
      expect(saved[0]).toEqual({ ...baseConfig(), toolchains: { node: false, go: true, buildBase: true } })
      expect((res.data as { toolchains: unknown }).toolchains).toEqual({ node: false, go: true, buildBase: true })
      expect(manager.onSettingsChanged).not.toHaveBeenCalled()
    })

    it('a global allowlist change notifies every known workspace', async () => {
      const { handlers, saved, manager } = makeRig()
      await handlers[SANDBOX_CHANNELS.UPDATE_SETTINGS](makeEvent(), { globalAllowlist: ['new.example.com'] })
      expect(saved[0].globalAllowlist).toEqual(['new.example.com'])
      expect(manager.onSettingsChanged).toHaveBeenCalledWith([SLUG, 'other'])
    })

    it('a workspace allowlist change notifies only that workspace and keeps its stored channel port', async () => {
      const { handlers, saved, manager } = makeRig()
      await handlers[SANDBOX_CHANNELS.UPDATE_SETTINGS](makeEvent(), { workspaceAllowlist: { workspaceSlug: 'other', entries: ['b.dev'] } })
      expect(saved[0].workspaces.other).toEqual({ channelPort: 4242, allowlist: ['b.dev'] })
      expect(manager.onSettingsChanged).toHaveBeenCalledWith(['other'])
    })

    it('a workspace without stored config gets a null channel port', async () => {
      const { handlers, saved } = makeRig()
      await handlers[SANDBOX_CHANNELS.UPDATE_SETTINGS](makeEvent(), { workspaceAllowlist: { workspaceSlug: SLUG, entries: ['c.dev'] } })
      expect(saved[0].workspaces[SLUG]).toEqual({ channelPort: null, allowlist: ['c.dev'] })
    })

    it('rejects an unknown workspace with NOT_FOUND and writes nothing', async () => {
      const { handlers, saved, manager } = makeRig()
      const res = await handlers[SANDBOX_CHANNELS.UPDATE_SETTINGS](makeEvent(), { workspaceAllowlist: { workspaceSlug: 'ghost', entries: ['c.dev'] } })
      expect(res.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
      expect(saved).toHaveLength(0)
      expect(manager.onSettingsChanged).not.toHaveBeenCalled()
    })

    it('a failed write does not wedge the queue', async () => {
      let calls = 0
      const rig = makeRig({
        save: async () => {
          calls += 1
          if (calls === 1) throw LEAKY
        },
      })
      const handlers = buildSandboxHandlers(rig.manager, rig.deps)
      const first = await handlers[SANDBOX_CHANNELS.UPDATE_SETTINGS](makeEvent(), { globalAllowlist: ['x.dev'] })
      const second = await handlers[SANDBOX_CHANNELS.UPDATE_SETTINGS](makeEvent(), { globalAllowlist: ['y.dev'] })
      expect(first.error?.code).toBe(IPC_ERROR_CODES.INTERNAL_ERROR)
      expect(second.error).toBeNull()
    })
  })
})

describe('createSandboxPushSenders', () => {
  function windowStub(destroyed = false): { win: Electron.BrowserWindow; send: ReturnType<typeof vi.fn> } {
    const send = vi.fn()
    const win = { isDestroyed: () => destroyed, webContents: { send } } as unknown as Electron.BrowserWindow
    return { win, send }
  }

  it('sends each payload on its own channel', () => {
    const { win, send } = windowStub()
    const push = createSandboxPushSenders(() => win)
    push.changed({ workspaceSlug: null })
    push.buildProgress({ line: 'step 1', phase: 'running' })
    push.blocked({ workspaceSlug: SLUG, entries: [] })
    expect(send.mock.calls).toEqual([
      [SANDBOX_CHANNELS.CHANGED, { workspaceSlug: null }],
      [SANDBOX_CHANNELS.BUILD_PROGRESS, { line: 'step 1', phase: 'running' }],
      [SANDBOX_CHANNELS.BLOCKED, { workspaceSlug: SLUG, entries: [] }],
    ])
  })

  it('does nothing without a window or with a destroyed one', () => {
    const { win, send } = windowStub(true)
    createSandboxPushSenders(() => win).changed({ workspaceSlug: SLUG })
    createSandboxPushSenders(() => null).changed({ workspaceSlug: SLUG })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('sandbox:startSession with a real manager', () => {
  it('a scripted docker failure returns fixed copy and never the stderr text', async () => {
    sandboxSettings.disabled = false
    const h = setup()
    prepareRepo(h)
    h.docker.script(['exec'], { error: { kind: 'failed', exitCode: 2, stderrTail: 'init-firewall: SECRET_STDERR /home/x/path' } })
    const manager = createSandboxManager(h.makeDeps())
    const handlers = buildSandboxHandlers(manager, {
      ...makeWrapDeps(),
      image: h.image.service,
      config: { get: () => h.sandboxConfig, update: async (mutator) => mutator(h.sandboxConfig) },
      workspaceSlugs: () => [SLUG],
      noteBuildRequester: () => {},
    })

    const res = await handlers[SANDBOX_CHANNELS.START_SESSION](makeEvent(), { ...(VALID_INPUT[SANDBOX_CHANNELS.START_SESSION] as object) })

    expect(res.error).toBeNull()
    expect(res.data).toMatchObject({ ok: false, code: 'FIREWALL_FAILED' })
    expect(JSON.stringify(res)).not.toContain('SECRET_STDERR')
    expect(JSON.stringify(res)).not.toContain('/home/x')
  })
})
