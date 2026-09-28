import fs from 'fs'
import path from 'path'
import { hasGitSegment, toAbs } from './repo-path'
import { isSecret } from './secret-patterns'
import { denied, notFound } from './safe-fs'
import type { CodeFileResponse, CodeListDirResponse, CodeTreeEntry, CodeFileIndexResponse } from '../types/code'

// ---------------------------------------------------------------------------
// code-fs.ts — safe open, size cap and classification for worktree files
// (TRD §3.3.3, H2, H3, L6, M6, B-L3; Sec H-4; Be M2).
//
// openRegularFileSafe is the only way this module reads a worktree file, and
// readFile inlines its own copy of the same open -> stat -> cap -> read
// sequence (via openVerified directly) so the secret gate can run BETWEEN
// the open and the read, using the already-open handle's stat — never a
// second, unguarded stat/read (Sec H-4).
// ---------------------------------------------------------------------------

export const VIEW_MAX = 10 * 1024 * 1024 // 10 MB — the read/view cap (FR-16)
export const EDIT_MAX = 2 * 1024 * 1024 // 2 MB — the edit/highlight cap
export const LONGEST_LINE_MAX = 10_000

// ---------------------------------------------------------------------------
// openVerified — §3.3.3 steps 2-4
// ---------------------------------------------------------------------------

export interface OpenVerifiedResult {
  fh: fs.promises.FileHandle
  st: fs.Stats
}

export interface OpenVerifiedTestHooks {
  /**
   * Test-only: invoked after the handle is opened and stat'd, right before
   * the dev/ino re-check's own lstat. Lets a test simulate a TOCTOU swap of
   * the target between open() and the re-check.
   */
  onAfterOpen?: () => Promise<void> | void
}

/**
 * `real` must already be a realpath'd, existing path (the caller does the
 * realpath — see readFile below). Verifies containment and the .git rule,
 * opens with O_NOFOLLOW|O_NONBLOCK (refusing symlinks, FIFOs, sockets and
 * devices before any read can ever be attempted, H3), then cross-checks the
 * open handle's dev/ino against a fresh lstat (L6) — closing most of the
 * intermediate-directory swap window. The residual race is accepted (§10.3).
 *
 * `platform` is injectable (Be M2): O_NOFOLLOW/O_NONBLOCK are 0 on win32, so
 * that branch pre-checks with lstat instead.
 */
export async function openVerified(
  root: string,
  real: string,
  platform: NodeJS.Platform = process.platform,
  testHooks?: OpenVerifiedTestHooks,
): Promise<OpenVerifiedResult> {
  // Step 2: containment, then the .git rule, both against the realpath'd target.
  if (real !== root && !real.startsWith(root + path.sep)) throw denied()
  if (hasGitSegment(path.relative(root, real), platform)) throw denied()

  // Step 3: open. On win32, O_NOFOLLOW/O_NONBLOCK are 0, so a symlink would
  // silently be followed — pre-check with lstat instead.
  let fh: fs.promises.FileHandle
  if (platform === 'win32') {
    let precheck: fs.Stats
    try {
      precheck = await fs.promises.lstat(real)
    } catch {
      throw notFound()
    }
    if (precheck.isSymbolicLink()) throw denied()
    try {
      fh = await fs.promises.open(real, fs.constants.O_RDONLY)
    } catch (err) {
      throw mapOpenError(err)
    }
  } else {
    try {
      fh = await fs.promises.open(
        real,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      )
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ELOOP') throw denied()
      throw mapOpenError(err)
    }
  }

  // Step 4: must be a regular file, and dev/ino must match a fresh lstat.
  let st: fs.Stats
  try {
    st = await fh.stat()
  } catch {
    await fh.close().catch(() => {})
    throw denied()
  }
  if (!st.isFile()) {
    await fh.close().catch(() => {})
    throw denied()
  }
  if (testHooks?.onAfterOpen) await testHooks.onAfterOpen()
  let recheck: fs.Stats
  try {
    recheck = await fs.promises.lstat(real)
  } catch {
    await fh.close().catch(() => {})
    throw denied()
  }
  if (recheck.dev !== st.dev || recheck.ino !== st.ino) {
    await fh.close().catch(() => {})
    throw denied()
  }

  return { fh, st }
}

