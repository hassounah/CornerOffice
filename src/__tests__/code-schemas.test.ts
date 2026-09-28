import { describe, it, expect } from 'vitest'
import {
  relPathError,
  RelPathSchema,
  RelDirSchema,
  CodeGetStatusSchema,
  CodeListDirSchema,
  CodeReadFileSchema,
  CodeReadBaselineSchema,
  CodeWriteFileSchema,
  CodeGetFileIndexSchema,
  CodeWatchSchema,
  CodeUnwatchSchema,
} from '../main/ipc/schemas'
import { CODE_CHANNELS, PUSH_CHANNELS, WINDOW_CHANNELS } from '../main/ipc/channels'

// ---------------------------------------------------------------------------
// relPathError / RelPathSchema / RelDirSchema — §3.3.1, §7.1 accept/reject matrix
// ---------------------------------------------------------------------------

describe('relPathError — accepted paths', () => {
  it.each(['index.ts', 'src/index.ts', 'a/b/c.txt', 'README.md', 'a.b.c'])(
    '%s is a valid relative path',
    (rel) => {
      expect(relPathError(rel)).toBeNull()
    }
  )

  it("'' is accepted only with allowEmpty (listDir.relDir)", () => {
    expect(relPathError('', { allowEmpty: true })).toBeNull()
  })
})

describe('relPathError — rejected paths (§7.1 matrix)', () => {
  it("'' is rejected without allowEmpty", () => {
    expect(relPathError('')).not.toBeNull()
  })

  it("'..' is rejected", () => {
    expect(relPathError('..')).not.toBeNull()
  })

  it("a bare '.' segment is rejected", () => {
    expect(relPathError('.')).not.toBeNull()
  })

  it("'./' is rejected", () => {
    expect(relPathError('./')).not.toBeNull()
  })

  it("a nested '..' segment is rejected", () => {
    expect(relPathError('a/../b')).not.toBeNull()
  })

  it("'//' is rejected", () => {
    expect(relPathError('//')).not.toBeNull()
  })

  it('a leading / is rejected', () => {
    expect(relPathError('/etc/passwd')).not.toBeNull()
  })

  it('a backslash is rejected', () => {
    expect(relPathError('a\\b')).not.toBeNull()
  })

  it('a NUL byte is rejected', () => {
    expect(relPathError('a\u0000b')).not.toBeNull()
  })

  it.each(['.git', '.GIT', '.Git'])('%s at the top level is rejected', (rel) => {
    expect(relPathError(rel)).not.toBeNull()
  })

  it.each(['a/.git', 'a/b/.GIT/config', '.git/hooks/post-index-change'])(
    '%s (.git at depth) is rejected',
    (rel) => {
      expect(relPathError(rel)).not.toBeNull()
    }
  )

  it("a zero-width space inside '.git' (.g\\u200Bit) is rejected", () => {
    // Built from a code point, never a literal, so this file cannot itself
    // smuggle the very character it is testing for.
    const zeroWidthSpace = String.fromCharCode(0x200b)
    expect(relPathError(`.g${zeroWidthSpace}it`)).not.toBeNull()
  })

  it('a RTL override before .git (\\u202E.git) is rejected', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    expect(relPathError(`${rtlOverride}.git`)).not.toBeNull()
  })

  it.each(['.git.', '.git ', 'GIT~1'])('win32 alias %s is rejected on win32', (rel) => {
    expect(relPathError(rel, { platform: 'win32' })).not.toBeNull()
  })

  it.each(['.git.', '.git ', 'GIT~1'])('win32 alias %s is NOT rejected as a .git alias on posix (platform matters)', (rel) => {
    // These aliases only fold to '.git' under win32 NTFS rules — on POSIX they are
    // ordinary (if unusual) file names and must not be treated as .git.
    expect(relPathError(rel, { platform: 'linux' })).toBeNull()
  })

  it("':' in a segment is rejected on win32", () => {
    expect(relPathError('a:b.txt', { platform: 'win32' })).not.toBeNull()
  })

  it("':' is NOT rejected on posix", () => {
    expect(relPathError('a:b.txt', { platform: 'linux' })).toBeNull()
  })

  it.each(['CON', 'con.txt', 'NUL', 'COM1', 'LPT1', 'lpt1.log'])(
    'reserved device name %s is rejected on win32',
    (rel) => {
      expect(relPathError(rel, { platform: 'win32' })).not.toBeNull()
    }
  )

  it('a reserved device name is NOT rejected on posix', () => {
    expect(relPathError('CON', { platform: 'linux' })).toBeNull()
  })

  // Fix #132: a trailing-space-disguised '.' / '..' segment. Windows path
  // resolution strips the trailing space, revealing a real navigation
  // token underneath — a naive exact-match check on the raw segment misses
  // this. (Stripping trailing dots+spaces together, as the reserved-name
  // check above does, does NOT work here: a dot-only string like '.. ' is
  // consumed in full by that broader strip, leaving '' — never '.' or '..'.)
  it.each(['. ', '.. ', '.  ', '..  '])('a disguised dot segment %j is rejected on win32', (rel) => {
    expect(relPathError(rel, { platform: 'win32' })).not.toBeNull()
  })

  it.each(['. ', '.. '])('a disguised dot segment %j is NOT rejected on posix (platform matters)', (rel) => {
    // On POSIX, trailing spaces are ordinary, significant filename
    // characters — '. ' and '.. ' name real, if unusual, files distinct
    // from '.' and '..', and the OS never strips them.
    expect(relPathError(rel, { platform: 'linux' })).toBeNull()
  })

  it("'...' (three dots, no trailing space) is NOT rejected as a disguised dot segment", () => {
    // Over-blocking guard: '...'.replace(/[. ]+$/, '') is '' too, but '...'
    // is a legal (if unusual) POSIX filename and must not be treated as
    // unsafe just because it's made entirely of dots.
    expect(relPathError('...', { platform: 'win32' })).toBeNull()
    expect(relPathError('...')).toBeNull()
  })

  it('4097 characters is rejected (max 4096)', () => {
    expect(relPathError('a'.repeat(4097))).not.toBeNull()
  })

  it('4096 characters is accepted', () => {
    expect(relPathError('a'.repeat(4096))).toBeNull()
  })
})

