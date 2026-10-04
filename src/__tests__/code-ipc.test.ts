import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildCodeHandlers } from '../main/ipc/code-handlers'
import type { BuildCodeHandlersDeps } from '../main/ipc/code-handlers'
import { CODE_CHANNELS } from '../main/ipc/channels'
import { sandboxPaths } from '../main/services/sandbox-paths'
import type { SandboxManagerService } from '../main/services/sandbox-manager'
import { IPC_ERROR_CODES } from '../main/types/ipc'
import {
  makeEvent,
  makeWrapDeps,
  makeWorkspace,
  makeAppState,
  makeMockRepoService,
  makeMockCodeWatcher,
  mainFrame,
  foreignFrame,
} from './helpers/code-ipc-harness'

// ---------------------------------------------------------------------------
// code-ipc.test.ts — the 8 code:* IPC handlers (Step 1.18, TRD §3.3.5,
// §3.4.2; Sec H-1, M-2).
//
// Real fs in a fresh mkdtemp'd repo root per test; RepoService and
// CodeWatcher are mocked at their own interface boundary — each already has
// its own dedicated, real-git/real-fs test suite (git-service-*.test.ts,
// code-watcher.test.ts), so these tests are about the IPC wiring and the
// write policy, never about re-proving those services' own behavior.
// ---------------------------------------------------------------------------

let tmpDir: string
let root: string

/** makeWorkspace's default docs root; every call passes it to git-runner's binary check alongside the workspace path. */
const DOCS_ROOT = '/tmp/does-not-matter/docs'

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-code-ipc-test-'))
  root = fs.realpathSync(tmpDir)
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello\n')
  fs.mkdirSync(path.join(root, 'sub'))
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'world\n')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function mtimeOf(rel: string): string {
  return fs.statSync(path.join(root, rel)).mtime.toISOString()
}

function build(overrides: Partial<BuildCodeHandlersDeps> = {}) {
  const repoService = makeMockRepoService()
  const codeWatcher = makeMockCodeWatcher()
  const ws = makeWorkspace({ slug: 'ws', path: root })
  const appState = makeAppState([ws])
  // A never-created fake home: the default (the real home) leaks any sandbox worktrees on the dev machine into the git-binary refusal roots.
  const deps: BuildCodeHandlersDeps = { ...makeWrapDeps(), repoService, codeWatcher, sandboxPaths: sandboxPaths(path.join(tmpDir, 'no-home')), ...overrides }
  const handlers = buildCodeHandlers(appState, deps)
  return { handlers, repoService, codeWatcher }
}

