import { describe, it, expect } from 'vitest'
import { PROFILE_NAME_RE } from '../main/services/app-home'

// ---------------------------------------------------------------------------
// The profile-name regex (#0038): the app is the only validator now (the Makefile and the
// launcher no longer carry a copy).
// ---------------------------------------------------------------------------

const FIXTURES: Array<[string, boolean]> = [
  ['dev', true],
  ['a', true],
  ['x-1', true],
  ['a'.repeat(32), true],
  ['default', true],
  ['Dev_1', false],
  ['-x', false],
  ['a'.repeat(33), false],
  ['', false],
]

describe('profile name regex', () => {
  it.each(FIXTURES)('TS: %j -> %s', (value, ok) => {
    expect(PROFILE_NAME_RE.test(value)).toBe(ok)
  })
})
