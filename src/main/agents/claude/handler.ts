import path from 'path'
import { defineAgent } from '../handler'
import type { AgentConfigResult, AgentMountSpec, SandboxCtx } from '../handler'
import { pluginDetectorService } from '../../services/plugin-detector'
import {
  checkClaudeConfigSources,
  claudeHomeOk,
  clearClaudeConfigFiles,
  prepareClaudeConfig,
  seedClaudeJson,
} from '../../services/sandbox-claude-config'
import type { ClaudeConfigResult } from '../../services/sandbox-claude-config'
import { PERM_FLAGS, cardDir, claudeShadowSource, sandboxClaudeJsonPath, settingsOverlayPath } from '../../services/sandbox-spec'
import { claudeConfigDetail } from '../../types/claude-config'

// ---------------------------------------------------------------------------
// claude/handler.ts — Claude Code's handler (TRD §4.5): host argv, plugin
// detection and the sandbox half, a byte-identical wrapper around
// services/sandbox-claude-config.ts and the 4cbd703 mount plan.
// ---------------------------------------------------------------------------

/** The host launch command, byte-identical to terminal-manager's CLAUDE_COMMAND. */
const CLAUDE_COMMAND = 'claude --dangerously-load-development-channels plugin:corner-office@amerh --teammate-mode in-process'
const CLAUDE_TOKENS: readonly string[] = CLAUDE_COMMAND.split(' ')

/** Fixed copy only (never file contents): the label and problem map to a sentence naming the entry and the fix. */
function toAgentResult(result: ClaudeConfigResult): AgentConfigResult {
  return result.ok ? { ok: true } : { ok: false, detail: claudeConfigDetail(result.label, result.problem) }
}

export const CLAUDE_HANDLER = defineAgent('claude', {
  host: {
    argv: () => CLAUDE_TOKENS,
    envAllow: new Set<string>(),
  },
  sandbox: {
    readiness: (paths) => {
      if (!claudeHomeOk(paths)) return { ok: false, code: 'home-missing' }
      if (!checkClaudeConfigSources(paths).ok) return { ok: false, code: 'config-invalid' }
      return { ok: true }
    },
    prepare: (ctx, phase) =>
      toAgentResult(phase === 'plan' ? prepareClaudeConfig(ctx.paths, ctx.slug) : seedClaudeJson(ctx.paths, ctx.slug)),
    // The order is part of the mount-plan hash: keep it identical to sandbox-spec's 4cbd703 entries.
    mounts: ({ paths, slug }: SandboxCtx): readonly AgentMountSpec[] => [
      { source: paths.claudeDir, target: paths.claudeDir, readonly: false },
      { source: settingsOverlayPath(paths, slug), target: paths.claudeSettings, readonly: true }, // 0030: sanitized settings copy
      ...paths.claudeRoDirs.map((d) => ({ source: d, target: d, readonly: true })), // 0030: plugins, commands, agents, skills, hooks
      { source: paths.claudeMd, target: paths.claudeMd, readonly: true },
      { source: paths.claudeSettingsLocal, target: paths.claudeSettingsLocal, readonly: true }, // 0030 L4
      ...paths.claudeShadowDirs.map((d) => ({ source: claudeShadowSource(paths, slug, d), target: d, readonly: false })), // 0030 C1
      { source: sandboxClaudeJsonPath(paths, slug), target: paths.claudeJson, readonly: false }, // per-sandbox source, never the host file
      { source: cardDir(paths, slug), target: path.join(paths.claudeDir, 'channels'), readonly: false },
    ],
    launch: (_ctx, { permissionMode }) => {
      if (permissionMode === 'default') throw new Error('claude: the sandbox has no default permission mode; use skip or auto')
      return {
        env: [],
        argv: [
          'claude',
          ...PERM_FLAGS[permissionMode],
          '--dangerously-load-development-channels',
          'plugin:corner-office@amerh',
          '--teammate-mode',
          'in-process',
        ],
      }
    },
    cleanup: ({ paths, slug }) => clearClaudeConfigFiles(paths, slug),
  },
  plugin: { detect: () => pluginDetectorService.getStatus() },
})
