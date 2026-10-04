import React, { useId, useState } from 'react'
import { validateAllowlistEntry } from '../../utils/allowlist-validate'
import { DisabledReason } from '../shared/DisabledReason'

// ---------------------------------------------------------------------------
// AllowlistEditor — a textarea-free list editor for the egress allowlist
// (step 5.7, TRD 5.3 part §3.15.2, UX-M1 (Gate 1), D9). Skin-agnostic logic
// component (TRD §3.15.2 "components/sandbox/" note): `skin: 'office' |
// 'realm'` picks the chrome only, copy and behavior are identical.
//
// Controlled: the caller (5.8b's SandboxSettingsPanel, for both the global
// list and a picked workspace's additions) owns `entries` and receives
// `onAdd`/`onRemove`. Validation and normalization happen here as the user
// types, via allowlist-validate.ts's wrapper around sandbox-allowlist.ts's
// pure §3.8.1 grammar — `onAdd` is only ever called with an already-valid,
// normalized, non-duplicate entry.
//
// UX-M1 (Gate 1): the validation message has role="alert" and is referenced
// by the input's aria-describedby; the input sets aria-invalid while
// invalid. Validated live (as you type), not just on blur/submit.
// ---------------------------------------------------------------------------

export interface AllowlistEditorProps {
  entries: readonly string[]
  onAdd: (entry: string) => void
  onRemove: (entry: string) => void
  skin?: 'office' | 'realm'
}

const FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#c9a84c]'

const REALM_INPUT_STYLE: React.CSSProperties = {
  background: 'rgba(10,6,2,0.6)',
  border: '1px solid rgba(201,168,76,0.4)',
  color: '#e8dcc8',
  fontFamily: 'serif',
}

const REALM_INPUT_INVALID_STYLE: React.CSSProperties = {
  ...REALM_INPUT_STYLE,
  border: '1px solid #e05c5c',
}

const REALM_CHIP_STYLE: React.CSSProperties = {
  background: 'rgba(30,20,10,0.6)',
  border: '1px solid rgba(201,168,76,0.3)',
  color: '#e8dcc8',
  fontFamily: 'serif',
}

export function AllowlistEditor({ entries, onAdd, onRemove, skin = 'office' }: AllowlistEditorProps): React.ReactElement {
  const [draft, setDraft] = useState('')
  const errorId = useId()
  const isRealm = skin === 'realm'

  const trimmed = draft.trim()
  const hasInput = trimmed !== ''
  const { normalized, valid } = hasInput ? validateAllowlistEntry(trimmed) : { normalized: '', valid: true }
  const isDuplicate = hasInput && valid && entries.includes(normalized)
  const invalid = hasInput && (!valid || isDuplicate)
  const errorMessage = !valid ? 'Not a valid domain (e.g. example.com or *.example.com).' : 'Already in the list.'
  // Add is never natively disabled (§3.15.1): it stays focusable and says why it does nothing.
  const addBlockedReason = !hasInput ? 'Type a site to add first.' : invalid ? errorMessage : null

  function commit(): void {
    if (!hasInput || invalid) return
    onAdd(normalized)
    setDraft('')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    }
  }

  return (
    <div>
      {entries.length > 0 && (
        <div className={isRealm ? undefined : 'flex flex-wrap gap-1.5 mb-3'} style={isRealm ? { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } : undefined}>
          {entries.map((entry) => (
            <span
              key={entry}
              className={isRealm ? undefined : 'inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-co-bg-tertiary border border-white/[0.04] text-co-text-secondary'}
              style={isRealm ? { ...REALM_CHIP_STYLE, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, padding: '2px 8px', borderRadius: 999 } : undefined}
            >
              {entry}
              <button
                type="button"
                aria-label={`Remove ${entry}`}
                onClick={() => onRemove(entry)}
                className={isRealm ? FOCUS : `${FOCUS} text-co-text-muted hover:text-co-text-secondary transition-colors`}
                style={isRealm ? { color: '#c9a84c', background: 'transparent', border: 'none', cursor: 'pointer' } : undefined}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={isRealm ? undefined : 'flex gap-2 max-w-sm'} style={isRealm ? { display: 'flex', gap: 8, maxWidth: 320 } : undefined}>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="example.com"
          aria-label="Add allowlist entry"
          aria-invalid={invalid ? 'true' : 'false'}
          aria-describedby={invalid ? errorId : undefined}
          className={isRealm ? FOCUS : [
            'flex-1 px-3 py-1.5 rounded bg-co-bg-tertiary border text-sm text-co-text-primary',
            'focus:outline-none focus:border-co-accent placeholder:text-co-text-muted',
            invalid ? 'border-red-500' : 'border-white/[0.04]',
          ].join(' ')}
          style={isRealm ? (invalid ? REALM_INPUT_INVALID_STYLE : REALM_INPUT_STYLE) : undefined}
        />
        <DisabledReason reason={addBlockedReason} skin={skin}>
          {(props) => (
            <button
              type="button"
              onClick={commit}
              className={isRealm ? FOCUS : `${FOCUS} px-3 py-1.5 rounded bg-co-bg-tertiary border border-white/[0.04] text-sm text-co-text-secondary hover:text-co-text-primary transition-colors ${addBlockedReason ? 'opacity-50 cursor-not-allowed' : ''}`}
              style={isRealm ? { background: 'rgba(201,168,76,0.15)', border: '1px solid #c9a84c', color: '#c9a84c', borderRadius: 3, padding: '4px 12px', fontFamily: 'serif', cursor: addBlockedReason ? 'not-allowed' : 'pointer', opacity: addBlockedReason ? 0.5 : 1 } : undefined}
              {...props}
            >
              Add
            </button>
          )}
        </DisabledReason>
      </div>

      {invalid && (
        <p
          id={errorId}
          role="alert"
          className={isRealm ? undefined : 'text-xs text-red-400 mt-1'}
          style={isRealm ? { color: '#e05c5c', fontSize: 12, marginTop: 4, fontFamily: 'serif' } : undefined}
        >
          {errorMessage}
        </p>
      )}

      <p
        className={isRealm ? undefined : 'text-xs text-co-text-muted mt-1.5'}
        style={isRealm ? { color: '#a8916a', fontSize: 12, marginTop: 6, fontFamily: 'serif' } : undefined}
      >
        Entries include subdomains.
      </p>
    </div>
  )
}
