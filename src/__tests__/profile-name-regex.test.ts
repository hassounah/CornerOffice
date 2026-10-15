import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PROFILE_NAME_RE } from '../main/services/app-home'

// ---------------------------------------------------------------------------
// One fixture list against every copy of the profile-name regex (#0038, step 1.9):
// the TS constant, the Makefile's and the launcher's, the latter two extracted and run with grep -E.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../..')

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

/** The Makefile's `PROFILE_RE := …` with make's `$$` unescaped to `$`. */
function makefileRegex(): string {
  const line = fs.readFileSync(path.join(ROOT, 'Makefile'), 'utf8').split('\n').find((l) => l.startsWith('PROFILE_RE :='))
  if (!line) throw new Error('PROFILE_RE not found in the Makefile')
  return line.slice('PROFILE_RE :='.length).trim().replace(/\$\$/g, '$')
}

/** The launcher's `PROFILE_RE='…'` line. */
function launcherRegex(): string {
  const line = fs.readFileSync(path.join(ROOT, 'scripts/co_dev_sandbox.sh'), 'utf8').split('\n').find((l) => l.startsWith('PROFILE_RE='))
  const match = line?.match(/^PROFILE_RE='(.*)'/)
  if (!match) throw new Error('PROFILE_RE not found in scripts/co_dev_sandbox.sh')
  return match[1]
}

function grepMatches(regex: string, value: string): boolean {
  return spawnSync('grep', ['-Eq', regex], { input: value, encoding: 'utf8' }).status === 0
}

describe('profile name regex', () => {
  it.each(FIXTURES)('TS: %j -> %s', (value, ok) => {
    expect(PROFILE_NAME_RE.test(value)).toBe(ok)
  })

  it.each(FIXTURES)('launcher: %j -> %s', (value, ok) => {
    expect(grepMatches(launcherRegex(), value)).toBe(ok)
  })

  it.each(FIXTURES)('Makefile: %j -> %s', (value, ok) => {
    expect(grepMatches(makefileRegex(), value)).toBe(ok)
  })
})
