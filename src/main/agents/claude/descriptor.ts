import type { AgentDescriptor } from '../types'
import { MINIMUM_PLUGIN_VERSION } from '../../types/plugin-version'

// ---------------------------------------------------------------------------
// claude/descriptor.ts — Claude Code's pure data (TRD §4.5, §4.6). Descriptor
// files may import only ../types, sibling descriptors and zod-free
// src/main/types/* modules: the renderer loads them at startup.
// ---------------------------------------------------------------------------

/** Shown in sandbox mode: the first session in a new sandbox stops at Claude Code's folder-trust prompt (README, First-run prompts). */
export const TRUST_PROMPT_COPY = 'The first session in a new sandbox asks you to trust the folder once, in the terminal.'

export const CLAUDE_DESCRIPTOR = {
  id: 'claude',
  displayName: 'Claude Code',
  binaryName: 'claude',
  capabilities: { channels: true, plugin: true },
  permissionModes: {
    host: [
      { mode: 'default', label: 'Default', note: 'Uses your Claude Code settings.' },
      { mode: 'auto', label: 'Auto mode', note: 'Claude decides when to ask.' },
    ],
    sandbox: [
      { mode: 'skip', label: 'Skip permissions', note: 'Never asks. The sandbox is the boundary.' },
      { mode: 'auto', label: 'Auto mode', note: 'Claude decides when to ask.' },
    ],
  },
  homeEntries: ['.claude', '.claude.json'],
  copy: {
    notFound: 'claude command not found. Is Claude Code installed?',
    readiness: {
      'home-missing': { message: 'Run Claude Code on this machine once first, then try again.', command: null },
      'config-invalid': {
        message: 'An entry in ~/.claude is a symbolic link or the wrong type. Replace it with a real file or folder, then try again.',
        command: null,
      },
    },
    configInvalid: '{file} {problem}. Fix or remove it, then Start again.',
    hostFirstRunNote: null,
    sandboxFirstRunNote: TRUST_PROMPT_COPY,
    noActivity: null,
  },
  plugin: {
    minimumVersion: MINIMUM_PLUGIN_VERSION,
    installCommands: ['claude plugin marketplace add hassounah/amerh', 'claude plugin install corner-office@amerh'],
    nextStep: 'Install the Corner Office plugin in Claude Code.',
  },
} as const satisfies AgentDescriptor
