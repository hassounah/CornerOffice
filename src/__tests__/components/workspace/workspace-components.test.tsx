import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { Pipeline, Feature, IdeationItem, ShippedFeature, Workspace, TeamLevel } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))

vi.mock('remark-gfm', () => ({ default: () => {} }))

vi.mock('react-window', () => ({
  List: ({
    rowComponent: Row,
    rowCount,
    rowProps,
  }: {
    rowComponent: React.ComponentType<Record<string, unknown> & { index: number; style: React.CSSProperties }>
    rowCount: number
    rowProps: Record<string, unknown>
  }) => (
    <div data-testid="fixed-size-list">
      {Array.from({ length: rowCount }, (_, i) => (
        <Row key={i} index={i} style={{}} {...rowProps} ariaAttributes={{ 'aria-posinset': i + 1, 'aria-setsize': rowCount, role: 'listitem' as const }} />
      ))}
    </div>
  ),
}))

const mockWorkspaceStore = vi.hoisted(() => ({
  workspaces: [] as Workspace[],
  loading: false,
  fetchAll: vi.fn().mockResolvedValue(undefined),
  fetchOne: vi.fn().mockResolvedValue(undefined),
  selectWorkspace: vi.fn(),
  updateConfig: vi.fn().mockResolvedValue(undefined),
  initListeners: vi.fn().mockReturnValue(() => {}),
}))

vi.mock('../../../renderer/stores/workspace-store', () => ({
  useWorkspaceStore: vi.fn((selector?: (s: typeof mockWorkspaceStore) => unknown) =>
    selector ? selector(mockWorkspaceStore) : mockWorkspaceStore,
  ),
}))

// Mock react-router
const mockNavigate = vi.fn()
vi.mock('react-router', () => ({
  useParams: vi.fn().mockReturnValue({ slug: 'test-ws' }),
  useNavigate: () => mockNavigate,
}))

const mockDocViewerStore = vi.hoisted(() => ({
  openFolder: vi.fn(),
  openFile: vi.fn(),
  mode: 'closed' as const,
  close: vi.fn(),
  retry: vi.fn(),
  treeLoading: false,
  fileLoading: false,
  error: null,
  file: null,
}))

vi.mock('../../../renderer/stores/docviewer-store', () => ({
  useDocViewerStore: vi.fn((selector?: (s: typeof mockDocViewerStore) => unknown) =>
    selector ? selector(mockDocViewerStore) : mockDocViewerStore,
  ),
}))

vi.mock('../../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn((selector?: (s: { config: { appearance: { compactView: boolean } } | null }) => unknown) =>
    selector ? selector({ config: { appearance: { compactView: false } } }) : { config: null },
  ),
}))

// Mock window.cornerOffice
Object.defineProperty(window, 'cornerOffice', {
  value: {
    workspace: {
      getDetail: vi.fn().mockResolvedValue({ ok: true, data: null }),
    },
  },
  writable: true,
})

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { PipelineTrack } from '../../../renderer/components/workspace/PipelineTrack'
import { ParkedPipelines } from '../../../renderer/components/workspace/ParkedPipelines'
import { FeatureCard } from '../../../renderer/components/workspace/FeatureCard'
import { IdeationCard } from '../../../renderer/components/workspace/IdeationCard'
import { FeatureBoard } from '../../../renderer/components/workspace/FeatureBoard'
import { MemoryPanel } from '../../../renderer/components/workspace/MemoryPanel'
import { HistoryTimeline } from '../../../renderer/components/workspace/HistoryTimeline'
import WorkspaceDetail from '../../../renderer/pages/WorkspaceDetail'
import { setPendingReturnFocus } from '../../../renderer/utils/code-explorer-return-focus'
import { assertNoNestedInteractive } from '../../helpers/a11y'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    slug: '0001-my-feature',
    featureName: 'My Feature',
    featureId: '0001',
    pipelineType: 'full',
    stage: 'design',
    gate: 1,
    branch: 'feat/my-feature',
    planFile: null,
    taskList: null,
    started: '2024-01-01',
    fixCycles: 0,
    parkedAt: null,
    lastDecision: null,
    ...overrides,
  }
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: '0001',
    name: 'My Feature',
    slug: '0001-my-feature',
    status: 'in_progress',
    pipelineType: 'full',
    gateProgress: 2,
    isParked: false,
    shippedDate: null,
    directory: '/path/to/feature',
    ...overrides,
  }
}

