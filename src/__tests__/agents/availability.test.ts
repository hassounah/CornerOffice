import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getHostAvailability, isOnHostPath } from '../../main/agents/availability'

const dirs: string[] = []

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-avail-'))
  dirs.push(dir)
  return dir
}

function writeBinary(dir: string, name: string, mode: number): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), '#!/bin/sh\n')
  fs.chmodSync(path.join(dir, name), mode)
}

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('isOnHostPath', () => {
  it('finds an executable file in a PATH directory', () => {
    const bin = mkTmp()
    writeBinary(bin, 'codex', 0o755)
    expect(isOnHostPath('codex', { pathEnv: bin, home: mkTmp() })).toBe(true)
  })

  it('does not count a file without an execute bit', () => {
    const bin = mkTmp()
    writeBinary(bin, 'codex', 0o644)
    expect(isOnHostPath('codex', { pathEnv: bin, home: mkTmp() })).toBe(false)
  })

  it('does not count a directory with the binary name', () => {
    const bin = mkTmp()
    fs.mkdirSync(path.join(bin, 'codex'), { mode: 0o755 })
    expect(isOnHostPath('codex', { pathEnv: bin, home: mkTmp() })).toBe(false)
  })

  it('skips a PATH directory that does not exist and keeps scanning', () => {
    const bin = mkTmp()
    writeBinary(bin, 'codex', 0o755)
    const pathEnv = [path.join(bin, 'missing'), '', 'relative/dir', bin].join(path.delimiter)
    expect(isOnHostPath('codex', { pathEnv, home: mkTmp() })).toBe(true)
  })

  it.each(['.local/bin', '.npm-global/bin', '.bun/bin', '.local/share/pnpm'])('also looks in ~/%s, which a GUI-launched PATH often lacks', (rel) => {
    const home = mkTmp()
    writeBinary(path.join(home, rel), 'codex', 0o755)
    expect(isOnHostPath('codex', { pathEnv: '', home })).toBe(true)
  })

  it('reports a miss when the binary is nowhere', () => {
    expect(isOnHostPath('definitely-not-installed-co', { pathEnv: mkTmp(), home: mkTmp() })).toBe(false)
  })
})

describe('getHostAvailability', () => {
  it('maps every registered agent to found or not-found by its binary name', () => {
    const bin = mkTmp()
    writeBinary(bin, 'codex', 0o755)
    const result = getHostAvailability({ pathEnv: bin, home: mkTmp() })
    expect(result.codex).toBe('found')
    expect(result.claude).toBe('not-found')
  })
})
