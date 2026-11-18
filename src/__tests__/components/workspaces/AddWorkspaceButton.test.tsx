import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AddWorkspaceButton } from '../../../renderer/components/workspaces/AddWorkspaceButton'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { installWorkspaceApi, type WorkspaceApiMock } from '../../helpers/workspace-api-mock'
import { makeWorkspace } from '../../helpers/workspace-fixture'

let api: WorkspaceApiMock

beforeEach(() => {
  useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'api', path: '/home/amer/api', selectedPath: '/home/amer/link/api', displayName: 'Api' })], pending: new Set(), highlightSlug: null })
  api = installWorkspaceApi(() => useWorkspaceStore.getState().workspaces)
})

describe('AddWorkspaceButton', () => {
  it('cancelling the picker does nothing', async () => {
    render(<AddWorkspaceButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalledWith('add'))
    expect(api.add).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('adds the picked folder, reports it, and highlights the row', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/new' }, error: null })
    const onAdded = vi.fn()
    render(<AddWorkspaceButton onAdded={onAdded} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await waitFor(() => expect(api.add).toHaveBeenCalledWith('/home/amer/new'))
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(expect.objectContaining({ slug: 'added' })))
    expect(useWorkspaceStore.getState().highlightSlug).toBe('added')
  })

  it('shows main\'s refusal as fixed copy under the button', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer' }, error: null })
    api.fail('add', 'WORKSPACE_UNSAFE_ROOT')
    render(<AddWorkspaceButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent("Corner Office can't use your home folder or a folder above it. Pick a project folder.")
    expect(alert).not.toHaveTextContent('secret')
  })

  it('a duplicate names the existing workspace, found by path or by the path as chosen', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/link/api' }, error: null })
    api.fail('add', 'WORKSPACE_DUPLICATE')
    render(<AddWorkspaceButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Already added as Api.')
  })

  it('a duplicate of an unknown folder uses the generic copy', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/elsewhere' }, error: null })
    api.fail('add', 'WORKSPACE_DUPLICATE')
    render(<AddWorkspaceButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This folder is already in your workspaces.')
  })

  it('a failed picker shows fixed copy', async () => {
    api.fail('pickFolder', 'NOT_READY')
    render(<AddWorkspaceButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Corner Office is still starting')
  })

  it('clears an old error on the next try, and ignores a click while busy', async () => {
    let release: () => void = () => undefined
    api.pickFolder.mockImplementationOnce(async () => ({ data: null, error: { code: 'NOT_READY', message: 'x' } }))
    render(<AddWorkspaceButton />)
    fireEvent.click(screen.getByRole('button', { name: 'Add folder…' }))
    await screen.findByRole('alert')
    api.pickFolder.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ data: { path: null }, error: null })
        }),
    )
    const button = screen.getByRole('button', { name: 'Add folder…' })
    button.focus()
    fireEvent.click(button)
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    // aria-disabled, not disabled, so focus stays on the button while the picker is open.
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).not.toBeDisabled()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    expect(api.pickFolder).toHaveBeenCalledTimes(2)
    release()
    await waitFor(() => expect(button).toHaveAttribute('aria-disabled', 'false'))
    expect(button).toHaveFocus()
  })
})
