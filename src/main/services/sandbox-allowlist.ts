import { z } from 'zod'

// ---------------------------------------------------------------------------
// sandbox-allowlist.ts — the egress allowlist grammar, normalization,
// effective-list merge, membership test and dnsmasq query-log parser
// (TRD §3.8.1, §3.8.2 parse, D9, Q3).
//
// Pure, and imports nothing but `zod` (checked by a test) so the renderer's
// AllowlistEditor (step 5.7) can import AllowlistEntrySchema directly,
// without pulling in any Node-only module.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Grammar (§3.8.1) — host side; init-firewall.sh (step 2.1) repeats it.
//
//   entry     := [ "*." ] hostname
//   hostname  := label ( "." label )+            ; at least 2 labels
//   label     := [a-z0-9] ( [a-z0-9-]{0,61} [a-z0-9] )?
//
// The input is trimmed and lowercased first. The hostname (after a leading
// `*.` is stripped) is at most 253 characters. Rejected: a trailing dot; any
// character outside [a-z0-9.-*] (spaces, `/`, `:`, `$`, `;`, backticks,
// quotes, newlines and non-ASCII all fall outside this — IDNs must be
// entered as punycode); a `*` anywhere except a leading `*.`; an IPv4
// literal (every label all-numeric); and a bare TLD (single label). IPv6
// literals are rejected by the character class alone (`:` isn't allowed).
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const MAX_HOSTNAME_LEN = 253
const ALL_DIGITS_RE = /^[0-9]+$/

/** Trim, lowercase, and strip a leading `*.` (D9: `*.x.y` normalizes to `x.y`). */
export function normalizeAllowlistEntry(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  return trimmed.startsWith('*.') ? trimmed.slice(2) : trimmed
}

/**
 * Validates a normalized hostname (leading `*.` already stripped) against
 * the §3.8.1 grammar. Splitting on `.` and testing each label against
 * LABEL_RE covers the character-class rule (any char outside [a-z0-9-] per
 * label — including a stray `*` — fails to match), the per-label length
 * cap (63, via the bounded quantifier), the trailing-dot rule and the
 * empty-label rule (both produce an empty label, which fails LABEL_RE),
 * all in one pass.
 */
export function isValidAllowlistEntry(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LEN) return false
  const labels = hostname.split('.')
  if (labels.length < 2) return false // bare TLD / single label
  if (!labels.every((label) => LABEL_RE.test(label))) return false
  if (labels.every((label) => ALL_DIGITS_RE.test(label))) return false // IPv4-literal shape
  return true
}

/**
 * `z.string().max(260)` caps the raw input before normalization runs (so a
 * pathological input never does unbounded work), then `normalizeAllowlistEntry`
 * transforms it, then `isValidAllowlistEntry` refines the result. The 260
 * cap is deliberately a little above MAX_HOSTNAME_LEN so an over-length
 * entry still reaches (and fails) the real length check, instead of being
 * rejected by the raw cap with a less specific error.
 */
export const AllowlistEntrySchema = z
  .string()
  .max(260)
  .transform(normalizeAllowlistEntry)
  .refine(isValidAllowlistEntry, { message: 'Invalid allowlist entry' })

/** §3.8.1 limits: 200 global entries and 200 per workspace. */
export const MAX_ALLOWLIST_ENTRIES = 200

/**
 * The array-level counterpart to AllowlistEntrySchema — the §3.8.1 entry
 * count cap. This is "the authority" (TRD §10.4): the renderer editor (5.7)
 * and the config schema (1.8, for globalAllowlist and each
 * workspaces[slug].allowlist) both reuse this instead of hardcoding 200
 * again.
 */
export const AllowlistSchema = z.array(AllowlistEntrySchema).max(MAX_ALLOWLIST_ENTRIES)

// from ideas.md; read-only in the UI. No addendum is applied yet — Phase 0
// (step 0.9) hasn't signed off, and 1.7 depends on nothing from it (plan.md
// "Deps: none (0.9 only for the addendum)"). If the user approves an
// addendum, it's added here as part of that sign-off, not before.
export const DEFAULT_ALLOWLIST = [
  'api.anthropic.com',
  // Claude Code's OAuth TOKEN_URL (#0030): without it the in-container
  // token refresh is blocked and the session dies when the token expires.
  'platform.claude.com',
  'statsig.anthropic.com',
  'sentry.io',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'sum.golang.org',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
] as const

/**
 * The minimal shape `effectiveAllowlist` needs from `SandboxConfig`
 * (types/config.ts, step 1.8). Defined structurally here, not imported —
 * 1.7 has no dependency on 1.8 (it's the other way around), and importing
 * from config.ts would also break the only-zod import constraint above.
 * `SandboxConfig` (and `SandboxWorkspaceConfig`) satisfy this shape
 * structurally once 1.8 lands.
 */
