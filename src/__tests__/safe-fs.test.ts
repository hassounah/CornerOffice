import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import {
  durableWrite,
  assertNoSymlinkOnPath,
  MAX_FILE_SIZE,
  denied,
  openParentDir,
  withTimeout,
  readRegularFileCappedSync,
  readRegularFileCapped,
} from '../main/services/safe-fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let root: string

async function fileMtime(filePath: string): Promise<string> {
  const st = await fs.promises.lstat(filePath)
  return st.mtime.toISOString()
}

function tmpFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-safe-fs-test-'))
  root = path.join(tmpDir, 'root')
  fs.mkdirSync(root, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// durableWrite — happy path
// ---------------------------------------------------------------------------

describe('durableWrite — happy path', () => {
  it('writes content to an existing file inside root; disk content equals payload', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# Hello')
    const mtime = await fileMtime(target)

    const result = await durableWrite({
      root,
      rawPath: target,
      content: '# Updated',
      expectedMtime: mtime,
      maxBytes: MAX_FILE_SIZE,
    })

    expect(fs.readFileSync(target, 'utf-8')).toBe('# Updated')
    expect(result.resolvedFile).toBe(await fs.promises.realpath(target))
    expect(result.size).toBe(Buffer.byteLength('# Updated', 'utf-8'))
    expect(result.lastModified).toBe((await fs.promises.stat(target)).mtime.toISOString())
  })

  it('no leftover .tmp files after a successful write', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# Hello')
    const mtime = await fileMtime(target)

    await durableWrite({ root, rawPath: target, content: '# No leftovers', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE })

    expect(tmpFilesIn(root)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// checkTarget — policy hook
// ---------------------------------------------------------------------------

describe('durableWrite — checkTarget policy hook', () => {
  it('receives the lstat-verified target and the resolved path', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# Hello')
    const mtime = await fileMtime(target)
    const resolvedTarget = await fs.promises.realpath(target)

    const checkTarget = vi.fn(async (_resolvedFile: string, _lst: fs.Stats): Promise<void> => {})

    await durableWrite({ root, rawPath: target, content: 'ok', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE, checkTarget })

    expect(checkTarget).toHaveBeenCalledTimes(1)
    const call = checkTarget.mock.calls[0]
    expect(call?.[0]).toBe(resolvedTarget)
    expect(call?.[1]?.isFile()).toBe(true)
  })

  it('can refuse the write with denied() — file untouched, no tmp file left', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)

    const checkTarget = async (): Promise<void> => {
      throw denied()
    }

    await expect(
      durableWrite({ root, rawPath: target, content: 'evil', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE, checkTarget }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

    expect(fs.readFileSync(target, 'utf-8')).toBe('# original')
    expect(tmpFilesIn(root)).toHaveLength(0)
  })

  it('the prefix returned by checkTarget is prepended on disk and counted against maxBytes', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)
    const bom = Buffer.from([0xef, 0xbb, 0xbf])

    const checkTarget = async () => ({ prefix: bom })

    const result = await durableWrite({
      root,
      rawPath: target,
      content: 'hello',
      expectedMtime: mtime,
      maxBytes: MAX_FILE_SIZE,
      checkTarget,
    })

    const onDisk = fs.readFileSync(target)
    expect(onDisk).toEqual(Buffer.concat([bom, Buffer.from('hello', 'utf-8')]))
    expect(result.size).toBe(bom.length + Buffer.byteLength('hello', 'utf-8'))
  })

  it('rejects when prefix + content exceeds maxBytes, even though content alone would fit', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)
    const prefix = Buffer.alloc(10, 'a')
    const content = 'b'.repeat(5)
    const checkTarget = async () => ({ prefix })

    // maxBytes fits content alone (5) but not prefix + content (15)
    await expect(
      durableWrite({ root, rawPath: target, content, expectedMtime: mtime, maxBytes: 10, checkTarget }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

    expect(fs.readFileSync(target, 'utf-8')).toBe('# original')
    expect(tmpFilesIn(root)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Stale-mtime guard
// ---------------------------------------------------------------------------

describe('durableWrite — stale-write guard', () => {
  it('rejects a write when expectedMtime does not match disk mtime → STALE_WRITE', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')

    await expect(
      durableWrite({
        root,
        rawPath: target,
        content: 'evil',
        expectedMtime: '2000-01-01T00:00:00.000Z',
        maxBytes: MAX_FILE_SIZE,
      }),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' })

    expect(fs.readFileSync(target, 'utf-8')).toBe('# original')
    expect(tmpFilesIn(root)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Symlink guard
// ---------------------------------------------------------------------------

describe('assertNoSymlinkOnPath — `..`-prefixed names', () => {
  it.skipIf(process.platform === 'win32')('still walks a segment like `..docs` (a normal name, not a parent step)', async () => {
    const realDir = path.join(tmpDir, 'real-dir')
    fs.mkdirSync(realDir)
    try {
      fs.symlinkSync(realDir, path.join(root, '..docs'))
    } catch {
      return // symlinks unsupported on this filesystem
    }
    await expect(assertNoSymlinkOnPath(root, path.join(root, '..docs', 'x'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('returns early for a real parent step (the containment check owns that case)', async () => {
    await expect(assertNoSymlinkOnPath(root, path.join(root, '..', 'elsewhere'))).resolves.toBeUndefined()
  })
})

describe('durableWrite — symlink guard', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects a symlink component in the path → PERMISSION_DENIED, real file untouched',
    async () => {
      const realSubdir = path.join(tmpDir, 'real-subdir')
      fs.mkdirSync(realSubdir)
      fs.writeFileSync(path.join(realSubdir, 'file.md'), '# real')
      const symlinkDir = path.join(root, 'sym-subdir')
      try {
        fs.symlinkSync(realSubdir, symlinkDir)
      } catch {
        return // symlinks unsupported on this filesystem
      }
      const target = path.join(symlinkDir, 'file.md')

      await expect(
        durableWrite({
          root,
          rawPath: target,
          content: 'evil',
          expectedMtime: '2000-01-01T00:00:00.000Z',
          maxBytes: MAX_FILE_SIZE,
        }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

      expect(fs.readFileSync(path.join(realSubdir, 'file.md'), 'utf-8')).toBe('# real')
      expect(tmpFilesIn(root)).toHaveLength(0)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a symlink AS the target file → PERMISSION_DENIED, never written through',
    async () => {
      const realFile = path.join(tmpDir, 'real.md')
      fs.writeFileSync(realFile, '# real')
      const linkPath = path.join(root, 'link.md')
      try {
        fs.symlinkSync(realFile, linkPath)
      } catch {
        return
      }
      const mtime = await fileMtime(realFile)

      await expect(
        durableWrite({ root, rawPath: linkPath, content: 'evil', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE }),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })

      expect(fs.readFileSync(realFile, 'utf-8')).toBe('# real')
      expect(tmpFilesIn(root)).toHaveLength(0)
    },
  )
})

// ---------------------------------------------------------------------------
// File mode preservation
// ---------------------------------------------------------------------------

describe('durableWrite — file mode preservation', () => {
  it.skipIf(process.platform === 'win32')('preserves the original file mode after write', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    fs.chmodSync(target, 0o640)
    const mtime = await fileMtime(target)

    await durableWrite({ root, rawPath: target, content: 'new content', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE })

    const mode = fs.statSync(target).mode & 0o777
    expect(mode).toBe(0o640)
  })
})

// ---------------------------------------------------------------------------
// Temp-file cleanup on every failure path
// ---------------------------------------------------------------------------

describe('durableWrite — no stray .tmp file on any failure path', () => {
  it('cleans up when checkTarget refuses', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)

    await expect(
      durableWrite({
        root,
        rawPath: target,
        content: 'evil',
        expectedMtime: mtime,
        maxBytes: MAX_FILE_SIZE,
        checkTarget: async () => {
          throw denied()
        },
      }),
    ).rejects.toThrow()
    expect(tmpFilesIn(root)).toHaveLength(0)
  })

  it('cleans up on a STALE_WRITE rejection (write never reached)', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')

    await expect(
      durableWrite({ root, rawPath: target, content: 'evil', expectedMtime: '2000-01-01T00:00:00.000Z', maxBytes: MAX_FILE_SIZE }),
    ).rejects.toThrow()
    expect(tmpFilesIn(root)).toHaveLength(0)
  })

  it('cleans up the .tmp file when rename fails (mocked rename throw)', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)

    const renameSpy = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('rename failed'), { code: 'ENOENT' }),
    )

    await expect(
      durableWrite({ root, rawPath: target, content: 'new content', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE }),
    ).rejects.toThrow()
    renameSpy.mockRestore()

    expect(fs.readFileSync(target, 'utf-8')).toBe('# original')
    expect(tmpFilesIn(root)).toHaveLength(0)
  })

  it('cleans up the .tmp file when the write itself fails (mocked open throw)', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)

    const openSpy = vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(
      Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    )

    await expect(
      durableWrite({ root, rawPath: target, content: 'new content', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE }),
    ).rejects.toThrow()
    openSpy.mockRestore()

    expect(fs.readFileSync(target, 'utf-8')).toBe('# original')
    expect(tmpFilesIn(root)).toHaveLength(0)
  })

  it('sanitizes a post-rename stat failure (concurrent-mutation race) — no leaked path', async () => {
    const target = path.join(root, 'file.md')
    fs.writeFileSync(target, '# original')
    const mtime = await fileMtime(target)

    const realStat = fs.promises.stat.bind(fs.promises)
    let call = 0
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(async (...args: Parameters<typeof fs.promises.stat>) => {
      call += 1
      // 1st call: origMode capture (must succeed). 2nd call: post-rename stat (fails here).
      if (call === 2) {
        throw Object.assign(new Error(`ENOENT: no such file, stat '${target}'`), { code: 'ENOENT' })
      }
      return realStat(...args)
    })

    await expect(
      durableWrite({ root, rawPath: target, content: '# raced', expectedMtime: mtime, maxBytes: MAX_FILE_SIZE }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'Write failed' })
    statSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// openParentDir — pre-rename parent recheck (§17 R1)
// ---------------------------------------------------------------------------

describe('openParentDir', () => {
  it.skipIf(process.platform === 'win32')('returns a handle for a real directory', async () => {
    const dir = path.join(root, 'subdir')
    fs.mkdirSync(dir)
    const handle = await openParentDir(dir)
    expect(handle).not.toBeNull()
    await handle?.close()
  })

  it.skipIf(process.platform === 'win32')('throws writeFailed when the opened handle fails to stat', async () => {
    const dir = path.join(root, 'subdir2')
    fs.mkdirSync(dir)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async () =>
      ({
        stat: async () => { throw new Error('boom') },
        close: async () => {},
      }) as unknown as fs.promises.FileHandle,
    )

    await expect(openParentDir(dir)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
    openSpy.mockRestore()
  })

  it.skipIf(process.platform === 'win32')('throws denied when the opened handle is not a directory', async () => {
    const dir = path.join(root, 'subdir3')
    fs.mkdirSync(dir)
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async () =>
      ({
        stat: async () => ({ isDirectory: () => false }),
        close: async () => {},
      }) as unknown as fs.promises.FileHandle,
    )

    await expect(openParentDir(dir)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    openSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
  it('resolves when the promise settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok')
  })

  it('rejects with TIMEOUT when the promise takes too long', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 50))
    await expect(withTimeout(slow, 5)).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

// ---------------------------------------------------------------------------
// readRegularFileCappedSync / readRegularFileCapped — H2, §10.8, X1, SEC-L4
// ---------------------------------------------------------------------------

describe('readRegularFileCappedSync', () => {
  it('reads an ordinary regular file up to the cap', () => {
    const target = path.join(root, 'file.txt')
    fs.writeFileSync(target, 'hello world')

    const result = readRegularFileCappedSync(target, 1024)
    expect(result).not.toBeNull()
    expect(result?.buf.toString('utf-8')).toBe('hello world')
    expect(result?.size).toBe(Buffer.byteLength('hello world'))
  })

  it('caps the read at `cap` bytes even when the file is larger', () => {
    const target = path.join(root, 'big.txt')
    const content = 'a'.repeat(2000)
    fs.writeFileSync(target, content)

    const result = readRegularFileCappedSync(target, 100)
    expect(result?.buf.length).toBe(100)
    expect(result?.buf.toString('utf-8')).toBe('a'.repeat(100))
    expect(result?.size).toBe(2000) // true file size still reported
  })

  it('reads from a given offset', () => {
    const target = path.join(root, 'offset.txt')
    fs.writeFileSync(target, '0123456789')

    const result = readRegularFileCappedSync(target, 1024, { offset: 5 })
    expect(result?.buf.toString('utf-8')).toBe('56789')
  })

  it('returns an empty buffer when offset is at or past the end', () => {
    const target = path.join(root, 'atend.txt')
    fs.writeFileSync(target, 'hi')

    const result = readRegularFileCappedSync(target, 1024, { offset: 2 })
    expect(result?.buf.length).toBe(0)
    expect(result?.size).toBe(2)
  })

  it('returns null for a nonexistent file', () => {
    const result = readRegularFileCappedSync(path.join(root, 'nope.txt'), 1024)
    expect(result).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink (never followed)', () => {
    const realFile = path.join(tmpDir, 'real.txt')
    fs.writeFileSync(realFile, 'secret')
    const link = path.join(root, 'link.txt')
    try {
      fs.symlinkSync(realFile, link)
    } catch {
      return
    }
    const result = readRegularFileCappedSync(link, 1024)
    expect(result).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a FIFO and returns promptly (no hang)', () => {
    const fifoPath = path.join(root, 'myfifo')
    execFileSync('mkfifo', [fifoPath])
    const result = readRegularFileCappedSync(fifoPath, 1024)
    expect(result).toBeNull()
  })

  it('refuses a directory', () => {
    const dir = path.join(root, 'subdir')
    fs.mkdirSync(dir)
    const result = readRegularFileCappedSync(dir, 1024)
    expect(result).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'a type swap between lstat and open is caught by the fstat re-check (injected hook)',
    () => {
      const target = path.join(root, 'swapped.txt')
      fs.writeFileSync(target, 'before')
      const fifoPath = path.join(root, 'planted-fifo')

      const result = readRegularFileCappedSync(target, 1024, {
        onAfterLstat: () => {
          // Simulate a TOCTOU swap: the regular file is replaced with a FIFO
          // between the initial lstat and the open() call.
          fs.unlinkSync(target)
          execFileSync('mkfifo', [fifoPath])
          fs.renameSync(fifoPath, target)
        },
      })
      expect(result).toBeNull()
    },
  )

  describe('with root (SEC-L4 containment)', () => {
    it('reads a file that resolves inside root', () => {
      const target = path.join(root, 'inside.txt')
      fs.writeFileSync(target, 'inside content')

      const result = readRegularFileCappedSync(target, 1024, { root })
      expect(result?.buf.toString('utf-8')).toBe('inside content')
    })

    it.skipIf(process.platform === 'win32')(
      'refuses a file reached through a symlinked parent directory outside root',
      () => {
        const outsideDir = path.join(tmpDir, 'outside-dir')
        fs.mkdirSync(outsideDir)
        fs.writeFileSync(path.join(outsideDir, 'file.txt'), 'exfiltrate me')

        const symlinkedSubdir = path.join(root, 'sub')
        try {
          fs.symlinkSync(outsideDir, symlinkedSubdir)
        } catch {
          return
        }
        const target = path.join(symlinkedSubdir, 'file.txt')

        const result = readRegularFileCappedSync(target, 1024, { root })
        expect(result).toBeNull()
      },
    )

    it('refuses when root itself does not resolve', () => {
      const target = path.join(root, 'file.txt')
      fs.writeFileSync(target, 'content')

      const result = readRegularFileCappedSync(target, 1024, { root: path.join(tmpDir, 'no-such-root') })
      expect(result).toBeNull()
    })

    it.skipIf(process.platform === 'win32')(
      'a symlink repointed outside root AFTER the containment check does not redirect the read (Fix 1.11 Finding 1)',
      () => {
        // A directory symlink whose target is legitimate at containment-check
        // time (like an agent-writable .rix/pipelines that currently points
        // inside the repo), repointed to escape root before the open. The fix
        // opens the already-resolved `real` path from the containment check
        // — which names the ORIGINAL target directly, not through the
        // symlink — so the repoint has no effect on what gets read.
        const insideTarget = path.join(root, 'inside-target')
        fs.mkdirSync(insideTarget)
        fs.writeFileSync(path.join(insideTarget, 'file.txt'), 'legitimate content')

        const outsideTarget = path.join(tmpDir, 'outside-target')
        fs.mkdirSync(outsideTarget)
        fs.writeFileSync(path.join(outsideTarget, 'file.txt'), 'evil content')

        const link = path.join(root, 'link')
        try {
          fs.symlinkSync(insideTarget, link)
        } catch {
          return // symlinks unsupported on this filesystem
        }

        const result = readRegularFileCappedSync(path.join(link, 'file.txt'), 1024, {
          root,
          onAfterLstat: () => {
            // Repoint AFTER containment already resolved `link` -> insideTarget.
            fs.unlinkSync(link)
            fs.symlinkSync(outsideTarget, link)
          },
        })

        expect(result?.buf.toString('utf-8')).toBe('legitimate content')
      },
    )

    it.skipIf(process.platform === 'win32')(
      'detects a dev/ino swap to a different regular file between open and the recheck (injected hook)',
      () => {
        const target = path.join(root, 'swap-target.txt')
        const other = path.join(root, 'other.txt')
        fs.writeFileSync(target, 'original')
        fs.writeFileSync(other, 'attacker-controlled')

        const result = readRegularFileCappedSync(target, 1024, {
          root,
          onAfterOpen: () => {
            // Simulate a TOCTOU swap: a different regular file is renamed
            // over the target between the post-open fstat and the
            // dev/ino recheck.
            fs.renameSync(other, target)
          },
        })
        expect(result).toBeNull()
      },
    )

    it.skipIf(process.platform === 'win32')(
      'refuses when the target is removed between open and the recheck (recheck lstat fails)',
      () => {
        const target = path.join(root, 'vanish.txt')
        fs.writeFileSync(target, 'content')

        const result = readRegularFileCappedSync(target, 1024, {
          root,
          onAfterOpen: () => {
            fs.unlinkSync(target)
          },
        })
        expect(result).toBeNull()
      },
    )
  })

  describe('defensive range guard (Fix 1.11 Finding 3)', () => {
    it('returns null for a negative offset', () => {
      const target = path.join(root, 'file.txt')
      fs.writeFileSync(target, 'content')
      expect(readRegularFileCappedSync(target, 1024, { offset: -1 })).toBeNull()
    })

    it('returns null for a zero cap', () => {
      const target = path.join(root, 'file.txt')
      fs.writeFileSync(target, 'content')
      expect(readRegularFileCappedSync(target, 0)).toBeNull()
    })

    it('returns null for a negative cap', () => {
      const target = path.join(root, 'file.txt')
      fs.writeFileSync(target, 'content')
      expect(readRegularFileCappedSync(target, -5)).toBeNull()
    })
  })

  it.skipIf(process.platform === 'win32')('returns null when the file is removed between lstat and open (race)', () => {
    const target = path.join(root, 'raced.txt')
    fs.writeFileSync(target, 'content')

    const result = readRegularFileCappedSync(target, 1024, {
      onAfterLstat: () => {
        fs.unlinkSync(target)
      },
    })
    expect(result).toBeNull()
  })

  it('returns null when fstat fails on the freshly opened handle', () => {
    const target = path.join(root, 'fstat-fail.txt')
    fs.writeFileSync(target, 'content')

    const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const result = readRegularFileCappedSync(target, 1024)
    fstatSpy.mockRestore()
    expect(result).toBeNull()
  })
})

describe('readRegularFileCapped (async)', () => {
  it('reads an ordinary regular file up to the cap', async () => {
    const target = path.join(root, 'file.txt')
    fs.writeFileSync(target, 'hello async')

    const result = await readRegularFileCapped(target, 1024)
    expect(result?.buf.toString('utf-8')).toBe('hello async')
    expect(result?.size).toBe(Buffer.byteLength('hello async'))
  })

  it('caps the read and reads from an offset', async () => {
    const target = path.join(root, 'big.txt')
    fs.writeFileSync(target, '0123456789'.repeat(50))

    const result = await readRegularFileCapped(target, 10, { offset: 5 })
    expect(result?.buf.length).toBe(10)
    expect(result?.buf.toString('utf-8')).toBe('5678901234')
  })

  it.skipIf(process.platform === 'win32')('refuses a symlink (never followed)', async () => {
    const realFile = path.join(tmpDir, 'real-async.txt')
    fs.writeFileSync(realFile, 'secret')
    const link = path.join(root, 'link-async.txt')
    try {
      fs.symlinkSync(realFile, link)
    } catch {
      return
    }
    const result = await readRegularFileCapped(link, 1024)
    expect(result).toBeNull()
  })

  it('refuses a directory', async () => {
    const dir = path.join(root, 'subdir-async')
    fs.mkdirSync(dir)
    const result = await readRegularFileCapped(dir, 1024)
    expect(result).toBeNull()
  })

  it('returns null for a nonexistent file', async () => {
    const result = await readRegularFileCapped(path.join(root, 'nope-async.txt'), 1024)
    expect(result).toBeNull()
  })

  describe('with root (SEC-L4 containment)', () => {
    it('reads a file that resolves inside root', async () => {
      const target = path.join(root, 'inside-async.txt')
      fs.writeFileSync(target, 'inside content')

      const result = await readRegularFileCapped(target, 1024, { root })
      expect(result?.buf.toString('utf-8')).toBe('inside content')
    })

    it.skipIf(process.platform === 'win32')(
      'refuses a file reached through a symlinked parent directory outside root',
      async () => {
        const outsideDir = path.join(tmpDir, 'outside-dir-async')
        fs.mkdirSync(outsideDir)
        fs.writeFileSync(path.join(outsideDir, 'file.txt'), 'exfiltrate me')

        const symlinkedSubdir = path.join(root, 'sub-async')
        try {
          fs.symlinkSync(outsideDir, symlinkedSubdir)
        } catch {
          return
        }
        const target = path.join(symlinkedSubdir, 'file.txt')

        const result = await readRegularFileCapped(target, 1024, { root })
        expect(result).toBeNull()
      },
    )

    it.skipIf(process.platform === 'win32')(
      'a symlink repointed outside root AFTER the containment check does not redirect the read (Fix 1.11 Finding 1)',
      async () => {
        const insideTarget = path.join(root, 'inside-target-async')
        fs.mkdirSync(insideTarget)
        fs.writeFileSync(path.join(insideTarget, 'file.txt'), 'legitimate content')

        const outsideTarget = path.join(tmpDir, 'outside-target-async')
        fs.mkdirSync(outsideTarget)
        fs.writeFileSync(path.join(outsideTarget, 'file.txt'), 'evil content')

        const link = path.join(root, 'link-async')
        try {
          fs.symlinkSync(insideTarget, link)
        } catch {
          return
        }

        const result = await readRegularFileCapped(path.join(link, 'file.txt'), 1024, {
          root,
          onAfterLstat: () => {
            fs.unlinkSync(link)
            fs.symlinkSync(outsideTarget, link)
          },
        })

        expect(result?.buf.toString('utf-8')).toBe('legitimate content')
      },
    )

    it.skipIf(process.platform === 'win32')(
      'detects a dev/ino swap to a different regular file between open and the recheck (injected hook)',
      async () => {
        const target = path.join(root, 'swap-target-async.txt')
        const other = path.join(root, 'other-async.txt')
        fs.writeFileSync(target, 'original')
        fs.writeFileSync(other, 'attacker-controlled')

        const result = await readRegularFileCapped(target, 1024, {
          root,
          onAfterOpen: () => {
            fs.renameSync(other, target)
          },
        })
        expect(result).toBeNull()
      },
    )

    it.skipIf(process.platform === 'win32')(
      'refuses when the target is removed between open and the recheck (recheck lstat fails)',
      async () => {
        const target = path.join(root, 'vanish-async.txt')
        fs.writeFileSync(target, 'content')

        const result = await readRegularFileCapped(target, 1024, {
          root,
          onAfterOpen: () => {
            fs.unlinkSync(target)
          },
        })
        expect(result).toBeNull()
      },
    )
  })

  describe('defensive range guard (Fix 1.11 Finding 3)', () => {
    it('returns null for a negative offset', async () => {
      const target = path.join(root, 'file.txt')
      fs.writeFileSync(target, 'content')
      expect(await readRegularFileCapped(target, 1024, { offset: -1 })).toBeNull()
    })

    it('returns null for a zero cap', async () => {
      const target = path.join(root, 'file.txt')
      fs.writeFileSync(target, 'content')
      expect(await readRegularFileCapped(target, 0)).toBeNull()
    })

    it('returns null for a negative cap', async () => {
      const target = path.join(root, 'file.txt')
      fs.writeFileSync(target, 'content')
      expect(await readRegularFileCapped(target, -5)).toBeNull()
    })
  })

  it.skipIf(process.platform === 'win32')('returns null when the file is removed between lstat and open (race)', async () => {
    const target = path.join(root, 'raced-async.txt')
    fs.writeFileSync(target, 'content')

    const result = await readRegularFileCapped(target, 1024, {
      onAfterLstat: () => {
        fs.unlinkSync(target)
      },
    })
    expect(result).toBeNull()
  })

  it('returns null when the opened handle fails to stat', async () => {
    const target = path.join(root, 'fstat-fail-async.txt')
    fs.writeFileSync(target, 'content')

    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async () =>
      ({
        stat: async () => { throw new Error('boom') },
        close: async () => {},
      }) as unknown as fs.promises.FileHandle,
    )
    const result = await readRegularFileCapped(target, 1024)
    openSpy.mockRestore()
    expect(result).toBeNull()
  })
})
