import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { Instinct, HomunculusStats, CrossWorkspacePattern, HomunculusState } from '@main/types/homunculus'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

vi.mock('remark-gfm', () => ({ default: () => {} }))

let mockShipMomentStyle: 'full' | 'compact' | 'off' = 'full'

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector: (s: { config: { appearance: { shipMomentStyle: string } } | null }) => unknown) =>
    selector({ config: { appearance: { shipMomentStyle: mockShipMomentStyle } } })
  ),
}))

let evolvedListener: ((payload: unknown) => void) | null = null
const mockOn = vi.fn().mockImplementation((_channel: string, listener: (p: unknown) => void) => {
  evolvedListener = listener
  return () => { evolvedListener = null }
})
Object.defineProperty(window, 'cornerOffice', {
  value: { on: mockOn },
  writable: true,
  configurable: true,
})

let mockHomunculusState: { state: HomunculusState | null; loading: boolean; fetchState: () => void } = {
  state: null,
  loading: false,
  fetchState: vi.fn(),
}

vi.mock('../../../renderer/stores/homunculus-store', () => ({
  useHomunculusStore: vi.fn((selector?: (s: typeof mockHomunculusState) => unknown) =>
    selector ? selector(mockHomunculusState) : mockHomunculusState
  ),
}))

// ---------------------------------------------------------------------------
// Component imports (after mocks)
// ---------------------------------------------------------------------------

import { InstinctCard } from '../../../renderer/components/homunculus/InstinctCard'
import { InstinctFeed } from '../../../renderer/components/homunculus/InstinctFeed'
import { IntelligenceSummary } from '../../../renderer/components/homunculus/IntelligenceSummary'
import { CrossWorkspacePatterns } from '../../../renderer/components/homunculus/CrossWorkspacePatterns'
import { EvolutionMomentOverlay } from '../../../renderer/components/homunculus/EvolutionMoment'
import Homunculus from '../../../renderer/pages/Homunculus'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInstinct(overrides: Partial<Instinct> = {}): Instinct {
  return {
    id: 'test-instinct',
    trigger: 'When doing X, do Y',
    confidence: 0.9,
    domain: 'python',
    source: 'session-observation',
    content: '# Problem\nSome problem\n# Action\nDo this',
    filePath: '/path/test-instinct.yaml',
    lastModified: '2026-03-10T10:00:00Z',
    type: 'personal',
    ...overrides,
  }
}

function makeStats(overrides: Partial<HomunculusStats> = {}): HomunculusStats {
  return {
    totalInstincts: 5,
    personalCount: 3,
    inheritedCount: 2,
    evolvedAgents: 1,
    evolvedSkills: 2,
    evolvedCommands: 0,
    totalObservations: 42,
    confidenceDistribution: { high: 3, medium: 1, low: 1 },
    mostActiveDomains: ['python', 'claude-code'],
    crossWorkspacePatterns: [],
    ...overrides,
  }
}