export interface EffectiveAllowlistConfig {
  globalAllowlist?: readonly string[]
  workspaces?: Readonly<Record<string, { allowlist?: readonly string[] }>>
}

/** Defaults + global additions + this workspace's additions, deduped and sorted. */
export function effectiveAllowlist(cfg: EffectiveAllowlistConfig, slug: string): string[] {
  const combined = new Set<string>([
    ...DEFAULT_ALLOWLIST,
    ...(cfg.globalAllowlist ?? []),
    ...(cfg.workspaces?.[slug]?.allowlist ?? []),
  ])
  return Array.from(combined).sort()
}

/**
 * Suffix semantics (D9): an allowlist entry also matches every subdomain,
 * because dnsmasq's `/domain/` match always includes subdomains and the
 * grammar's `*.` is normalized away rather than tracked separately.
 */
export function isAllowed(name: string, list: readonly string[]): boolean {
  return list.some((entry) => name === entry || name.endsWith(`.${entry}`))
}

// ---------------------------------------------------------------------------
// Blocked-feed query-log parser (§3.8.2 parse)
// ---------------------------------------------------------------------------

// `\S{1,253}` bounds the captured name so a hostile line can't drive
// unbounded backtracking or allocation; no `m`/`g` flags — matched per line.
// Every line dnsmasq logs for a query carries the pid it's handling that
// query on: `dnsmasq[PID]: <rest>`. Three shapes matter here (from the
// Phase 0 spike, phase0-results.md:138-142):
//   dnsmasq[36]: query[A] example.org from 127.0.0.1
//   dnsmasq[36]: config error is REFUSED (EDE: not ready)   <- blocked
//   dnsmasq[36]: config example.org is NODATA                <- NOT blocked
// A REFUSED line never repeats the name — the blocked name is whatever
// query was still pending for that pid. Pids are reused across unrelated
// queries once resolved, so pairing is "the next resolution line for this
// pid", never a global most-recent query.
const PID_PREFIX_RE = /dnsmasq\[(\d+)\]:/
const QUERY_LOG_LINE_RE = /dnsmasq\[(\d+)\]:\s*query\[(A|AAAA|HTTPS|SVCB|CNAME|MX|TXT|SRV)\] (\S{1,253}) from 127\.0\.0\.1$/
const REFUSED_LINE_RE = /config error is REFUSED\b/

/**
 * Parses codns's dnsmasq query log (agent-influenced data — the agent
 * chooses what to query, so every line is treated as hostile input, never
 * thrown on). Returns the distinct, valid, blocked domain names — a name is
 * blocked only when its `query[...]` line is followed by a `config error is
 * REFUSED` line for the *same pid* (ground truth: what the container's
 * firewall actually did), never by re-checking the caller's allowlist
 * config, which can be stale relative to the running container during a
 * live-update failure (§3.8.3: "the previous rules are still active") — the
 * caller (sandbox-network.ts, step 4.1) folds the result into its
 * per-workspace `Map<domain, {count, firstSeen, lastSeen}>`.
 *
 * A pending query is dropped without emitting when any other line for its
 * pid arrives first (`reply`, `forwarded`, `config ... is NODATA`, or
 * anything else — the query resolved without being refused). A name is
 * dropped even when paired with REFUSED when: it fails the §3.8.1 hostname
 * grammar (`isValidAllowlistEntry`, which already drops single-label
 * names); or it's a reverse-DNS domain (`*.in-addr.arpa`, `*.ip6.arpa`).
 *
 * PID reuse before a pending query resolves (no intervening line at all)
 * silently drops the earlier pending entry rather than emitting a name with
 * no confirmed REFUSED pairing — a stray unresolved query is not proof of
 * a block.
 */
export function parseQueryLog(text: string): string[] {
  const pending = new Map<string, string>() // pid -> the name it queried
  const blocked = new Set<string>()

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine

    const queryMatch = QUERY_LOG_LINE_RE.exec(line)
    if (queryMatch) {
      const [, pid, , rawName] = queryMatch
      let name = rawName.toLowerCase()
      if (name.endsWith('.')) name = name.slice(0, -1)
      pending.set(pid, name) // overwrites any stale unresolved entry for this pid
      continue
    }

    const pidMatch = PID_PREFIX_RE.exec(line)
    if (!pidMatch) continue // not a dnsmasq line at all
    const pid = pidMatch[1]
    if (!pending.has(pid)) continue // nothing pending for this pid

    const name = pending.get(pid)!
    pending.delete(pid)

    if (!REFUSED_LINE_RE.test(line)) continue // resolved without being refused
    if (!isValidAllowlistEntry(name)) continue
    if (name.endsWith('.in-addr.arpa') || name.endsWith('.ip6.arpa')) continue
    blocked.add(name)
  }
  return Array.from(blocked)
}
