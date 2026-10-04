import path from 'path'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { IpcResponse } from '../types/ipc'
import { IPC_ERROR_CODES } from '../types/ipc'
import type {
  CodeGetStatusInput,
  CodeListDirInput,
  CodeReadFileInput,
  CodeReadBaselineInput,
  CodeWriteFileInput,
  CodeGetFileIndexInput,
  CodeWatchInput,
  CodeUnwatchInput,
} from './schemas'
import {
  CodeGetStatusSchema,
  CodeListDirSchema,
  CodeReadFileSchema,
  CodeReadBaselineSchema,
  CodeWriteFileSchema,
  CodeGetFileIndexSchema,
  CodeWatchSchema,
  CodeUnwatchSchema,
} from './schemas'
import { CODE_CHANNELS } from './channels'
import { wrapCodeHandler } from './wrap-code-handler'
import type { IsAppOrigin } from './app-origin'
import { resolveCodeRoot, listSandboxWorktreeRoots, hasGitSegment, toAbs } from '../services/repo-path'
import { denied, durableWrite, withTimeout, MAX_FILE_SIZE } from '../services/safe-fs'
import { readFile as codeReadFile, listDir, openRegularFileSafe, classifyBuffer } from '../services/code-fs'
import type { RepoService } from '../services/git-service'
import type { CodeWatcher } from '../services/code-watcher'
import type { SandboxPaths } from '../services/sandbox-paths'
import type { AppState } from './handlers'
import type {
  CodeStatusResponse,
  CodeListDirResponse,
  CodeFileResponse,
  CodeBaselineResponse,
  CodeWriteResponse,
  CodeFileIndexResponse,
  CodeWatchResponse,
} from '../types/code'

// ---------------------------------------------------------------------------
// code-handlers.ts — the 8 code:* IPC handlers (TRD §3.3.5, §3.4.2; Sec H-1,
// M-2). Every entry below is wrapCodeHandler(impl, Schema, deps), never the
// plain wrapHandler (Sec H-1) — swapHandlers replaces the whole registered
// function, so a NOT_READY stub registered through wrapHandler instead would
// lose the sender/origin check and the fixed-copy error allowlist the moment
// it's swapped for the real implementation, not just before.
// ---------------------------------------------------------------------------

type HandlerFn = (event: IpcMainInvokeEvent, input: unknown) => Promise<IpcResponse<unknown>>

export interface BuildCodeHandlersDeps {
  getMainWindow: () => BrowserWindow | null
  isAppOrigin: IsAppOrigin
  repoService: RepoService
  codeWatcher: CodeWatcher
  /** Where sandbox worktrees live. Defaults to the real home's; tests inject a temp tree. */
  sandboxPaths?: SandboxPaths
}

// TRD §3.4.2's per-channel timeout column. code:unwatch has none (n/a).
const TIMEOUT_MS = {
  getStatus: 10_000,
  listDir: 5_000,
  readFile: 5_000,
  readBaseline: 10_000,
  writeFile: 10_000,
  getFileIndex: 10_000,
  watch: 5_000,
} as const

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * durableWrite's checkTarget policy hook for code:writeFile (TRD §3.3.5).
 * Runs on the containment-checked, lstat-verified target durableWrite has
 * already confirmed is a regular, non-symlink file. Re-opens it through
 * openRegularFileSafe — the only way this codebase reads a worktree file —
 * on that SAME verified path, then reuses classifyBuffer (the read side's
 * own classifier) rather than re-implementing NUL/UTF-8/EOL detection here:
 * refuses anything that isn't currently a small, plain-UTF-8, non-mixed-EOL
 * text file. A BOM on the existing file is preserved via durableWrite's
 * `prefix` (Sec M-2) — content itself never carries one (the WRITE_FILE
 * handler below strips a leading U+FEFF before durableWrite ever sees it).
 *
 * durableWrite does NOT normalize an error thrown by checkTarget (Sec review,
 * step 1.3) — it propagates straight up, uncaught, to wrapCodeHandler. So
 * this hook wraps its own body: anything other than a deliberate denied()/
 * notFound() becomes denied() here, never a raw Error whose message could
 * carry an absolute path.
 */
