import { defineAgent } from '../handler'
import { pluginDetectorService } from '../../services/plugin-detector'

// ---------------------------------------------------------------------------
// codex/handler.ts — Codex CLI's host-only handler (TRD §4.7). There is no
// `sandbox` half yet (Phase D), so main rejects Codex in the sandbox.
// ---------------------------------------------------------------------------

const CODEX_TOKENS: readonly string[] = ['codex', '--no-alt-screen', '--no-daemon']
const CODEX_AUTO_TOKENS: readonly string[] = [...CODEX_TOKENS, '--approve-for-me']

export const CODEX_HANDLER = defineAgent('codex', {
  host: {
    argv: ({ permissionMode }) => {
      if (permissionMode === 'default') return CODEX_TOKENS
      if (permissionMode === 'auto') return CODEX_AUTO_TOKENS
      throw new Error(`codex: the host has no ${permissionMode} permission mode; use default or auto`)
    },
    // Re-admitted for Codex only (SEC-M5): they stay on ENV_DENYLIST for every other child process.
    envAllow: new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN']),
  },
  plugin: { detect: () => pluginDetectorService.getCodexStatus() },
})
