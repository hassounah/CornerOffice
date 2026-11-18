import fs from 'fs'
import path from 'path'
import { withDeadline } from './fs-deadline'
import type { StoreHealth, StoreHealthDetail } from './json-store'

// ---------------------------------------------------------------------------
// store-files.ts — "Show in folder" for a config store (#0039, Sec L5). The renderer sends a store NAME, never a path:
// main lists the config dir itself and only ever reveals a regular file whose name is exactly the store's label, or
// the label plus a `.corrupt-<UTC stamp>` backup suffix.
// ---------------------------------------------------------------------------

export const STORE_NAMES = ['settings', 'workspaces', 'sandbox', 'sessionDefaults'] as const
export type StoreName = (typeof STORE_NAMES)[number]

/** The file name each store keeps in the config dir. */
export const STORE_LABELS: Readonly<Record<StoreName, string>> = {
  settings: 'settings.json',
  workspaces: 'workspaces.json',
  sandbox: 'sandbox.json',
  sessionDefaults: 'session-defaults.json',
}

export type StoreHealthMap = Record<StoreName, StoreHealth>
export type StoreHealthDetailMap = Record<StoreName, StoreHealthDetail>

const FS_DEADLINE_MS = 2_000
const CORRUPT_SUFFIX = /^\.corrupt-\d{8}T\d{6}Z$/

export interface RevealDeps {
  configDir: () => string
  readdir: (dir: string) => Promise<string[]>
  lstat: (p: string) => Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>
  showItemInFolder: (p: string) => void
}

export const realRevealFs = {
  readdir: (dir: string): Promise<string[]> => fs.promises.readdir(dir),
  lstat: (p: string): Promise<fs.Stats> => fs.promises.lstat(p),
}

/** True for exactly `<label>` or `<label>.corrupt-<YYYYMMDDTHHMMSSZ>`. */
export function isStoreFileName(name: string, label: string): boolean {
  return name === label || (name.startsWith(label) && CORRUPT_SUFFIX.test(name.slice(label.length)))
}

/**
 * Reveals the newest `.corrupt-*` backup of `store` if one exists, else the store file itself. Returns `{ revealed: false }`
 * when there is nothing safe to show. Symlinks and anything that is not a regular file are ignored.
 */
export async function revealStoreFile(store: StoreName, deps: RevealDeps): Promise<{ revealed: boolean }> {
  const label = STORE_LABELS[store]
  const dir = deps.configDir()

  let names: string[]
  try {
    names = await withDeadline(deps.readdir(dir), FS_DEADLINE_MS)
  } catch {
    return { revealed: false }
  }

  const matching: string[] = []
  for (const name of names.filter((n) => isStoreFileName(n, label))) {
    try {
      const st = await withDeadline(deps.lstat(path.join(dir, name)), FS_DEADLINE_MS)
      if (st.isFile() && !st.isSymbolicLink()) matching.push(name)
    } catch {
      // vanished or unreadable: skip it
    }
  }

  // Stamps are fixed-width UTC, so the lexicographic order is chronological.
  const newestBackup = matching.filter((n) => n !== label).sort().at(-1)
  const chosen = newestBackup ?? (matching.includes(label) ? label : undefined)
  if (chosen === undefined) return { revealed: false }
  deps.showItemInFolder(path.join(dir, chosen))
  return { revealed: true }
}
