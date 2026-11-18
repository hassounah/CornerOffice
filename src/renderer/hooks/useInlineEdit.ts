import { useRef, useState } from 'react'
import type { ChangeEvent, FocusEvent, KeyboardEvent } from 'react'
import { workspaceErrorMessage } from '../utils/workspace-errors'
import type { WorkspaceErrorContext } from '../utils/workspace-errors'

// ---------------------------------------------------------------------------
// useInlineEdit — the save-on-blur text field behind the workspace manager's Display name and Docs root (#0039, TRD
// §4.9 UX M9, M-7, H-6).
//
//  - Blur or Enter saves, when the value changed.
//  - Esc reverts. The blur that follows does NOT save (UX M-7).
//  - An empty value reverts and says why, when `emptyMessage` is set; otherwise it saves `null` (a reset).
//  - A quiet "Saved" status appears after a save. An error stays until the next edit.
//  - Realm: Esc on a dirty edit stops the event, so the Settings chamber behind it stays open (UX H-6).
// ---------------------------------------------------------------------------

export interface InlineEditOptions {
  /** The value saved in main right now. The field resets to it when it changes from outside. */
  value: string
  /** Persist `next` (`null` = reset to the default). Rejects with an `IpcError` carrying a fixed code. */
  save: (next: string | null) => Promise<unknown>
  /** Set: an empty value reverts and shows this. Unset: an empty value saves `null`. */
  emptyMessage?: string
  /** `realm` stops Esc from reaching the chamber when there is something to revert. */
  skin: 'office' | 'realm'
  /** Which field this is, so a validation error says what that field accepts. */
  context?: WorkspaceErrorContext
}

export interface InlineEdit {
  /** The text in the field. */
  draft: string
  dirty: boolean
  saved: boolean
  error: string | null
  saving: boolean
  inputProps: {
    value: string
    onChange: (e: ChangeEvent<HTMLInputElement>) => void
    onBlur: (e: FocusEvent<HTMLInputElement>) => void
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  }
  /** Save an explicit value now (the Browse… result, Reset). */
  commit: (next: string | null) => Promise<void>
}

export function useInlineEdit({ value, save, emptyMessage, skin, context }: InlineEditOptions): InlineEdit {
  // `draft` is what the user typed; it is `null` while the field simply shows the saved value.
  const [draft, setDraft] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const inFlight = useRef(false)
  const skipBlur = useRef(false)

  const shown = draft ?? value
  const dirty = draft !== null && draft !== value

  async function run(next: string | null): Promise<void> {
    if (inFlight.current) return // Enter and the blur that follows it are one save
    inFlight.current = true
    setSaving(true)
    setError(null)
    try {
      await save(next)
      setDraft(null)
      setSaved(true)
    } catch (err) {
      setError(workspaceErrorMessage((err as { code?: string }).code, { context }))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  async function commitDraft(): Promise<void> {
    if (!dirty || draft === null) {
      setDraft(null)
      return
    }
    const trimmed = draft.trim()
    if (trimmed === '') {
      if (emptyMessage !== undefined) {
        setDraft(null)
        setError(emptyMessage)
        return
      }
      await run(null)
      return
    }
    if (trimmed === value) {
      setDraft(null)
      return
    }
    await run(trimmed)
  }

  return {
    draft: shown,
    dirty,
    saved,
    error,
    saving,
    inputProps: {
      value: shown,
      onChange: (e) => {
        skipBlur.current = false
        setSaved(false)
        setError(null)
        setDraft(e.target.value)
      },
      onBlur: () => {
        if (skipBlur.current) {
          skipBlur.current = false
          return
        }
        void commitDraft()
      },
      onKeyDown: (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commitDraft()
        } else if (e.key === 'Escape' && dirty) {
          // Something to revert: Esc is spent on that, and must not also close the Settings chamber (realm).
          if (skin === 'realm') e.stopPropagation()
          e.preventDefault()
          skipBlur.current = true
          setDraft(null)
          setError(null)
        }
      },
    },
    commit: (next) => run(next),
  }
}