function makeIdeationItem(overrides: Partial<IdeationItem> = {}): IdeationItem {
  return {
    filename: 'cool-idea.md',
    title: 'Cool Idea',
    lastModified: new Date().toISOString(),
    path: '/path/cool-idea.md',
    ...overrides,
  }
}

function makeShippedFeature(overrides: Partial<ShippedFeature> = {}): ShippedFeature {
  return {
    id: '0001',
    name: 'Shipped Feature',
    shippedDate: '2024-01-15',
    pipelineType: 'full',
    gatesPassed: '3/3 passed',
    fixCycles: { design: 0, plan: 0, impl: 1, reviewFixes: 0, total: 1 },
    filesChanged: '12 files',
    testsInfo: '150 passing',
    mode: 'default',
    keyComponents: 'Auth, API',
    qualityScore: 90,
    ...overrides,
  }
}

function makeLevel(overrides: Partial<TeamLevel> = {}): TeamLevel {
  return {
    number: 2,
    name: 'Alpha',
    xpRequired: 500,
    xpCurrent: 250,
    ...overrides,
  }
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'test-ws',
    path: '/home/user/test-ws',
    displayName: 'Test Workspace',
    docsRoot: '/home/user/test-ws/docs',
    docsRootExists: true,
    repoRootStatus: 'ok',
    status: 'active',
    nextFeatureId: 2,
    projectContext: 'A test project.',
    activePipelines: [],
    parkedPipelines: [],
    features: [],
    ideationItems: [],
    shippedFeatures: [],
    lastActivityTimestamp: null,
    weekShipCount: 0,
    pinned: false,
    archived: false,
    level: makeLevel(),
    xp: 250,
    readmeContent: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// PipelineTrack
// ---------------------------------------------------------------------------

describe('PipelineTrack', () => {
  it('renders feature name', () => {
    render(<PipelineTrack pipeline={makePipeline()} />)
    expect(screen.getByText('My Feature')).toBeInTheDocument()
  })

  it('renders feature ID', () => {
    render(<PipelineTrack pipeline={makePipeline({ featureId: '0001' })} />)
    expect(screen.getByText('#0001')).toBeInTheDocument()
  })

  it('renders branch name', () => {
    render(<PipelineTrack pipeline={makePipeline({ branch: 'feat/my-feature' })} />)
    expect(screen.getByText('feat/my-feature')).toBeInTheDocument()
  })

  it('renders pipeline type badge', () => {
    render(<PipelineTrack pipeline={makePipeline({ pipelineType: 'full' })} />)
    expect(screen.getByText('Full')).toBeInTheDocument()
  })

  it('renders gate labels for full pipeline', () => {
    render(<PipelineTrack pipeline={makePipeline({ pipelineType: 'full' })} />)
    expect(screen.getByRole('listitem', { name: /Gate 1/ })).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: /Gate 2/ })).toBeInTheDocument()
    expect(screen.getByRole('listitem', { name: /Gate 3/ })).toBeInTheDocument()
  })

  it('renders simplified track for light pipeline', () => {
    render(<PipelineTrack pipeline={makePipeline({ pipelineType: 'light', stage: 'implementing' })} />)
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByText('Light')).toBeInTheDocument()
  })

  it('shows fix cycles when > 0', () => {
    render(<PipelineTrack pipeline={makePipeline({ fixCycles: 2 })} />)
    expect(screen.getByText('2 fixes')).toBeInTheDocument()
  })

  // --- Review changes (TRD §3.8.3 FR-3, step 2.22) -------------------------

  it('renders a Review button when onReview is provided and calls it with the pipeline', () => {
    const onReview = vi.fn()
    const pipeline = makePipeline()
    render(<PipelineTrack pipeline={pipeline} onReview={onReview} workspaceSlug="ws" />)
    fireEvent.click(screen.getByRole('button', { name: /review/i }))
    expect(onReview).toHaveBeenCalledWith(pipeline)
  })

  it('does not render a Review button when onReview is omitted (card stays non-interactive)', () => {
    const { container } = render(<PipelineTrack pipeline={makePipeline()} />)
    expect(screen.queryByRole('button', { name: /review/i })).not.toBeInTheDocument()
    assertNoNestedInteractive(container)
  })

  it('Review button carries a workspace-scoped data-return-focus id', () => {
    render(<PipelineTrack pipeline={makePipeline({ slug: '0009-x' })} onReview={vi.fn()} workspaceSlug="ws" />)
    expect(screen.getByRole('button', { name: /review/i })).toHaveAttribute('data-return-focus', 'review:ws:0009-x')
  })

  // Fix #137 (HIGH): the accessible name must distinguish which pipeline a
  // Review button belongs to — "Review" alone is identical across every
  // pipeline on the page.
  it("Review button's accessible name includes the pipeline's feature name", () => {
    render(<PipelineTrack pipeline={makePipeline({ featureName: 'Webhook Retry' })} onReview={vi.fn()} workspaceSlug="ws" />)
    expect(screen.getByRole('button', { name: /review changes:.*webhook retry/i })).toBeInTheDocument()
  })

  it('two PipelineTracks with different feature names get distinct Review button accessible names', () => {
    render(
      <>
        <PipelineTrack pipeline={makePipeline({ featureName: 'Webhook Retry', slug: 'a' })} onReview={vi.fn()} workspaceSlug="ws" />
        <PipelineTrack pipeline={makePipeline({ featureName: 'Slug Directories', slug: 'b' })} onReview={vi.fn()} workspaceSlug="ws" />
      </>,
    )
    const buttons = screen.getAllByRole('button', { name: /review changes:/i })
    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toHaveAccessibleName('Review changes: Webhook Retry')
    expect(buttons[1]).toHaveAccessibleName('Review changes: Slug Directories')
  })
})

