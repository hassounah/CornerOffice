import { describe, it, expect } from 'vitest'
import { isSafeRel, posixDirname, posixJoin, posixNormalize } from '../renderer/utils/code-paths'

describe('isSafeRel — accepted paths', () => {
  it.each(['index.ts', 'src/index.ts', 'a/b/c.md', 'README.md'])('%s is safe', (rel) => {
    expect(isSafeRel(rel)).toBe(true)
  })
})

describe('isSafeRel — traversal and structural rejects', () => {
  it("rejects '' ", () => {
    expect(isSafeRel('')).toBe(false)
  })
  it("rejects '..'", () => {
    expect(isSafeRel('..')).toBe(false)
  })
  it("rejects a nested '..' segment", () => {
    expect(isSafeRel('a/../b')).toBe(false)
  })
  it("rejects '.'", () => {
    expect(isSafeRel('.')).toBe(false)
  })
  it('rejects a leading /', () => {
    expect(isSafeRel('/etc/passwd')).toBe(false)
  })
  it('rejects a backslash', () => {
    expect(isSafeRel('a\\b')).toBe(false)
  })
  it('rejects a NUL byte', () => {
    expect(isSafeRel('a\u0000b')).toBe(false)
  })
  it('rejects an empty segment (//)', () => {
    expect(isSafeRel('a//b')).toBe(false)
  })
})

describe('isSafeRel — .git variants (union of platform rules, Sec L-5)', () => {
  it.each(['.git', 'a/.git', 'a/b/.GIT/config'])('%s is rejected', (rel) => {
    expect(isSafeRel(rel)).toBe(false)
  })

  it('a zero-width space inside .git (.g\\u200Bit) is rejected', () => {
    const zeroWidthSpace = String.fromCharCode(0x200b)
    expect(isSafeRel(`.g${zeroWidthSpace}it`)).toBe(false)
  })

  it.each(['.git.', '.git ', 'GIT~1'])('the win32 alias %s is rejected on every platform', (rel) => {
    expect(isSafeRel(rel)).toBe(false)
  })
})

describe('isSafeRel — scheme-like strings via colon rejection (Sec H-3)', () => {
  it.each(['file:/x', 'javascript:x', 'c:foo'])('%s is rejected', (rel) => {
    expect(isSafeRel(rel)).toBe(false)
  })
})

describe('isSafeRel — reserved device names (union of platform rules)', () => {
  it.each(['CON', 'con.txt', 'NUL', 'COM1'])('%s is rejected on every platform', (rel) => {
    expect(isSafeRel(rel)).toBe(false)
  })
})

describe('isSafeRel — disguised dot segments (Fix #132)', () => {
  // A trailing-space-disguised '.' / '..' — Windows strips the trailing
  // space, revealing a real navigation token. Stripping trailing dots+
  // spaces together (as the reserved-name check does) does NOT catch this:
  // a dot-only string like '.. ' is consumed in full by that broader strip,
  // leaving '' — never '.' or '..' (see the isSafeRel implementation
  // comment). Applied unconditionally here, matching this function's own
  // conservative union-of-platform-rules design (it never reads
  // process.platform, per §D-8).
  it.each(['. ', '.. ', '.  ', '..  '])('a disguised dot segment %j is rejected', (rel) => {
    expect(isSafeRel(rel)).toBe(false)
  })

  it.each(['a/.. /b', 'a/. /b'])('a disguised dot segment nested at depth (%s) is rejected', (rel) => {
    expect(isSafeRel(rel)).toBe(false)
  })

  it("'...' (three dots, no trailing space) is NOT rejected as a disguised dot segment", () => {
    // Over-blocking guard: '...' is a legal (if unusual) filename and must
    // not be treated as unsafe just because it's made entirely of dots.
    expect(isSafeRel('...')).toBe(true)
  })
})

describe('posixDirname (step 2.17)', () => {
  it('returns the parent directory of a nested path', () => {
    expect(posixDirname('src/main/services/git-service.ts')).toBe('src/main/services')
  })

  it("returns '' for a root-level path (no /)", () => {
    expect(posixDirname('README.md')).toBe('')
  })

  it("returns '' for a path with exactly one segment above it", () => {
    expect(posixDirname('docs/README.md')).toBe('docs')
  })
})

describe('posixJoin (step 2.17)', () => {
  it('joins non-empty parts with /', () => {
    expect(posixJoin('src', 'main', 'index.ts')).toBe('src/main/index.ts')
  })

  it('skips empty parts (root-level dirname join)', () => {
    expect(posixJoin('', 'x.md')).toBe('x.md')
  })

  it('with no parts at all returns an empty string', () => {
    expect(posixJoin()).toBe('')
  })
})

describe('posixNormalize (step 2.17)', () => {
  it('collapses a redundant .. against a real preceding segment', () => {
    expect(posixNormalize('a/b/../c')).toBe('a/c')
  })

  it('drops . segments', () => {
    expect(posixNormalize('a/./b')).toBe('a/b')
  })

  it('drops empty segments from a doubled slash', () => {
    expect(posixNormalize('a//b')).toBe('a/b')
  })

  it('leaves an escaping .. in place (nothing to collapse against) — the traversal-detection contract', () => {
    expect(posixNormalize('../../y.md')).toBe('../../y.md')
  })

  it('leaves a partially-escaping .. in place once real segments are exhausted', () => {
    expect(posixNormalize('a/../../y.md')).toBe('../y.md')
  })

  it('a path with no . or .. segments is unchanged', () => {
    expect(posixNormalize('a/b/c.md')).toBe('a/b/c.md')
  })
})

// The full resolveLink algorithm end to end: posixNormalize(posixJoin(posixDirname(relPath), href)), then isSafeRel.
describe('Preview link resolution algorithm (step 2.17, Sec H-3)', () => {
  function resolve(relPath: string, href: string): string | null {
    const rel = posixNormalize(posixJoin(posixDirname(relPath), href))
    return isSafeRel(rel) ? rel : null
  }

  it('resolves a same-directory relative link', () => {
    expect(resolve('docs/README.md', 'other.md')).toBe('docs/other.md')
  })

  it('resolves a ../ link that stays within the repo', () => {
    expect(resolve('docs/sub/README.md', '../other.md')).toBe('docs/other.md')
  })

  it('rejects a traversal attempt that escapes the repo root', () => {
    expect(resolve('README.md', '../../etc/passwd')).toBeNull()
  })

  it('rejects a .git-internal target', () => {
    expect(resolve('README.md', '.git/config')).toBeNull()
  })
})
