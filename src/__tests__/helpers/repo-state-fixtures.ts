import type { RepoInfo } from '@main/types/code'

// ---------------------------------------------------------------------------
// repo-state-fixtures.ts — the parametrized RepoState x base-reason matrix
// (TRD §3.9.1), shared by GitStateBanner (2.10) and reused by 2.12/2.13
// (disabled-with-reason for Compare / Changed files / View = Changes).
// ---------------------------------------------------------------------------

function makeRepoInfo(overrides: Partial<RepoInfo> = {}): RepoInfo {
  return {
    state: 'git',
    stateDetail: null,
    gitVersionInfo: 'ok',
    gitVersion: null,
    liveGitUpdates: true,
    hasCommits: true,
    branch: 'main',
    detached: false,
    headShort: 'abc1234',
    isWorktree: false,
    isShallow: false,
    base: { available: true, name: 'main', onBase: true },
    ...overrides,
  }
}

/** One fixture per row of the TRD §3.9.1 state table, plus the base-
 *  resolution variants used by 2.12/2.13's disabled-with-reason states. */
export const REPO_STATE_FIXTURES = {
  // --- RepoState variants (each with a GitStateBanner entry) --------------
  git: makeRepoInfo(),
  notGit: makeRepoInfo({
    state: 'not-git',
    hasCommits: false,
    branch: null,
    headShort: null,
    base: { available: false, name: null, reason: 'not-git' },
  }),
  gitUnavailableNotFound: makeRepoInfo({
    state: 'git-unavailable',
    stateDetail: null,
    hasCommits: false,
    branch: null,
    headShort: null,
    base: { available: false, name: null, reason: 'not-git' },
  }),
  gitUnavailableInsideWorkspace: makeRepoInfo({
    state: 'git-unavailable',
    stateDetail: 'git found inside a workspace',
    hasCommits: false,
    branch: null,
    headShort: null,
    base: { available: false, name: null, reason: 'not-git' },
  }),
  gitTooOld: makeRepoInfo({
    state: 'git-too-old',
    hasCommits: false,
    branch: null,
    headShort: null,
    base: { available: false, name: null, reason: 'not-git' },
  }),
  gitUntrusted: makeRepoInfo({
    state: 'git-untrusted',
    hasCommits: false,
    branch: null,
    headShort: null,
    base: { available: false, name: null, reason: 'not-git' },
  }),
  gitUnsafe: makeRepoInfo({ state: 'git-unsafe', liveGitUpdates: false }),
  rootMismatch: makeRepoInfo({
    state: 'root-mismatch',
    hasCommits: false,
    branch: null,
    headShort: null,
    base: { available: false, name: null, reason: 'not-git' },
  }),

  // --- Cross-cutting variants (independent of state, TRD M5 / live-updates) ---
  preOldGitVersion: makeRepoInfo({ gitVersionInfo: 'pre-2.39.1' }),
  liveUpdatesLimited: makeRepoInfo({ liveGitUpdates: false }),

  // --- Base-resolution variants (2.12/2.13 disabled-with-reason states) ---
  noCommits: makeRepoInfo({
    hasCommits: false,
    headShort: null,
    base: { available: false, name: null, reason: 'no-commits' },
  }),
  detachedHead: makeRepoInfo({ branch: null, detached: true }),
  noBaseBranch: makeRepoInfo({ base: { available: false, name: null, reason: 'no-base-branch' } }),
  onBaseBranch: makeRepoInfo({ base: { available: true, name: 'main', onBase: true } }),
  divergedFromBase: makeRepoInfo({ base: { available: true, name: 'main', onBase: false } }),
  noMergeBase: makeRepoInfo({ isShallow: true, base: { available: false, name: null, reason: 'no-merge-base' } }),
  worktree: makeRepoInfo({ isWorktree: true }),
} as const satisfies Record<string, RepoInfo>