function mapOpenError(err: unknown): Error {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return notFound()
  return denied()
}

// ---------------------------------------------------------------------------
// openRegularFileSafe — §3.3.3 steps 1-6 (the only way code-fs reads a file)
// ---------------------------------------------------------------------------

export type OpenRegularFileSafeResult =
  | { kind: 'ok'; buf: Buffer; st: fs.Stats }
  | { kind: 'too-large'; st: fs.Stats }

/**
 * openVerified, then a too-large check BEFORE any read, then a read of at
 * most `maxBytes` from the (already-verified) handle. Used by readFile, the
 * git-service line counter (§3.3.4) and the writeFile checkTarget (§3.3.5).
 */
export async function openRegularFileSafe(
  root: string,
  real: string,
  maxBytes: number,
  platform: NodeJS.Platform = process.platform,
): Promise<OpenRegularFileSafeResult> {
  const { fh, st } = await openVerified(root, real, platform)
  try {
    if (st.size > maxBytes) return { kind: 'too-large', st }
    const buf = Buffer.alloc(st.size)
    if (st.size > 0) await fh.read(buf, 0, st.size, 0)
    return { kind: 'ok', buf, st }
  } finally {
    await fh.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// classifyBuffer — §3.3.3 step 4 of readFile
// ---------------------------------------------------------------------------

export type ClassifiedFile =
  | {
      kind: 'text'
      content: string
      encoding: 'utf-8' | 'utf-8-lossy' | 'utf-16le' | 'utf-16be'
      bom: boolean
      eol: 'lf' | 'crlf' | 'none' | 'mixed'
      highlight: boolean
      editable: boolean
      readOnlyReason: null | 'too-large' | 'encoding' | 'mixed-eol' | 'symlink'
      previewable: null | 'markdown' | 'yaml' | 'svg'
    }
  | { kind: 'image'; mime: string; dataBase64: string }
  | { kind: 'binary'; mime: string | null }

const IMAGE_SIGNATURES: ReadonlyArray<{ mime: string; test: (buf: Buffer) => boolean }> = [
  {
    mime: 'image/png',
    test: (buf) =>
      buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a,
  },
  {
    mime: 'image/jpeg',
    test: (buf) => buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff,
  },
  {
    mime: 'image/gif',
    test: (buf) =>
      buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38,
  },
  {
    mime: 'image/webp',
    test: (buf) =>
      buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50,
  },
]

function detectPreviewable(name: string): null | 'markdown' | 'yaml' | 'svg' {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  if (ext === '.svg') return 'svg'
  return null
}

/** `mixed` includes a lone CR not followed by LF, as well as a genuine mix of LF and CRLF. */
function detectEol(text: string): 'lf' | 'crlf' | 'none' | 'mixed' {
  let hasLf = false
  let hasCrlf = false
  let hasLoneCr = false
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') {
        hasCrlf = true
        i++
      } else {
        hasLoneCr = true
      }
    } else if (text[i] === '\n') {
      hasLf = true
    }
  }
  if (hasLoneCr || (hasLf && hasCrlf)) return 'mixed'
  if (hasCrlf) return 'crlf'
  if (hasLf) return 'lf'
  return 'none'
}

function longestLineLength(text: string): number {
  let longest = 0
  let current = 0
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') {
      if (current > longest) longest = current
      current = 0
    } else {
      current++
    }
  }
  if (current > longest) longest = current
  return longest
}

