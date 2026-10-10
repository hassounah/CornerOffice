import React from 'react'
import { DisabledReason } from '../shared/DisabledReason'
import { SessionSelector } from './SessionSelector'

// ---------------------------------------------------------------------------
// ChatUnavailable — the chat panel's place when the live session's agent has
// no channels (#0037 C6, TRD §4.11, UX-H6). The session list shows an empty
// state carrying the reason, and the chat entry is disabled through
// DisabledReason, so it stays focusable and explains itself. No channel badge:
// there is no channel session to describe.
// ---------------------------------------------------------------------------

export function ChatUnavailable({ reason, skin = 'office' }: { reason: string; skin?: 'office' | 'realm' }): React.ReactElement {
  return (
    <section aria-label="Chat" className="flex h-full flex-col gap-3 p-3" data-testid="chat-unavailable">
      <SessionSelector sessions={[]} activeSessionId={null} onSelect={() => {}} emptyReason={reason} />
      <DisabledReason reason={reason} skin={skin}>
        {(props) => (
          <button
            type="button"
            {...props}
            className="self-start rounded-md border border-stone-700/60 bg-stone-900/80 px-3 py-1.5 text-sm text-stone-400 aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
          >
            Chat
          </button>
        )}
      </DisabledReason>
    </section>
  )
}
