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

  it('flags a binary whose real path is inside a sandbox-writable root, following a symlink (SEC-M3)', () => {
    const root = fs.realpathSync(mkTmp())
    const real = path.join(root, 'packages', 'bin')
    writeBinary(real, 'codex', 0o755)
    const bin = mkTmp()
    fs.symlinkSync(path.join(real, 'codex'), path.join(bin, 'codex'))

    const result = getHostAvailability({ pathEnv: bin, home: mkTmp(), writableRoots: [root] })

    expect(result.codex).toBe(`found-in-writable-root:${path.join(real, 'codex')}`)
  })

  it('leaves a binary outside every writable root, and a sibling that only shares a prefix, as found', () => {
    const root = fs.realpathSync(mkTmp())
    const sibling = `${root}-other`
    fs.mkdirSync(sibling)
    dirs.push(sibling)
    writeBinary(sibling, 'codex', 0o755)

    expect(getHostAvailability({ pathEnv: sibling, home: mkTmp(), writableRoots: [root, path.join(root, 'missing')] }).codex).toBe('found')
  })
})