export function classifyBuffer(buf: Buffer, name: string, size: number): ClassifiedFile {
  const image = IMAGE_SIGNATURES.find(({ test }) => test(buf))
  if (image) return { kind: 'image', mime: image.mime, dataBase64: buf.toString('base64') }

  const isUtf16Le = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
  const isUtf16Be = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff
  if (isUtf16Le || isUtf16Be) {
    const encoding = isUtf16Le ? 'utf-16le' : 'utf-16be'
    const content = new TextDecoder(encoding).decode(buf.subarray(2))
    return {
      kind: 'text',
      content,
      encoding,
      bom: true,
      eol: detectEol(content),
      highlight: false,
      editable: false,
      readOnlyReason: 'encoding',
      previewable: detectPreviewable(name),
    }
  }

  if (buf.subarray(0, Math.min(8192, buf.length)).includes(0)) {
    return { kind: 'binary', mime: null }
  }

  // Text. Strip a UTF-8 BOM before decoding.
  const hasUtf8Bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const body = hasUtf8Bom ? buf.subarray(3) : buf

  let encoding: 'utf-8' | 'utf-8-lossy' = 'utf-8'
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    content = new TextDecoder('utf-8', { fatal: false }).decode(body)
    encoding = 'utf-8-lossy'
  }

  const eol = detectEol(content)
  let readOnlyReason: null | 'too-large' | 'encoding' | 'mixed-eol' = null
  if (encoding === 'utf-8-lossy') readOnlyReason = 'encoding'
  if (eol === 'mixed') readOnlyReason = 'mixed-eol'

  const highlight = size <= EDIT_MAX && longestLineLength(content) <= LONGEST_LINE_MAX
  let editable = size <= EDIT_MAX && encoding === 'utf-8' && eol !== 'mixed'

  // Backend Low: 2-10 MB is read-only even though it already fails EDIT_MAX
  // (kept explicit — highlight is already off via the formula above, this
  // line only adds the reason).
  if (size > EDIT_MAX) {
    readOnlyReason = 'too-large'
    editable = false
  }

  return {
    kind: 'text',
    content,
    encoding,
    bom: hasUtf8Bom,
    eol,
    highlight,
    editable,
    readOnlyReason,
    previewable: detectPreviewable(name),
  }
}

// ---------------------------------------------------------------------------
// readFile — §3.3.3, in the Sec H-4 order (openVerified before the secret gate)
// ---------------------------------------------------------------------------

export async function readFile(
  root: string,
  relPath: string,
  opts: { reveal: boolean },
  platform: NodeJS.Platform = process.platform,
): Promise<CodeFileResponse> {
  // 1. toAbs, then realpath.
  const abs = toAbs(root, relPath)
  let real: string
  try {
    real = await fs.promises.realpath(abs)
  } catch {
    throw notFound()
  }

  // 2. openVerified — external or .git-internal targets are denied here,
  //    before anything else (Sec H-4).
  const { fh, st } = await openVerified(root, real, platform)

  try {
    const name = path.basename(relPath)
    const lastModified = st.mtime.toISOString()

    // 3. Secret gate — uses the already-open handle's stat; no read, and the
    //    handle is closed (in the outer finally) without ever being read.
    if (!opts.reveal && (isSecret(path.basename(relPath)) || isSecret(path.basename(real)))) {
      return { kind: 'secret', relPath, name, size: st.size, lastModified }
    }

    // 4. VIEW_MAX cap, then the read, then classification.
    if (st.size > VIEW_MAX) {
      return { kind: 'too-large', relPath, name, size: st.size, lastModified }
    }

    const buf = Buffer.alloc(st.size)
    if (st.size > 0) await fh.read(buf, 0, st.size, 0)

    const classified = classifyBuffer(buf, name, st.size)

    // Internal symlinked files get readOnlyReason: 'symlink' (only when no
    // more specific reason already applies) and are never editable.
    if (classified.kind === 'text') {
      let isSymlink = false
      try {
        isSymlink = (await fs.promises.lstat(abs)).isSymbolicLink()
      } catch {
        isSymlink = false
      }
      if (isSymlink) {
        classified.editable = false
        if (classified.readOnlyReason === null) classified.readOnlyReason = 'symlink'
      }
    }

    return { ...classified, relPath, name, size: st.size, lastModified }
  } finally {
    await fh.close().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// listDir — §3.3.3 steps 1-8
// ---------------------------------------------------------------------------

/** Non-git ignore fallback and the fallback walk's own skip-list (§3.3.3
 *  steps 3, 8; getFileIndex's non-git branch, step 1.13). */
export const FALLBACK_IGNORES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  'coverage',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.gradle',
  '.idea',
  '.DS_Store',
])

const LIST_DIR_CAP = 5000

type DirentKind = 'dir' | 'file' | 'symlink' | 'other'

/** FIFO, socket, block/char device — or an unknown d_type — all fall back to
 *  'other', the same inert, non-openable bucket. */
function direntKind(dirent: fs.Dirent): DirentKind {
  if (dirent.isSymbolicLink()) return 'symlink'
  if (dirent.isDirectory()) return 'dir'
  if (dirent.isFile()) return 'file'
  return 'other'
}

