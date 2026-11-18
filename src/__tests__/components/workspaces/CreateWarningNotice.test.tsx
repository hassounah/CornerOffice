import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { CreateWarning } from '@main/services/workspace-registry'
import { CreateWarningNotice } from '../../../renderer/components/workspaces/CreateWarningNotice'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { expectNoAxeViolations } from '../../helpers/a11y'

function warn(slug: string, ...warnings: CreateWarning[]): void {
  useWorkspaceStore.setState({ createWarnings: new Map([[slug, warnings]]) })
}

beforeEach(() => useWorkspaceStore.setState({ createWarnings: new Map() }))

describe('CreateWarningNotice', () => {
  it('renders nothing without a warning', () => {
    const { container } = render(<CreateWarningNotice slug="api" path="/home/amer/api" />)
    expect(container).toBeEmptyDOMElement()
  })

  it.each([
    ['git-unavailable', "Created. Git wasn't found, so the folder isn't a git repository yet."],
    ['git-init-failed', 'Created, but `git init` failed. Run it yourself in ~/api.'],
    ['git-commit-failed', 'Created, but the first commit failed: set `user.name` and `user.email`, then commit in ~/api.'],
  ] as const)('%s shows its copy with the folder', (token, copy) => {
    warn('api', token)
    render(<CreateWarningNotice slug="api" path="/home/amer/api" />)
    expect(screen.getByText(copy)).toBeInTheDocument()
  })

  it('only shows its own workspace', () => {
    warn('web', 'git-unavailable')
    const { container } = render(<CreateWarningNotice slug="api" path="/home/amer/api" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('a workspace named constructor is looked up as an own key', () => {
    const first = render(<CreateWarningNotice slug="constructor" path="/home/amer/constructor" />)
    expect(first.container).toBeEmptyDOMElement()
    first.unmount()
    warn('constructor', 'git-init-failed')
    render(<CreateWarningNotice slug="constructor" path="/home/amer/constructor" />)
    expect(screen.getByText(/git init/)).toBeInTheDocument()
  })

  it('Dismiss clears it from the store and the screen', () => {
    warn('api', 'git-unavailable', 'git-commit-failed')
    const { container } = render(<CreateWarningNotice slug="api" path="/home/amer/api" />)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the notice about api' }))
    expect(useWorkspaceStore.getState().createWarnings.has('api')).toBe(false)
    expect(container).toBeEmptyDOMElement()
  })

  it('has no axe violations', async () => {
    warn('api', 'git-commit-failed')
    const { container } = render(<CreateWarningNotice slug="api" path="/home/amer/api" />)
    await expectNoAxeViolations(container)
  })
})