const PERMISSION_DENIED_RESPONSE = { data: null, error: { code: IPC_ERROR_CODES.PERMISSION_DENIED, message: 'Access denied' } }
const VALIDATION_ERROR_RESPONSE = { data: null, error: { code: IPC_ERROR_CODES.VALIDATION_ERROR, message: 'Invalid request' } }
const INTERNAL_ERROR_RESPONSE = { data: null, error: { code: IPC_ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong' } }

// ---------------------------------------------------------------------------
// Key parity
// ---------------------------------------------------------------------------

describe('buildCodeHandlers', () => {
  it('key parity: registers exactly the 8 code:* request channels (CHANGED is push-only)', () => {
    const { handlers } = build()
    const requestChannels = Object.values(CODE_CHANNELS).filter((c) => c !== CODE_CHANNELS.CHANGED)
    expect(requestChannels).toHaveLength(8)
    expect(Object.keys(handlers).sort()).toEqual([...requestChannels].sort())
  })
})

// ---------------------------------------------------------------------------
// Happy-path smoke tests — one successful call per channel, proving each
// handler's normal (non-error) return path and its call-through to the
// right service method with repo-relative arguments.
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('getStatus resolves the workspace to its root and calls repoService.getStatus', async () => {
    const { handlers, repoService } = build()
    const res = await handlers[CODE_CHANNELS.GET_STATUS](makeEvent(mainFrame), { workspaceSlug: 'ws', baseline: 'head' })
    expect(res.error).toBeNull()
    expect(repoService.getStatus).toHaveBeenCalledWith({ root }, [root, DOCS_ROOT], 'head')
  })

  it('listDir with no prior git probe falls back to FALLBACK_IGNORES (gitCtx undefined)', async () => {
    const { handlers, repoService } = build()
    const res = await handlers[CODE_CHANNELS.LIST_DIR](makeEvent(mainFrame), { workspaceSlug: 'ws', relDir: '', includeIgnored: false })
    expect(res.error).toBeNull()
    expect(res.data).toMatchObject({ relDir: '' })
    expect(repoService.checkIgnore).not.toHaveBeenCalled()
  })

  it('listDir with a cached git probe wires gitCtx.checkIgnore through to repoService', async () => {
    const { handlers, repoService } = build()
    repoService.getCachedEntry.mockReturnValueOnce({
      gitDir: null,
      commonDir: null,
      gitDirValid: false,
      headOid: null,
      mergeBase: null,
      gitlinks: new Set<string>(),
      unsafe: false,
    })
    const res = await handlers[CODE_CHANNELS.LIST_DIR](makeEvent(mainFrame), { workspaceSlug: 'ws', relDir: '', includeIgnored: false })
    expect(res.error).toBeNull()
    expect(repoService.checkIgnore).toHaveBeenCalledWith({ root }, [root, DOCS_ROOT], expect.arrayContaining(['a.txt', 'sub']))
  })

  it('readFile returns the real file content, repo-relative', async () => {
    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.READ_FILE](makeEvent(mainFrame), { workspaceSlug: 'ws', relPath: 'a.txt', reveal: false })
    expect(res.error).toBeNull()
    expect(res.data).toMatchObject({ kind: 'text', relPath: 'a.txt', content: 'hello\n' })
  })

  it('getFileIndex calls through to repoService with the resolved root', async () => {
    const { handlers, repoService } = build()
    const res = await handlers[CODE_CHANNELS.GET_FILE_INDEX](makeEvent(mainFrame), { workspaceSlug: 'ws', includeIgnored: false })
    expect(res.error).toBeNull()
    expect(repoService.getFileIndex).toHaveBeenCalledWith({ root }, [root, DOCS_ROOT], false)
  })

  it('watch delegates to codeWatcher.watch', async () => {
    const { handlers, codeWatcher } = build()
    const res = await handlers[CODE_CHANNELS.WATCH](makeEvent(mainFrame), { workspaceSlug: 'ws', gen: 1, openFile: null, expandedDirs: [] })
    expect(res.error).toBeNull()
    expect(codeWatcher.watch).toHaveBeenCalledWith({ workspaceSlug: 'ws', root: 'workspace', gen: 1, openFile: null, expandedDirs: [] })
  })

  it('unwatch delegates to codeWatcher.unwatch and returns { ok: true }', async () => {
    const { handlers, codeWatcher } = build()
    const res = await handlers[CODE_CHANNELS.UNWATCH](makeEvent(mainFrame), { workspaceSlug: 'ws', gen: 1 })
    expect(res).toEqual({ data: { ok: true }, error: null })
    expect(codeWatcher.unwatch).toHaveBeenCalledWith({ workspaceSlug: 'ws', root: 'workspace', gen: 1 })
  })
})

// ---------------------------------------------------------------------------
// Table-driven: sender/origin, validation and error-sanitization, over all
// 8 channels.
// ---------------------------------------------------------------------------

type MockRepoService = ReturnType<typeof makeMockRepoService>
type MockCodeWatcher = ReturnType<typeof makeMockCodeWatcher>

interface ChannelCase {
  channel: string
  validInput: () => Record<string, unknown>
  invalidInput: () => Record<string, unknown>
  /** Configures whatever this channel's real dependency needs to throw an
   *  un-coded (non-allowlisted) error, and returns a teardown to undo it. */
  injectThrow: (ctx: { repoService: MockRepoService; codeWatcher: MockCodeWatcher }) => Promise<() => void>
}

