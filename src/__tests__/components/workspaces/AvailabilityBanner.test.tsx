import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Availability } from '@main/types/workspace'
import { AvailabilityBanner } from '../../../renderer/components/workspaces/AvailabilityBanner'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { expectNoAxeViolations } from '../../helpers/a11y'
import { installWorkspaceApi, type WorkspaceApiMock } from '../../helpers/workspace-api-mock'
import { makeWorkspace } from '../../helpers/workspace-fixture'

let api: WorkspaceApiMock

const ws = (availability: Availability) => makeWorkspace({ slug: 'api', path: '/home/amer/projects/api', displayName: 'Api', availability })

beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: [ws('missing')], pending: new Set() })
  api = installWorkspaceApi(() => useWorkspaceStore.getState().workspaces)
})

describe('copy', () => {
  it.each([
    ['missing', 'Folder not found: ~/projects/api. It may be on an unmounted drive. If you moved it, remove it and add the new location. Its name, docs-root setting and sandbox allowlist will be reset.'],
    ['unreachable', 'Folder not responding. It may be on an unmounted or slow drive.'],
    ['not-a-directory', 'This path is now a file, not a folder.'],
    ['unsafe', "Corner Office can't use this folder: it is your home folder, a folder above it, or one of the app's own folders."],
    ['moved', 'This folder now points somewhere else. If you moved it, remove it and add the new location. Its name, docs-root setting and sandbox allowlist will be reset.'],
    ['checking', 'Checking this folder…'],
  ] as const)('%s', (state, copy) => {
    render(<AvailabilityBanner workspace={ws(state)} onRemove={vi.fn()} />)
    expect(screen.getByText(copy)).toBeInTheDocument()
  })

  it('renders nothing for an available workspace', () => {
    const { container } = render(<AvailabilityBanner workspace={ws('ok')} onRemove={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('actions', () => {
  it('Remove calls the handler', () => {
    const onRemove = vi.fn()
    render(<AvailabilityBanner workspace={ws('missing')} onRemove={onRemove} />)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('Check again shows Checking…, then "Checked just now"', async () => {
    let release: () => void = () => undefined
    api.recheck.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: [ws('missing')], error: null })
        }),
    )
    render(<AvailabilityBanner workspace={ws('missing')} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    const pending = await screen.findByRole('button', { name: 'Checking…' })
    // aria-disabled, not disabled: the button has focus, and disabling it would drop focus to the page.
    expect(pending).toHaveAttribute('aria-disabled', 'true')
    expect(pending).not.toBeDisabled()
    fireEvent.click(pending)
    expect(api.recheck).toHaveBeenCalledTimes(1)
    release()
    expect(await screen.findByRole('button', { name: 'Checked just now' })).toBeInTheDocument()
  })

  it('a second check after "Checked just now" runs again', async () => {
    render(<AvailabilityBanner workspace={ws('missing')} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Checked just now' }))
    await waitFor(() => expect(api.recheck).toHaveBeenCalledTimes(2))
  })

  it('a failed check shows fixed copy and goes back to Check again', async () => {
    api.fail('recheck', 'TIMEOUT')
    render(<AvailabilityBanner workspace={ws('unreachable')} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Still not responding.')
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled()
  })

  it('a change of state resets "Checked just now"', async () => {
    const { rerender } = render(<AvailabilityBanner workspace={ws('missing')} onRemove={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await screen.findByRole('button', { name: 'Checked just now' })
    rerender(<AvailabilityBanner workspace={ws('unreachable')} onRemove={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument()
  })

  it('has no axe violations', async () => {
    const { container } = render(<AvailabilityBanner workspace={ws('moved')} onRemove={vi.fn()} />)
    await expectNoAxeViolations(container)
  })
})
