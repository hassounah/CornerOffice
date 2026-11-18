import fs from 'fs'
import os from 'os'
import path from 'path'
import { setActiveProfile, resetActiveProfileForTests, type Profile } from '@main/services/app-home'
import type { RegistryEntry } from '@main/services/stores'
import type { RuntimeFs } from '@main/services/workspace-runtime'

/** A temp "home" with a registered profile, so anchors resolve under it and never touch the real config. */
export interface RuntimeSandbox {
  base: string
  configDir: string
  /** Creates `<base>/<name>` and returns its realpath. */
  mkWorkspace(name: string): string
  cleanup(): void
}

export function makeRuntimeSandbox(): RuntimeSandbox {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-runtime-')))
  const configDir = path.join(base, 'cfg')
  const profile: Profile = {
    name: 'runtime-test',
    home: path.join(base, '.co'),
    homeDisplay: '~/.corner-office/profiles/runtime-test',
    userDataDir: null,
    configDir,
    configDirDisplay: '~/.config/corner-office',
    logFile: null,
    debugPort: null,
    claudeHome: path.join(base, '.claude'),
    discoveryRoots: [base],
    warning: null,
  }
  resetActiveProfileForTests()
  setActiveProfile(profile)
  return {
    base,
    configDir,
    mkWorkspace(name) {
      const dir = path.join(base, name)
      fs.mkdirSync(dir, { recursive: true })
      return fs.realpathSync(dir)
    },
    cleanup() {
      resetActiveProfileForTests()
      fs.rmSync(base, { recursive: true, force: true })
    },
  }
}

export function makeEntry(id: string, wsPath: string, overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    id,
    path: wsPath,
    selectedPath: wsPath,
    displayName: null,
    docsRoot: null,
    hidden: false,
    source: 'manual',
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

export interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

export function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A scriptable `RuntimeFs`: identity realpath, everything is a directory, unless told otherwise. */
export class StubRuntimeFs implements RuntimeFs {
  realOverrides = new Map<string, string>()
  realErrors = new Map<string, Error>()
  statErrors = new Map<string, Error>()
  files = new Set<string>()
  statGates = new Map<string, Deferred>()
  statCalls: string[] = []

  async realpath(p: string): Promise<string> {
    const err = this.realErrors.get(p)
    if (err) throw err
    return this.realOverrides.get(p) ?? p
  }

  async stat(p: string): Promise<{ isDirectory(): boolean }> {
    this.statCalls.push(p)
    const gate = this.statGates.get(p)
    if (gate) await gate.promise
    const err = this.statErrors.get(p)
    if (err) throw err
    return { isDirectory: () => !this.files.has(p) }
  }
}

export function fsError(code: string): Error {
  return Object.assign(new Error(`fs ${code}`), { code })
}

/** Let queued promise callbacks (and a macrotask) run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