export interface ListDirGitCtx {
  /** Injected (git-service's checkIgnore, step 1.13): returns the subset of
   *  the given repo-relative paths that are git-ignored. Omitted entirely
   *  for a non-git root, where FALLBACK_IGNORES is used by name instead. */
  checkIgnore?: (relPaths: readonly string[]) => Promise<ReadonlySet<string>>
  /** Injected (git-service's gitlinks, from the index-blob .gitmodules read,
   *  L1): repo-relative submodule paths. */
  gitlinks?: ReadonlySet<string>
}

export interface ListDirOptions {
  includeIgnored: boolean
  gitCtx?: ListDirGitCtx
}

interface SymlinkClassification {
  kind: NonNullable<CodeTreeEntry['symlink']>
  /** The resolved target, or null when the symlink is broken. Used for the
   *  realpath-basename half of the secret check (M6). */
  real: string | null
}

async function classifySymlinkTarget(root: string, absPath: string, platform: NodeJS.Platform): Promise<SymlinkClassification> {
  let real: string
  try {
    real = await fs.promises.realpath(absPath)
  } catch {
    return { kind: 'broken', real: null }
  }
  if (real !== root && !real.startsWith(root + path.sep)) return { kind: 'external', real }
  if (hasGitSegment(path.relative(root, real), platform)) return { kind: 'git-internal', real }
  let st: fs.Stats
  try {
    st = await fs.promises.stat(real) // follows the (already-resolved) target
  } catch {
    return { kind: 'broken', real }
  }
  return { kind: st.isDirectory() ? 'dir-internal' : 'file-internal', real }
}

interface RawEntry {
  name: string
  relPath: string
  kind: DirentKind
}

/**
 * `listDir(root, relDir, { includeIgnored, gitCtx })` — TRD §3.3.3 steps 1-8.
 * `checkIgnore`/`gitlinks` are injected rather than imported directly so
 * code-fs.ts never depends on git-service.ts (git-service already depends on
 * code-fs for the untracked-file line counter, §3.3.4).
 */
export async function listDir(
  root: string,
  relDir: string,
  opts: ListDirOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<CodeListDirResponse> {
  const abs = toAbs(root, relDir)
  let real: string
  try {
    real = await fs.promises.realpath(abs)
  } catch {
    throw notFound()
  }
  if (real !== root && !real.startsWith(root + path.sep)) throw denied()
  if (hasGitSegment(path.relative(root, real), platform)) throw denied()

  const checkIgnore = opts.gitCtx?.checkIgnore
  const gitlinks = opts.gitCtx?.gitlinks ?? new Set<string>()

  // ignoredParent: whether relDir itself is ignored. Recomputed fresh on
  // every call (not passed in) so a direct listDir on a deeply-nested path
  // is correct even without ever having listed its ancestors first.
  let ignoredParent = false
  if (relDir !== '') {
    if (checkIgnore) {
      const ignoredSet = await checkIgnore([relDir])
      ignoredParent = ignoredSet.has(relDir)
    } else {
      ignoredParent = relDir.split('/').some((seg) => FALLBACK_IGNORES.has(seg))
    }
  }

  const rawEntries: RawEntry[] = []
  const dirHandle = await fs.promises.opendir(real)
  try {
    for await (const dirent of dirHandle) {
      if (hasGitSegment(dirent.name, platform)) continue // drop .git (and aliases) at any depth
      const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name
      rawEntries.push({ name: dirent.name, relPath, kind: direntKind(dirent) })
    }
  } finally {
    await dirHandle.close().catch(() => {})
  }

  // Ignore classification (batched): children of an ignored parent inherit
  // ignored without a separate check; otherwise one batched call covers
  // every child at once.
  let ignoredChildren: ReadonlySet<string> = new Set()
  if (!ignoredParent && rawEntries.length > 0) {
    if (checkIgnore) {
      ignoredChildren = await checkIgnore(rawEntries.map((e) => e.relPath))
    } else {
      ignoredChildren = new Set(rawEntries.filter((e) => FALLBACK_IGNORES.has(e.name)).map((e) => e.relPath))
    }
  }

  const classified: Array<{ entry: CodeTreeEntry; isDir: boolean }> = []
  for (const raw of rawEntries) {
    const ignored = ignoredParent || ignoredChildren.has(raw.relPath)
    if (!opts.includeIgnored && ignored) continue // dropped BEFORE the cap

    const absChild = path.join(real, raw.name)
    const nameIsSecret = isSecret(raw.name)

    if (raw.kind === 'symlink') {
      const classification = await classifySymlinkTarget(root, absChild, platform)
      const secret = nameIsSecret || (classification.real !== null && isSecret(path.basename(classification.real)))
      classified.push({
        isDir: classification.kind === 'dir-internal',
        entry: { name: raw.name, relPath: raw.relPath, type: 'symlink', symlink: classification.kind, ignored, secret },
      })
      continue
    }

    if (raw.kind === 'other') {
      classified.push({
        isDir: false,
        entry: { name: raw.name, relPath: raw.relPath, type: 'other', ignored, secret: nameIsSecret },
      })
      continue
    }

    const isDir = raw.kind === 'dir'
    const isSubmodule = gitlinks.has(raw.relPath)
    classified.push({
      isDir,
      entry: {
        name: raw.name,
        relPath: raw.relPath,
        type: isSubmodule ? 'submodule' : isDir ? 'dir' : 'file',
        ignored,
        secret: nameIsSecret,
      },
    })
  }

  // Directories (and submodules — physically directories on disk) first,
  // then case-insensitive name (FR-5).
  classified.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.entry.name.localeCompare(b.entry.name, undefined, { sensitivity: 'base' })
  })

  const omitted = Math.max(0, classified.length - LIST_DIR_CAP)
  const entries = classified.slice(0, LIST_DIR_CAP).map((c) => c.entry)

  return { relDir, entries, omitted, ignoredParent }
}

