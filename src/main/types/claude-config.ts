// ---------------------------------------------------------------------------
// claude-config.ts — shared vocabulary for #0030 Claude config preparation
// failures (TRD §4.2, §4.7). Pure, so the main process builds the fixed
// `detail` copy and the renderer tests cover the same table. No fs, no
// electron: both sides can import it.
// ---------------------------------------------------------------------------

export type ClaudeConfigLabel =
  | 'settings.json'
  | 'CLAUDE.md'
  | 'settings.local.json'
  | 'plugins'
  | 'commands'
  | 'agents'
  | 'skills'
  | 'hooks'
  | 'shell-snapshots'
  | 'session-env'
  | 'backups'
  | 'security'
  | 'ide'
  | '.claude.json'
  | 'sandbox-state'

export type ClaudeConfigProblem = 'wrong-type' | 'symlink' | 'unreadable' | 'too-large' | 'invalid-json' | 'write-failed'

export const CLAUDE_CONFIG_LABELS: readonly ClaudeConfigLabel[] = [
  'settings.json',
  'CLAUDE.md',
  'settings.local.json',
  'plugins',
  'commands',
  'agents',
  'skills',
  'hooks',
  'shell-snapshots',
  'session-env',
  'backups',
  'security',
  'ide',
  '.claude.json',
  'sandbox-state',
]

export const CLAUDE_CONFIG_PROBLEMS: readonly ClaudeConfigProblem[] = [
  'wrong-type',
  'symlink',
  'unreadable',
  'too-large',
  'invalid-json',
  'write-failed',
]

const FILE_LABELS: readonly ClaudeConfigLabel[] = ['settings.json', 'CLAUDE.md', 'settings.local.json', '.claude.json']

function displayName(label: ClaudeConfigLabel): string {
  if (label === 'sandbox-state') return "The sandbox's state folder in ~/.corner-office/sandbox"
  if (label === '.claude.json') return '~/.claude.json'
  return `~/.claude/${label}`
}

/** Fixed copy for one (label, problem) pair, ending in what to do: never a raw path or file content (SEC). */
export function claudeConfigDetail(label: ClaudeConfigLabel, problem: ClaudeConfigProblem): string {
  const name = displayName(label)
  const kind = FILE_LABELS.includes(label) ? 'a regular file' : 'a folder'
  switch (problem) {
    case 'wrong-type':
      return `${name} exists but isn't ${kind}. Move or remove it, then try again.`
    case 'symlink':
      return `${name} is a symbolic link, which sandboxes can't use. Replace it with ${kind}, then try again.`
    case 'unreadable':
      return `${name} couldn't be read. Check that it exists and that you can read it, then try again.`
    case 'too-large':
      return `${name} is too large to copy into the sandbox. Make it smaller, then try again.`
    case 'invalid-json':
      return `${name} isn't a valid settings file (it must be a JSON object). Fix it, then try again.`
    case 'write-failed':
      return `${name} couldn't be created or written. Check the folder's permissions and free space, then try again.`
  }
}