// ---------------------------------------------------------------------------
// ParkedPipelines
// ---------------------------------------------------------------------------

describe('ParkedPipelines', () => {
  it('renders nothing when empty', () => {
    const { container } = render(<ParkedPipelines pipelines={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders parked pipeline cards', () => {
    render(<ParkedPipelines pipelines={[makePipeline({ parkedAt: '2024-01-10T00:00:00Z' })]} />)
    expect(screen.getByText('My Feature')).toBeInTheDocument()
  })

  it('shows parked count', () => {
    render(
      <ParkedPipelines
        pipelines={[makePipeline({ featureName: 'A' }), makePipeline({ featureName: 'B' })]}
      />,
    )
    expect(screen.getByText('Parked (2)')).toBeInTheDocument()
  })

  it('shows last decision when present', () => {
    const p = makePipeline({ lastDecision: 'Waiting on API team' })
    render(<ParkedPipelines pipelines={[p]} />)
    expect(screen.getByText('Waiting on API team')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// FeatureCard
// ---------------------------------------------------------------------------

describe('FeatureCard', () => {
  it('renders feature name', () => {
    render(<FeatureCard feature={makeFeature()} />)
    expect(screen.getByText('My Feature')).toBeInTheDocument()
  })

  it('renders feature ID', () => {
    render(<FeatureCard feature={makeFeature({ id: '0001' })} />)
    expect(screen.getByText('#0001')).toBeInTheDocument()
  })

  it('shows parked badge when isParked=true', () => {
    render(<FeatureCard feature={makeFeature({ isParked: true })} />)
    expect(screen.getByText('Parked')).toBeInTheDocument()
  })

  it('shows gate dots for full pipeline', () => {
    render(<FeatureCard feature={makeFeature({ pipelineType: 'full', gateProgress: 2 })} />)
    expect(screen.getByLabelText('2 of 3 gates passed')).toBeInTheDocument()
  })

  it('shows pipeline type badge', () => {
    render(<FeatureCard feature={makeFeature({ pipelineType: 'light' })} />)
    expect(screen.getByText('light')).toBeInTheDocument()
  })

  // --- Card body click/keyboard activation (role="button" operability) -----

  it('calls onClick when the card body is clicked', () => {
    const onClick = vi.fn()
    const feature = makeFeature()
    render(<FeatureCard feature={feature} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /feature:/i }))
    expect(onClick).toHaveBeenCalledWith(feature)
  })

  it('calls onClick on Enter key (role="button" must be keyboard-operable)', () => {
    const onClick = vi.fn()
    const feature = makeFeature()
    render(<FeatureCard feature={feature} onClick={onClick} />)
    fireEvent.keyDown(screen.getByRole('button', { name: /feature:/i }), { key: 'Enter' })
    expect(onClick).toHaveBeenCalledWith(feature)
  })

  it('calls onClick on Space key', () => {
    const onClick = vi.fn()
    const feature = makeFeature()
    render(<FeatureCard feature={feature} onClick={onClick} />)
    fireEvent.keyDown(screen.getByRole('button', { name: /feature:/i }), { key: ' ' })
    expect(onClick).toHaveBeenCalledWith(feature)
  })

  it('ignores other keys (no-op, no crash)', () => {
    const onClick = vi.fn()
    render(<FeatureCard feature={makeFeature()} onClick={onClick} />)
    fireEvent.keyDown(screen.getByRole('button', { name: /feature:/i }), { key: 'a' })
    expect(onClick).not.toHaveBeenCalled()
  })

  // --- Review changes sibling button (TRD §3.8.3 FR-3, H-U1 pattern, 2.22) --

  it('renders a sibling Review button (not nested inside role=button) when onReview is provided', () => {
    const onReview = vi.fn()
    const feature = makeFeature()
    const { container } = render(
      <FeatureCard feature={feature} onClick={vi.fn()} onReview={onReview} workspaceSlug="ws" />,
    )
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }))
    expect(onReview).toHaveBeenCalledWith(feature)
    assertNoNestedInteractive(container)
  })

  it('does not render a Review button when onReview is omitted', () => {
    render(<FeatureCard feature={makeFeature()} onClick={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /review changes/i })).not.toBeInTheDocument()
  })

  it('Review button carries a workspace-scoped data-return-focus id', () => {
    render(<FeatureCard feature={makeFeature({ slug: '0009-x' })} onReview={vi.fn()} workspaceSlug="ws" />)
    expect(screen.getByRole('button', { name: /review changes/i })).toHaveAttribute(
      'data-return-focus',
      'review-card:ws:0009-x',
    )
  })

  it('clicking Review does not also trigger the card onClick (sibling, not nested)', () => {
    const onClick = vi.fn()
    const onReview = vi.fn()
    render(<FeatureCard feature={makeFeature()} onClick={onClick} onReview={onReview} workspaceSlug="ws" />)
    fireEvent.click(screen.getByRole('button', { name: /review changes/i }))
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// IdeationCard
// ---------------------------------------------------------------------------

describe('IdeationCard', () => {
  it('renders title', () => {
    render(<IdeationCard item={makeIdeationItem({ title: 'Big Idea' })} />)
    expect(screen.getByText('Big Idea')).toBeInTheDocument()
  })

  it('calls onClick when clicked', () => {
    const onClickMock = vi.fn()
    const item = makeIdeationItem({ title: 'Clickable Idea' })
    render(<IdeationCard item={item} onClick={onClickMock} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClickMock).toHaveBeenCalledWith(item)
  })

  it('calls onClick on Enter key', () => {
    const onClickMock = vi.fn()
    const item = makeIdeationItem({ title: 'Key Idea' })
    render(<IdeationCard item={item} onClick={onClickMock} />)
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' })
    expect(onClickMock).toHaveBeenCalledWith(item)
  })

  it('calls onClick on Space key', () => {
    const onClickMock = vi.fn()
    const item = makeIdeationItem({ title: 'Space Idea' })
    render(<IdeationCard item={item} onClick={onClickMock} />)
    fireEvent.keyDown(screen.getByRole('button'), { key: ' ' })
    expect(onClickMock).toHaveBeenCalledWith(item)
  })

  it('does not have button role without onClick', () => {
    render(<IdeationCard item={makeIdeationItem()} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// FeatureBoard
// ---------------------------------------------------------------------------

describe('FeatureBoard', () => {
  it('renders all column headers', () => {
    render(<FeatureBoard features={[]} ideationItems={[]} />)
    expect(screen.getByText('Ideation')).toBeInTheDocument()
    expect(screen.getByText('TODO')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('shows empty state for empty columns', () => {
    render(<FeatureBoard features={[]} ideationItems={[]} />)
    // Empty columns render blank spacer divs instead of "Empty" text
    expect(screen.queryByText('Empty')).not.toBeInTheDocument()
    // All 4 column headers should still be present
    expect(screen.getByText('Ideation')).toBeInTheDocument()
    expect(screen.getByText('TODO')).toBeInTheDocument()
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('Done')).toBeInTheDocument()
  })

  it('places features in correct columns', () => {
    const features = [
      makeFeature({ slug: 'f1', name: 'Todo Item', status: 'todo' }),
      makeFeature({ slug: 'f2', name: 'WIP Item', status: 'in_progress' }),
      makeFeature({ slug: 'f3', name: 'Done Item', status: 'done' }),
    ]
    render(<FeatureBoard features={features} ideationItems={[]} />)
    expect(screen.getByText('Todo Item')).toBeInTheDocument()
    expect(screen.getByText('WIP Item')).toBeInTheDocument()
    expect(screen.getByText('Done Item')).toBeInTheDocument()
  })

  it('renders ideation items', () => {
    render(
      <FeatureBoard
        features={[]}
        ideationItems={[makeIdeationItem({ title: 'My Idea' })]}
      />,
    )
    expect(screen.getByText('My Idea')).toBeInTheDocument()
  })

  it('shows count badge for non-empty columns', () => {
    const features = [makeFeature({ status: 'todo' })]
    render(<FeatureBoard features={features} ideationItems={[]} />)
    // Count badge: 1
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('calls openFolder when feature is clicked with workspaceSlug', () => {
    const feature = makeFeature({ status: 'todo', directory: '/features/auth' })
    render(<FeatureBoard features={[feature]} ideationItems={[]} workspaceSlug="test-ws" />)
    fireEvent.click(screen.getByLabelText(/My Feature/))
    expect(mockDocViewerStore.openFolder).toHaveBeenCalledWith('/features/auth', 'test-ws')
  })

  it('calls openFile when ideation item is clicked with workspaceSlug', () => {
    const item = makeIdeationItem({ path: '/ideas/big-idea.md' })
    render(<FeatureBoard features={[]} ideationItems={[item]} workspaceSlug="test-ws" />)
    fireEvent.click(screen.getByLabelText(/Cool Idea/))
    expect(mockDocViewerStore.openFile).toHaveBeenCalledWith('/ideas/big-idea.md', 'test-ws')
  })

  // --- Review changes: In Progress column only (TRD §3.8.3 FR-3, 2.22) -----

  it('wires onReview only into the In Progress column, not TODO or Done', () => {
    const onReview = vi.fn()
    const features = [
      makeFeature({ slug: 'f1', name: 'Todo Item', status: 'todo' }),
      makeFeature({ slug: 'f2', name: 'WIP Item', status: 'in_progress' }),
      makeFeature({ slug: 'f3', name: 'Done Item', status: 'done' }),
    ]
    render(<FeatureBoard features={features} ideationItems={[]} workspaceSlug="test-ws" onReview={onReview} />)
    fireEvent.click(screen.getByRole('button', { name: /review changes: wip item/i }))
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /review changes: todo item/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /review changes: done item/i })).not.toBeInTheDocument()
  })

  it('does not render Review buttons without a workspaceSlug', () => {
    const onReview = vi.fn()
    render(
      <FeatureBoard features={[makeFeature({ status: 'in_progress' })]} ideationItems={[]} onReview={onReview} />,
    )
    expect(screen.queryByRole('button', { name: /review changes/i })).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// MemoryPanel
// ---------------------------------------------------------------------------

describe('MemoryPanel', () => {
  it('is collapsed by default', () => {
    render(<MemoryPanel content="# Memory" />)
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  it('expands on toggle click', () => {
    render(<MemoryPanel content="# Memory content" />)
    fireEvent.click(screen.getByRole('button', { name: /memory/i }))
    expect(screen.getByTestId('markdown')).toBeInTheDocument()
  })

  it('aria-expanded reflects state', () => {
    render(<MemoryPanel content="# Memory" />)
    const btn = screen.getByRole('button', { name: /memory/i })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-expanded', 'true')
  })

  it('does NOT render raw HTML (XSS test)', () => {
    render(<MemoryPanel content={'<script>alert(1)</script>\n<img onerror="alert(2)" src="x">'} />)
    fireEvent.click(screen.getByRole('button', { name: /memory/i }))
    // The mock just renders content as text — no script or img elements created
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// HistoryTimeline
// ---------------------------------------------------------------------------

describe('HistoryTimeline', () => {
  it('shows empty state when no features', () => {
    render(<HistoryTimeline features={[]} />)
    expect(screen.getByText('No features shipped yet.')).toBeInTheDocument()
  })

  it('renders shipped feature rows', () => {
    render(<HistoryTimeline features={[makeShippedFeature({ name: 'Auth System' })]} />)
    expect(screen.getByText('Auth System')).toBeInTheDocument()
  })

  it('expands feature details on click', () => {
    render(<HistoryTimeline features={[makeShippedFeature({ name: 'Auth System' })]} />)
    fireEvent.click(screen.getByRole('button', { name: /Auth System/i }))
    expect(screen.getByText('3/3 passed')).toBeInTheDocument()
  })

  it('shows gates passed in expanded view', () => {
    render(<HistoryTimeline features={[makeShippedFeature({ gatesPassed: '3/3 passed' })]} />)
    fireEvent.click(screen.getByRole('button', { name: /Shipped Feature/i }))
    expect(screen.getByText('3/3 passed')).toBeInTheDocument()
  })

  it('shows files changed in expanded view', () => {
    render(<HistoryTimeline features={[makeShippedFeature({ filesChanged: '8 files' })]} />)
    fireEvent.click(screen.getByRole('button', { name: /Shipped Feature/i }))
    expect(screen.getByText('8 files')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// WorkspaceDetail page
// ---------------------------------------------------------------------------

describe('WorkspaceDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWorkspaceStore.workspaces = []
  })

  it('shows loading state initially', () => {
    // No workspace in store and store is loading
    mockWorkspaceStore.loading = true
    mockWorkspaceStore.workspaces = []
    const { container } = render(<WorkspaceDetail />)
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
    mockWorkspaceStore.loading = false
  })

  it('renders workspace from store cache', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    expect(screen.getByText('Test Workspace')).toBeInTheDocument()
  })

  it('shows workspace path', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    expect(screen.getByText('/home/user/test-ws')).toBeInTheDocument()
  })

  it('shows active pipeline when present', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ activePipelines: [makePipeline({ featureName: 'Active Feature' })] }),
    ]
    render(<WorkspaceDetail />)
    expect(screen.getByText('Active Feature')).toBeInTheDocument()
  })

  it('shows empty state when no pipeline and no history', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ activePipelines: [], shippedFeatures: [] })]
    render(<WorkspaceDetail />)
    expect(screen.getByText('No features shipped yet.')).toBeInTheDocument()
  })

  it('renders level badge', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('calls fetchOne on mount to refresh workspace data', async () => {
    mockWorkspaceStore.workspaces = [makeWorkspace()]

    await act(async () => {
      render(<WorkspaceDetail />)
    })

    expect(mockWorkspaceStore.fetchOne).toHaveBeenCalledWith('test-ws')
  })

  it('shows error state when fetchOne fails', async () => {
    mockWorkspaceStore.fetchOne.mockRejectedValueOnce(new Error('Network error'))
    mockWorkspaceStore.workspaces = []

    await act(async () => {
      render(<WorkspaceDetail />)
    })

    expect(screen.getByText('Network error')).toBeInTheDocument()
  })

  it('shows "Workspace not found." when no workspace and no error', async () => {
    const mockGetDetail = window.cornerOffice.workspace.getDetail as ReturnType<typeof vi.fn>
    mockGetDetail.mockResolvedValue({ ok: true, data: null })
    mockWorkspaceStore.workspaces = []

    await act(async () => {
      render(<WorkspaceDetail />)
    })

    expect(screen.getByText('Workspace not found.')).toBeInTheDocument()
  })

  it('shows parked pipelines when present', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ parkedPipelines: [makePipeline({ featureName: 'Parked Feature', parkedAt: '2024-01-01' })] }),
    ]
    render(<WorkspaceDetail />)
    expect(screen.getByText('Parked Feature')).toBeInTheDocument()
  })

  it('shows shipped features history section', () => {
    // ResizeObserver not available in jsdom — provide a minimal stub
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ shippedFeatures: [makeShippedFeature({ name: 'Shipped Feature' })] }),
    ]
    render(<WorkspaceDetail />)
    expect(screen.getByText(/Shipped Features/)).toBeInTheDocument()
  })

  it('shows projectContext in empty state', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ activePipelines: [], shippedFeatures: [], projectContext: 'My project context' }),
    ]
    render(<WorkspaceDetail />)
    expect(screen.getByText('My project context')).toBeInTheDocument()
  })

  it('renders MemoryPanel when projectContext present', () => {
    mockWorkspaceStore.workspaces = [
      makeWorkspace({ activePipelines: [makePipeline()], projectContext: 'Project summary' }),
    ]
    render(<WorkspaceDetail />)
    // MemoryPanel is present (collapsed by default but mounted)
    expect(screen.getByText('Memory')).toBeInTheDocument()
  })

  it('renders Browse Docs button', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    expect(screen.getByRole('button', { name: /browse docs/i })).toBeInTheDocument()
  })

  it('calls openFolder with docsRoot and slug when Browse Docs clicked', () => {
    mockDocViewerStore.openFolder.mockClear()
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    fireEvent.click(screen.getByRole('button', { name: /browse docs/i }))
    expect(mockDocViewerStore.openFolder).toHaveBeenCalledWith('/home/user/test-ws/docs', 'test-ws')
  })

  it('Browse Docs button is disabled when docsRootExists is false', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ docsRootExists: false })]
    render(<WorkspaceDetail />)
    const btn = screen.getByRole('button', { name: /browse docs/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Docs directory not found — try refreshing')
  })

  it('Browse Docs button is enabled when docsRootExists is true', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ docsRootExists: true })]
    render(<WorkspaceDetail />)
    const btn = screen.getByRole('button', { name: /browse docs/i })
    expect(btn).not.toBeDisabled()
    expect(btn).not.toHaveAttribute('title')
  })

  // --- Browse Code (TRD §3.8.3 FR-1, §3.3.1, step 2.21) ---------------------

  it('renders a Browse Code button with a workspace-scoped data-return-focus id (Fix #130)', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    const btn = screen.getByRole('button', { name: /browse code/i })
    expect(btn).toHaveAttribute('data-return-focus', 'browse-code:test-ws')
  })

  it('is enabled with a shortcut tooltip when repoRootStatus is ok', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ repoRootStatus: 'ok' })]
    render(<WorkspaceDetail />)
    const btn = screen.getByRole('button', { name: /browse code/i })
    expect(btn).not.toBeDisabled()
    expect(btn.getAttribute('title')).toMatch(/Shift\+E/)
  })

  it('is disabled with the missing-folder tooltip when repoRootStatus is missing', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ repoRootStatus: 'missing' })]
    render(<WorkspaceDetail />)
    const btn = screen.getByRole('button', { name: /browse code/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Workspace folder not found — try refreshing')
  })

  it('is disabled with the unsafe-root tooltip when repoRootStatus is unsafe', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace({ repoRootStatus: 'unsafe' })]
    render(<WorkspaceDetail />)
    const btn = screen.getByRole('button', { name: /browse code/i })
    expect(btn).toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Code explorer is disabled for your home folder or a drive root')
  })

  it('navigates to the code explorer route when clicked', () => {
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    fireEvent.click(screen.getByRole('button', { name: /browse code/i }))
    expect(mockNavigate).toHaveBeenCalledWith('/workspace/test-ws/code?entry=browse')
  })

  it('restores focus to the Browse Code button on mount when a return-focus id is pending (TRD §3.8.1)', () => {
    setPendingReturnFocus('browse-code:test-ws')
    mockWorkspaceStore.workspaces = [makeWorkspace()]
    render(<WorkspaceDetail />)
    expect(screen.getByRole('button', { name: /browse code/i })).toHaveFocus()
  })

  // Fix #130 (HIGH, review-2.21.md): the id must be workspace-scoped, or
  // navigating from workspace A's explorer to workspace B's detail page (not
  // "Back") steals focus onto B's Browse Code button, which nobody clicked.
  // Reproduces the exact bug: before the fix, EVERY workspace's button used
  // the same flat 'browse-code' id, so a pending id captured from workspace
  // A's own trigger (also 'browse-code', pre-fix) would incorrectly match
  // workspace B's button too. This workspace's own scoped id is
  // 'browse-code:test-ws' (see useParams mock above), which the flat legacy
  // string must NOT match.
  it('does NOT steal focus for a pending id captured from a different workspace (pre-fix flat id)', () => {
    setPendingReturnFocus('browse-code')
    mockWorkspaceStore.workspaces = [makeWorkspace()] // slug: 'test-ws'
    render(<WorkspaceDetail />)
    expect(screen.getByRole('button', { name: /browse code/i })).not.toHaveFocus()
  })

  // --- Review entries (TRD §3.8.3 FR-3, §4.2, step 2.22) --------------------

  describe('Review entries', () => {
    it('PipelineTrack Review opens the explorer with changed/branch/review params', () => {
      mockWorkspaceStore.workspaces = [
        makeWorkspace({
          activePipelines: [makePipeline({ slug: '0001-my-feature', branch: 'feat/my-feature' })],
        }),
      ]
      render(<WorkspaceDetail />)
      fireEvent.click(screen.getByRole('button', { name: /review/i }))
      expect(mockNavigate).toHaveBeenCalledWith(
        '/workspace/test-ws/code?changed=1&baseline=branch&branch=feat%2Fmy-feature&entry=review',
      )
    })

    it('PipelineTrack Review carries a workspace-scoped data-return-focus id', () => {
      mockWorkspaceStore.workspaces = [
        makeWorkspace({ activePipelines: [makePipeline({ slug: '0001-my-feature' })] }),
      ]
      render(<WorkspaceDetail />)
      expect(screen.getByRole('button', { name: /review/i })).toHaveAttribute(
        'data-return-focus',
        'review:test-ws:0001-my-feature',
      )
    })

    it('FeatureCard Review (In Progress) opens the explorer with the matching pipeline branch', () => {
      mockWorkspaceStore.workspaces = [
        makeWorkspace({
          features: [makeFeature({ slug: '0002-thing', name: 'Thing', status: 'in_progress' })],
          activePipelines: [makePipeline({ slug: '0002-thing', branch: 'feat/thing' })],
        }),
      ]
      render(<WorkspaceDetail />)
      fireEvent.click(screen.getByRole('button', { name: /review changes: thing/i }))
      expect(mockNavigate).toHaveBeenCalledWith(
        '/workspace/test-ws/code?changed=1&baseline=branch&branch=feat%2Fthing&entry=review',
      )
    })

    it('FeatureCard Review falls back to no expected branch when no active pipeline matches the slug', () => {
      mockWorkspaceStore.workspaces = [
        makeWorkspace({
          features: [makeFeature({ slug: '0003-orphan', name: 'Orphan', status: 'in_progress' })],
          activePipelines: [],
        }),
      ]
      render(<WorkspaceDetail />)
      fireEvent.click(screen.getByRole('button', { name: /review changes: orphan/i }))
      expect(mockNavigate).toHaveBeenCalledWith('/workspace/test-ws/code?changed=1&baseline=branch&entry=review')
    })

    it('does not render a Review button on TODO or Done FeatureCards', () => {
      mockWorkspaceStore.workspaces = [
        makeWorkspace({
          features: [
            makeFeature({ slug: '0004-todo', name: 'Todo Thing', status: 'todo' }),
            makeFeature({ slug: '0005-done', name: 'Done Thing', status: 'done' }),
          ],
        }),
      ]
      render(<WorkspaceDetail />)
      expect(screen.queryByRole('button', { name: /review changes: todo thing/i })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /review changes: done thing/i })).not.toBeInTheDocument()
    })

    it('has no nested interactive elements anywhere on the page (assertNoNestedInteractive)', () => {
      mockWorkspaceStore.workspaces = [
        makeWorkspace({
          activePipelines: [makePipeline({ slug: '0001-my-feature' })],
          features: [makeFeature({ slug: '0001-my-feature', status: 'in_progress' })],
        }),
      ]
      const { container } = render(<WorkspaceDetail />)
      assertNoNestedInteractive(container)
    })
  })
})
