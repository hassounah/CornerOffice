import { defineAgent } from '../handler'
import { pluginDetectorService } from '../../services/plugin-detector'

// ---------------------------------------------------------------------------
// claude/handler.ts — Claude Code's host and plugin handler (TRD §4.5). The
// sandbox half is added in A3, wrapping services/sandbox-claude-config.ts.
// ---------------------------------------------------------------------------

/** The host launch command, byte-identical to terminal-manager's CLAUDE_COMMAND. */
const CLAUDE_COMMAND = 'claude --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process'
const CLAUDE_TOKENS: readonly string[] = CLAUDE_COMMAND.split(' ')

export const CLAUDE_HANDLER = defineAgent('claude', {
  host: {
    argv: () => CLAUDE_TOKENS,
    envAllow: new Set<string>(),
  },
  plugin: { detect: () => pluginDetectorService.getStatus() },
})
