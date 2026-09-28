// ---------------------------------------------------------------------------
// secret-patterns.ts — basename-based secret detection (TRD §10.6, Q5, L7, M6)
//
// isSecret() is a UX protection, not access control (§10.6): it drives the
// content-withholding gate in code-fs.ts's readFile, not path containment.
// `.git/config` (which may hold token URLs) is unreachable by construction
// (H2, hasGitSegment) rather than being masked here.
//
// Callers apply this against BOTH the requested basename and the realpath
// basename (M6) — that OR-of-two-checks lives in the caller (code-fs.ts),
// not here.
// ---------------------------------------------------------------------------

/**
 * Secret basename patterns (§10.6), case-insensitive. `*` matches any run of
 * characters (including none); `{a,b,c}` is a literal alternation, same as a
 * shell brace expansion.
 */
const SECRET_PATTERNS = [
  '.env',
  '.env.*',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.p8',
  '*.jks',
  '*.keystore',
  '*.ppk',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  'credentials',
  'credentials*.json',
  '*.credentials',
  'client_secret*.json',
  'service-account*.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  '.dockercfg',
  'secrets.{yml,yaml,json,toml}',
  '*.secret',
  '*.secrets',
  '*.tfvars',
  // L7 additions
  '*.tfstate',
  '*.tfstate.backup',
  '.pgpass',
  '*.kdbx',
  'kubeconfig',
  '.s3cfg',
  '*.gpg',
  'secring.*',
  'local.settings.json',
] as const

/**
 * Patterns excluded from the secret list above, checked first — e.g. `.env`
 * templates that are meant to be committed, and public SSH keys.
 */
const EXCLUDED_PATTERNS = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  'id_*.pub',
] as const

function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Expand `{a,b,c}` alternation groups within a single glob segment (no `*`). */
function segmentToRegExpSource(segment: string): string {
  let source = ''
  let i = 0
  while (i < segment.length) {
    const open = segment.indexOf('{', i)
    if (open === -1) {
      source += escapeRegExpLiteral(segment.slice(i))
      break
    }
    source += escapeRegExpLiteral(segment.slice(i, open))
    const close = segment.indexOf('}', open)
    const options = segment
      .slice(open + 1, close)
      .split(',')
      .map(escapeRegExpLiteral)
    source += `(?:${options.join('|')})`
    i = close + 1
  }
  return source
}

/** Compile a `*`/`{a,b,c}` glob pattern into a whole-string, case-insensitive RegExp. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern.split('*').map(segmentToRegExpSource).join('.*')
  return new RegExp(`^${source}$`, 'i')
}

const SECRET_MATCHERS = SECRET_PATTERNS.map(globToRegExp)
const EXCLUDED_MATCHERS = EXCLUDED_PATTERNS.map(globToRegExp)

/**
 * True if `basename` (a single path component, not a full path) matches one
 * of the secret patterns in §10.6 and none of the exclusions. Case-insensitive.
 */
export function isSecret(basename: string): boolean {
  if (EXCLUDED_MATCHERS.some((re) => re.test(basename))) return false
  return SECRET_MATCHERS.some((re) => re.test(basename))
}
