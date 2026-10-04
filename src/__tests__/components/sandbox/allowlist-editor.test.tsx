import React, { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AllowlistEditor } from '../../../renderer/components/sandbox/AllowlistEditor'

// ---------------------------------------------------------------------------
// AllowlistEditor — step 5.7 (TRD 5.3 part, §3.15.2, UX-M1 (Gate 1), D9).
// ---------------------------------------------------------------------------

/** A stateful wrapper — AllowlistEditor is controlled, so the tests that
 *  exercise add/remove need a real entries array behind onAdd/onRemove. */
function ControlledEditor({
  initial = [],
  skin,
}: {
  initial?: string[]
  skin?: 'office' | 'realm'
}): React.ReactElement {
  const [entries, setEntries] = useState<string[]>(initial)
  return (
    <AllowlistEditor
      entries={entries}
      onAdd={(entry) => setEntries((prev) => [...prev, entry])}
      onRemove={(entry) => setEntries((prev) => prev.filter((e) => e !== entry))}
      skin={skin}
    />
  )
}

describe.each(['office', 'realm'] as const)('AllowlistEditor (skin=%s)', (skin) => {
  it('renders existing entries and the subdomains note', () => {
    render(<ControlledEditor initial={['github.com', 'npmjs.org']} skin={skin} />)
    expect(screen.getByText('github.com')).toBeInTheDocument()
    expect(screen.getByText('npmjs.org')).toBeInTheDocument()
    expect(screen.getByText('Entries include subdomains.')).toBeInTheDocument()
  })

  it('adds a valid entry and clears the input', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, 'example.com')
    await user.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(input).toHaveValue('')
  })

  it('adds a valid entry on Enter', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, 'example.com{Enter}')
    expect(screen.getByText('example.com')).toBeInTheDocument()
  })

  it('normalizes a leading *. before adding (D9)', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, '*.x.y{Enter}')
    expect(screen.getByText('x.y')).toBeInTheDocument()
    expect(screen.queryByText('*.x.y')).not.toBeInTheDocument()
  })

  it('shows role="alert" and aria-invalid for an invalid entry, referenced by aria-describedby', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, 'not a domain')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Not a valid domain (e.g. example.com or *.example.com).')
    expect(input).toHaveAttribute('aria-describedby', alert.id)
  })

  it('does not add an invalid entry, on click or Enter', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, 'not a domain{Enter}')
    expect(screen.queryByText('not a domain')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-disabled', 'true')
  })

  it('Add is never natively disabled: with nothing typed it is aria-disabled, explains itself and adds nothing', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(<AllowlistEditor entries={[]} onAdd={onAdd} onRemove={() => {}} skin={skin} />)
    const add = screen.getByRole('button', { name: 'Add' })

    expect(add).toHaveAttribute('aria-disabled', 'true')
    expect(add).not.toBeDisabled()
    await user.click(add)
    expect(onAdd).not.toHaveBeenCalled()
    fireEvent.focus(add)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Type a site to add first.')
  })

  it('rejects a bare TLD (single label) as invalid', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, 'localhost')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('dedupes: adding an already-present entry shows the alert, disables Add, and does not duplicate it', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={['github.com']} skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, 'github.com')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Already in the list.')
    expect(screen.getByRole('button', { name: 'Add' })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getAllByText('github.com')).toHaveLength(1)
  })

  it('dedupes case- and *.-insensitively against an existing entry', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={['github.com']} skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, '*.GITHUB.com')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent('Already in the list.')
  })

  it('clears the invalid state once the input is corrected', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, 'not a domain')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    await user.clear(input)
    await user.type(input, 'example.com')
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('removes an entry via its remove button', async () => {
    const user = userEvent.setup()
    render(<ControlledEditor initial={['github.com', 'npmjs.org']} skin={skin} />)
    await user.click(screen.getByRole('button', { name: 'Remove github.com' }))
    expect(screen.queryByText('github.com')).not.toBeInTheDocument()
    expect(screen.getByText('npmjs.org')).toBeInTheDocument()
  })

  it('calls onAdd with the normalized value, not the raw input', async () => {
    const user = userEvent.setup()
    const onAdd = vi.fn()
    render(<AllowlistEditor entries={[]} onAdd={onAdd} onRemove={() => {}} skin={skin} />)
    const input = screen.getByRole('textbox', { name: 'Add allowlist entry' })
    await user.type(input, '*.Example.COM{Enter}')
    expect(onAdd).toHaveBeenCalledWith('example.com')
  })
})

describe('AllowlistEditor — default skin', () => {
  it('defaults to office skin when skin is omitted', () => {
    render(<AllowlistEditor entries={['github.com']} onAdd={() => {}} onRemove={() => {}} />)
    expect(screen.getByText('github.com')).toBeInTheDocument()
  })
})
