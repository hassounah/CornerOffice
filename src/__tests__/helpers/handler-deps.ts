import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RealHandlerDeps } from '../../main/ipc/handlers'
import type { JsonStore, StoreHealth } from '../../main/services/json-store'
import {
  defaultRegistry,
  defaultSandbox,
  defaultSessionDefaults,
  defaultSettings,
} from '../../main/services/stores'
import type { Registry, SandboxFile, SessionDefaultsFile, Settings } from '../../main/services/stores'

export interface MemoryStore<T> extends JsonStore<T> {
  /** Every value written, in order. */
  writes: T[]
  setHealth(h: StoreHealth): void
  /** Make the next `mutate` reject with `err` (a store whose write fails). */
  failNextWith(err: Error): void
}

/** An in-memory `JsonStore` for handler tests: `mutate` is serialized and records its writes, nothing touches the disk. */
export function memoryStore<T>(initial: T): MemoryStore<T> {
  let value = initial
  let health: StoreHealth = 'ok'
  let queue: Promise<unknown> = Promise.resolve()
  let nextError: Error | null = null
  const listeners = new Set<(next: T) => void>()
  const writes: T[] = []
  return {
    writes,
    get: () => value,
    health: () => health,
    healthDetail: () => ({ health }),
    setHealth: (h) => {
      health = h
    },
    failNextWith: (err) => {
      nextError = err
    },
    mutate: (fn) => {
      const run = queue.then(() => {
        if (nextError) {
          const err = nextError
          nextError = null
          throw err
        }
        value = fn(value)
        writes.push(value)
        for (const l of listeners) l(value)
        return value
      })
      queue = run.catch(() => undefined)
      return run
    },
    onChange: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    resetCacheForTests: () => undefined,
  }
}

export interface HandlerDepsKit {
  deps: RealHandlerDeps
  settings: MemoryStore<Settings>
  registry: MemoryStore<Registry>
  sandbox: MemoryStore<SandboxFile>
  sessionDefaults: MemoryStore<SessionDefaultsFile>
  recordSessionStart: Mock<RealHandlerDeps['recordSessionStart']>
}

/** Deps for `buildRealHandlers`: fake stores, an allow-all origin check, and a `recordSessionStart` spy. */
export function makeHandlerDeps(overrides: Partial<RealHandlerDeps> = {}): HandlerDepsKit {
  const settings = memoryStore(defaultSettings())
  const registry = memoryStore(defaultRegistry())
  const sandbox = memoryStore(defaultSandbox())
  const sessionDefaults = memoryStore(defaultSessionDefaults())
  const recordSessionStart = vi.fn<RealHandlerDeps['recordSessionStart']>()
  return {
    deps: {
      recordSessionStart,
      stores: { settings, registry, sandbox, sessionDefaults },
      isAppOrigin: () => true,
      ...overrides,
    },
    settings,
    registry,
    sandbox,
    sessionDefaults,
    recordSessionStart,
  }
}
