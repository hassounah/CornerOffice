import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { IpcResponse } from '../main/types/ipc'
import type { DocTreeResponse, DocFileResponse, DocWriteResponse, DocTreeEntry } from '../main/types/docs'
import type { AppState } from '../main/ipc/handlers'
import { buildRealHandlers } from '../main/ipc/handlers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let docsRoot: string
let appState: AppState
let handlers: ReturnType<typeof buildRealHandlers>

const fakeEvent = {} as Electron.IpcMainInvokeEvent

function getHandler(channel: string) {
  const handler = handlers[channel]
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`)
  return handler
}

async function invokeListTree(dirPath: string, workspaceSlug = 'test-ws') {
  const handler = getHandler('docs:listTree')
  return handler(fakeEvent, { dirPath, workspaceSlug }) as Promise<IpcResponse<DocTreeResponse>>
}

async function invokeReadFile(filePath: string, workspaceSlug = 'test-ws') {
  const handler = getHandler('docs:readFile')
  return handler(fakeEvent, { filePath, workspaceSlug }) as Promise<IpcResponse<DocFileResponse>>
}

async function invokeWriteFile(
  filePath: string,
  content: string,
  expectedMtime: string,
  workspaceSlug = 'test-ws',
) {
  const handler = getHandler('docs:writeFile')
  return handler(fakeEvent, { filePath, workspaceSlug, content, expectedMtime }) as Promise<IpcResponse<DocWriteResponse>>
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-docs-test-'))
  docsRoot = path.join(tmpDir, 'docs')
  fs.mkdirSync(docsRoot, { recursive: true })

  // Create test file structure
  fs.writeFileSync(path.join(docsRoot, 'readme.md'), '# Hello')
  fs.writeFileSync(path.join(docsRoot, 'trd.md'), '# TRD')
  fs.writeFileSync(path.join(docsRoot, 'prd.md'), '# PRD')
  fs.writeFileSync(path.join(docsRoot, 'plan.md'), '# Plan')
  fs.writeFileSync(path.join(docsRoot, 'design-review.md'), '# Review')
  fs.writeFileSync(path.join(docsRoot, 'config.yaml'), 'key: value')
  fs.writeFileSync(path.join(docsRoot, 'notes.txt'), 'plain text')
  fs.writeFileSync(path.join(docsRoot, '.hidden-file.md'), '# Hidden')
  fs.mkdirSync(path.join(docsRoot, 'subdir'))
  fs.writeFileSync(path.join(docsRoot, 'subdir', 'nested.md'), '# Nested')
  fs.mkdirSync(path.join(docsRoot, '.02-impl-team'))
  fs.writeFileSync(path.join(docsRoot, '.02-impl-team', 'task.md'), '# Task')
  fs.mkdirSync(path.join(docsRoot, 'empty-dir'))
  fs.mkdirSync(path.join(docsRoot, 'handoffs'))
  fs.writeFileSync(path.join(docsRoot, 'handoffs', 'h1.md'), '# Handoff')

  appState = {
    workspaces: new Map([
      ['test-ws', { docsRoot } as unknown as import('../main/types').Workspace],
    ]),
    activityFeed: [],
    notifications: [],
    gamificationState: {} as unknown as import('../main/types').GamificationState,
    homunculusState: null,
    discoveryService: {} as unknown as import('../main/services/workspace-discovery').WorkspaceDiscoveryService,
    channelDiscovery: null,
    pluginDetector: null,
    channelConnection: null,
    terminalManager: null,
  }

  handlers = buildRealHandlers(appState, () => null)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// docs:listTree
// ---------------------------------------------------------------------------

describe('docs:listTree', () => {
  it('returns correct entries for docsRoot', async () => {
    const result = await invokeListTree(docsRoot)
    expect(result.error).toBeNull()
    expect(result.data).not.toBeNull()
    expect(result.data!.entries.length).toBeGreaterThan(0)
  })

  it('sorts directories before files, alphabetical within groups', async () => {
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries
    const dirs = entries.filter((e: DocTreeEntry) => e.type === 'directory')
    const files = entries.filter((e: DocTreeEntry) => e.type === 'file')

    // All dirs should come before all files
    const lastDirIdx = entries.lastIndexOf(dirs[dirs.length - 1])
    const firstFileIdx = entries.indexOf(files[0])
    if (dirs.length > 0 && files.length > 0) {
      expect(lastDirIdx).toBeLessThan(firstFileIdx)
    }

    // Files should be sorted alphabetically (case-insensitive)
    for (let i = 1; i < files.length; i++) {
      expect(files[i - 1].name.toLowerCase() <= files[i].name.toLowerCase()).toBe(true)
    }
  })

  it('classifies isKeyDocument correctly (A.9)', async () => {
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries

    const trd = entries.find((e: DocTreeEntry) => e.name === 'trd.md')
    expect(trd?.isKeyDocument).toBe(true)

    const prd = entries.find((e: DocTreeEntry) => e.name === 'prd.md')
    expect(prd?.isKeyDocument).toBe(true)

    const plan = entries.find((e: DocTreeEntry) => e.name === 'plan.md')
    expect(plan?.isKeyDocument).toBe(true)

    const review = entries.find((e: DocTreeEntry) => e.name === 'design-review.md')
    expect(review?.isKeyDocument).toBe(true)

    const readme = entries.find((e: DocTreeEntry) => e.name === 'readme.md')
    expect(readme?.isKeyDocument).toBe(false)
  })

  it('classifies isTeamArtifact correctly', async () => {
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries

    const teamArtifact = entries.find((e: DocTreeEntry) => e.name === '.02-impl-team')
    expect(teamArtifact?.isTeamArtifact).toBe(true)

    const subdir = entries.find((e: DocTreeEntry) => e.name === 'subdir')
    expect(subdir?.isTeamArtifact).toBe(false)
  })

  it('classifies isHidden correctly', async () => {
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries

    const hidden = entries.find((e: DocTreeEntry) => e.name === '.hidden-file.md')
    expect(hidden?.isHidden).toBe(true)

    const visible = entries.find((e: DocTreeEntry) => e.name === 'readme.md')
    expect(visible?.isHidden).toBe(false)
  })

  it('classifies isHandoffs correctly', async () => {
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries

    const handoffs = entries.find((e: DocTreeEntry) => e.name === 'handoffs')
    expect(handoffs?.isHandoffs).toBe(true)

    const subdir = entries.find((e: DocTreeEntry) => e.name === 'subdir')
    expect(subdir?.isHandoffs).toBe(false)
  })

  it('hasChildren is true for non-empty dirs, false for empty dirs (A.8)', async () => {
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries

    const subdir = entries.find((e: DocTreeEntry) => e.name === 'subdir')
    expect(subdir?.hasChildren).toBe(true)

    const emptyDir = entries.find((e: DocTreeEntry) => e.name === 'empty-dir')
    expect(emptyDir?.hasChildren).toBe(false)
  })

  it('rejects path traversal via ../', async () => {
    const evilPath = path.join(docsRoot, '..', '..')
    const result = await invokeListTree(evilPath)
    expect(result.error).not.toBeNull()
  })

  it('rejects unknown workspace slug (A.1)', async () => {
    const handler = getHandler('docs:listTree')
    const result = await handler(fakeEvent, {
      dirPath: docsRoot,
      workspaceSlug: 'nonexistent-slug',
    }) as IpcResponse<DocTreeResponse>
    expect(result.error).not.toBeNull()
  })

  it('silently omits symlinks that escape docsRoot (A.2)', async () => {
    const outsideDir = path.join(tmpDir, 'outside')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret')

    try {
      fs.symlinkSync(outsideDir, path.join(docsRoot, 'escape-link'))
    } catch {
      // symlink creation may fail on some systems — skip test
      return
    }

    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries
    const symEntry = entries.find((e: DocTreeEntry) => e.name === 'escape-link')
    expect(symEntry).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// docs:readFile
// ---------------------------------------------------------------------------

describe('docs:readFile', () => {
  it('returns content for .md files', async () => {
    const result = await invokeReadFile(path.join(docsRoot, 'readme.md'))
    expect(result.error).toBeNull()
    expect(result.data!.content).toBe('# Hello')
    expect(result.data!.extension).toBe('md')
  })

  it('returns content for .yaml files', async () => {
    const result = await invokeReadFile(path.join(docsRoot, 'config.yaml'))
    expect(result.error).toBeNull()
    expect(result.data!.content).toBe('key: value')
    expect(result.data!.extension).toBe('yaml')
  })

  it('returns content for .txt files', async () => {
    const result = await invokeReadFile(path.join(docsRoot, 'notes.txt'))
    expect(result.error).toBeNull()
    expect(result.data!.content).toBe('plain text')
    expect(result.data!.extension).toBe('txt')
  })

  it('rejects unsupported file extensions', async () => {
    fs.writeFileSync(path.join(docsRoot, 'script.js'), 'alert(1)')
    const result = await invokeReadFile(path.join(docsRoot, 'script.js'))
    expect(result.error).not.toBeNull()
  })

  it('rejects files over 2MB', async () => {
    const bigFile = path.join(docsRoot, 'big.md')
    fs.writeFileSync(bigFile, 'x'.repeat(2 * 1024 * 1024 + 1))
    const result = await invokeReadFile(bigFile)
    expect(result.error).not.toBeNull()
  })

  it('rejects paths outside docsRoot', async () => {
    const outsideFile = path.join(tmpDir, 'outside.md')
    fs.writeFileSync(outsideFile, 'outside')
    const result = await invokeReadFile(outsideFile)
    expect(result.error).not.toBeNull()
  })

  it('rejects directories', async () => {
    const result = await invokeReadFile(path.join(docsRoot, 'subdir'))
    expect(result.error).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isKeyDocument (tested through listTree)
// ---------------------------------------------------------------------------

describe('isKeyDocument via listTree', () => {
  it('identifies all key doc names including prd.md (A.9)', async () => {
    // Create all key docs
    const keyDocs = ['trd.md', 'plan.md', 'prd.md', 'report.md', 'task-list.md']
    for (const name of keyDocs) {
      const filePath = path.join(docsRoot, name)
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, `# ${name}`)
      }
    }

    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries

    for (const name of keyDocs) {
      const entry = entries.find((e: DocTreeEntry) => e.name === name)
      expect(entry?.isKeyDocument, `Expected ${name} to be a key document`).toBe(true)
    }
  })

  it('identifies *-review.md pattern as key document', async () => {
    fs.writeFileSync(path.join(docsRoot, 'security-review.md'), '# Security Review')
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries
    const review = entries.find((e: DocTreeEntry) => e.name === 'security-review.md')
    expect(review?.isKeyDocument).toBe(true)
  })

  it('non-key docs are not marked as key documents', async () => {
    const result = await invokeListTree(docsRoot)
    const entries = result.data!.entries
    const notes = entries.find((e: DocTreeEntry) => e.name === 'notes.txt')
    expect(notes?.isKeyDocument).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Security: Path validation (Step 29)
// ---------------------------------------------------------------------------

describe('Security: path validation via handlers', () => {
  it('allows exact docsRoot path', async () => {
    const result = await invokeListTree(docsRoot)
    expect(result.error).toBeNull()
  })

  it('allows nested paths within docsRoot', async () => {
    const result = await invokeListTree(path.join(docsRoot, 'subdir'))
    expect(result.error).toBeNull()
  })

  it('rejects ../ traversal', async () => {
    const result = await invokeListTree(path.join(docsRoot, '..'))
    expect(result.error).not.toBeNull()
  })

  it('rejects sibling prefix attacks (/home/docs-evil vs /home/docs)', async () => {
    // Create a sibling directory that shares a prefix with docsRoot
    const siblingDir = docsRoot + '-evil'
    fs.mkdirSync(siblingDir, { recursive: true })
    fs.writeFileSync(path.join(siblingDir, 'secret.md'), 'evil')

    const result = await invokeListTree(siblingDir)
    expect(result.error).not.toBeNull()

    fs.rmSync(siblingDir, { recursive: true, force: true })
  })

  it('rejects absolute paths outside docsRoot', async () => {
    const outsidePath = path.join(tmpDir, 'outside-dir')
    fs.mkdirSync(outsidePath, { recursive: true })

    const result = await invokeListTree(outsidePath)
    expect(result.error).not.toBeNull()

    fs.rmSync(outsidePath, { recursive: true, force: true })
  })

  it('rejects symlink traversal — symlink inside docsRoot pointing outside (A.2)', async () => {
    const outsideDir = path.join(tmpDir, 'escape-target')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret content')

    const symlinkPath = path.join(docsRoot, 'malicious-link')
    try {
      fs.symlinkSync(outsideDir, symlinkPath)
    } catch {
      // symlink creation may fail on some systems — skip
      return
    }

    // The symlink entry should be omitted from listTree
    const listResult = await invokeListTree(docsRoot)
    const entries = listResult.data!.entries
    expect(entries.find((e: DocTreeEntry) => e.name === 'malicious-link')).toBeUndefined()

    // Direct access to the symlink target via readFile should be rejected
    const readResult = await invokeReadFile(path.join(outsideDir, 'secret.md'))
    expect(readResult.error).not.toBeNull()
  })

  it('unknown workspace slug returns error (A.1)', async () => {
    const handler = getHandler('docs:listTree')
    const result = await handler(fakeEvent, {
      dirPath: docsRoot,
      workspaceSlug: 'unknown-slug-xyz',
    }) as IpcResponse<DocTreeResponse>
    expect(result.error).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// docs:writeFile — security tests (§8.1)
// ---------------------------------------------------------------------------

// Helper: get mtime of a file as ISO string (matches what the handler reads)
async function fileMtime(filePath: string): Promise<string> {
  const st = await fs.promises.lstat(filePath)
  return st.mtime.toISOString()
}

describe('docs:writeFile — happy path', () => {
  it('writes content to an existing file inside docsRoot; disk content equals payload', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    const result = await invokeWriteFile(target, '# Updated', mtime)
    expect(result.error).toBeNull()
    expect(result.data).not.toBeNull()
    expect(fs.readFileSync(target, 'utf-8')).toBe('# Updated')
  })

  it('response contains correct size and lastModified after write', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    const result = await invokeWriteFile(target, 'hello world', mtime)
    expect(result.error).toBeNull()
    const stat = await fs.promises.stat(target)
    expect(result.data!.size).toBe(stat.size)
    expect(result.data!.lastModified).toBe(stat.mtime.toISOString())
  })

  it('writes empty-string content (0-byte file)', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    const result = await invokeWriteFile(target, '', mtime)
    expect(result.error).toBeNull()
    expect(fs.readFileSync(target, 'utf-8')).toBe('')
    expect(result.data!.size).toBe(0)
  })

  it('writes .yaml file successfully', async () => {
    const target = path.join(docsRoot, 'config.yaml')
    const mtime = await fileMtime(target)
    const result = await invokeWriteFile(target, 'updated: true', mtime)
    expect(result.error).toBeNull()
    expect(fs.readFileSync(target, 'utf-8')).toBe('updated: true')
  })

  it('writes .txt file successfully', async () => {
    const target = path.join(docsRoot, 'notes.txt')
    const mtime = await fileMtime(target)
    const result = await invokeWriteFile(target, 'new content', mtime)
    expect(result.error).toBeNull()
    expect(fs.readFileSync(target, 'utf-8')).toBe('new content')
  })

  it('round-trip: write then docs:readFile returns new content and matching mtime', async () => {
    const target = path.join(docsRoot, 'readme.md')
    // Backdate the fixture so the write below always lands on a different
    // millisecond mtime; otherwise a fast write can reproduce the same mtime.
    const past = new Date(Date.now() - 60_000)
    fs.utimesSync(target, past, past)
    const mtime = await fileMtime(target)
    await invokeWriteFile(target, '# Round-trip', mtime)

    const readResult = await invokeReadFile(target)
    expect(readResult.error).toBeNull()
    expect(readResult.data!.content).toBe('# Round-trip')

    const writeResult = await invokeWriteFile(target, '# Round-trip', mtime)
    // After the first write, mtime changed — second write with old mtime should STALE_WRITE
    expect(writeResult.error?.code).toBe('STALE_WRITE')
  })

  it('no leftover .tmp files after a successful write', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    await invokeWriteFile(target, '# No leftovers', mtime)
    const tmpFiles = fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })
})

describe('docs:writeFile — security: path containment', () => {
  it('rejects path traversal (docsRoot/../outside.md) → PERMISSION_DENIED', async () => {
    const outsideFile = path.join(tmpDir, 'outside.md')
    fs.writeFileSync(outsideFile, '# outside')
    const traversalPath = path.join(docsRoot, '..', 'outside.md')
    // mtime doesn't matter — should be blocked before mtime check
    const result = await invokeWriteFile(traversalPath, 'evil', '2000-01-01T00:00:00.000Z')
    expect(result.error).not.toBeNull()
    expect(result.error!.code).toBe('PERMISSION_DENIED')
    // Original file must be untouched
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('# outside')
  })

  it('rejects sibling prefix attack (docsRoot-evil) → PERMISSION_DENIED', async () => {
    const siblingDir = docsRoot + '-evil'
    fs.mkdirSync(siblingDir, { recursive: true })
    const siblingFile = path.join(siblingDir, 'secret.md')
    fs.writeFileSync(siblingFile, 'secret')
    const result = await invokeWriteFile(siblingFile, 'pwned', '2000-01-01T00:00:00.000Z')
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(fs.readFileSync(siblingFile, 'utf-8')).toBe('secret')
    fs.rmSync(siblingDir, { recursive: true, force: true })
  })

  it('rejects unknown workspaceSlug → PERMISSION_DENIED', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    const handler = getHandler('docs:writeFile')
    const result = await handler(fakeEvent, {
      filePath: target,
      workspaceSlug: 'no-such-slug',
      content: 'evil',
      expectedMtime: mtime,
    }) as IpcResponse<DocWriteResponse>
    expect(result.error?.code).toBe('PERMISSION_DENIED')
  })
})

describe('docs:writeFile — security: symlink guard (§17 R1)', () => {
  it('rejects symlink AS the target file → PERMISSION_DENIED (never written through)', async () => {
    const realFile = path.join(tmpDir, 'real.md')
    fs.writeFileSync(realFile, '# real')
    const linkPath = path.join(docsRoot, 'link.md')
    try {
      fs.symlinkSync(realFile, linkPath)
    } catch {
      return // symlink not supported on this system
    }
    const mtime = (await fs.promises.lstat(realFile)).mtime.toISOString()
    const result = await invokeWriteFile(linkPath, 'evil', mtime)
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    // Original file content must be unchanged
    expect(fs.readFileSync(realFile, 'utf-8')).toBe('# real')
  })

  it('rejects symlink AS a parent directory component → PERMISSION_DENIED', async () => {
    const realSubdir = path.join(tmpDir, 'real-subdir')
    fs.mkdirSync(realSubdir)
    fs.writeFileSync(path.join(realSubdir, 'file.md'), '# real')
    const symlinkDir = path.join(docsRoot, 'sym-subdir')
    try {
      fs.symlinkSync(realSubdir, symlinkDir)
    } catch {
      return
    }
    const target = path.join(symlinkDir, 'file.md')
    const result = await invokeWriteFile(target, 'evil', '2000-01-01T00:00:00.000Z')
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(fs.readFileSync(path.join(realSubdir, 'file.md'), 'utf-8')).toBe('# real')
  })

  it('rejects symlink whose realpath stays inside docsRoot but is still a symlink', async () => {
    // Create a real file inside docsRoot, then symlink it within docsRoot.
    // realpath resolves to inside docsRoot, but lstat on the symlink itself must still reject.
    const realFile = path.join(docsRoot, 'real-target.md')
    fs.writeFileSync(realFile, '# real target')
    const symlinkPath = path.join(docsRoot, 'internal-link.md')
    try {
      fs.symlinkSync(realFile, symlinkPath)
    } catch {
      return
    }
    const mtime = await fileMtime(realFile)
    const result = await invokeWriteFile(symlinkPath, 'evil', mtime)
    // Even though realpath is inside docsRoot, the symlink must be rejected
    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(fs.readFileSync(realFile, 'utf-8')).toBe('# real target')
  })
})

describe('docs:writeFile — security: pre-rename parent recheck (§17 R1)', () => {
  // chmod on the temp file is the last step before the recheck, so swapping the
  // parent directory there simulates a race between validation and the rename.
  function swapParentBeforeRename(swap: () => void) {
    const realChmod = fs.promises.chmod
    return vi.spyOn(fs.promises, 'chmod').mockImplementationOnce(async (p, mode) => {
      await realChmod(p, mode)
      swap()
    })
  }

  it.skipIf(process.platform === 'win32')(
    'rejects when the parent dir is replaced by a symlink just before rename',
    async () => {
      const target = path.join(docsRoot, 'subdir', 'nested.md')
      const mtime = await fileMtime(target)
      const elsewhere = path.join(tmpDir, 'elsewhere')
      fs.mkdirSync(elsewhere)
      fs.writeFileSync(path.join(elsewhere, 'nested.md'), '# elsewhere')
      const moved = path.join(tmpDir, 'subdir-moved')

      const chmodSpy = swapParentBeforeRename(() => {
        fs.renameSync(path.join(docsRoot, 'subdir'), moved)
        fs.symlinkSync(elsewhere, path.join(docsRoot, 'subdir'))
      })
      const result = await invokeWriteFile(target, 'evil', mtime)
      chmodSpy.mockRestore()

      expect(result.error?.code).toBe('PERMISSION_DENIED')
      expect(fs.readFileSync(path.join(elsewhere, 'nested.md'), 'utf-8')).toBe('# elsewhere')
      expect(fs.readFileSync(path.join(moved, 'nested.md'), 'utf-8')).toBe('# Nested')
    },
  )

  it('rejects when the parent dir is replaced by a regular file just before rename', async () => {
    const target = path.join(docsRoot, 'subdir', 'nested.md')
    const mtime = await fileMtime(target)
    const moved = path.join(tmpDir, 'subdir-moved')

    const chmodSpy = swapParentBeforeRename(() => {
      fs.renameSync(path.join(docsRoot, 'subdir'), moved)
      fs.writeFileSync(path.join(docsRoot, 'subdir'), 'not a directory')
    })
    const result = await invokeWriteFile(target, 'evil', mtime)
    chmodSpy.mockRestore()

    expect(result.error?.code).toBe('PERMISSION_DENIED')
    expect(fs.readFileSync(path.join(moved, 'nested.md'), 'utf-8')).toBe('# Nested')
  })
})

describe('docs:writeFile — security: extension and type guards', () => {
  it('rejects disallowed extension .png → PERMISSION_DENIED', async () => {
    const target = path.join(docsRoot, 'image.png')
    fs.writeFileSync(target, 'fake-png-data')
    const mtime = await fileMtime(target)
    const result = await invokeWriteFile(target, 'evil', mtime)
    expect(result.error?.code).toBe('PERMISSION_DENIED')
  })

  it('rejects disallowed extension .js → PERMISSION_DENIED', async () => {
    const target = path.join(docsRoot, 'script.js')
    fs.writeFileSync(target, 'alert(1)')
    const mtime = await fileMtime(target)
    const result = await invokeWriteFile(target, 'evil()', mtime)
    expect(result.error?.code).toBe('PERMISSION_DENIED')
  })

  it('rejects target that does not exist → NOT_FOUND (no create)', async () => {
    const nonexistent = path.join(docsRoot, 'nonexistent.md')
    const result = await invokeWriteFile(nonexistent, '# new', '2000-01-01T00:00:00.000Z')
    expect(result.error?.code).toBe('NOT_FOUND')
  })

  it('rejects target that is a directory → NOT_FOUND', async () => {
    const dir = path.join(docsRoot, 'subdir')
    const result = await invokeWriteFile(dir, 'content', '2000-01-01T00:00:00.000Z')
    expect(result.error?.code).toBe('NOT_FOUND')
  })
})

describe('docs:writeFile — security: size cap', () => {
  it('rejects content exceeding 2 MB bytes → error returned (Zod or handler cap)', async () => {
    // §17 R23: Zod .max() counts UTF-16 code units (loose upper bound); Buffer.byteLength is
    // authoritative in the handler. For pure ASCII the thresholds coincide, so Zod's
    // VALIDATION_ERROR fires first. Either way, an error is returned and the file is untouched.
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    const oversized = 'a'.repeat(2 * 1024 * 1024 + 1)
    const result = await invokeWriteFile(target, oversized, mtime)
    expect(result.error).not.toBeNull()
    expect(['PERMISSION_DENIED', 'VALIDATION_ERROR']).toContain(result.error!.code)
    // Original content must be unchanged
    expect(fs.readFileSync(target, 'utf-8')).toBe('# Hello')
  })
})

describe('docs:writeFile — stale-write guard', () => {
  it('rejects write when expectedMtime does not match disk mtime → STALE_WRITE', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const originalContent = fs.readFileSync(target, 'utf-8')
    // Use a clearly wrong (old) mtime
    const result = await invokeWriteFile(target, 'new content', '2000-01-01T00:00:00.000Z')
    expect(result.error?.code).toBe('STALE_WRITE')
    // File content must be unchanged
    expect(fs.readFileSync(target, 'utf-8')).toBe(originalContent)
  })

  it('STALE_WRITE uses IPC_ERROR_CODES constant (§17 R8) — error code is the string STALE_WRITE', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const result = await invokeWriteFile(target, 'evil', '1970-01-01T00:00:00.000Z')
    expect(result.error?.code).toBe('STALE_WRITE')
  })

  it('rejects write after file is externally modified (mtime advances)', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const staleMtime = await fileMtime(target)

    // Simulate an external modification: overwrite the file to advance its mtime
    fs.writeFileSync(target, '# externally changed')
    // Ensure mtime actually changed (may need a small delay on some FS)
    await new Promise((resolve) => setTimeout(resolve, 10))
    fs.utimesSync(target, new Date(), new Date())

    const result = await invokeWriteFile(target, 'my edit', staleMtime)
    expect(result.error?.code).toBe('STALE_WRITE')
    // External content must be preserved
    expect(fs.readFileSync(target, 'utf-8')).toBe('# externally changed')
  })
})

