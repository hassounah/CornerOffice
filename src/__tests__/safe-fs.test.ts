import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { durableWrite, MAX_FILE_SIZE, denied, openParentDir, withTimeout } from '../main/services/safe-fs'

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
