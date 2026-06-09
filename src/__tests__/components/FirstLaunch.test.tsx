import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn()
vi.mock('react-router', () => ({
  useNavigate: () => mockNavigate,
}))

const mockUpdateConfig = vi.fn().mockResolvedValue(undefined)
const mockFetchConfig = vi.fn().mockResolvedValue(undefined)
vi.mock('../../renderer/stores/settings-store', () => ({
  useSettingsStore: vi.fn(() => ({
    updateConfig: mockUpdateConfig,
    fetchConfig: mockFetchConfig,
    config: null,
    loading: false,
    error: null,
  })),
}))

const mockDiscover = vi.fn()

Object.defineProperty(window, 'cornerOffice', {
  value: {
    workspace: { discover: mockDiscover },
    config: { update: vi.fn(), get: vi.fn() },
  },
  writable: true,
  configurable: true,
})

vi.mock('../../renderer/utils/ipc', () => ({
  unwrapIpc: (r: unknown) => r,
}))

// ---------------------------------------------------------------------------
// Component import (after mocks)
// ---------------------------------------------------------------------------

import FirstLaunch from '../../renderer/pages/FirstLaunch'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderWizard() {
  return render(<FirstLaunch />)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FirstLaunch wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDiscover.mockResolvedValue([])
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // -------------------------------------------------------------------------
  // Step 1: Welcome
  // -------------------------------------------------------------------------

  describe('Step 1 — Welcome', () => {
    it('renders welcome heading', () => {
      renderWizard()
      expect(screen.getByText('Welcome to Corner Office')).toBeInTheDocument()
    })

    it('renders Get started button', () => {
      renderWizard()
      expect(screen.getByRole('button', { name: /get started/i })).toBeInTheDocument()
    })

    it('shows 3 progress dots', () => {
      renderWizard()
      const dots = document.querySelectorAll('[aria-hidden="true"] > div')
      expect(dots.length).toBeGreaterThanOrEqual(3)
    })

    it('advances to step 2 when Get started is clicked', async () => {
      renderWizard()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /get started/i }))
      })
      expect(screen.getByText('Your Workspaces')).toBeInTheDocument()
    })

    it('triggers workspace discovery when advancing to step 2', async () => {
      renderWizard()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /get started/i }))
      })
      expect(mockDiscover).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // Step 2: Workspace Discovery
  // -------------------------------------------------------------------------

  describe('Step 2 — Workspace Discovery', () => {
    async function goToStep2() {
      renderWizard()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /get started/i }))
        // Flush the discoverWorkspaces promise chain
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
    }

    it('shows empty state when no workspaces found', async () => {
      mockDiscover.mockResolvedValue([])
      await goToStep2()
      expect(screen.getByText(/no rix workspaces found/i)).toBeInTheDocument()
    })

    it('lists discovered workspaces as checkboxes (all checked by default)', async () => {
      mockDiscover.mockResolvedValue([
        { slug: 'seraph', path: '/home/amer/seraph' },
        { slug: 'helios', path: '/home/amer/helios' },
      ])
      await goToStep2()
      const checkboxes = screen.getAllByRole('checkbox')
      expect(checkboxes).toHaveLength(2)
      checkboxes.forEach((cb) => expect(cb).toBeChecked())
    })

    it('toggles workspace selection', async () => {
      mockDiscover.mockResolvedValue([
        { slug: 'seraph', path: '/home/amer/seraph' },
      ])
      await goToStep2()
      expect(screen.getByRole('checkbox')).toBeChecked()
      fireEvent.click(screen.getByRole('checkbox'))
      expect(screen.getByRole('checkbox')).not.toBeChecked()
    })

    it('Continue button advances to step 3 (Company Name)', async () => {
      await goToStep2()
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      expect(screen.getByText('Name Your Company')).toBeInTheDocument()
    })

    it('Back button returns to step 1', async () => {
      await goToStep2()
      fireEvent.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByText('Welcome to Corner Office')).toBeInTheDocument()
    })
  })

  // -------------------------------------------------------------------------
  // Step 3: Company Name
  // -------------------------------------------------------------------------

  describe('Step 3 — Company Name', () => {
    async function goToStep3() {
      renderWizard()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /get started/i }))
      })
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
    }

    it('renders company name input', async () => {
      await goToStep3()
      expect(screen.getByRole('textbox')).toBeInTheDocument()
    })

    it('"Finish setup" is disabled when input is empty', async () => {
      await goToStep3()
      expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled()
    })

    it('"Finish setup" is enabled when input has text', async () => {
      await goToStep3()
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Acme Labs' } })
      expect(screen.getByRole('button', { name: /finish setup/i })).not.toBeDisabled()
    })

    it('Back button returns to step 2', async () => {
      await goToStep3()
      fireEvent.click(screen.getByRole('button', { name: /back/i }))
      expect(screen.getByText('Your Workspaces')).toBeInTheDocument()
    })

    it('Enter key submits when name is non-empty', async () => {
      await goToStep3()
      const input = screen.getByRole('textbox')
      fireEvent.change(input, { target: { value: 'Studio 42' } })
      await act(async () => {
        fireEvent.keyDown(input, { key: 'Enter' })
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      // Should advance to step 4 (Reveal)
      expect(screen.getByText(/ready|all set/i)).toBeInTheDocument()
    })
  })

  // -------------------------------------------------------------------------
  // Step 4: The Reveal
  // -------------------------------------------------------------------------

  describe('Step 4 — The Reveal', () => {
    async function finishWizard(companyName = 'Acme Labs') {
      renderWizard()
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /get started/i }))
      })
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))
      fireEvent.change(screen.getByRole('textbox'), { target: { value: companyName } })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /finish setup/i }))
      })
    }

    it('shows company name in reveal', async () => {
      await finishWizard('Acme Labs')
      expect(screen.getByText(/acme labs is ready/i)).toBeInTheDocument()
    })

    it('hides progress dots on step 4', async () => {
      await finishWizard()
      // ProgressDots should not render on step 4
      expect(screen.queryByText('1')).not.toBeInTheDocument()
    })

    it('calls updateConfig with companyName and firstLaunchComplete', async () => {
      await finishWizard('Studio 42')
      expect(mockUpdateConfig).toHaveBeenCalledWith({
        companyName: 'Studio 42',
        firstLaunchComplete: true,
      })
    })

    it('calls fetchConfig after updateConfig', async () => {
      await finishWizard()
      expect(mockFetchConfig).toHaveBeenCalledOnce()
    })

    it('navigates to / after 1500ms', async () => {
      await finishWizard()
      expect(mockNavigate).not.toHaveBeenCalled()
      await act(async () => {
        vi.advanceTimersByTime(1500)
      })
      expect(mockNavigate).toHaveBeenCalledWith('/')
    })
  })
})