describe('docs:writeFile — error message sanitization (§17 R7)', () => {
  it('error messages do not leak absolute paths or raw fs error details', async () => {
    const traversalPath = path.join(docsRoot, '..', 'outside.md')
    const result = await invokeWriteFile(traversalPath, 'evil', '2000-01-01T00:00:00.000Z')
    expect(result.error).not.toBeNull()
    // The message should be a fixed string, not contain the tmpDir path
    expect(result.error!.message).not.toContain(tmpDir)
    expect(result.error!.message).not.toContain('/tmp/')
  })

  it('NOT_FOUND error message is a fixed string, not a raw fs error', async () => {
    const result = await invokeWriteFile(
      path.join(docsRoot, 'no-such-file.md'),
      'content',
      '2000-01-01T00:00:00.000Z',
    )
    expect(result.error?.code).toBe('NOT_FOUND')
    // Should not contain fs-level error details
    expect(result.error!.message).not.toMatch(/ENOENT/)
  })

  it('post-validation fs failure (concurrent-mutation race) is sanitized, not leaked', async () => {
    // Impl-review H1: the post-rename stat() and pre-rename lstat() sit after the
    // validation block; an unwrapped throw there would leak the raw err.message
    // (absolute host path) to the renderer. Simulate the race by making the
    // post-rename stat reject with a path-bearing message.
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    const statSpy = vi.spyOn(fs.promises, 'stat').mockRejectedValueOnce(
      Object.assign(new Error(`ENOENT: no such file, stat '${target}'`), { code: 'ENOENT' }),
    )

    const result = await invokeWriteFile(target, '# raced', mtime)
    statSpy.mockRestore()

    expect(result.error).not.toBeNull()
    // Must NOT leak the absolute path or raw fs error text — whichever post-validation
    // fs call the race hits, the renderer only ever sees a fixed, sanitized message.
    expect(result.error!.message).not.toContain(docsRoot)
    expect(result.error!.message).not.toContain(tmpDir)
    expect(result.error!.message).not.toMatch(/ENOENT/)
    expect(result.error!.message).not.toMatch(/[/\\]/) // no path separators at all
    expect(result.error!.message.length).toBeLessThan(40)
  })
})

