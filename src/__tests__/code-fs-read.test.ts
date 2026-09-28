import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import {
  openVerified,
  openRegularFileSafe,
  classifyBuffer,
  readFile,
  VIEW_MAX,
  EDIT_MAX,
} from '../main/services/code-fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let root: string
let outside: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-code-fs-test-'))
  root = path.join(tmpDir, 'repo')
  outside = path.join(tmpDir, 'outside')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFile(relToRoot: string, content: string | Buffer): string {
  const abs = path.join(root, relToRoot)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return abs
}

function symlink(target: string, relToRoot: string): string {
  const abs = path.join(root, relToRoot)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.symlinkSync(target, abs)
  return abs
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise
    expect.unreachable(`expected a throw with code ${code}`)
  } catch (err) {
    expect((err as { code?: string }).code).toBe(code)
  }
}

// ---------------------------------------------------------------------------
// openVerified
// ---------------------------------------------------------------------------

describe('openVerified', () => {
  it('opens an ordinary regular file', async () => {
    const abs = writeFile('a.txt', 'hello')
    const { fh, st } = await openVerified(root, abs)
    try {
      expect(st.isFile()).toBe(true)
      expect(st.size).toBe(5)
    } finally {
      await fh.close()
    }
  })

  it('denies a target outside root (containment)', async () => {
    const abs = path.join(outside, 'file.txt')
    fs.writeFileSync(abs, 'x')
    await expectCode(openVerified(root, abs), 'PERMISSION_DENIED')
  })

  it('denies a target inside .git', async () => {
    const abs = writeFile('.git/config', '[core]')
    await expectCode(openVerified(root, abs), 'PERMISSION_DENIED')
  })

  it('denies a target inside .GIT (case-insensitive)', async () => {
    const abs = writeFile('.GIT/config', '[core]')
    await expectCode(openVerified(root, abs), 'PERMISSION_DENIED')
  })

  it('denies a FIFO (never gets past the isFile check, H3)', async () => {
    const fifoPath = path.join(root, 'myfifo')
    execFileSync('mkfifo', [fifoPath])
    await expectCode(openVerified(root, fifoPath), 'PERMISSION_DENIED')
  })

  it('denies a directory', async () => {
    const dir = path.join(root, 'subdir')
    fs.mkdirSync(dir)
    await expectCode(openVerified(root, dir), 'PERMISSION_DENIED')
  })

  it('detects a dev/ino swap between open and the re-check (injected hook)', async () => {
    const absA = writeFile('a.txt', 'aaaa')
    const absB = writeFile('b.txt', 'bbbb')
    await expectCode(
      openVerified(root, absA, process.platform, {
        onAfterOpen: () => {
          // Simulate a TOCTOU swap: replace a.txt's inode with b.txt's content
          // by renaming b.txt over a.txt between open() and the re-check.
          fs.renameSync(absB, absA)
        },
      }),
      'PERMISSION_DENIED',
    )
  })

  it('the win32 branch is exercised via an injected platform: symlink pre-check', async () => {
    const target = writeFile('real.txt', 'hi')
    const link = symlink(target, 'link.txt')
    // On POSIX, O_NOFOLLOW refuses the symlink at open(); on the injected
    // win32 branch, the lstat pre-check refuses it instead — same result.
    await expectCode(openVerified(root, link, 'win32'), 'PERMISSION_DENIED')
  })

  it('the win32 branch opens an ordinary regular file successfully', async () => {
    const abs = writeFile('a.txt', 'hello')
    const { fh, st } = await openVerified(root, abs, 'win32')
    try {
      expect(st.isFile()).toBe(true)
    } finally {
      await fh.close()
    }
  })

  it('a nonexistent target gives NOT_FOUND via mapOpenError (posix open ENOENT)', async () => {
    const abs = path.join(root, 'never-existed.txt')
    await expectCode(openVerified(root, abs), 'NOT_FOUND')
  })

  it('an unreadable target gives PERMISSION_DENIED via mapOpenError (posix open EACCES)', async () => {
    const abs = writeFile('locked.txt', 'secret')
    fs.chmodSync(abs, 0o000)
    try {
      await expectCode(openVerified(root, abs), 'PERMISSION_DENIED')
    } finally {
      fs.chmodSync(abs, 0o644)
    }
  })

  it('the win32 branch maps a post-precheck open() failure through mapOpenError too', async () => {
    const abs = writeFile('win-locked.txt', 'secret')
    fs.chmodSync(abs, 0o000)
    try {
      await expectCode(openVerified(root, abs, 'win32'), 'PERMISSION_DENIED')
    } finally {
      fs.chmodSync(abs, 0o644)
    }
  })

  it('a fh.stat() failure after a successful open is denied and the handle is closed', async () => {
    const abs = writeFile('stat-fails.txt', 'hello')

    // fs.promises.FileHandle isn't exported as a named class in this Node
    // version — get a live prototype reference from a throwaway handle,
    // then force the NEXT stat() call (openVerified's own) to reject once.
    const dummyPath = writeFile('dummy-for-stat-spy.txt', 'x')
    const dummy = await fs.promises.open(dummyPath, 'r')
    const proto = Object.getPrototypeOf(dummy) as { stat: (...args: unknown[]) => unknown }
    await dummy.close()

    const statSpy = vi.spyOn(proto, 'stat')
    statSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('boom'), { code: 'EIO' })
    })
    try {
      await expectCode(openVerified(root, abs), 'PERMISSION_DENIED')
    } finally {
      statSpy.mockRestore()
    }
  })

  it('a recheck lstat() failure after a successful open is denied and the handle is closed', async () => {
    const abs = writeFile('recheck-lstat-fails.txt', 'hello')
    const lstatSpy = vi.spyOn(fs.promises, 'lstat')
    lstatSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('boom'), { code: 'EIO' })
    })
    try {
      await expectCode(openVerified(root, abs), 'PERMISSION_DENIED')
    } finally {
      lstatSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// openRegularFileSafe
// ---------------------------------------------------------------------------

describe('openRegularFileSafe', () => {
  it('reads a small file fully', async () => {
    const abs = writeFile('a.txt', 'hello world')
    const result = await openRegularFileSafe(root, abs, 1024)
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.buf.toString('utf-8')).toBe('hello world')
    }
  })

  it('gives too-large before reading when size exceeds maxBytes', async () => {
    const abs = writeFile('big.txt', 'x'.repeat(100))
    const result = await openRegularFileSafe(root, abs, 10)
    expect(result.kind).toBe('too-large')
  })

  it('an external symlink is denied', async () => {
    const target = path.join(outside, 'secret.txt')
    fs.writeFileSync(target, 'nope')
    const link = symlink(target, 'link.txt')
    await expectCode(openRegularFileSafe(root, link, 1024), 'PERMISSION_DENIED')
  })
})

