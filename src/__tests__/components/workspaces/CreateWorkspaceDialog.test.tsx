import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { CreateWorkspaceDialog } from '../../../renderer/components/workspaces/CreateWorkspaceDialog'
import { useWorkspaceStore } from '../../../renderer/stores/workspace-store'
import { LAST_PARENT_KEY } from '../../../renderer/utils/workspace-prefs'
import { expectNoAxeViolations } from '../../helpers/a11y'
import { installWorkspaceApi, type WorkspaceApiMock } from '../../helpers/workspace-api-mock'
import { makeWorkspace } from '../../helpers/workspace-fixture'

let api: WorkspaceApiMock

beforeEach(() => {
  window.localStorage.clear()
  useWorkspaceStore.setState({ workspaces: [], pending: new Set(), createWarnings: new Map(), highlightSlug: null })
  api = installWorkspaceApi(() => [makeWorkspace({ slug: 'seed', path: '/home/amer/seed' })])
})
afterEach(() => window.localStorage.clear())

const nameInput = (): HTMLInputElement => screen.getByLabelText('Name') as HTMLInputElement
const createButton = (): HTMLButtonElement => screen.getByRole('button', { name: /^Create/ }) as HTMLButtonElement

function openWith(props: { onClose?: () => void; onCreated?: (ws: unknown) => void } = {}): ReturnType<typeof render> {
  return render(<CreateWorkspaceDialog open onClose={props.onClose ?? vi.fn()} onCreated={props.onCreated} />)
}

describe('opening', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<CreateWorkspaceDialog open={false} onClose={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('is a named dialog, with focus on Name', () => {
    openWith()
    expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeInTheDocument()
    expect(nameInput()).toHaveFocus()
  })

  it('Location defaults to the last parent used (UX L-1)', () => {
    window.localStorage.setItem(LAST_PARENT_KEY, '/home/amer/code')
    openWith()
    expect(screen.getByTestId('create-location')).toHaveTextContent('~/code')
  })

  it('else to the home folder, read off a registered workspace', () => {
    useWorkspaceStore.setState({ workspaces: [makeWorkspace({ slug: 'a', path: '/home/amer/projects/a' })] })
    openWith()
    expect(screen.getByTestId('create-location')).toHaveTextContent('~')
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    expect(screen.getByTestId('create-preview')).toHaveTextContent('Will create ~/fresh')
  })

  it('else unset: Create stays disabled until a folder is chosen', () => {
    openWith()
    expect(screen.getByTestId('create-location')).toHaveTextContent('No folder chosen')
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    expect(createButton()).toBeDisabled()
  })

  it('survives a storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    openWith()
    expect(screen.getByTestId('create-location')).toHaveTextContent('No folder chosen')
    spy.mockRestore()
  })
})

describe('name validation as the user types', () => {
  beforeEach(() => window.localStorage.setItem(LAST_PARENT_KEY, '/home/amer/code'))

  it.each(['', '-lead', '.hidden', 'a/b', 'x'.repeat(65)])('%j is not valid: Create is disabled', (value) => {
    openWith()
    fireEvent.change(nameInput(), { target: { value } })
    expect(createButton()).toBeDisabled()
  })

  it('an invalid, non-empty name shows the rule', () => {
    openWith()
    fireEvent.change(nameInput(), { target: { value: 'a/b' } })
    expect(screen.getByText('Use letters, numbers, spaces, dots, dashes or underscores (up to 64), starting with a letter or number.')).toBeInTheDocument()
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
  })

  it('an empty name shows no hint yet', () => {
    openWith()
    expect(screen.queryByText(/Use letters/)).toBeNull()
  })

  it('a valid name enables Create and previews the folder', () => {
    openWith()
    fireEvent.change(nameInput(), { target: { value: 'my-app' } })
    expect(createButton()).toBeEnabled()
    expect(screen.getByTestId('create-preview')).toHaveTextContent('Will create ~/code/my-app')
    expect(screen.queryByText(/Shown as/)).toBeNull()
  })

  it('"My App" is shown as typed when the id differs', () => {
    openWith()
    fireEvent.change(nameInput(), { target: { value: 'My App' } })
    expect(screen.getByTestId('create-preview')).toHaveTextContent('Shown as "My App"')
  })
})

describe('type', () => {
  beforeEach(() => window.localStorage.setItem(LAST_PARENT_KEY, '/home/amer/code'))

  it('defaults to a Rix workspace, and describes both', () => {
    openWith()
    expect(screen.getByRole('radio', { name: /Rix workspace/ })).toBeChecked()
    expect(screen.getByRole('radio', { name: /Empty folder/ })).not.toBeChecked()
    expect(screen.getByText('Just a folder. Add Rix later.')).toBeInTheDocument()
    expect(screen.getByText(/runs git init on main/)).toBeInTheDocument()
  })

  it('sends the chosen mode', async () => {
    openWith()
    fireEvent.change(nameInput(), { target: { value: 'notes' } })
    fireEvent.click(screen.getByRole('radio', { name: /Empty folder/ }))
    fireEvent.click(createButton())
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('/home/amer/code', 'notes', 'plain'))
  })
})

