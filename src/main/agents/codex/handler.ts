import { defineAgent } from '../handler'
import type { AgentMountSpec, SandboxCtx } from '../handler'
import { pluginDetectorService } from '../../services/plugin-detector'
import { codexMounts, codexQuarantineFolder, codexReadiness, codexStatePaths } from './sandbox-config'
import { cleanupCodexSession, closeCodexGuard, codexGuardIsOpen, prepareCodexSession } from './guard'

// ---------------------------------------------------------------------------
// codex/handler.ts — Codex CLI's handler (TRD §4.7, §4.9). The host half is a
// login-shell command; the sandbox half composes codex/sandbox-config.ts (what
// the container is given of ~/.codex) and codex/guard.ts (what the session left
// behind). A container never sees ~/.claude (apart from the shared homunculus
// subtree, a neutral mount) or a channel port.
// ---------------------------------------------------------------------------

const CODEX_TOKENS: readonly string[] = ['codex', '--no-alt-screen', '--no-daemon']
const CODEX_AUTO_TOKENS: readonly string[] = [...CODEX_TOKENS, '--approve-for-me']

/** Sandbox launch: no alternate screen, no daemon, hooks trusted (the app writes none), and no approvals: the container is the boundary. */
const CODEX_SANDBOX_TOKENS: readonly string[] = ['codex', '--no-alt-screen', '--no-daemon', '--dangerously-bypass-hook-trust']
const CODEX_SANDBOX_SKIP_FLAGS: readonly string[] = ['--dangerously-bypass-approvals-and-sandbox']

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
  sandbox: {
    readiness: (paths) => codexReadiness(paths),
    // 'plan' precreates, writes the overlay and opens the guard (openSession); nothing is seeded at 'create'.
    prepare: (ctx, phase) => (phase === 'plan' ? prepareCodexSession(ctx.paths, ctx.slug, ctx.workTree) : { ok: true }),
    mounts: ({ paths, slug }: SandboxCtx): readonly AgentMountSpec[] => codexMounts(paths, slug),
    launch: ({ paths, slug }, { permissionMode }) => {
      if (permissionMode !== 'skip') throw new Error('codex: the sandbox only offers skip permissions')
      return {
        // A per-sandbox sqlite home, at the same path in the container (D25): the host's queue and memories are not shared.
        env: [`CODEX_SQLITE_HOME=${codexStatePaths(paths, slug).sqlite}`],
        argv: [...CODEX_SANDBOX_TOKENS, ...CODEX_SANDBOX_SKIP_FLAGS],
      }
    },
    cleanup: ({ paths, slug }, opts) => cleanupCodexSession(paths, slug, opts?.containerAbsent ?? true),
    afterStop: ({ paths, slug }) => closeCodexGuard(paths, slug),
    quarantineFolder: ({ paths, slug }) => codexQuarantineFolder(paths, slug),
    sweepPending: ({ paths, slug }) => codexGuardIsOpen(paths, slug),
  },
  plugin: { detect: () => pluginDetectorService.getCodexStatus() },
})