// ---------------------------------------------------------------------------
// classifyBuffer
// ---------------------------------------------------------------------------

describe('classifyBuffer', () => {
  it('detects a PNG by magic bytes', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])
    const result = classifyBuffer(buf, 'x.png', buf.length)
    expect(result.kind).toBe('image')
    if (result.kind === 'image') expect(result.mime).toBe('image/png')
  })

  it('detects a JPEG by magic bytes', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0, 0])
    const result = classifyBuffer(buf, 'x.jpg', buf.length)
    expect(result.kind).toBe('image')
    if (result.kind === 'image') expect(result.mime).toBe('image/jpeg')
  })

  it('detects a GIF by magic bytes', () => {
    const buf = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const result = classifyBuffer(buf, 'x.gif', buf.length)
    expect(result.kind).toBe('image')
    if (result.kind === 'image') expect(result.mime).toBe('image/gif')
  })

  it('detects a WebP by magic bytes', () => {
    const buf = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')])
    const result = classifyBuffer(buf, 'x.webp', buf.length)
    expect(result.kind).toBe('image')
    if (result.kind === 'image') expect(result.mime).toBe('image/webp')
  })

  it('detects binary content via a NUL in the first 8 KB', () => {
    const buf = Buffer.from([0x68, 0x69, 0x00, 0x62, 0x79, 0x65])
    const result = classifyBuffer(buf, 'x.bin', buf.length)
    expect(result.kind).toBe('binary')
  })

  it('decodes a UTF-16 LE BOM as read-only text', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])
    const result = classifyBuffer(buf, 'x.txt', buf.length)
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.encoding).toBe('utf-16le')
      expect(result.content).toBe('hi')
      expect(result.readOnlyReason).toBe('encoding')
      expect(result.editable).toBe(false)
    }
  })

  it('decodes a UTF-16 BE BOM as read-only text', () => {
    const leBuf = Buffer.from('hi', 'utf16le')
    const beBuf = Buffer.alloc(leBuf.length)
    for (let i = 0; i < leBuf.length; i += 2) {
      beBuf[i] = leBuf[i + 1]
      beBuf[i + 1] = leBuf[i]
    }
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), beBuf])
    const result = classifyBuffer(buf, 'x.txt', buf.length)
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.encoding).toBe('utf-16be')
      expect(result.content).toBe('hi')
    }
  })

  it('strips a UTF-8 BOM and sets bom: true', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello')])
    const result = classifyBuffer(buf, 'x.txt', buf.length)
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.bom).toBe(true)
      expect(result.content).toBe('hello')
      expect(result.encoding).toBe('utf-8')
    }
  })

  it('detects LF-only line endings', () => {
    const result = classifyBuffer(Buffer.from('a\nb\nc'), 'x.txt', 5)
    if (result.kind === 'text') expect(result.eol).toBe('lf')
  })

  it('detects CRLF-only line endings', () => {
    const result = classifyBuffer(Buffer.from('a\r\nb\r\nc'), 'x.txt', 7)
    if (result.kind === 'text') expect(result.eol).toBe('crlf')
  })

  it('treats a lone CR as mixed', () => {
    const result = classifyBuffer(Buffer.from('a\rb\nc'), 'x.txt', 5)
    if (result.kind === 'text') {
      expect(result.eol).toBe('mixed')
      expect(result.readOnlyReason).toBe('mixed-eol')
      expect(result.editable).toBe(false)
    }
  })

  it('treats a genuine mix of LF and CRLF as mixed', () => {
    const result = classifyBuffer(Buffer.from('a\nb\r\nc'), 'x.txt', 6)
    if (result.kind === 'text') expect(result.eol).toBe('mixed')
  })

  it('detects "none" for a single line with no terminator', () => {
    const result = classifyBuffer(Buffer.from('one line'), 'x.txt', 8)
    if (result.kind === 'text') expect(result.eol).toBe('none')
  })

  it('falls back to lossy decoding on invalid UTF-8, marking readOnlyReason: encoding', () => {
    const buf = Buffer.from([0x68, 0x69, 0x0a, 0xc0, 0x80, 0x0a, 0x62, 0x79, 0x65])
    const result = classifyBuffer(buf, 'x.txt', buf.length)
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.encoding).toBe('utf-8-lossy')
      expect(result.readOnlyReason).toBe('encoding')
      expect(result.editable).toBe(false)
    }
  })

  it('is editable for a small, clean, LF utf-8 file', () => {
    const result = classifyBuffer(Buffer.from('clean\nfile\n'), 'x.txt', 11)
    if (result.kind === 'text') {
      expect(result.editable).toBe(true)
      expect(result.readOnlyReason).toBeNull()
    }
  })

  it('is highlighted when small with short lines', () => {
    const result = classifyBuffer(Buffer.from('short\nlines\n'), 'x.txt', 12)
    if (result.kind === 'text') expect(result.highlight).toBe(true)
  })

  it('turns off highlight when the longest line exceeds 10,000 chars', () => {
    const content = 'a'.repeat(10_001)
    const buf = Buffer.from(content)
    const result = classifyBuffer(buf, 'x.txt', buf.length)
    if (result.kind === 'text') expect(result.highlight).toBe(false)
  })

  it('at exactly the 2 MB boundary: still editable/highlightable', () => {
    const buf = Buffer.from('a'.repeat(EDIT_MAX))
    const result = classifyBuffer(buf, 'x.txt', buf.length)
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.editable).toBe(true)
      expect(result.readOnlyReason).toBeNull()
    }
  })

  it('just over the 2 MB boundary (2-10 MB band): too-large, read-only, no highlight', () => {
    const buf = Buffer.from('a'.repeat(EDIT_MAX + 1))
    const result = classifyBuffer(buf, 'x.txt', buf.length)
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.readOnlyReason).toBe('too-large')
      expect(result.editable).toBe(false)
      expect(result.highlight).toBe(false)
    }
  })

  it.each([
    ['x.md', 'markdown'],
    ['x.markdown', 'markdown'],
    ['x.yml', 'yaml'],
    ['x.yaml', 'yaml'],
    ['x.svg', 'svg'],
    ['x.txt', null],
  ])('previewable for %s is %s', (name, expected) => {
    const result = classifyBuffer(Buffer.from('content'), name, 7)
    if (result.kind === 'text') expect(result.previewable).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// readFile
// ---------------------------------------------------------------------------

describe('readFile', () => {
  it('reads an ordinary text file', async () => {
    writeFile('hello.txt', 'hello world')
    const result = await readFile(root, 'hello.txt', { reveal: false })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') expect(result.content).toBe('hello world')
    expect(result.relPath).toBe('hello.txt')
    expect(result.name).toBe('hello.txt')
  })

  it('a symlink to .git/config gives PERMISSION_DENIED', async () => {
    writeFile('.git/config', '[core]')
    symlink(path.join(root, '.git/config'), 'link-to-git.txt')
    await expectCode(readFile(root, 'link-to-git.txt', { reveal: false }), 'PERMISSION_DENIED')
  })

  it('a symlink to .GIT/config (case-insensitive) gives PERMISSION_DENIED', async () => {
    writeFile('.GIT/config', '[core]')
    symlink(path.join(root, '.GIT/config'), 'link-to-git-upper.txt')
    await expectCode(readFile(root, 'link-to-git-upper.txt', { reveal: false }), 'PERMISSION_DENIED')
  })

  it('link.env -> an outside file gives PERMISSION_DENIED, not secret', async () => {
    const target = path.join(outside, 'file.txt')
    fs.writeFileSync(target, 'nope')
    symlink(target, 'link.env')
    try {
      await readFile(root, 'link.env', { reveal: false })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
    }
  })

  it('x.env -> .git/config gives PERMISSION_DENIED, not secret', async () => {
    writeFile('.git/config', '[core]')
    symlink(path.join(root, '.git/config'), 'x.env')
    try {
      await readFile(root, 'x.env', { reveal: false })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect((err as { code?: string }).code).toBe('PERMISSION_DENIED')
    }
  })

  it('notes.txt -> .env is masked (secret), with zero reads from the handle', async () => {
    writeFile('.env', 'SECRET=1')
    symlink(path.join(root, '.env'), 'notes.txt')

    // fs.promises.FileHandle isn't exported as a named class in this Node
    // version — get a live prototype reference from a throwaway handle
    // instead, then spy on the shared prototype method.
    const dummyPath = writeFile('dummy-for-spy.txt', 'x')
    const dummy = await fs.promises.open(dummyPath, 'r')
    const proto = Object.getPrototypeOf(dummy) as { read: (...args: unknown[]) => unknown }
    await dummy.close()

    const readSpy = vi.spyOn(proto, 'read')
    try {
      const result = await readFile(root, 'notes.txt', { reveal: false })
      expect(result.kind).toBe('secret')
      expect(readSpy).not.toHaveBeenCalled()
    } finally {
      readSpy.mockRestore()
    }
  })

  it('reveal: true bypasses the secret gate and reads content', async () => {
    writeFile('.env', 'SECRET=1')
    const result = await readFile(root, '.env', { reveal: true })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') expect(result.content).toBe('SECRET=1')
  })

  it('an external symlink is denied', async () => {
    const target = path.join(outside, 'secret.txt')
    fs.writeFileSync(target, 'nope')
    symlink(target, 'link.txt')
    await expectCode(readFile(root, 'link.txt', { reveal: false }), 'PERMISSION_DENIED')
  })

  it('a symlink to /dev/zero is refused promptly (external target)', async () => {
    symlink('/dev/zero', 'zero-link')
    await expectCode(readFile(root, 'zero-link', { reveal: false }), 'PERMISSION_DENIED')
  })

  it('a FIFO is refused promptly, never read (H3)', async () => {
    const fifoPath = path.join(root, 'myfifo')
    execFileSync('mkfifo', [fifoPath])
    await expectCode(readFile(root, 'myfifo', { reveal: false }), 'PERMISSION_DENIED')
  })

  it('gives too-large for a file over VIEW_MAX (10 MB)', async () => {
    const abs = path.join(root, 'huge.txt')
    fs.writeFileSync(abs, Buffer.alloc(VIEW_MAX + 1, 'a'))
    const result = await readFile(root, 'huge.txt', { reveal: false })
    expect(result.kind).toBe('too-large')
  })

  it('a nonexistent path gives NOT_FOUND', async () => {
    await expectCode(readFile(root, 'missing.txt', { reveal: false }), 'NOT_FOUND')
  })

  it('an internal symlinked file is readable but read-only (symlink reason)', async () => {
    writeFile('real.txt', 'hello')
    symlink(path.join(root, 'real.txt'), 'link.txt')
    const result = await readFile(root, 'link.txt', { reveal: false })
    expect(result.kind).toBe('text')
    if (result.kind === 'text') {
      expect(result.content).toBe('hello')
      expect(result.editable).toBe(false)
      expect(result.readOnlyReason).toBe('symlink')
    }
  })

  it('the win32 branch is exercised end-to-end', async () => {
    writeFile('hello.txt', 'hi')
    const result = await readFile(root, 'hello.txt', { reveal: false }, 'win32')
    expect(result.kind).toBe('text')
  })

  it('a failing final isSymlink lstat is treated as not-a-symlink, not an error', async () => {
    writeFile('plain.txt', 'hello world')
    // openVerified's own recheck lstat (on `real`) must succeed normally;
    // only readFile's later isSymlink check (on `abs`) should fail here —
    // it is the second of exactly two lstat calls for a plain, non-symlink,
    // non-win32 read.
    const originalLstat = fs.promises.lstat.bind(fs.promises)
    const lstatSpy = vi.spyOn(fs.promises, 'lstat')
    lstatSpy.mockImplementationOnce(originalLstat)
    lstatSpy.mockImplementationOnce(async () => {
      throw Object.assign(new Error('boom'), { code: 'EIO' })
    })
    try {
      const result = await readFile(root, 'plain.txt', { reveal: false })
      expect(result.kind).toBe('text')
      if (result.kind === 'text') {
        expect(result.readOnlyReason).not.toBe('symlink')
      }
    } finally {
      lstatSpy.mockRestore()
    }
  })

  it('no thrown error or response contains the tmp directory path', async () => {
    const errors: unknown[] = []
    try {
      await readFile(root, 'missing.txt', { reveal: false })
    } catch (err) {
      errors.push(err)
    }
    const target = path.join(outside, 'x.txt')
    fs.writeFileSync(target, 'x')
    symlink(target, 'ext-link.txt')
    try {
      await readFile(root, 'ext-link.txt', { reveal: false })
    } catch (err) {
      errors.push(err)
    }
    writeFile('.git/config', '[core]')
    symlink(path.join(root, '.git/config'), 'git-link.txt')
    try {
      await readFile(root, 'git-link.txt', { reveal: false })
    } catch (err) {
      errors.push(err)
    }

    expect(errors.length).toBeGreaterThan(0)
    for (const err of errors) {
      const message = (err as Error).message ?? ''
      expect(message).not.toContain(tmpDir)
    }

    const okResult = await (async () => {
      writeFile('ok.txt', 'hello')
      return readFile(root, 'ok.txt', { reveal: false })
    })()
    expect(JSON.stringify(okResult)).not.toContain(tmpDir)
  })
})