// ---------------------------------------------------------------------------
// walkFileIndex — the non-git fallback for getFileIndex (§3.3.3, step 1.13)
// ---------------------------------------------------------------------------

export const FILE_INDEX_WALK_CAP = 100_000
const FILE_INDEX_WALK_TIME_BUDGET_MS = 3_000

/**
 * A plain fs walk used only when the workspace isn't a git repo: skips
 * FALLBACK_IGNORES and `.git` by name, and skips symlinked DIRECTORIES
 * (no recursion — avoids cycles and escaping the root) while still listing
 * a symlinked FILE's path (opening it later goes through the same
 * openVerified containment checks as any other file). Capped at
 * FILE_INDEX_WALK_CAP entries and a 3 s wall-clock budget, whichever comes
 * first.
 */
export async function walkFileIndex(root: string, platform: NodeJS.Platform = process.platform): Promise<CodeFileIndexResponse> {
  const paths: string[] = []
  const deadline = Date.now() + FILE_INDEX_WALK_TIME_BUDGET_MS
  let truncated = false

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (truncated) return
    if (Date.now() > deadline) {
      truncated = true
      return
    }
    let dirHandle: fs.Dir
    try {
      dirHandle = await fs.promises.opendir(absDir)
    } catch {
      return
    }
    try {
      for await (const dirent of dirHandle) {
        if (truncated) return
        if (Date.now() > deadline) {
          truncated = true
          return
        }
        if (hasGitSegment(dirent.name, platform)) continue
        if (FALLBACK_IGNORES.has(dirent.name)) continue

        const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name
        const absChild = path.join(absDir, dirent.name)
        const kind = direntKind(dirent)

        if (kind === 'dir') {
          await walk(absChild, relPath)
          continue
        }
        if (kind === 'file') {
          paths.push(relPath)
          if (paths.length >= FILE_INDEX_WALK_CAP) {
            truncated = true
            return
          }
          continue
        }
        if (kind === 'symlink') {
          let target: fs.Stats
          try {
            target = await fs.promises.stat(absChild) // follows the symlink
          } catch {
            continue // broken — skip
          }
          if (target.isDirectory()) continue // no recursion into a symlinked dir
          if (target.isFile()) {
            paths.push(relPath)
            if (paths.length >= FILE_INDEX_WALK_CAP) {
              truncated = true
              return
            }
          }
          continue
        }
        // 'other' (FIFO/socket/device): never listed.
      }
    } finally {
      await dirHandle.close().catch(() => {})
    }
  }

  await walk(root, '')
  return { paths, truncated }
}
