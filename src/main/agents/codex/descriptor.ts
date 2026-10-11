import type { AgentDescriptor } from '../types'

// ---------------------------------------------------------------------------
// codex/descriptor.ts — Codex CLI's pure data (TRD §4.6, §4.7, §4.9.5). The
// sandbox mode list is non-empty, which is what makes the handler's `sandbox`
// half required (contract test). Descriptor files may import only ../types,
// sibling descriptors and zod-free src/main/types/* modules: the renderer
// loads them at startup.
// ---------------------------------------------------------------------------

export const CODEX_DESCRIPTOR = {
  id: 'codex',
  displayName: 'Codex',
  binaryName: 'codex',
  capabilities: { channels: false, plugin: true },
  permissionModes: {
    host: [
      { mode: 'default', label: 'Default', note: 'Uses your Codex config (normally: ask before risky actions).' },
      { mode: 'auto', label: 'Auto mode', note: 'Codex reviews approvals automatically.' },
    ],
    // Auto only if the live check (TRD §11.2 #8) passes; until then the sandbox is the boundary.
    sandbox: [{ mode: 'skip', label: 'Skip permissions', note: 'Never asks. The sandbox is the boundary.' }],
  },
  homeEntries: ['.codex'],
  copy: {
    notFound:
      "`codex` may not be installed: install it with `pnpm add -g @openai/codex`. If it is installed, check your shell startup files.",
    reinstallCommand: 'pnpm add -g @openai/codex',
    // One message per readiness code (TRD §4.9.5); the sandbox option and the Start refusal both read these (UX-M8).
    readiness: {
      'never-run': { message: 'Run Codex on this computer once first.', command: 'codex' },
      keyring: {
        message:
          'Codex keeps its sign-in in the system keyring, which the sandbox can\'t use. Set `cli_auth_credentials_store = "file"` in `~/.codex/config.toml`, then sign in again.',
        command: 'codex login',
        commandLead: 'After that, run:',
      },
      'not-signed-in': { message: 'Sign in to Codex on this computer.', command: 'codex login' },
      'config-invalid': {
        message: 'An entry in ~/.codex is a symbolic link or the wrong type. Replace it with a real file or folder, then Start again.',
        command: null,
      },
    },
    configInvalid: '{file} {problem}. Fix or remove it, then Start again.',
    hostFirstRunNote:
      "Codex asks to trust this folder the first time. Corner Office can't show Codex activity or approval alerts unless the Corner Office plugin for Codex is installed.",
    sandboxFirstRunNote:
      'The sandbox agent can use and replace your Codex sign-in, and shares your Codex history. Codex settings, plugins and prompts are read-only in the sandbox.',
    noActivity: 'Activity tracking off. Codex activity and approval alerts need the Corner Office plugin for Codex.',
  },
  plugin: {
    minimumVersion: null,
    installCommands: [],
    nextStep: "A Corner Office plugin for Codex isn't published yet.",
  },
} as const satisfies AgentDescriptor