describe('choosing a location', () => {
  it('Choose… uses the create-parent picker and shows the result', async () => {
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/elsewhere' }, error: null })
    openWith()
    fireEvent.click(screen.getByRole('button', { name: 'Choose location' }))
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalledWith('create-parent'))
    await waitFor(() => expect(screen.getByTestId('create-location')).toHaveTextContent('~/elsewhere'))
  })

  it('cancelling the picker keeps the location', async () => {
    window.localStorage.setItem(LAST_PARENT_KEY, '/home/amer/code')
    openWith()
    fireEvent.click(screen.getByRole('button', { name: 'Choose location' }))
    await waitFor(() => expect(api.pickFolder).toHaveBeenCalled())
    expect(screen.getByTestId('create-location')).toHaveTextContent('~/code')
  })

  it('a failed picker shows fixed copy', async () => {
    api.fail('pickFolder', 'NOT_READY')
    openWith()
    fireEvent.click(screen.getByRole('button', { name: 'Choose location' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Corner Office is still starting')
  })
})

describe('creating', () => {
  beforeEach(() => window.localStorage.setItem(LAST_PARENT_KEY, '/home/amer/code'))

  it('creates, remembers the parent, reports the workspace and closes', async () => {
    const onClose = vi.fn()
    const onCreated = vi.fn()
    openWith({ onClose, onCreated })
    window.localStorage.removeItem(LAST_PARENT_KEY)
    api.pickFolder.mockResolvedValue({ data: { path: '/home/amer/projects' }, error: null })
    fireEvent.click(screen.getByRole('button', { name: 'Choose location' }))
    await waitFor(() => expect(screen.getByTestId('create-location')).toHaveTextContent('~/projects'))
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('/home/amer/projects', 'fresh', 'rix'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ slug: 'fresh' }))
    expect(window.localStorage.getItem(LAST_PARENT_KEY)).toBe('/home/amer/projects')
  })

  it('Enter in the name field submits', async () => {
    openWith()
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.submit(nameInput().closest('form') as HTMLFormElement)
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
  })

  it('warnings go to the store (the row shows them), not into the dialog', async () => {
    api.create.mockResolvedValue({ data: { workspace: { ...makeWorkspace({ slug: 'fresh', path: '/home/amer/code/fresh' }) }, warnings: ['git-commit-failed'] }, error: null })
    openWith()
    fireEvent.change(nameInput(), { target: { value: 'fresh' } })
    fireEvent.click(createButton())
    await waitFor(() => expect(useWorkspaceStore.getState().createWarnings.get('fresh')).toEqual(['git-commit-failed']))
    expect(screen.queryByText(/first commit failed/)).toBeNull()
  })

  it('shows an error inline, keeps the dialog open and the input, and clears it on the next edit', async () => {
    api.fail('create', 'WORKSPACE_EXISTS')
    const onClose = vi.fn()
    openWith({ onClose })
    fireEvent.change(nameInput(), { target: { value: 'taken' } })
    fireEvent.click(createButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('A folder with that name already exists here.')
    expect(onClose).not.toHaveBeenCalled()
    expect(nameInput().value).toBe('taken')
    expect(nameInput()).not.toHaveAttribute('readonly')
    fireEvent.change(nameInput(), { target: { value: 'taken-2' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  describe('pending (UX H-5)', () => {
    function holdCreate(): () => void {
      let release: () => void = () => undefined
      api.create.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ data: { workspace: makeWorkspace({ slug: 'fresh', path: '/home/amer/code/fresh' }), warnings: [] }, error: null })
          }),
      )
      return () => release()
    }

    it('shows Creating…, disables every control, and a double click makes one call', async () => {
      const release = holdCreate()
      openWith()
      fireEvent.change(nameInput(), { target: { value: 'fresh' } })
      const button = createButton()
      fireEvent.click(button)
      fireEvent.click(button)
      fireEvent.submit(nameInput().closest('form') as HTMLFormElement)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Creating…' })).toHaveAttribute('aria-disabled', 'true'))
      // The submit button and the Name field keep focus while busy, so they are aria-disabled and read-only, not disabled.
      expect(screen.getByRole('button', { name: 'Creating…' })).not.toBeDisabled()
      expect(nameInput()).toHaveAttribute('readonly')
      expect(nameInput()).toHaveAttribute('aria-busy', 'true')
      expect(screen.getByRole('button', { name: 'Choose location' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
      expect(screen.getByRole('radio', { name: /Rix workspace/ })).toBeDisabled()
      expect(api.create).toHaveBeenCalledTimes(1)
      release()
      await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
    })

    it('Esc and the backdrop are ignored while in flight', async () => {
      const release = holdCreate()
      const onClose = vi.fn()
      openWith({ onClose })
      fireEvent.change(nameInput(), { target: { value: 'fresh' } })
      fireEvent.click(createButton())
      await screen.findByRole('button', { name: 'Creating…' })
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).not.toHaveBeenCalled()
      release()
      await waitFor(() => expect(onClose).toHaveBeenCalled())
    })

    it('Esc closes when nothing is in flight', () => {
      const onClose = vi.fn()
      openWith({ onClose })
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalled()
    })

    it('after a failure the form is usable again', async () => {
      api.fail('create', 'WORKSPACE_EXISTS')
      openWith()
      fireEvent.change(nameInput(), { target: { value: 'taken' } })
      fireEvent.click(createButton())
      await screen.findByRole('alert')
      expect(createButton()).toBeEnabled()
    })
  })
})

describe('closing', () => {
  it('Cancel closes', () => {
    const onClose = vi.fn()
    openWith({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('accessibility', () => {
  it('has no axe violations', async () => {
    window.localStorage.setItem(LAST_PARENT_KEY, '/home/amer/code')
    const { baseElement } = openWith()
    fireEvent.change(nameInput(), { target: { value: 'a/b' } })
    await expectNoAxeViolations(baseElement)
  })
})