/** Spies on the shared FileHandle prototype's `.read`, rejecting exactly the
 *  next call — the same technique code-fs-read.test.ts uses, since
 *  fs.promises.FileHandle isn't exported as a named class to spy on
 *  directly. */
async function spyOnNextFileHandleRead(): Promise<() => void> {
  const dummyPath = path.join(root, `.dummy-for-spy-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(dummyPath, 'x')
  const dummy = await fs.promises.open(dummyPath, 'r')
  const proto = Object.getPrototypeOf(dummy) as { read: (...args: unknown[]) => unknown }
  await dummy.close()
  const readSpy = vi.spyOn(proto, 'read').mockRejectedValueOnce(new Error('boom'))
  return () => readSpy.mockRestore()
}

const CHANNEL_CASES: ChannelCase[] = [
  {
    channel: CODE_CHANNELS.GET_STATUS,
    validInput: () => ({ workspaceSlug: 'ws', baseline: 'head' }),
    invalidInput: () => ({ workspaceSlug: 'ws', baseline: 'nonsense' }),
    injectThrow: async ({ repoService }) => {
      repoService.getStatus.mockRejectedValueOnce(new Error('boom'))
      return () => {}
    },
  },
  {
    channel: CODE_CHANNELS.LIST_DIR,
    validInput: () => ({ workspaceSlug: 'ws', relDir: '', includeIgnored: false }),
    invalidInput: () => ({ workspaceSlug: 'ws', relDir: '../x', includeIgnored: false }),
    injectThrow: async ({ repoService }) => {
      // listDir itself is the real code-fs.listDir (not injected) — the only
      // injectable dependency it takes is gitCtx.checkIgnore, wired only
      // when getCachedEntry returns a cache entry.
      repoService.getCachedEntry.mockReturnValueOnce({
        gitDir: null,
        commonDir: null,
        gitDirValid: false,
        headOid: null,
        mergeBase: null,
        gitlinks: new Set<string>(),
        unsafe: false,
      })
      repoService.checkIgnore.mockRejectedValueOnce(new Error('boom'))
      return () => {}
    },
  },
  {
    channel: CODE_CHANNELS.READ_FILE,
    validInput: () => ({ workspaceSlug: 'ws', relPath: 'a.txt', reveal: false }),
    invalidInput: () => ({ workspaceSlug: 'ws', relPath: '.git/config', reveal: false }),
    // readFile is the real code-fs.readFile — its own fh.read() call is the
    // only step not already wrapped/converted to a fixed error code.
    injectThrow: async () => spyOnNextFileHandleRead(),
  },
  {
    channel: CODE_CHANNELS.READ_BASELINE,
    validInput: () => ({ workspaceSlug: 'ws', relPath: 'a.txt', baseline: 'head', reveal: false }),
    invalidInput: () => ({ workspaceSlug: 'ws', relPath: '../x', baseline: 'head', reveal: false }),
    injectThrow: async ({ repoService }) => {
      repoService.readBlob.mockRejectedValueOnce(new Error('boom'))
      return () => {}
    },
  },
  {
    channel: CODE_CHANNELS.WRITE_FILE,
    validInput: () => ({ workspaceSlug: 'ws', relPath: 'a.txt', content: 'hello again', expectedMtime: mtimeOf('a.txt') }),
    invalidInput: () => ({ workspaceSlug: 'ws', relPath: '.git/config', content: 'x', expectedMtime: new Date().toISOString() }),
    // durableWrite's own post-rename stat is the one step not caught/mapped
    // to a fixed code by checkTarget's blanket catch (safe-fs.test.ts uses
    // this same call-counting technique for the same real stat call). Three
    // fs.promises.stat calls happen before it: resolveRepoRoot's own (in the
    // handler, before durableWrite even starts), then durableWrite's origMode
    // capture (both of those two DO map to a fixed code on failure) — so the
    // un-coded conversion (writeFailed() -> INTERNAL_ERROR) is the 3rd call.
    injectThrow: async () => {
      const realStat = fs.promises.stat.bind(fs.promises)
      let call = 0
      const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (...args: Parameters<typeof fs.promises.stat>) => {
        call += 1
        if (call === 3) throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
        return realStat(...args)
      })
      return () => statSpy.mockRestore()
    },
  },
  {
    channel: CODE_CHANNELS.GET_FILE_INDEX,
    validInput: () => ({ workspaceSlug: 'ws', includeIgnored: false }),
    invalidInput: () => ({ workspaceSlug: '../bad', includeIgnored: false }),
    injectThrow: async ({ repoService }) => {
      repoService.getFileIndex.mockRejectedValueOnce(new Error('boom'))
      return () => {}
    },
  },
  {
    channel: CODE_CHANNELS.WATCH,
    validInput: () => ({ workspaceSlug: 'ws', gen: 1, openFile: null, expandedDirs: [] }),
    invalidInput: () => ({ workspaceSlug: 'ws', gen: 1, openFile: '../x', expandedDirs: [] }),
    injectThrow: async ({ codeWatcher }) => {
      codeWatcher.watch.mockRejectedValueOnce(new Error('boom'))
      return () => {}
    },
  },
  {
    channel: CODE_CHANNELS.UNWATCH,
    validInput: () => ({ workspaceSlug: 'ws', gen: 1 }),
    invalidInput: () => ({ workspaceSlug: 'ws', gen: -1 }),
    injectThrow: async ({ codeWatcher }) => {
      codeWatcher.unwatch.mockRejectedValueOnce(new Error('boom'))
      return () => {}
    },
  },
]

describe.each(CHANNEL_CASES)('$channel', (tc) => {
  it('a foreign senderFrame gives PERMISSION_DENIED', async () => {
    const { handlers } = build()
    const res = await handlers[tc.channel](makeEvent(foreignFrame), tc.validInput())
    expect(res).toEqual(PERMISSION_DENIED_RESPONSE)
  })

  it('a null senderFrame gives PERMISSION_DENIED', async () => {
    const { handlers } = build()
    const res = await handlers[tc.channel](makeEvent(null), tc.validInput())
    expect(res).toEqual(PERMISSION_DENIED_RESPONSE)
  })

  it('an invalid path-bearing field gives VALIDATION_ERROR', async () => {
    const { handlers } = build()
    const res = await handlers[tc.channel](makeEvent(mainFrame), tc.invalidInput())
    expect(res).toEqual(VALIDATION_ERROR_RESPONSE)
  })

  it('an injected throw gives INTERNAL_ERROR', async () => {
    const { handlers, repoService, codeWatcher } = build()
    const restore = await tc.injectThrow({ repoService, codeWatcher })
    try {
      const res = await handlers[tc.channel](makeEvent(mainFrame), tc.validInput())
      expect(res).toEqual(INTERNAL_ERROR_RESPONSE)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// writeFile — checkTarget's own write policy (TRD §3.3.5): refuses a target
// over 2 MB, one with NUL in the first 8 KB, and one with mixed EOLs.
// ---------------------------------------------------------------------------

describe('writeFile — checkTarget refuses a non-plain-text target', () => {
  it('refuses a target over 2 MB', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 'a')
    fs.writeFileSync(path.join(root, 'big.txt'), big)
    const expectedMtime = mtimeOf('big.txt')

    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'big.txt',
      content: 'short replacement',
      expectedMtime,
    })
    expect(res).toEqual(PERMISSION_DENIED_RESPONSE)
  })

  it('refuses a target with a NUL byte in the first 8 KB (binary)', async () => {
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x41, 0x42, 0x00, 0x43]))
    const expectedMtime = mtimeOf('bin.dat')

    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'bin.dat',
      content: 'x',
      expectedMtime,
    })
    expect(res).toEqual(PERMISSION_DENIED_RESPONSE)
  })

  it('refuses a target with mixed EOLs', async () => {
    fs.writeFileSync(path.join(root, 'mixed.txt'), 'line1\r\nline2\nline3')
    const expectedMtime = mtimeOf('mixed.txt')

    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'mixed.txt',
      content: 'x',
      expectedMtime,
    })
    expect(res).toEqual(PERMISSION_DENIED_RESPONSE)
  })
})

// ---------------------------------------------------------------------------
// writeFile — BOM preservation (Sec M-2): checkTarget's `{prefix}` return is
// the ONLY source of a written BOM.
// ---------------------------------------------------------------------------

describe('writeFile — BOM preservation', () => {
  it('a BOM file saved without a BOM in its content keeps its BOM, byte-exact', async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line one\nline two\n', 'utf-8')])
    fs.writeFileSync(path.join(root, 'bom.txt'), original)
    const expectedMtime = mtimeOf('bom.txt')

    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'bom.txt',
      content: 'line one\nline three\n', // no BOM char here — comes solely from checkTarget
      expectedMtime,
    })

    expect(res.error).toBeNull()
    const onDisk = fs.readFileSync(path.join(root, 'bom.txt'))
    const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('line one\nline three\n', 'utf-8')])
    expect(onDisk.equals(expected)).toBe(true)
  })

  it('strips a leading U+FEFF from renderer-supplied content so the BOM is never doubled', async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('one\n', 'utf-8')])
    fs.writeFileSync(path.join(root, 'bom2.txt'), original)
    const expectedMtime = mtimeOf('bom2.txt')

    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'bom2.txt',
      content: String.fromCharCode(0xfeff) + 'two\n', // a leading U+FEFF the handler must strip before writing
      expectedMtime,
    })

    expect(res.error).toBeNull()
    const onDisk = fs.readFileSync(path.join(root, 'bom2.txt'))
    const expected = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('two\n', 'utf-8')])
    expect(onDisk.equals(expected)).toBe(true)
  })

  it('does not add a BOM to a file that never had one', async () => {
    const expectedMtime = mtimeOf('a.txt')
    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'a.txt',
      content: 'plain, no bom\n',
      expectedMtime,
    })

    expect(res.error).toBeNull()
    const onDisk = fs.readFileSync(path.join(root, 'a.txt'))
    expect(onDisk.equals(Buffer.from('plain, no bom\n', 'utf-8'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// writeFile — checkTarget sanitizes its own errors. durableWrite does NOT
// normalize an error thrown by checkTarget (it propagates straight up
// uncaught), so checkTarget itself must be the thing that turns an
// unrelated raw error into denied() — this proves that, rather than the raw
// message ever reaching wrapCodeHandler's response.
// ---------------------------------------------------------------------------

describe('writeFile — checkTarget sanitizes its own internal errors', () => {
  it('an injected raw error inside checkTarget produces a sanitized PERMISSION_DENIED, never the raw message', async () => {
    fs.writeFileSync(path.join(root, 'c.txt'), 'plain text\n')
    const expectedMtime = mtimeOf('c.txt')

    // Forces the read inside checkTarget's own openRegularFileSafe re-open to
    // fail with an unrelated, raw error carrying a path-shaped message.
    const restore = await spyOnNextFileHandleRead()

    const { handlers } = build()
    try {
      const res = await handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame), {
        workspaceSlug: 'ws',
        relPath: 'c.txt',
        content: 'new text\n',
        expectedMtime,
      })
      expect(res).toEqual(PERMISSION_DENIED_RESPONSE)
    } finally {
      restore()
    }
  })
})

// ---------------------------------------------------------------------------
// readBaseline — oldPath validation. Confirms CodeReadBaselineSchema's
// existing RelPathSchema.optional() on oldPath actually rejects a bad value
// (a regression/confirming test, not a fix — the schema already does this).
// ---------------------------------------------------------------------------

describe('readBaseline — oldPath validation', () => {
  it.each(['../x', '.git/config'])('a bad oldPath (%s) gives VALIDATION_ERROR', async (badOldPath) => {
    const { handlers } = build()
    const res = await handlers[CODE_CHANNELS.READ_BASELINE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'a.txt',
      oldPath: badOldPath,
      baseline: 'head',
      reveal: false,
    })
    expect(res).toEqual(VALIDATION_ERROR_RESPONSE)
  })

  it('a valid (or omitted) oldPath is accepted', async () => {
    const { handlers, repoService } = build()
    const res = await handlers[CODE_CHANNELS.READ_BASELINE](makeEvent(mainFrame), {
      workspaceSlug: 'ws',
      relPath: 'a.txt',
      oldPath: 'old/a.txt',
      baseline: 'head',
      reveal: false,
    })
    expect(res.error).toBeNull()
    expect(repoService.readBlob).toHaveBeenCalledWith({ root }, [root, DOCS_ROOT], 'head', 'a.txt', 'old/a.txt')
  })
})

// ---------------------------------------------------------------------------
// root: 'sandbox' (#0029, TRD §3.10, C2, M1, SEC-L6)
// ---------------------------------------------------------------------------

describe("root: 'sandbox'", () => {
  let home: string
  let wt: string

  /** A sandbox worktree under a fake home, and handlers wired to it. */
  function buildSandbox(manager: Pick<SandboxManagerService, 'isBusy'> | null) {
    const repoService = makeMockRepoService()
    const codeWatcher = makeMockCodeWatcher()
    const appState = makeAppState([makeWorkspace({ slug: 'ws', path: root })])
    appState.sandboxManager = manager as SandboxManagerService | null
    const handlers = buildCodeHandlers(appState, { ...makeWrapDeps(), repoService, codeWatcher, sandboxPaths: sandboxPaths(home) })
    return { handlers, repoService }
  }

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-code-ipc-home-')))
    wt = path.join(sandboxPaths(home).sandboxesRoot, 'ws')
    fs.mkdirSync(wt, { recursive: true })
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: x\n')
    fs.writeFileSync(path.join(wt, 'agent.txt'), 'from the sandbox\n')
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('reads from the sandbox worktree, not the workspace', async () => {
    const { handlers } = buildSandbox({ isBusy: () => true })

    const res = await handlers[CODE_CHANNELS.READ_FILE](makeEvent(mainFrame), { workspaceSlug: 'ws', root: 'sandbox', relPath: 'agent.txt', reveal: false })

    expect(res.error).toBeNull()
    expect(JSON.stringify(res.data)).toContain('from the sandbox')
    const missing = await handlers[CODE_CHANNELS.READ_FILE](makeEvent(mainFrame), { workspaceSlug: 'ws', root: 'workspace', relPath: 'agent.txt', reveal: false })
    expect(missing.error).not.toBeNull()
  })

  it('passes a pinned target to every git call, and includes the worktree and docs roots in the binary check', async () => {
    const { handlers, repoService } = buildSandbox({ isBusy: () => true })

    const res = await handlers[CODE_CHANNELS.GET_STATUS](makeEvent(mainFrame), { workspaceSlug: 'ws', root: 'sandbox', baseline: 'branch' })

    expect(res.error).toBeNull()
    expect(repoService.getStatus).toHaveBeenCalledWith(
      { root: wt, pin: { gitDir: path.join(root, '.git', 'worktrees', 'ws'), commonDir: path.join(root, '.git'), workTree: wt } },
      [root, DOCS_ROOT, wt],
      'branch',
    )
  })

  it('getFileIndex and readBaseline also use the pinned target', async () => {
    const { handlers, repoService } = buildSandbox({ isBusy: () => true })

    await handlers[CODE_CHANNELS.GET_FILE_INDEX](makeEvent(mainFrame), { workspaceSlug: 'ws', root: 'sandbox', includeIgnored: false })
    await handlers[CODE_CHANNELS.READ_BASELINE](makeEvent(mainFrame), { workspaceSlug: 'ws', root: 'sandbox', relPath: 'agent.txt', baseline: 'head', reveal: false })

    expect(repoService.getFileIndex).toHaveBeenCalledWith(expect.objectContaining({ root: wt, pin: expect.any(Object) }), expect.any(Array), false)
    expect(repoService.readBlob).toHaveBeenCalledWith(expect.objectContaining({ root: wt, pin: expect.any(Object) }), expect.any(Array), 'head', 'agent.txt', undefined)
  })

  it('denies a sandbox root for an unknown workspace, and is not found when there is no worktree', async () => {
    const { handlers } = buildSandbox({ isBusy: () => false })

    const unknown = await handlers[CODE_CHANNELS.GET_STATUS](makeEvent(mainFrame), { workspaceSlug: 'nope', root: 'sandbox', baseline: 'head' })
    expect(unknown).toEqual(PERMISSION_DENIED_RESPONSE)

    fs.rmSync(wt, { recursive: true })
    const none = await handlers[CODE_CHANNELS.GET_STATUS](makeEvent(mainFrame), { workspaceSlug: 'ws', root: 'sandbox', baseline: 'head' })
    expect(none.error?.code).toBe(IPC_ERROR_CODES.NOT_FOUND)
  })

  it('rejects an unknown root value at validation', async () => {
    const { handlers } = buildSandbox({ isBusy: () => false })
    const res = await handlers[CODE_CHANNELS.GET_STATUS](makeEvent(mainFrame), { workspaceSlug: 'ws', root: 'elsewhere', baseline: 'head' })
    expect(res).toEqual(VALIDATION_ERROR_RESPONSE)
  })

  describe('M1: writeFile', () => {
    const write = (handlers: Record<string, (e: never, i: unknown) => Promise<unknown>>, root: 'sandbox' | 'workspace') =>
      handlers[CODE_CHANNELS.WRITE_FILE](makeEvent(mainFrame) as never, {
        workspaceSlug: 'ws',
        root,
        relPath: root === 'sandbox' ? 'agent.txt' : 'a.txt',
        content: 'edited\n',
        expectedMtime: root === 'sandbox' ? fs.statSync(path.join(wt, 'agent.txt')).mtime.toISOString() : mtimeOf('a.txt'),
      })

    it('is allowed while the session is idle', async () => {
      const { handlers } = buildSandbox({ isBusy: () => false })

      const res = (await write(handlers, 'sandbox')) as { error: unknown }

      expect(res.error).toBeNull()
      expect(fs.readFileSync(path.join(wt, 'agent.txt'), 'utf8')).toBe('edited\n')
    })

    it.each(['preparing', 'running', 'ending'])('is PERMISSION_DENIED while the session is %s (isBusy covers every non-idle state)', async () => {
      const { handlers } = buildSandbox({ isBusy: () => true })

      const res = await write(handlers, 'sandbox')

      expect(res).toEqual(PERMISSION_DENIED_RESPONSE)
      expect(fs.readFileSync(path.join(wt, 'agent.txt'), 'utf8')).toBe('from the sandbox\n')
    })

    it('fails closed when the sandbox manager is not up yet', async () => {
      const { handlers } = buildSandbox(null)
      expect(await write(handlers, 'sandbox')).toEqual(PERMISSION_DENIED_RESPONSE)
    })

    it('asks the manager about this workspace only, and never gates a workspace-root write', async () => {
      const isBusy = vi.fn(() => true)
      const { handlers } = buildSandbox({ isBusy })

      const res = (await write(handlers, 'workspace')) as { error: unknown }

      expect(res.error).toBeNull()
      expect(isBusy).not.toHaveBeenCalled()
      await write(handlers, 'sandbox')
      expect(isBusy).toHaveBeenCalledWith('ws')
    })
  })
})
