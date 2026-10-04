import React from 'react'
import type { ChatMessage as ChatMessageType } from '@main/types/channels'
import rixPortrait from '../../../../assets/realm/study/Rix_portrait.png'
import { SandboxTag } from '../sandbox/SandboxTag'

interface ChatMessageProps {
  message: ChatMessageType
  /** Set (to the workspace slug) when the message's session runs in a sandbox: channel content from a sandbox is agent-controlled and must say so (TRD §3.17). */
  sandboxWorkspace?: string
}

/**
 * Renders a single chat message bubble.
 * - User messages: right-aligned, accent background
 * - Assistant messages: left-aligned with Rix portrait, muted background
 * Plain text only — content is never rendered as HTML.
 */
export function ChatMessage({ message, sandboxWorkspace }: ChatMessageProps): React.ReactElement {
  const isUser = message.role === 'user'

  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <img
          src={rixPortrait}
          alt="Rix"
          className="h-8 w-8 rounded-full shrink-0 mt-1 mr-2"
        />
      )}
      <div
        className={`
          max-w-[80%] rounded-lg px-3 py-2 text-sm leading-relaxed
          ${isUser
            ? 'bg-amber-900/40 text-amber-50 rounded-br-sm'
            : 'bg-stone-800/60 text-stone-200 rounded-bl-sm'
          }
        `}
      >
        {!isUser && sandboxWorkspace !== undefined && (
          <div className="mb-1">
            <SandboxTag workspace={sandboxWorkspace} />
          </div>
        )}
        {/* Plain text — whitespace preserved, no HTML injection */}
        <p className="whitespace-pre-wrap break-words">{message.text}</p>
        <time
          dateTime={message.timestamp}
          className={`mt-1 block text-[10px] ${isUser ? 'text-amber-400/60 text-right' : 'text-stone-500'}`}
        >
          {timestamp}
          {message.editedAt && <span className="ml-1 italic">(edited)</span>}
        </time>
      </div>
    </div>
  )
}