function makeHomunculusState(overrides: Partial<HomunculusState> = {}): HomunculusState {
  return {
    instincts: [makeInstinct()],
    observations: [],
    evolved: [],
    stats: makeStats(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// IntelligenceSummary
// ---------------------------------------------------------------------------

describe('IntelligenceSummary', () => {
  it('renders total instinct count', () => {
    render(<IntelligenceSummary stats={makeStats({ totalInstincts: 7 })} />)
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('renders personal and inherited counts', () => {
    render(<IntelligenceSummary stats={makeStats({ personalCount: 3, inheritedCount: 2, evolvedSkills: 0 })} />)
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('renders evolved artifact counts', () => {
    render(<IntelligenceSummary stats={makeStats({ evolvedAgents: 1, evolvedSkills: 2, evolvedCommands: 0 })} />)
    expect(screen.getByText('Evolved Agents')).toBeInTheDocument()
    expect(screen.getByText('Evolved Skills')).toBeInTheDocument()
  })

  it('renders confidence distribution bar', () => {
    render(<IntelligenceSummary stats={makeStats()} />)
    expect(screen.getByRole('img', { name: /Confidence:/ })).toBeInTheDocument()
  })

  it('renders top domains', () => {
    render(<IntelligenceSummary stats={makeStats({ mostActiveDomains: ['python', 'claude-code'] })} />)
    expect(screen.getByText('python')).toBeInTheDocument()
    expect(screen.getByText('claude-code')).toBeInTheDocument()
  })

  it('hides confidence bar when totalInstincts is 0', () => {
    render(<IntelligenceSummary stats={makeStats({ totalInstincts: 0, confidenceDistribution: { high: 0, medium: 0, low: 0 } })} />)
    expect(screen.queryByRole('img', { name: /Confidence:/ })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// InstinctCard
// ---------------------------------------------------------------------------

describe('InstinctCard', () => {
  it('renders instinct trigger', () => {
    render(<InstinctCard instinct={makeInstinct()} />)
    expect(screen.getByText('When doing X, do Y')).toBeInTheDocument()
  })

  it('renders domain badge', () => {
    render(<InstinctCard instinct={makeInstinct({ domain: 'python' })} />)
    expect(screen.getByText('python')).toBeInTheDocument()
  })

  it('is collapsed by default (no markdown)', () => {
    render(<InstinctCard instinct={makeInstinct()} />)
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it('expands to show markdown on click', () => {
    render(<InstinctCard instinct={makeInstinct()} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('markdown')).toBeInTheDocument()
  })

  it('aria-expanded reflects state', () => {
    render(<InstinctCard instinct={makeInstinct()} />)
    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows confidence percentage', () => {
    render(<InstinctCard instinct={makeInstinct({ confidence: 0.9 })} />)
    expect(screen.getByText('90%')).toBeInTheDocument()
  })

  it('shows type badge', () => {
    render(<InstinctCard instinct={makeInstinct({ type: 'personal' })} />)
    expect(screen.getByText('personal')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// InstinctFeed
// ---------------------------------------------------------------------------

describe('InstinctFeed', () => {
  it('shows empty state when no instincts', () => {
    render(<InstinctFeed instincts={[]} />)
    expect(screen.getByText(/No instincts yet/)).toBeInTheDocument()
  })

  it('renders instinct cards', () => {
    render(<InstinctFeed instincts={[makeInstinct()]} />)
    expect(screen.getByText('When doing X, do Y')).toBeInTheDocument()
  })

  it('shows domain filter select', () => {
    render(<InstinctFeed instincts={[makeInstinct()]} />)
    expect(screen.getByLabelText('Domain')).toBeInTheDocument()
  })

  it('shows confidence filter select', () => {
    render(<InstinctFeed instincts={[makeInstinct()]} />)
    expect(screen.getByLabelText('Confidence')).toBeInTheDocument()
  })

  it('filters by domain', () => {
    const instincts = [
      makeInstinct({ id: 'i1', trigger: 'Python trigger', domain: 'python' }),
      makeInstinct({ id: 'i2', trigger: 'Go trigger', domain: 'go' }),
    ]
    render(<InstinctFeed instincts={instincts} />)
    fireEvent.change(screen.getByLabelText('Domain'), { target: { value: 'python' } })
    expect(screen.getByText('Python trigger')).toBeInTheDocument()
    expect(screen.queryByText('Go trigger')).not.toBeInTheDocument()
  })

  it('filters by confidence level (high)', () => {
    const instincts = [
      makeInstinct({ id: 'i1', trigger: 'High trigger', confidence: 0.9 }),
      makeInstinct({ id: 'i2', trigger: 'Low trigger', confidence: 0.3 }),
    ]
    render(<InstinctFeed instincts={instincts} />)
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'high' } })
    expect(screen.getByText('High trigger')).toBeInTheDocument()
    expect(screen.queryByText('Low trigger')).not.toBeInTheDocument()
  })

  it('shows "N of M" count', () => {
    render(<InstinctFeed instincts={[makeInstinct(), makeInstinct({ id: 'i2', trigger: 'Other' })]} />)
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// CrossWorkspacePatterns
// ---------------------------------------------------------------------------

describe('CrossWorkspacePatterns', () => {
  const pattern: CrossWorkspacePattern = {
    instinctId: 'test-instinct',
    domain: 'python',
    confidence: 0.9,
    workspacesApplied: ['ws-a', 'ws-b'],
  }

  it('renders nothing when no patterns', () => {
    const { container } = render(<CrossWorkspacePatterns patterns={[]} instincts={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders domain badge', () => {
    render(<CrossWorkspacePatterns patterns={[pattern]} instincts={[makeInstinct()]} />)
    expect(screen.getAllByText('python').length).toBeGreaterThan(0)
  })

  it('renders workspace slugs', () => {
    render(<CrossWorkspacePatterns patterns={[pattern]} instincts={[makeInstinct()]} />)
    expect(screen.getByText('ws-a')).toBeInTheDocument()
    expect(screen.getByText('ws-b')).toBeInTheDocument()
  })

  it('shows trigger text from instincts', () => {
    render(<CrossWorkspacePatterns patterns={[pattern]} instincts={[makeInstinct({ id: 'test-instinct', trigger: 'When doing X' })]} />)
    expect(screen.getByText('When doing X')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// EvolutionMomentOverlay
// ---------------------------------------------------------------------------

describe('EvolutionMomentOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockShipMomentStyle = 'full'
    evolvedListener = null
    mockOn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function fireEvolved(state: HomunculusState): void {
    act(() => { evolvedListener?.(state) })
  }

  it('renders nothing initially', () => {
    const { container } = render(<EvolutionMomentOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when style is "off"', () => {
    mockShipMomentStyle = 'off'
    render(<EvolutionMomentOverlay />)
    const state = makeHomunculusState({
      evolved: [{ name: 'my-skill', type: 'skill', filePath: '/path/my-skill.md', lastModified: '2026-03-12T10:00:00Z', content: '' }],
    })
    fireEvolved(state)
    act(() => { vi.advanceTimersByTime(6000) })
    expect(screen.queryByTestId('evolution-moment-full')).not.toBeInTheDocument()
  })

  it('shows full overlay after batch window', () => {
    render(<EvolutionMomentOverlay />)
    const state = makeHomunculusState({
      evolved: [{ name: 'my-skill', type: 'skill', filePath: '/path/my-skill.md', lastModified: '2026-03-12T10:00:00Z', content: '' }],
    })
    fireEvolved(state)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByTestId('evolution-moment-full')).toBeInTheDocument()
  })

  it('shows evolved name', () => {
    render(<EvolutionMomentOverlay />)
    const state = makeHomunculusState({
      evolved: [{ name: 'my-awesome-skill', type: 'skill', filePath: '/path/skill.md', lastModified: '2026-03-12T10:00:00Z', content: '' }],
    })
    fireEvolved(state)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByText('my-awesome-skill')).toBeInTheDocument()
  })

  it('auto-dismisses after 3s', () => {
    render(<EvolutionMomentOverlay />)
    const state = makeHomunculusState({
      evolved: [{ name: 'my-skill', type: 'skill', filePath: '/path/skill.md', lastModified: '2026-03-12T10:00:00Z', content: '' }],
    })
    fireEvolved(state)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByTestId('evolution-moment-full')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(3001) })
    expect(screen.queryByTestId('evolution-moment-full')).not.toBeInTheDocument()
  })

  it('shows compact variant', () => {
    mockShipMomentStyle = 'compact'
    render(<EvolutionMomentOverlay />)
    const state = makeHomunculusState({
      evolved: [{ name: 'my-skill', type: 'skill', filePath: '/path/skill.md', lastModified: '2026-03-12T10:00:00Z', content: '' }],
    })
    fireEvolved(state)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByTestId('evolution-moment-compact')).toBeInTheDocument()
  })

  it('does not re-trigger for same filePath', () => {
    render(<EvolutionMomentOverlay />)
    const state = makeHomunculusState({
      evolved: [{ name: 'my-skill', type: 'skill', filePath: '/path/skill.md', lastModified: '2026-03-12T10:00:00Z', content: '' }],
    })
    // First time: new
    fireEvolved(state)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.getByTestId('evolution-moment-full')).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(3001) })
    // Second time same state: already tracked, should not trigger again
    fireEvolved(state)
    act(() => { vi.advanceTimersByTime(5001) })
    expect(screen.queryByTestId('evolution-moment-full')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Homunculus page
// ---------------------------------------------------------------------------

describe('Homunculus page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHomunculusState = { state: null, loading: false, fetchState: vi.fn() }
  })

  it('shows loading spinner when loading and no state', () => {
    mockHomunculusState = { state: null, loading: true, fetchState: vi.fn() }
    render(<Homunculus />)
    // Check for spinner via border class
    const spinner = document.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('shows empty state when no instincts', () => {
    mockHomunculusState = {
      state: makeHomunculusState({ stats: makeStats({ totalInstincts: 0 }), instincts: [] }),
      loading: false,
      fetchState: vi.fn(),
    }
    render(<Homunculus />)
    expect(screen.getByText(/No instincts yet/)).toBeInTheDocument()
  })

  it('renders page heading', () => {
    mockHomunculusState = {
      state: makeHomunculusState(),
      loading: false,
      fetchState: vi.fn(),
    }
    render(<Homunculus />)
    expect(screen.getByText('Rix Intelligence')).toBeInTheDocument()
  })

  it('renders IntelligenceSummary when state loaded', () => {
    mockHomunculusState = {
      state: makeHomunculusState(),
      loading: false,
      fetchState: vi.fn(),
    }
    render(<Homunculus />)
    expect(screen.getByLabelText('Intelligence summary')).toBeInTheDocument()
  })

  it('renders InstinctFeed when instincts present', () => {
    mockHomunculusState = {
      state: makeHomunculusState({ instincts: [makeInstinct()] }),
      loading: false,
      fetchState: vi.fn(),
    }
    render(<Homunculus />)
    expect(screen.getByLabelText('Instinct feed')).toBeInTheDocument()
  })

  it('calls fetchState on mount', () => {
    const fetchState = vi.fn()
    mockHomunculusState = { state: null, loading: false, fetchState }
    render(<Homunculus />)
    expect(fetchState).toHaveBeenCalled()
  })

  it('renders evolved artifacts section when evolved items present', () => {
    mockHomunculusState = {
      state: makeHomunculusState({
        instincts: [makeInstinct()],
        evolved: [
          { filePath: '/path/my-skill.md', name: 'my-skill', type: 'skill' as const, lastModified: '2026-03-14', content: '# My Skill' },
        ],
      }),
      loading: false,
      fetchState: vi.fn(),
    }
    render(<Homunculus />)
    expect(screen.getByText('Evolved Artifacts')).toBeInTheDocument()
    expect(screen.getByText('my-skill')).toBeInTheDocument()
  })

  it('does not render evolved artifacts section when evolved is empty', () => {
    mockHomunculusState = {
      state: makeHomunculusState({ instincts: [makeInstinct()], evolved: [] }),
      loading: false,
      fetchState: vi.fn(),
    }
    render(<Homunculus />)
    expect(screen.queryByText('Evolved Artifacts')).not.toBeInTheDocument()
  })

  it('shows IntelligenceSummary in empty state when state exists but no instincts', () => {
    mockHomunculusState = {
      state: makeHomunculusState({ stats: makeStats({ totalInstincts: 0 }), instincts: [] }),
      loading: false,
      fetchState: vi.fn(),
    }
    render(<Homunculus />)
    expect(screen.getByLabelText('Intelligence summary')).toBeInTheDocument()
  })
})
