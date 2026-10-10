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
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_GITHUB_PERSONAL_ACCESS_TOKEN',
  'DATABASE_URL',
])

/** Keys that can change what code a child process loads. No agent may ever re-admit them (SM-5); `ELECTRON_*` is matched by prefix in {@link isNeverAllowed}. */
export const NEVER_ALLOWED = new Set(['NODE_OPTIONS', 'LD_PRELOAD', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR'])

export function isNeverAllowed(key: string): boolean {
  return NEVER_ALLOWED.has(key) || key.startsWith('ELECTRON_')
}

/**
 * `base` with every `ENV_DENYLIST` key (and any undefined value) removed.
 * `allow` re-admits a key only if it is in `ENV_DENYLIST` and not
 * {@link isNeverAllowed}; anything else in `allow` is ignored (SM-5).
 */
export function sanitizedEnv(base: NodeJS.ProcessEnv, allow?: ReadonlySet<string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    const readmitted = allow?.has(key) === true && ENV_DENYLIST.has(key) && !isNeverAllowed(key)
    if (!ENV_DENYLIST.has(key) || readmitted) {
      env[key] = value
    }
  }
  return env
}
