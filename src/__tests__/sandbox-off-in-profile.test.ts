import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildOffSandboxHandlers } from '../main/ipc/sandbox-handlers'
import { SANDBOX_CHANNELS } from '../main/ipc/channels'
import { createRefusingDockerRunner } from '../main/services/docker-runner'
import { sandboxPaths } from '../main/services/sandbox-paths'
import { IPC_ERROR_CODES } from '../main/types/ipc'
import { makeEvent, makeWrapDeps, mainFrame, foreignFrame } from './helpers/code-ipc-harness'

// ---------------------------------------------------------------------------
// #0038 D6: in a named profile every SANDBOX_CHANNELS invoke channel is answered by the
// off handler set. Nothing may reach Docker or touch the real sandboxes root.
// ---------------------------------------------------------------------------

const PUSH_KEYS = ['CHANGED', 'BUILD_PROGRESS', 'BLOCKED']
const INVOKE_CHANNELS = Object.entries(SANDBOX_CHANNELS)
  .filter(([key]) => !PUSH_KEYS.includes(key))
  .map(([, channel]) => channel as string)

const SLUG = 'my-ws'
const HASH = 'a'.repeat(64)

/** A valid input for every invoke channel. */
const VALID_INPUT: Record<string, unknown> = {
  [SANDBOX_CHANNELS.GET_ENVIRONMENT]: { refresh: true },
  [SANDBOX_CHANNELS.GET_STATUS]: { workspaceSlug: SLUG },
  [SANDBOX_CHANNELS.GET_SUMMARIES]: {},
  [SANDBOX_CHANNELS.START_SESSION]: { workspaceSlug: SLUG, cols: 80, rows: 24, permissionMode: 'auto', networkMode: 'allowlist' },
  [SANDBOX_CHANNELS.HAND_OFF]: { workspaceSlug: SLUG, allowDirty: true },
  [SANDBOX_CHANNELS.PREVIEW_DELETE]: { workspaceSlug: SLUG },
  [SANDBOX_CHANNELS.DELETE]: { workspaceSlug: SLUG, acknowledgeDirty: true },
  [SANDBOX_CHANNELS.RECREATE]: { workspaceSlug: SLUG, newPort: false, confirmedSpecHash: HASH },
  [SANDBOX_CHANNELS.BUILD_IMAGE]: { rebuild: true, requestedFor: SLUG },
  [SANDBOX_CHANNELS.CANCEL_BUILD]: {},
  [SANDBOX_CHANNELS.GET_SETTINGS]: {},
  [SANDBOX_CHANNELS.UPDATE_SETTINGS]: { globalAllowlist: ['example.com'] },
  [SANDBOX_CHANNELS.GET_BLOCKED]: { workspaceSlug: SLUG },
}

const READS = [SANDBOX_CHANNELS.GET_ENVIRONMENT, SANDBOX_CHANNELS.GET_STATUS, SANDBOX_CHANNELS.GET_SUMMARIES, SANDBOX_CHANNELS.GET_SETTINGS, SANDBOX_CHANNELS.GET_BLOCKED] as string[]
const MUTATIONS = INVOKE_CHANNELS.filter((c) => !READS.includes(c))

/** Every path under `dir` with its size and mtime, so any create, write, rename or delete shows up. */
function snapshot(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name)
      const st = fs.lstatSync(full)
      out.push(`${path.relative(dir, full)}:${st.isDirectory() ? 'dir' : st.size}:${st.mtimeMs}`)
      if (st.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}

describe('buildOffSandboxHandlers', () => {
  let home: string
  let sandboxesRoot: string
  const handlers = buildOffSandboxHandlers(makeWrapDeps())

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-off-profile-')))
    sandboxesRoot = sandboxPaths(home).sandboxesRoot
    fs.mkdirSync(path.join(sandboxesRoot, SLUG, '.rix'), { recursive: true })
    fs.writeFileSync(path.join(sandboxesRoot, SLUG, 'agent.txt'), 'real worktree\n')
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('has a handler for every invoke channel of SANDBOX_CHANNELS, and for nothing else', () => {
    expect(Object.keys(handlers).sort()).toEqual([...INVOKE_CHANNELS].sort())
    expect(Object.keys(VALID_INPUT).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('answers every channel without docker calls or changes under the real sandboxes root', async () => {
    const docker = createRefusingDockerRunner()
    const run = vi.spyOn(docker, 'run')
    const stream = vi.spyOn(docker, 'stream')
    const before = snapshot(sandboxesRoot)

    for (const channel of INVOKE_CHANNELS) {
      await (handlers as Record<string, (e: unknown, i: unknown) => Promise<unknown>>)[channel](makeEvent(mainFrame), VALID_INPUT[channel])
    }

    expect(run).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(snapshot(sandboxesRoot)).toEqual(before)
  })

  const call = (channel: string, input: unknown = VALID_INPUT[channel]) =>
    (handlers as unknown as Record<string, (e: unknown, i: unknown) => Promise<{ data: unknown; error: { code: string; message: string } | null }>>)[channel](
      makeEvent(mainFrame),
      input,
    )

  it('reads return the static off values', async () => {
    expect((await call(SANDBOX_CHANNELS.GET_ENVIRONMENT)).data).toEqual({
      docker: 'not-installed',
      dockerVersion: null,
      image: { state: 'absent', builtAt: null, sizeBytes: null },
    })
    const status = (await call(SANDBOX_CHANNELS.GET_STATUS)).data as Record<string, unknown>
    expect(status).toMatchObject({
      workspaceSlug: SLUG,
      eligibility: { ok: false, reason: 'sandbox-disabled' },
      exists: false,
      container: 'absent',
      containers: { claude: 'absent', codex: 'absent' },
      worktree: 'absent',
      session: { state: 'idle', agentId: null },
      git: null,
      recreatePending: false,
      recreatePlan: null,
      recreatePlans: [],
    })
    expect((await call(SANDBOX_CHANNELS.GET_SUMMARIES)).data).toEqual({})
    expect((await call(SANDBOX_CHANNELS.GET_BLOCKED)).data).toEqual([])
    expect((await call(SANDBOX_CHANNELS.GET_SETTINGS)).data).toMatchObject({
      toolchains: { node: true, go: true, buildBase: true },
      globalAllowlist: [],
      workspaceAllowlists: {},
    })
  })

  it.each(MUTATIONS)('%s rejects with SANDBOX_OFF_IN_PROFILE and its fixed message', async (channel) => {
    const res = await call(channel)

    expect(res.data).toBeNull()
    expect(res.error).toEqual({ code: IPC_ERROR_CODES.SANDBOX_OFF_IN_PROFILE, message: 'Sandbox sessions are off in this profile' })
  })

  it('keeps the sender and validation checks of wrapCodeHandler', async () => {
    const foreign = await (handlers as unknown as Record<string, (e: unknown, i: unknown) => Promise<{ error: { code: string } | null }>>)[
      SANDBOX_CHANNELS.START_SESSION
    ](makeEvent(foreignFrame), VALID_INPUT[SANDBOX_CHANNELS.START_SESSION])
    expect(foreign.error?.code).toBe(IPC_ERROR_CODES.PERMISSION_DENIED)

    const invalid = await call(SANDBOX_CHANNELS.START_SESSION, { workspaceSlug: '../etc' })
    expect(invalid.error?.code).toBe(IPC_ERROR_CODES.VALIDATION_ERROR)
  })
})
