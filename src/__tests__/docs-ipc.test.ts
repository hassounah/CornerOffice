import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { IpcResponse } from '../main/types/ipc'
import type { DocTreeResponse, DocFileResponse, DocTreeEntry } from '../main/types/docs'
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
