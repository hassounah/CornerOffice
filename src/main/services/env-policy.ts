// ---------------------------------------------------------------------------
// env-policy.ts — the env-var denylist shared by every child process the app
// spawns (TRD §3.3). Moved out of terminal-manager.ts so terminal-manager's
// host ptys and docker-runner.ts (step 1.3) apply the exact same policy
// instead of keeping two copies of the list in sync.
// ---------------------------------------------------------------------------

/** Env var keys stripped from every child process environment. */
export const ENV_DENYLIST = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ASAR',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'CLAUDECODE',
  // Secrets (amendment P8)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'NPM_TOKEN',
  'OPENAI_API_KEY',
  'DATABASE_URL',
])

/** `base` with every `ENV_DENYLIST` key (and any undefined value) removed. No behaviour change from the inline loops it replaces. */
export function sanitizedEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !ENV_DENYLIST.has(key)) {
      env[key] = value
    }
  }
  return env
}
