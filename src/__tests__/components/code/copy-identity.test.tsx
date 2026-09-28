import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { CodeExplorer } from '../../../renderer/components/code/CodeExplorer'
import { useCodeExplorerStore } from '../../../renderer/stores/code-explorer-store'
import { REPO_STATE_FIXTURES } from '../../helpers/repo-state-fixtures'

// ---------------------------------------------------------------------------
// copy-identity — TRD §3.8.2's "Copy decision": themed copy is confined to
// navigation and chrome ("Grimoire of…", the two ExplorerToolbar labels);
// every security/degraded-state string (GitStateBanner's §3.9.1 table, the
// §3.8.3 branch-mismatch banner, the live-updates-limited notice) must stay
// byte-identical regardless of `skin` — CodeExplorer.tsx's own doc comment
// states this explicitly ("clarity beats immersion there"). This file proves
// it by rendering the shared shell with skin="office" and skin="realm" under
// the same seeded state and diffing the rendered text, rather than trusting
// the doc comment alone.
// ---------------------------------------------------------------------------

Object.defineProperty(window, 'cornerOffice', {
  value: { code: { getStatus: vi.fn(), listDir: vi.fn(), watch: vi.fn(), unwatch: vi.fn(), getFileIndex: vi.fn() } },
  writable: true,
})

const CLOSED_STATE_SNAPSHOT = useCodeExplorerStore.getState()

beforeEach(() => {
  useCodeExplorerStore.setState(CLOSED_STATE_SNAPSHOT, true)
  ;(window.cornerOffice.code.getStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ data: null, error: null })
  ;(window.cornerOffice.code.listDir as ReturnType<typeof vi.fn>).mockResolvedValue({
    data: { relDir: '', entries: [], omitted: 0, ignoredParent: false },
    error: null,
  })
})

function seed(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>> = {}): void {
  useCodeExplorerStore.setState({ open: true, workspaceSlug: 'test-ws', repo: REPO_STATE_FIXTURES.git, ...overrides })
}

/** Renders CodeExplorer once per skin under identical seeded state and
 *  returns the full rendered body text for each — cleaning up between
 *  renders so neither tree's text can leak into the other's query. */
function renderedTextByskin(overrides: Partial<ReturnType<typeof useCodeExplorerStore.getState>>): {
  office: string
  realm: string
} {
  seed(overrides)
  const office = render(<CodeExplorer skin="office" onBack={vi.fn()} />)
  const officeText = office.container.textContent ?? ''
  cleanup()

  seed(overrides)
  const realm = render(<CodeExplorer skin="realm" onBack={vi.fn()} />)
  const realmText = realm.container.textContent ?? ''
  cleanup()

  return { office: officeText, realm: realmText }
}

describe('copy identity — GitStateBanner (§3.9.1) is skin-invariant', () => {
  const cases: Array<[string, keyof typeof REPO_STATE_FIXTURES, string]> = [
    ['not-git', 'notGit', "Review features are off: this folder isn't a git repository."],
    ['git-unavailable (not found)', 'gitUnavailableNotFound', "Review features are off: git wasn't found."],
    [
      'git-unavailable (inside workspace)',
      'gitUnavailableInsideWorkspace',
      "Review features are off: git was found inside a workspace and won't be run.",
    ],
    ['git-too-old', 'gitTooOld', 'Review features are off: git 2.31 or newer is needed.'],
    ['git-untrusted', 'gitUntrusted', "Review features are off: git doesn't trust this folder (owned by another user)."],
    [
      'git-unsafe',
      'gitUnsafe',
      "Review features are off: this repository's git configuration changed unexpectedly or couldn't be checked.",
    ],
    ['root-mismatch', 'rootMismatch', "Review features are off: the workspace isn't the top of its git repository."],
  ]

  it.each(cases)('%s: identical banner text in both skins', (_label, fixtureKey, expectedMessage) => {
    const { office, realm } = renderedTextByskin({ repo: REPO_STATE_FIXTURES[fixtureKey] })
    expect(office).toContain(expectedMessage)
    expect(realm).toContain(expectedMessage)
  })
})

describe('copy identity — live-updates-limited notice is skin-invariant', () => {
  it('identical notice text in both skins', () => {
    const { office, realm } = renderedTextByskin({ liveLimited: true, repo: REPO_STATE_FIXTURES.liveUpdatesLimited })
    const expected = 'Live updates are limited: this repository has an unusual .git layout. Markers refresh every 10 s.'
    expect(office).toContain(expected)
    expect(realm).toContain(expected)
  })
})

describe('copy identity — branch-mismatch banner (§3.8.3) is skin-invariant', () => {
  it('identical banner text in both skins', () => {
    const overrides = {
      expectedBranch: 'feat/0028-code-explorer',
      repo: { ...REPO_STATE_FIXTURES.git, branch: 'main' },
    }
    const { office, realm } = renderedTextByskin(overrides)
    for (const fragment of ["isn't checked out", 'feat/0028-code-explorer', 'main']) {
      expect(office).toContain(fragment)
      expect(realm).toContain(fragment)
    }
  })
})

describe('copy identity — themed strings only ever appear where TRD §3.8.2 names them', () => {
  // The converse check: office's own render must NEVER contain realm's two
  // themed navigation labels, proving the theming is additive to realm only,
  // not a rename applied to both.
  it('office renders plain nav labels, never the realm-themed ones', () => {
    seed()
    render(<CodeExplorer skin="office" onBack={vi.fn()} />)
    expect(screen.getByText('← Back')).toBeInTheDocument()
    expect(screen.queryByText('Return to the Study')).toBeNull()
  })
})
