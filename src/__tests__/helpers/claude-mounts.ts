import { vi } from 'vitest'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { CLAUDE_HANDLER } from '../../main/agents/claude/handler'
import type { PermMode } from '../../main/agents/claude/handler'
import { sandboxPaths } from '../../main/services/sandbox-paths'
import { planMounts, sessionExecArgv } from '../../main/services/sandbox-spec'
import type { PlanMountsFacts, PlanMountsResult, SessionExecArgvOptions } from '../../main/services/sandbox-spec'

// ---------------------------------------------------------------------------
// Test adapters for #0037 A5. `planMounts` and `sessionExecArgv` now take the
// session agent's mounts and launch from its handler; these keep the Claude
// call shape so existing tests stay readable. The expected values in those
// tests are untouched: only how the inputs are built changed.
// ---------------------------------------------------------------------------

function claudeSandbox(): NonNullable<typeof CLAUDE_HANDLER.sandbox> {
  const sandbox = CLAUDE_HANDLER.sandbox
  if (!sandbox) throw new Error('claude handler has no sandbox half')
  return sandbox
}

/** `planMounts` with Claude's handler mounts. */
export function planClaudeMounts(facts: PlanMountsFacts): PlanMountsResult {
  const agentMounts = claudeSandbox().mounts({ paths: sandboxPaths(facts.home), slug: facts.slug, workTree: facts.wt })
  return planMounts(facts, agentMounts)
}

/** `sessionExecArgv` with Claude's handler launch for `permMode`. */
export function claudeSessionExecArgv(opts: Omit<SessionExecArgvOptions, 'agentEnv' | 'agentArgv'> & { permMode: PermMode }): string[] {
  const { permMode, ...rest } = opts
  const launch = claudeSandbox().launch(
    { paths: sandboxPaths('/nonexistent-home'), slug: 'x', workTree: opts.workTree },
    { permissionMode: permMode },
  )
  return sessionExecArgv({ ...rest, agentEnv: launch.env, agentArgv: launch.argv })
}