describe('RelPathSchema', () => {
  it('rejects empty string (listDir-only exception does not apply)', () => {
    expect(RelPathSchema.safeParse('').success).toBe(false)
  })

  it('accepts an ordinary relative path', () => {
    expect(RelPathSchema.safeParse('src/index.ts').success).toBe(true)
  })

  it('rejects .git at any depth', () => {
    expect(RelPathSchema.safeParse('a/b/.git').success).toBe(false)
  })
})

describe('RelDirSchema', () => {
  it("accepts '' (listDir root)", () => {
    expect(RelDirSchema.safeParse('').success).toBe(true)
  })

  it('accepts an ordinary relative directory', () => {
    expect(RelDirSchema.safeParse('src/components').success).toBe(true)
  })

  it('still rejects .git', () => {
    expect(RelDirSchema.safeParse('.git').success).toBe(false)
  })

  it('still rejects a leading /', () => {
    expect(RelDirSchema.safeParse('/etc').success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The 8 code:* input schemas
// ---------------------------------------------------------------------------

describe('CodeGetStatusSchema', () => {
  it('accepts a valid input', () => {
    expect(CodeGetStatusSchema.safeParse({ workspaceSlug: 'ws', baseline: 'head' }).success).toBe(true)
  })
  it('rejects an invalid baseline', () => {
    expect(CodeGetStatusSchema.safeParse({ workspaceSlug: 'ws', baseline: 'main' }).success).toBe(false)
  })
})

describe('CodeListDirSchema', () => {
  it('accepts the repo root (relDir: "")', () => {
    expect(
      CodeListDirSchema.safeParse({ workspaceSlug: 'ws', relDir: '', includeIgnored: false }).success
    ).toBe(true)
  })
  it('rejects a .git relDir', () => {
    expect(
      CodeListDirSchema.safeParse({ workspaceSlug: 'ws', relDir: '.git', includeIgnored: false }).success
    ).toBe(false)
  })
})

describe('CodeReadFileSchema', () => {
  it('accepts a valid input', () => {
    expect(
      CodeReadFileSchema.safeParse({ workspaceSlug: 'ws', relPath: 'src/index.ts', reveal: false }).success
    ).toBe(true)
  })
  it('rejects an empty relPath', () => {
    expect(CodeReadFileSchema.safeParse({ workspaceSlug: 'ws', relPath: '', reveal: false }).success).toBe(false)
  })
})

describe('CodeReadBaselineSchema', () => {
  it('accepts a valid input without oldPath', () => {
    expect(
      CodeReadBaselineSchema.safeParse({
        workspaceSlug: 'ws',
        relPath: 'src/index.ts',
        baseline: 'branch',
        reveal: false,
      }).success
    ).toBe(true)
  })
  it('accepts a valid oldPath (renamed file)', () => {
    expect(
      CodeReadBaselineSchema.safeParse({
        workspaceSlug: 'ws',
        relPath: 'src/new.ts',
        oldPath: 'src/old.ts',
        baseline: 'head',
        reveal: true,
      }).success
    ).toBe(true)
  })
  it('rejects a .git oldPath', () => {
    expect(
      CodeReadBaselineSchema.safeParse({
        workspaceSlug: 'ws',
        relPath: 'src/index.ts',
        oldPath: '.git/config',
        baseline: 'head',
        reveal: false,
      }).success
    ).toBe(false)
  })
})

describe('CodeWriteFileSchema', () => {
  it('accepts a valid input', () => {
    expect(
      CodeWriteFileSchema.safeParse({
        workspaceSlug: 'ws',
        relPath: 'src/index.ts',
        content: 'hello',
        expectedMtime: new Date().toISOString(),
      }).success
    ).toBe(true)
  })
  it('accepts content at exactly the 2 MiB boundary', () => {
    expect(
      CodeWriteFileSchema.safeParse({
        workspaceSlug: 'ws',
        relPath: 'src/index.ts',
        content: 'a'.repeat(2 * 1024 * 1024),
        expectedMtime: new Date().toISOString(),
      }).success
    ).toBe(true)
  })
  it('rejects content over 2 MiB', () => {
    expect(
      CodeWriteFileSchema.safeParse({
        workspaceSlug: 'ws',
        relPath: 'src/index.ts',
        content: 'a'.repeat(2 * 1024 * 1024 + 1),
        expectedMtime: new Date().toISOString(),
      }).success
    ).toBe(false)
  })
  it('rejects an empty expectedMtime', () => {
    expect(
      CodeWriteFileSchema.safeParse({
        workspaceSlug: 'ws',
        relPath: 'src/index.ts',
        content: 'hello',
        expectedMtime: '',
      }).success
    ).toBe(false)
  })
})

describe('CodeGetFileIndexSchema', () => {
  it('accepts a valid input', () => {
    expect(CodeGetFileIndexSchema.safeParse({ workspaceSlug: 'ws', includeIgnored: true }).success).toBe(true)
  })
})

describe('CodeWatchSchema', () => {
  it('accepts a valid input', () => {
    expect(
      CodeWatchSchema.safeParse({
        workspaceSlug: 'ws',
        gen: 0,
        openFile: 'src/index.ts',
        expandedDirs: ['src', 'src/components'],
      }).success
    ).toBe(true)
  })
  it('accepts a null openFile', () => {
    expect(
      CodeWatchSchema.safeParse({ workspaceSlug: 'ws', gen: 1, openFile: null, expandedDirs: [] }).success
    ).toBe(true)
  })
  it('rejects a negative gen', () => {
    expect(
      CodeWatchSchema.safeParse({ workspaceSlug: 'ws', gen: -1, openFile: null, expandedDirs: [] }).success
    ).toBe(false)
  })
  it('rejects more than 512 expandedDirs', () => {
    expect(
      CodeWatchSchema.safeParse({
        workspaceSlug: 'ws',
        gen: 0,
        openFile: null,
        expandedDirs: Array.from({ length: 513 }, (_, i) => `d${i}`),
      }).success
    ).toBe(false)
  })
})

describe('CodeUnwatchSchema', () => {
  it('accepts a valid input', () => {
    expect(CodeUnwatchSchema.safeParse({ workspaceSlug: 'ws', gen: 3 }).success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CODE_CHANNELS / PUSH_CHANNELS / WINDOW_CHANNELS wiring
// ---------------------------------------------------------------------------

describe('CODE_CHANNELS', () => {
  it('has the 8 request channels plus CHANGED', () => {
    expect(CODE_CHANNELS.GET_STATUS).toBe('code:getStatus')
    expect(CODE_CHANNELS.LIST_DIR).toBe('code:listDir')
    expect(CODE_CHANNELS.READ_FILE).toBe('code:readFile')
    expect(CODE_CHANNELS.READ_BASELINE).toBe('code:readBaseline')
    expect(CODE_CHANNELS.WRITE_FILE).toBe('code:writeFile')
    expect(CODE_CHANNELS.GET_FILE_INDEX).toBe('code:getFileIndex')
    expect(CODE_CHANNELS.WATCH).toBe('code:watch')
    expect(CODE_CHANNELS.UNWATCH).toBe('code:unwatch')
    expect(CODE_CHANNELS.CHANGED).toBe('code:changed')
  })

  it('code:changed is in PUSH_CHANNELS', () => {
    expect(PUSH_CHANNELS).toContain(CODE_CHANNELS.CHANGED)
  })
})

describe('WINDOW_CHANNELS.RESUME_CLOSE', () => {
  it('is window:resumeClose', () => {
    expect(WINDOW_CHANNELS.RESUME_CLOSE).toBe('window:resumeClose')
  })
})