describe('docs:writeFile — temp file cleanup (§17 R5)', () => {
  it('no .tmp files left in docsRoot after a successful write', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    await invokeWriteFile(target, '# Cleaned up', mtime)
    const tmpFiles = fs.readdirSync(docsRoot).filter((f) => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('no .tmp files left after a STALE_WRITE rejection (write never reached)', async () => {
    const target = path.join(docsRoot, 'readme.md')
    await invokeWriteFile(target, 'evil', '2000-01-01T00:00:00.000Z')
    const tmpFiles = fs.readdirSync(docsRoot).filter((f) => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('cleans up .tmp file when rename fails (mocked rename throw)', async () => {
    const target = path.join(docsRoot, 'readme.md')
    const mtime = await fileMtime(target)
    const originalContent = fs.readFileSync(target, 'utf-8')

    // Spy on fs.promises.rename and make it throw once
    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('rename failed'), { code: 'ENOENT' })
    )

    const result = await invokeWriteFile(target, 'new content', mtime)
    renameSpy.mockRestore()

    // Write should have failed
    expect(result.error).not.toBeNull()
    // Original file must be untouched
    expect(fs.readFileSync(target, 'utf-8')).toBe(originalContent)
    // No tmp files should remain
    const tmpFiles = fs.readdirSync(docsRoot).filter((f) => f.endsWith('.tmp'))
    expect(tmpFiles).toHaveLength(0)
  })
})

describe('docs:writeFile — read-only file (§17 conditional)', () => {
  it('chmod 0444 on the parent directory → PERMISSION_DENIED on write (skipped as root or permissive)', async () => {
    // Making the parent dir non-writable prevents temp-file creation and rename.
    // Root bypasses POSIX permission checks — skip when uid=0.
    if (process.getuid?.() === 0) return

    // Probe: can we actually deny writes to a subdir on this mount?
    const subdir = path.join(docsRoot, 'readonly-dir')
    fs.mkdirSync(subdir)
    const target = path.join(subdir, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)

    fs.chmodSync(subdir, 0o555) // remove write bit from dir

    // Check enforcement
    let dirWriteDenied = false
    try {
      fs.writeFileSync(path.join(subdir, 'probe.txt'), 'probe')
    } catch {
      dirWriteDenied = true
    } finally {
      fs.rmSync(path.join(subdir, 'probe.txt'), { force: true })
    }

    if (!dirWriteDenied) {
      // Permissive mount (CI/tmpfs/root-equiv) — restore and skip
      fs.chmodSync(subdir, 0o755)
      return
    }

    try {
      const result = await invokeWriteFile(target, 'evil', mtime)
      expect(result.error?.code).toBe('PERMISSION_DENIED')
      expect(fs.readFileSync(target, 'utf-8')).toBe('# original')
    } finally {
      fs.chmodSync(subdir, 0o755)
    }
  })
})