function makeCheckTarget(
  root: string,
  platform: NodeJS.Platform,
): (resolvedFile: string) => Promise<{ prefix?: Buffer } | void> {
  return async function checkTarget(resolvedFile) {
    try {
      if (hasGitSegment(path.relative(root, resolvedFile), platform)) throw denied()
      // B-L1: the re-read itself is the security control — it re-derives the
      // target's CURRENT on-disk classification (size/NUL/encoding/EOL)
      // through the exact same gate readFile uses, rather than trusting
      // whatever the renderer last reported for this path.
      const opened = await openRegularFileSafe(root, resolvedFile, MAX_FILE_SIZE, platform)
      if (opened.kind === 'too-large') throw denied()
      const classified = classifyBuffer(opened.buf, path.basename(resolvedFile), opened.st.size)
      if (classified.kind !== 'text') throw denied() // binary/image — never overwritable via code:writeFile
      if (classified.readOnlyReason === 'encoding' || classified.readOnlyReason === 'mixed-eol') throw denied()
      return classified.bom ? { prefix: UTF8_BOM } : undefined
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (code === IPC_ERROR_CODES.PERMISSION_DENIED || code === IPC_ERROR_CODES.NOT_FOUND) throw err
      throw denied() // never let anything else escape this hook (Sec review, step 1.3)
    }
  }
}

/**
 * buildCodeHandlers(appState, { getMainWindow, isAppOrigin, repoService,
 * codeWatcher }) — one entry per CODE_CHANNELS request channel, each
 * resolving the workspace slug to its repo root (except watch/unwatch,
 * which delegate that to codeWatcher's own resolveRepoRoot dependency) and
 * running under the TRD's per-channel timeout.
 */
