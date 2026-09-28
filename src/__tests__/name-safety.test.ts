import { describe, it, expect } from 'vitest'
import { tokenizeName, hasInvisibleChars, describeInvisibleChar, tokenizeNameToText } from '../renderer/utils/name-safety'

// ---------------------------------------------------------------------------
// Every test character is built from String.fromCharCode, never a literal or
// \u escape embedded in this file's source — see name-safety.ts's own comment
// on why (this file must not itself smuggle the characters it is testing).
// ---------------------------------------------------------------------------

const CODE_POINTS: Record<string, number> = {
  softHyphen: 0x00ad,
  zeroWidthSpace: 0x200b,
  zeroWidthNonJoiner: 0x200c,
  zeroWidthJoiner: 0x200d,
  leftToRightMark: 0x200e,
  rightToLeftMark: 0x200f,
  leftToRightEmbedding: 0x202a,
  rightToLeftEmbedding: 0x202b,
  popDirectionalFormatting: 0x202c,
  leftToRightOverride: 0x202d,
  rightToLeftOverride: 0x202e,
  leftToRightIsolate: 0x2066,
  rightToLeftIsolate: 0x2067,
  firstStrongIsolate: 0x2068,
  popDirectionalIsolate: 0x2069,
  bom: 0xfeff,
}

describe('tokenizeName — plain names', () => {
  it.each(['index.ts', 'src/components/Foo.tsx', 'main.feature-branch', 'a b c'])(
    '%s comes back as a single unchanged text token',
    (name) => {
      expect(tokenizeName(name)).toEqual([{ kind: 'text', text: name }])
    }
  )

  it('empty string produces no tokens', () => {
    expect(tokenizeName('')).toEqual([])
  })
})

describe('tokenizeName — every flagged code point (§7.1)', () => {
  it.each(Object.entries(CODE_POINTS))('%s (U+%s) is tokenized as invisible', (_label, codePoint) => {
    const ch = String.fromCharCode(codePoint)
    const tokens = tokenizeName(`a${ch}b`)
    expect(tokens).toEqual([
      { kind: 'text', text: 'a' },
      expect.objectContaining({ kind: 'invisible', raw: ch }),
      { kind: 'text', text: 'b' },
    ])
  })

  it('the invisible token carries a visible placeholder and a titled label', () => {
    const rtlOverride = String.fromCharCode(CODE_POINTS.rightToLeftOverride)
    const tokens = tokenizeName(`evil${rtlOverride}name`)
    const invisible = tokens.find((t) => t.kind === 'invisible')
    expect(invisible).toBeDefined()
    if (invisible?.kind === 'invisible') {
      expect(invisible.placeholder).toContain('U+202E')
      expect(invisible.title).toBe('U+202E RIGHT-TO-LEFT OVERRIDE')
    }
  })

  it('consecutive invisible characters each get their own token', () => {
    const zwsp = String.fromCharCode(CODE_POINTS.zeroWidthSpace)
    const rtl = String.fromCharCode(CODE_POINTS.rightToLeftOverride)
    const tokens = tokenizeName(`${zwsp}${rtl}x`)
    expect(tokens.filter((t) => t.kind === 'invisible')).toHaveLength(2)
    expect(tokens[tokens.length - 1]).toEqual({ kind: 'text', text: 'x' })
  })

  it('a leading invisible character produces no leading empty text token', () => {
    const zwsp = String.fromCharCode(CODE_POINTS.zeroWidthSpace)
    const tokens = tokenizeName(`${zwsp}x`)
    expect(tokens[0].kind).toBe('invisible')
    expect(tokens).toHaveLength(2)
  })
})

describe('hasInvisibleChars', () => {
  it('is false for a plain name', () => {
    expect(hasInvisibleChars('normal-file.md')).toBe(false)
  })

  it('is true when a flagged character is present', () => {
    const bom = String.fromCharCode(CODE_POINTS.bom)
    expect(hasInvisibleChars(`${bom}file.md`)).toBe(true)
  })
})

describe('describeInvisibleChar', () => {
  it('returns the placeholder and titled label for a flagged code point', () => {
    const described = describeInvisibleChar(CODE_POINTS.rightToLeftOverride)
    expect(described).not.toBeNull()
    expect(described?.placeholder).toContain('U+202E')
    expect(described?.title).toBe('U+202E RIGHT-TO-LEFT OVERRIDE')
  })

  it('returns null for an ordinary code point (Fix #117: never a raw-character fallback downstream)', () => {
    // 'a' — nowhere near any flagged range, and not one of the named
    // code points describeInvisibleChar's table covers.
    expect(describeInvisibleChar('a'.codePointAt(0)!)).toBeNull()
  })
})

describe('tokenizeNameToText', () => {
  it('returns a plain name unchanged', () => {
    expect(tokenizeNameToText('main')).toBe('main')
  })

  it('replaces a flagged character with its placeholder text, inline', () => {
    const rtl = String.fromCharCode(CODE_POINTS.rightToLeftOverride)
    const text = tokenizeNameToText(`feat${rtl}evil`)
    expect(text).not.toContain(rtl)
    expect(text).toContain('U+202E')
    expect(text).toBe(`feat${describeInvisibleChar(CODE_POINTS.rightToLeftOverride)!.placeholder}evil`)
  })
})
