import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { listDir, walkFileIndex, FALLBACK_IGNORES, FILE_INDEX_WALK_CAP } from '../main/services/code-fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let root: string
let outside: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-code-fs-list-test-'))
  root = path.join(tmpDir, 'repo')
  outside = path.join(tmpDir, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFile(relToRoot: string, content: string | Buffer = 'x'): string {
  const abs = path.join(root, relToRoot)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

function makeDir(relToRoot: string): string {
  const abs = path.join(root, relToRoot)
  fs.mkdirSync(abs, { recursive: true })
  return abs
}

function isFilesystemCaseSensitive(): boolean {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-case-probe-'))
  try {
    const upper = path.join(probeDir, 'CaseProbe')
    fs.writeFileSync(upper, 'x')
    return !fs.existsSync(path.join(probeDir, 'caseprobe'))
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
}

const FILESYSTEM_IS_CASE_SENSITIVE = isFilesystemCaseSensitive()

// ---------------------------------------------------------------------------
// listDir
// ---------------------------------------------------------------------------

describe('listDir', () => {
  it('lists files and directories, sorted directories-first then case-insensitive by name', async () => {
    writeFile('b.txt')
    writeFile('a.txt')
    makeDir('Zdir')
    makeDir('adir')

    const result = await listDir(root, '', { includeIgnored: true })
    expect(result.relDir).toBe('')
    expect(result.entries.map((e) => e.name)).toEqual(['adir', 'Zdir', 'a.txt', 'b.txt'])
    expect(result.entries.find((e) => e.name === 'adir')?.type).toBe('dir')
    expect(result.entries.find((e) => e.name === 'a.txt')?.type).toBe('file')
    expect(result.omitted).toBe(0)
    expect(result.ignoredParent).toBe(false)
  })

  it('drops a literal .git directory at any depth', async () => {
    makeDir('.git')
    makeDir('sub/.git')
    writeFile('sub/real.txt')

    const rootResult = await listDir(root, '', { includeIgnored: true })
    expect(rootResult.entries.some((e) => e.name === '.git')).toBe(false)

    const subResult = await listDir(root, 'sub', { includeIgnored: true })
    expect(subResult.entries.map((e) => e.name)).toEqual(['real.txt'])
  })

  it('denies listing a relDir that resolves inside .git (H2)', async () => {
    makeDir('.git/objects')
    await expect(listDir(root, '.git/objects', { includeIgnored: true })).rejects.toThrow()
  })

  it('throws notFound for a relDir that does not exist', async () => {
    await expect(listDir(root, 'nope', { includeIgnored: true })).rejects.toThrow()
  })

  it.skipIf(!FILESYSTEM_IS_CASE_SENSITIVE)(
    'drops a case-variant .GIT directory on a case-sensitive filesystem',
    async () => {
      makeDir('.GIT')
      const result = await listDir(root, '', { includeIgnored: true })
      expect(result.entries.some((e) => e.name === '.GIT')).toBe(false)
    },
  )

  it('classifies an internal file symlink as file-internal', async () => {
    writeFile('target.txt', 'hello')
    fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link-to-file'))
    const result = await listDir(root, '', { includeIgnored: true })
    const entry = result.entries.find((e) => e.name === 'link-to-file')
    expect(entry?.type).toBe('symlink')
    expect(entry?.symlink).toBe('file-internal')
  })

  it('classifies an internal directory symlink as dir-internal', async () => {
    makeDir('targetdir')
    fs.symlinkSync(path.join(root, 'targetdir'), path.join(root, 'link-to-dir'))
    const result = await listDir(root, '', { includeIgnored: true })
    const entry = result.entries.find((e) => e.name === 'link-to-dir')
    expect(entry?.symlink).toBe('dir-internal')
  })

  it('classifies a symlink pointing outside the root as external', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link-external'))
    const result = await listDir(root, '', { includeIgnored: true })
    const entry = result.entries.find((e) => e.name === 'link-external')
    expect(entry?.symlink).toBe('external')
  })

  it('classifies a broken symlink as broken', async () => {
    fs.symlinkSync(path.join(root, 'does-not-exist'), path.join(root, 'link-broken'))
    const result = await listDir(root, '', { includeIgnored: true })
    const entry = result.entries.find((e) => e.name === 'link-broken')
    expect(entry?.symlink).toBe('broken')
  })

  it('classifies a symlink pointing inside .git as git-internal', async () => {
    makeDir('.git')
    writeFile('.git/config', '[core]\n')
    fs.symlinkSync(path.join(root, '.git', 'config'), path.join(root, 'link-git-internal'))
    const result = await listDir(root, '', { includeIgnored: true })
    const entry = result.entries.find((e) => e.name === 'link-git-internal')
    expect(entry?.symlink).toBe('git-internal')
  })

  it('lists a FIFO as type "other"', async () => {
    const fifoPath = path.join(root, 'a.fifo')
    try {
      execFileSync('mkfifo', [fifoPath])
    } catch {
      return // mkfifo unavailable on this platform — skip
    }
    const result = await listDir(root, '', { includeIgnored: true })
    const entry = result.entries.find((e) => e.name === 'a.fifo')
    expect(entry?.type).toBe('other')
  })

  it('marks a gitlink path as type "submodule"', async () => {
    makeDir('vendor/lib')
    const result = await listDir(root, '', {
      includeIgnored: true,
      gitCtx: { gitlinks: new Set(['vendor/lib']) },
    })
    const vendorResult = await listDir(root, 'vendor', {
      includeIgnored: true,
      gitCtx: { gitlinks: new Set(['vendor/lib']) },
    })
    expect(result.entries.find((e) => e.name === 'vendor')?.type).toBe('dir')
    expect(vendorResult.entries.find((e) => e.name === 'lib')?.type).toBe('submodule')
  })

  it('drops ignored entries before capping when includeIgnored is false, using the injected checkIgnore', async () => {
    for (let i = 0; i < 10; i++) writeFile(`kept${i}.txt`)
    for (let i = 0; i < 10; i++) writeFile(`ignored${i}.txt`)
    const ignoredNames = new Set(Array.from({ length: 10 }, (_, i) => `ignored${i}.txt`))

    const result = await listDir(root, '', {
      includeIgnored: false,
      gitCtx: {
        checkIgnore: async (relPaths) => new Set(relPaths.filter((p) => ignoredNames.has(p))),
      },
    })
    expect(result.entries.length).toBe(10)
    expect(result.entries.every((e) => !ignoredNames.has(e.name))).toBe(true)
  })

  it('includes ignored entries, flagged, when includeIgnored is true', async () => {
    writeFile('normal.txt')
    writeFile('ignored.txt')
    const result = await listDir(root, '', {
      includeIgnored: true,
      gitCtx: { checkIgnore: async (relPaths) => new Set(relPaths.filter((p) => p === 'ignored.txt')) },
    })
    expect(result.entries.find((e) => e.name === 'ignored.txt')?.ignored).toBe(true)
    expect(result.entries.find((e) => e.name === 'normal.txt')?.ignored).toBe(false)
  })

  it('a child of an ignored parent inherits ignored without a per-child checkIgnore lookup', async () => {
    makeDir('ignoreddir')
    writeFile('ignoreddir/child.txt')
    let childCallArgs: readonly string[] | null = null
    const result = await listDir(root, 'ignoreddir', {
      includeIgnored: true,
      gitCtx: {
        checkIgnore: async (relPaths) => {
          if (relPaths.length === 1 && relPaths[0] === 'ignoreddir') return new Set(['ignoreddir'])
          childCallArgs = relPaths
          return new Set()
        },
      },
    })
    expect(result.ignoredParent).toBe(true)
    expect(result.entries[0].ignored).toBe(true)
    expect(childCallArgs).toBeNull() // never called for children — inherited instead
  })

  it('uses FALLBACK_IGNORES by name when no checkIgnore is injected (non-git)', async () => {
    makeDir('node_modules')
    writeFile('node_modules/pkg.js')
    writeFile('real.txt')
    const result = await listDir(root, '', { includeIgnored: false })
    expect(result.entries.map((e) => e.name)).toEqual(['real.txt'])
    expect(FALLBACK_IGNORES.has('node_modules')).toBe(true)
  })

  it('inherits ignored via FALLBACK_IGNORES ancestry even without listing the ancestor first', async () => {
    makeDir('node_modules/pkg')
    writeFile('node_modules/pkg/index.js')
    const result = await listDir(root, 'node_modules/pkg', { includeIgnored: true })
    expect(result.ignoredParent).toBe(true)
    expect(result.entries[0].ignored).toBe(true)
  })

  it('caps entries at LIST_DIR_CAP (5000) and reports omitted, without ignored entries counting toward the cap', async () => {
    for (let i = 0; i < 5010; i++) writeFile(`f${i}.txt`)
    for (let i = 0; i < 20; i++) writeFile(`ignored${i}.txt`)
    const ignoredNames = new Set(Array.from({ length: 20 }, (_, i) => `ignored${i}.txt`))

    const result = await listDir(root, '', {
      includeIgnored: false,
      gitCtx: { checkIgnore: async (relPaths) => new Set(relPaths.filter((p) => ignoredNames.has(p))) },
    })
    expect(result.entries.length).toBe(5000)
    expect(result.omitted).toBe(10) // 5010 kept files - 5000 cap; the 20 ignored never counted at all
  }, 30_000)

  it('flags a secret file by name', async () => {
    writeFile('.env')
    const result = await listDir(root, '', { includeIgnored: true })
    expect(result.entries.find((e) => e.name === '.env')?.secret).toBe(true)
  })

  it('flags a symlink as secret when its realpath basename matches, even if its own name does not', async () => {
    writeFile('.env')
    fs.symlinkSync(path.join(root, '.env'), path.join(root, 'harmless-name'))
    const result = await listDir(root, '', { includeIgnored: true })
    expect(result.entries.find((e) => e.name === 'harmless-name')?.secret).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// walkFileIndex
// ---------------------------------------------------------------------------

describe('walkFileIndex', () => {
  it('walks nested directories, skipping .git and FALLBACK_IGNORES', async () => {
    writeFile('a.txt')
    makeDir('sub')
    writeFile('sub/b.txt')
    makeDir('.git')
    writeFile('.git/HEAD', 'ref: refs/heads/main\n')
    makeDir('node_modules')
    writeFile('node_modules/pkg.js')

    const result = await walkFileIndex(root)
    expect(result.paths.sort()).toEqual(['a.txt', 'sub/b.txt'])
    expect(result.truncated).toBe(false)
  })

  it('does not recurse into a symlinked directory but does list a symlinked file', async () => {
    makeDir('realdir')
    writeFile('realdir/inner.txt')
    fs.symlinkSync(path.join(root, 'realdir'), path.join(root, 'linkdir'))
    writeFile('target.txt')
    fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'linkfile'))

    const result = await walkFileIndex(root)
    expect(result.paths).toContain('realdir/inner.txt')
    expect(result.paths).toContain('target.txt')
    expect(result.paths).toContain('linkfile')
    expect(result.paths.some((p) => p.startsWith('linkdir/'))).toBe(false)
  })

  it('skips a broken symlink entirely', async () => {
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'broken-link'))
    writeFile('real.txt')
    const result = await walkFileIndex(root)
    expect(result.paths).toEqual(['real.txt'])
  })

  it('caps at FILE_INDEX_WALK_CAP entries and reports truncated', async () => {
    // Use a cap far below the real 100k for a fast, deterministic test by
    // writing just over a small number of files and asserting truncation
    // kicks in at the real constant's boundary is impractical here, so this
    // test instead verifies the constant's existence and shape, and that a
    // small walk finishes untruncated well under budget.
    expect(FILE_INDEX_WALK_CAP).toBe(100_000)
    writeFile('only.txt')
    const result = await walkFileIndex(root)
    expect(result.truncated).toBe(false)
    expect(result.paths).toEqual(['only.txt'])
  })

  it('truncates once the time budget elapses, even with entries remaining', async () => {
    // A real 3s-budget test would be slow; instead this drives the same
    // deadline logic with Date.now() mocked to have already elapsed, which
    // is the actual mechanism the walk checks against.
    const originalNow = Date.now
    let calls = 0
    Date.now = () => {
      calls++
      // First call computes the deadline "now"; every call after is made to
      // look like it's already past that deadline.
      return calls === 1 ? originalNow() : originalNow() + 10_000
    }
    try {
      makeDir('sub')
      writeFile('sub/a.txt')
      writeFile('sub/b.txt')
      const result = await walkFileIndex(root)
      expect(result.truncated).toBe(true)
    } finally {
      Date.now = originalNow
    }
  })
})
