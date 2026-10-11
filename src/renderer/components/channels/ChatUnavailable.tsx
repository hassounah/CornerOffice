import React from 'react'
import { SessionSelector } from './SessionSelector'

// ---------------------------------------------------------------------------
// ChatUnavailable — the chat panel's place when the live session's agent has
// no channels (#0037 C6, TRD §4.11, UX-H6, UX-L13). The session list shows an
// empty state carrying the reason; there is no chat entry to disable, since a
// button that can never work only adds a dead stop. No channel badge: there is
// no channel session to describe.
// ---------------------------------------------------------------------------

export function ChatUnavailable({ reason }: { reason: string }): React.ReactElement {
  return (
    <section aria-label="Chat" className="flex h-full flex-col gap-3 p-3" data-testid="chat-unavailable">
      <SessionSelector sessions={[]} activeSessionId={null} onSelect={() => {}} emptyReason={reason} />
    </section>
  )
}
