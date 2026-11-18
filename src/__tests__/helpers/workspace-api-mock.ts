import { vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Workspace } from '@main/types/workspace'

/**
 * A fake `window.cornerOffice` for the workspace UI tests (#0039 4.3): the registry intents, the sandbox status and
 * the config calls. Every intent answers `{ data, error: null }` by default; make one fail with `fail(name, code)`.
 */
export interface WorkspaceApiMock {
  pickFolder: Mock<(purpose: string) => Promise<unknown>>
  add: Mock<(path: string) => Promise<unknown>>
  create: Mock<(parent: string, name: string, mode: string) => Promise<unknown>>
  remove: Mock<(slug: string) => Promise<unknown>>
  setHidden: Mock<(slug: string, hidden: boolean) => Promise<unknown>>
  rename: Mock<(slug: string, displayName: string | null) => Promise<unknown>>
  setDocsRoot: Mock<(slug: string, docsRoot: string | null) => Promise<unknown>>
  recheck: Mock<() => Promise<unknown>>
  getStatus: Mock<(slug: string) => Promise<unknown>>
  revealStoreFile: Mock<(store: string) => Promise<unknown>>
  getStoreHealth: Mock<() => Promise<unknown>>
  /** Make the named intent answer with an error envelope (a fixed code, as main sends it). */
  fail: (name: keyof Pick<WorkspaceApiMock, 'pickFolder' | 'add' | 'create' | 'remove' | 'setHidden' | 'rename' | 'setDocsRoot' | 'recheck'>, code: string) => void
}

const ok = <T>(data: T): { data: T; error: null } => ({ data, error: null })
const err = (code: string): { data: null; error: { code: string; message: string } } => ({ data: null, error: { code, message: `raw ${code} /secret/path` } })

export function installWorkspaceApi(workspaces: () => Workspace[] = () => []): WorkspaceApiMock {
  const find = (slug: string): Workspace => workspaces().find((w) => w.slug === slug) ?? workspaces()[0]
  const mock: WorkspaceApiMock = {
    pickFolder: vi.fn(async () => ok({ path: null })),
    add: vi.fn(async (path: string) => ok({ ...workspaces()[0], slug: 'added', path, selectedPath: path, displayName: 'Added' })),
    create: vi.fn(async (parent: string, name: string) =>
      ok({ workspace: { ...workspaces()[0], slug: name, path: `${parent}/${name}`, selectedPath: `${parent}/${name}`, displayName: name }, warnings: [] }),
    ),
    remove: vi.fn(async () => ok({ removed: true })),
    setHidden: vi.fn(async (slug: string, hidden: boolean) => ok({ ...find(slug), hidden })),
    rename: vi.fn(async (slug: string, displayName: string | null) => ok({ ...find(slug), displayName: displayName ?? find(slug).displayName })),
    setDocsRoot: vi.fn(async (slug: string, docsRoot: string | null) => ok({ ...find(slug), docsRoot: docsRoot ?? `${find(slug).path}/docs` })),
    recheck: vi.fn(async () => ok(workspaces())),
    getStatus: vi.fn(async () => ok({ worktree: 'absent' })),
    revealStoreFile: vi.fn(async () => ok({ revealed: true })),
    getStoreHealth: vi.fn(async () => ok({ stores: { settings: 'ok', workspaces: 'ok', sandbox: 'absent', sessionDefaults: 'absent' }, configDirMismatch: false, legacyConfigPresent: false })),
    fail: (name, code) => {
      mock[name].mockImplementation(async () => err(code))
    },
  }

  Object.defineProperty(window, 'cornerOffice', {
    value: {
      workspace: {
        pickFolder: (purpose: string) => mock.pickFolder(purpose),
        add: (path: string) => mock.add(path),
        create: (parent: string, name: string, mode: string) => mock.create(parent, name, mode),
        remove: (slug: string) => mock.remove(slug),
        setHidden: (slug: string, hidden: boolean) => mock.setHidden(slug, hidden),
        rename: (slug: string, name: string | null) => mock.rename(slug, name),
        setDocsRoot: (slug: string, docsRoot: string | null) => mock.setDocsRoot(slug, docsRoot),
        recheck: () => mock.recheck(),
        getAll: async () => ok(workspaces()),
        getDetail: async (slug: string) => ok(find(slug)),
      },
      sandbox: { getStatus: (slug: string) => mock.getStatus(slug) },
      config: { revealStoreFile: (store: string) => mock.revealStoreFile(store), getStoreHealth: () => mock.getStoreHealth() },
      on: () => () => undefined,
    },
    writable: true,
    configurable: true,
  })
  return mock
}
