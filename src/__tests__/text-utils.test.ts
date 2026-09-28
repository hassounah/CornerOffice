import { describe, it, expect } from 'vitest'
import { detectEol, serializeEol, eolOnlyChange, minimalChange } from '../renderer/utils/text-utils'

describe('detectEol', () => {
  it('returns "none" for text with no line breaks', () => {
    expect(detectEol('no newlines here')).toBe('none')
  })

  it('returns "none" for an empty string', () => {
    expect(detectEol('')).toBe('none')
  })

  it('detects pure LF', () => {
    expect(detectEol('line one\nline two\nline three')).toBe('lf')
  })

  it('detects pure CRLF', () => {
    expect(detectEol('line one\r\nline two\r\nline three')).toBe('crlf')
  })

  it('detects mixed LF and CRLF as mixed', () => {
    expect(detectEol('line one\r\nline two\nline three')).toBe('mixed')
  })

  it('treats a lone CR (not followed by LF) as mixed', () => {
    expect(detectEol('line one\rline two')).toBe('mixed')
  })

  it('treats a lone CR mixed with CRLF as mixed', () => {
    expect(detectEol('line one\r\nline two\rline three')).toBe('mixed')
  })

  it('does not double-count the LF half of a CRLF pair as a bare LF', () => {
    // A file that is pure CRLF must not be misclassified as mixed.
    expect(detectEol('a\r\nb\r\nc\r\n')).toBe('crlf')
  })
})

describe('serializeEol', () => {
  it('returns the text unchanged for lf', () => {
    expect(serializeEol('a\nb\nc', 'lf')).toBe('a\nb\nc')
  })

  it('converts LF to CRLF', () => {
    expect(serializeEol('a\nb\nc', 'crlf')).toBe('a\r\nb\r\nc')
  })

  it('handles text with no line breaks identically for both styles', () => {
    expect(serializeEol('single line', 'lf')).toBe('single line')
    expect(serializeEol('single line', 'crlf')).toBe('single line')
  })
})

describe('eolOnlyChange', () => {
  it('returns null for byte-identical text', () => {
    expect(eolOnlyChange('a\nb\nc', 'a\nb\nc')).toBeNull()
  })

  it('returns null for a real content change', () => {
    expect(eolOnlyChange('a\nb\nc', 'a\nB\nc')).toBeNull()
  })

  it('detects an LF → CRLF-only change', () => {
    expect(eolOnlyChange('a\nb\nc', 'a\r\nb\r\nc')).toEqual({ from: 'lf', to: 'crlf' })
  })

  it('detects a CRLF → LF-only change', () => {
    expect(eolOnlyChange('a\r\nb\r\nc', 'a\nb\nc')).toEqual({ from: 'crlf', to: 'lf' })
  })

  it('returns null when EOL changes but content also changes', () => {
    expect(eolOnlyChange('a\nb\nc', 'a\r\nB\r\nc')).toBeNull()
  })
})

describe('minimalChange', () => {
  it('returns null for identical text', () => {
    expect(minimalChange('same text', 'same text')).toBeNull()
  })

  it('returns an insert-at-end change for a pure append', () => {
    expect(minimalChange('abc', 'abcd')).toEqual({ from: 3, to: 3, insert: 'd' })
  })

  it('returns a change at the start for a prefix-only difference', () => {
    expect(minimalChange('abc', 'xbc')).toEqual({ from: 0, to: 1, insert: 'x' })
  })

  it('returns a minimal change for a middle edit', () => {
    expect(minimalChange('abcdef', 'abXYef')).toEqual({ from: 2, to: 4, insert: 'XY' })
  })

  it('returns a full replacement when there is no common prefix or suffix', () => {
    expect(minimalChange('abc', 'xyz')).toEqual({ from: 0, to: 3, insert: 'xyz' })
  })

  it('returns a zero-width insert for a single-character insertion', () => {
    expect(minimalChange('ab', 'acb')).toEqual({ from: 1, to: 1, insert: 'c' })
  })

  it('returns an empty-insert deletion for a single-character removal', () => {
    expect(minimalChange('acb', 'ab')).toEqual({ from: 1, to: 2, insert: '' })
  })

  it('handles deleting the entire text', () => {
    expect(minimalChange('abc', '')).toEqual({ from: 0, to: 3, insert: '' })
  })

  it('handles inserting into empty text', () => {
    expect(minimalChange('', 'abc')).toEqual({ from: 0, to: 0, insert: 'abc' })
  })

  it('operates on raw characters, not lines, for a CRLF file', () => {
    // A one-character change inside a CRLF file must not be widened to a
    // whole-line replacement, and the CRLFs on either side stay untouched.
    expect(minimalChange('one\r\ntwo\r\nthree', 'one\r\ntWo\r\nthree')).toEqual({
      from: 6,
      to: 7,
      insert: 'W',
    })
  })
})