export function buildCodeHandlers(appState: AppState, deps: BuildCodeHandlersDeps): Record<string, HandlerFn> {
  const { repoService, codeWatcher, getMainWindow, isAppOrigin, sandboxPaths } = deps
  const wrapDeps = { getMainWindow, isAppOrigin }
  const platform = process.platform

  // Sec M-8: fresh on every call, never cached, so a workspace added after
  // the service started is still caught by git-runner's own re-check.
  function workspaceRoots(): string[] {
    const roots = new Set<string>()
    for (const w of appState.workspaces.values()) {
      roots.add(w.path)
      roots.add(w.docsRoot) // mounted read-write into a sandbox, so a `git` binary inside it is just as untrusted
    }
    for (const sandboxRoot of listSandboxWorktreeRoots(sandboxPaths)) roots.add(sandboxRoot)
    return [...roots]
  }

  return {
    [CODE_CHANNELS.GET_STATUS]: wrapCodeHandler(
      async (input: CodeGetStatusInput): Promise<CodeStatusResponse> => {
        const target = await resolveCodeRoot(input.workspaceSlug, input.root, appState, sandboxPaths)
        return withTimeout(repoService.getStatus(target, workspaceRoots(), input.baseline), TIMEOUT_MS.getStatus)
      },
      CodeGetStatusSchema,
      wrapDeps,
    ) as HandlerFn,

    [CODE_CHANNELS.LIST_DIR]: wrapCodeHandler(
      async (input: CodeListDirInput): Promise<CodeListDirResponse> => {
        const target = await resolveCodeRoot(input.workspaceSlug, input.root, appState, sandboxPaths)
        const { root } = target
        // Reuses the cache populated by a prior getStatus/getRepoInfo call for
        // this root this session — never re-probes git just to list a
        // directory. No cache entry (never probed yet, or a non-git/unsafe
        // root) means no gitCtx: listDir falls back to FALLBACK_IGNORES.
        const cached = repoService.getCachedEntry(target)
        const gitCtx = cached
          ? {
              checkIgnore: (relPaths: readonly string[]) => repoService.checkIgnore(target, workspaceRoots(), relPaths),
              gitlinks: cached.gitlinks,
            }
          : undefined
        return withTimeout(
          listDir(root, input.relDir, { includeIgnored: input.includeIgnored, gitCtx }, platform),
          TIMEOUT_MS.listDir,
        )
      },
      CodeListDirSchema,
      wrapDeps,
    ) as HandlerFn,

    [CODE_CHANNELS.READ_FILE]: wrapCodeHandler(
      async (input: CodeReadFileInput): Promise<CodeFileResponse> => {
        const { root } = await resolveCodeRoot(input.workspaceSlug, input.root, appState, sandboxPaths)
        return withTimeout(codeReadFile(root, input.relPath, { reveal: input.reveal }, platform), TIMEOUT_MS.readFile)
      },
      CodeReadFileSchema,
      wrapDeps,
    ) as HandlerFn,

    [CODE_CHANNELS.READ_BASELINE]: wrapCodeHandler(
      async (input: CodeReadBaselineInput): Promise<CodeBaselineResponse> => {
        const target = await resolveCodeRoot(input.workspaceSlug, input.root, appState, sandboxPaths)
        // relPath AND oldPath both go through RelPathSchema (schemas.ts) —
        // readBlob trusts both as already-safe repo-relative paths.
        return withTimeout(
          repoService.readBlob(target, workspaceRoots(), input.baseline, input.relPath, input.oldPath),
          TIMEOUT_MS.readBaseline,
        )
      },
      CodeReadBaselineSchema,
      wrapDeps,
    ) as HandlerFn,

    [CODE_CHANNELS.WRITE_FILE]: wrapCodeHandler(
      async (input: CodeWriteFileInput): Promise<CodeWriteResponse> => {
        const { root } = await resolveCodeRoot(input.workspaceSlug, input.root, appState, sandboxPaths)
        // M1: a sandbox tree is only writable from the host while no session can be writing to it.
        // Reads, diffs and Review stay live during a session (reviewing unattended work is the point).
        // Fail closed when the manager isn't up yet. Documented residual (SEC-L6): a startSession can
        // begin between this check and the write below — a millisecond, user-triggered window, and
        // durableWrite's own lstat/mtime checks still apply. Taking the manager's per-slug lock around
        // check and write would close it, and is deliberately left optional.
        if (input.root === 'sandbox' && (!appState.sandboxManager || appState.sandboxManager.isBusy(input.workspaceSlug))) throw denied()
        // A leading U+FEFF is stripped before writing: checkTarget is the ONLY
        // source of a written BOM (its `{prefix}` return, Sec M-2), so content
        // that already carries one here would otherwise double it up.
        const content = input.content.startsWith(String.fromCharCode(0xfeff)) ? input.content.slice(1) : input.content
        return withTimeout(
          (async () => {
            const { size, lastModified } = await durableWrite({
              root,
              rawPath: toAbs(root, input.relPath),
              content,
              expectedMtime: input.expectedMtime,
              maxBytes: MAX_FILE_SIZE,
              checkTarget: makeCheckTarget(root, platform),
            })
            return { relPath: input.relPath, size, lastModified }
          })(),
          TIMEOUT_MS.writeFile,
        )
      },
      CodeWriteFileSchema,
      wrapDeps,
    ) as HandlerFn,

    [CODE_CHANNELS.GET_FILE_INDEX]: wrapCodeHandler(
      async (input: CodeGetFileIndexInput): Promise<CodeFileIndexResponse> => {
        const target = await resolveCodeRoot(input.workspaceSlug, input.root, appState, sandboxPaths)
        return withTimeout(
          repoService.getFileIndex(target, workspaceRoots(), input.includeIgnored),
          TIMEOUT_MS.getFileIndex,
        )
      },
      CodeGetFileIndexSchema,
      wrapDeps,
    ) as HandlerFn,

    // watch/unwatch delegate entirely to codeWatcher, which has its own
    // resolveRepoRoot (and abortRoot/resetRoot) injected at construction —
    // resolving the slug again here would just re-do that work.
    [CODE_CHANNELS.WATCH]: wrapCodeHandler(
      async (input: CodeWatchInput): Promise<CodeWatchResponse> => withTimeout(codeWatcher.watch(input), TIMEOUT_MS.watch),
      CodeWatchSchema,
      wrapDeps,
    ) as HandlerFn,

    [CODE_CHANNELS.UNWATCH]: wrapCodeHandler(
      async (input: CodeUnwatchInput): Promise<{ ok: true }> => {
        await codeWatcher.unwatch(input)
        return { ok: true }
      },
      CodeUnwatchSchema,
      wrapDeps,
    ) as HandlerFn,
  }
}
