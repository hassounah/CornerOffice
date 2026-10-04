import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import {
  AllowlistEntrySchema,
  AllowlistSchema,
  MAX_ALLOWLIST_ENTRIES,
  DEFAULT_ALLOWLIST,
  effectiveAllowlist,
  isAllowed,
  parseQueryLog,
  normalizeAllowlistEntry,
  isValidAllowlistEntry,
} from '../main/services/sandbox-allowlist'

// ---------------------------------------------------------------------------
// Only-zod import constraint (so the renderer's AllowlistEditor, step 5.7,
// can import AllowlistEntrySchema without pulling in any Node-only module).
// ---------------------------------------------------------------------------

describe('module imports', () => {
  it('imports nothing but zod', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'main', 'services', 'sandbox-allowlist.ts'),
      'utf-8',
    )
    const importLines = src.match(/^import .+$/gm) ?? []
    expect(importLines.length).toBeGreaterThan(0)
    for (const line of importLines) {
      expect(line).toMatch(/from 'zod'$/)
    }
  })
})

// ---------------------------------------------------------------------------
// Grammar table (§7.1) — every valid and invalid entry the TRD lists.
// ---------------------------------------------------------------------------

describe('isValidAllowlistEntry — grammar', () => {
  const valid = ['github.com', 'example.co.uk', 'a-b.c', 'xn--bcher-kva.example']
  const invalid = [
    'com',
    '*x.com', // '*' anywhere but a leading '*.' — normalize doesn't strip it
    'a.*.com',
    '1.2.3.4', // IPv4-literal shape (every label all-numeric)
    '[::1]',
    'a.com.', // trailing dot -> empty label
    'a..com', // empty label
    '-a.com', // label starts with '-'
    'a-.com', // label ends with '-'
    'a'.repeat(64) + '.com', // 64-char label (max is 63)
    'a'.repeat(50) + '.' + 'a'.repeat(50) + '.' + 'a'.repeat(50) + '.' + 'a'.repeat(50) + '.' + 'a'.repeat(50), // 254 chars total
    'a.com\nserver=/x/1.1.1.1',
    '$(id).com',
    '`id`.com',
    'a.com;rm',
    'a com',
    'ä.com',
    'a.com:443',
    'a.com/x',
  ]

  it.each(valid)('accepts %s', (entry) => {
    expect(isValidAllowlistEntry(entry)).toBe(true)
  })

  it.each(invalid)('rejects %s', (entry) => {
    expect(isValidAllowlistEntry(entry)).toBe(false)
  })

  it('the 254-char name fixture is actually 254 characters', () => {
    const name = invalid[10]
    expect(name.length).toBe(254)
  })

  // '*.com' normalizes to the bare TLD 'com', still invalid — this exercises
  // the *entry* grammar (including normalization) via AllowlistEntrySchema,
  // not isValidAllowlistEntry directly (which only sees the post-strip form).
  it('rejects *.com via AllowlistEntrySchema (normalizes to the bare TLD "com")', () => {
    expect(AllowlistEntrySchema.safeParse('*.com').success).toBe(false)
  })
})

describe('AllowlistEntrySchema — end to end (normalize + validate)', () => {
  it('accepts and normalizes a leading *. wildcard (D9)', () => {
    const result = AllowlistEntrySchema.safeParse('*.example.co.uk')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('example.co.uk')
  })

  it('trims and lowercases', () => {
    const result = AllowlistEntrySchema.safeParse('  GitHub.COM  ')
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toBe('github.com')
  })

  it('rejects an over-length raw string before normalization even runs', () => {
    const huge = 'a'.repeat(300) + '.com'
    expect(AllowlistEntrySchema.safeParse(huge).success).toBe(false)
  })

  it.each([
    'github.com',
    'example.co.uk',
    'a-b.c',
    'xn--bcher-kva.example',
  ])('accepts %s end to end', (entry) => {
    expect(AllowlistEntrySchema.safeParse(entry).success).toBe(true)
  })

  it.each([
    'com',
    '*x.com',
    'a.*.com',
    '1.2.3.4',
    '[::1]',
    'a.com.',
    'a..com',
    '-a.com',
    'a-.com',
    'a.com\nserver=/x/1.1.1.1',
    '$(id).com',
    '`id`.com',
    'a.com;rm',
    'a com',
    'ä.com',
    'a.com:443',
    'a.com/x',
  ])('rejects %s end to end', (entry) => {
    expect(AllowlistEntrySchema.safeParse(entry).success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AllowlistSchema — the §3.8.1 200-entry limit (global and per-workspace).
// "The authority" (TRD §10.4) — step 1.8's SandboxConfigSchema and step 5.7's
// AllowlistEditor both reuse this instead of hardcoding 200 again.
// ---------------------------------------------------------------------------

describe('AllowlistSchema — entry count limit', () => {
  it('MAX_ALLOWLIST_ENTRIES is 200', () => {
    expect(MAX_ALLOWLIST_ENTRIES).toBe(200)
  })

  it('accepts exactly 200 entries', () => {
    const entries = Array.from({ length: MAX_ALLOWLIST_ENTRIES }, (_, i) => `host${i}.example.com`)
    const result = AllowlistSchema.safeParse(entries)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toHaveLength(MAX_ALLOWLIST_ENTRIES)
  })

  it('rejects 201 entries', () => {
    const entries = Array.from({ length: MAX_ALLOWLIST_ENTRIES + 1 }, (_, i) => `host${i}.example.com`)
    expect(AllowlistSchema.safeParse(entries).success).toBe(false)
  })

  it('accepts an empty array', () => {
    expect(AllowlistSchema.safeParse([]).success).toBe(true)
  })

  it('still validates each entry\'s grammar, not just the count', () => {
    const result = AllowlistSchema.safeParse(['github.com', 'not a hostname'])
    expect(result.success).toBe(false)
  })

  it('normalizes every entry (leading *. stripped) like AllowlistEntrySchema', () => {
    const result = AllowlistSchema.safeParse(['*.example.com', '  GitHub.COM  '])
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).toEqual(['example.com', 'github.com'])
  })
})

describe('normalizeAllowlistEntry', () => {
  it('strips a leading *. but leaves a mid-string * alone', () => {
    expect(normalizeAllowlistEntry('*.example.com')).toBe('example.com')
    expect(normalizeAllowlistEntry('*x.com')).toBe('*x.com')
    expect(normalizeAllowlistEntry('a.*.com')).toBe('a.*.com')
  })

  it('trims surrounding whitespace and lowercases', () => {
    expect(normalizeAllowlistEntry('  Example.COM  ')).toBe('example.com')
  })
})

// ---------------------------------------------------------------------------
// effectiveAllowlist — defaults + global + workspace, deduped and sorted
// ---------------------------------------------------------------------------

describe('effectiveAllowlist', () => {
  it('includes every default entry when no config is given', () => {
    const result = effectiveAllowlist({}, 'my-ws')
    for (const entry of DEFAULT_ALLOWLIST) {
      expect(result).toContain(entry)
    }
  })

  it('merges defaults, global additions and workspace additions', () => {
    const result = effectiveAllowlist(
      {
        globalAllowlist: ['crates.io'],
        workspaces: { 'my-ws': { allowlist: ['pkg.go.dev'] } },
      },
      'my-ws',
    )
    expect(result).toContain('crates.io')
    expect(result).toContain('pkg.go.dev')
    expect(result).toContain('github.com') // still has the defaults
  })

  it('does not leak another workspace\'s additions', () => {
    const result = effectiveAllowlist(
      { workspaces: { 'other-ws': { allowlist: ['pkg.go.dev'] } } },
      'my-ws',
    )
    expect(result).not.toContain('pkg.go.dev')
  })

  it('dedupes an entry present in both the defaults and a global/workspace addition', () => {
    const result = effectiveAllowlist({ globalAllowlist: ['github.com'] }, 'my-ws')
    expect(result.filter((e) => e === 'github.com')).toHaveLength(1)
  })

  it('returns entries sorted', () => {
    const result = effectiveAllowlist(
      { globalAllowlist: ['zzz.example.com', 'aaa.example.com'] },
      'my-ws',
    )
    const sorted = [...result].sort()
    expect(result).toEqual(sorted)
  })
})

// ---------------------------------------------------------------------------
// isAllowed — suffix semantics
// ---------------------------------------------------------------------------

describe('isAllowed', () => {
  const list = ['github.com', 'api.anthropic.com']

  it('matches an exact entry', () => {
    expect(isAllowed('github.com', list)).toBe(true)
  })

  it('matches a subdomain of an entry (D9 suffix semantics)', () => {
    expect(isAllowed('codeload.github.com', list)).toBe(true)
    expect(isAllowed('a.b.github.com', list)).toBe(true)
  })

  it('does not match an unrelated domain', () => {
    expect(isAllowed('evil.com', list)).toBe(false)
  })

  it('does not match a domain that merely ends with the same characters (not a subdomain)', () => {
    // "notgithub.com" ends with "github.com" as a raw string, but not as a
    // dot-delimited suffix — must not be treated as a subdomain.
    expect(isAllowed('notgithub.com', list)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// parseQueryLog — §3.8.2 parse, redesigned around the real dnsmasq log shape
// confirmed by the Phase 0 spike (phase0-results.md:138-142): every query
// (allowed or blocked) logs a `dnsmasq[PID]: query[TYPE] <name> from
// 127.0.0.1` line; a blocked one is followed by a separate `dnsmasq[PID]:
// config error is REFUSED (...)` line that doesn't repeat the name; an
// allowed one is followed by `reply`/`forwarded`/`config ... is NODATA`
// under the same pid. Pids are reused across unrelated queries once
// resolved, so pairing is "the next resolution line for this pid", not a
// global most-recent query.
// ---------------------------------------------------------------------------

describe('parseQueryLog', () => {
  it('emits a name whose query is paired with a REFUSED line for the same pid', () => {
    const lines = [
      'dnsmasq[36]: query[A] example.org from 127.0.0.1',
      'dnsmasq[36]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['example.org'])
  })

  it('the literal Phase 0 spike excerpt: only the REFUSED name is blocked, not the allowed one', () => {
    // phase0-results.md:138-142, verbatim.
    const lines = [
      'dnsmasq[36]: query[A] example.org from 127.0.0.1',
      'dnsmasq[36]: config error is REFUSED (EDE: not ready)',
      'dnsmasq[37]: ipset add co-allow4 160.79.104.10 api.anthropic.com',
      'dnsmasq[37]: reply api.anthropic.com is 160.79.104.10',
      'dnsmasq[36]: config api.anthropic.com is NODATA',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['example.org'])
  })

  it('a query[AAAA] for an allowed name resolved via NODATA under a reused pid is not counted as blocked', () => {
    const lines = [
      'dnsmasq[36]: query[A] example.org from 127.0.0.1',
      'dnsmasq[36]: config error is REFUSED (EDE: not ready)',
      'dnsmasq[36]: query[AAAA] api.anthropic.com from 127.0.0.1', // pid 36 reused
      'dnsmasq[36]: config api.anthropic.com is NODATA',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['example.org'])
  })

  it('a query resolved via "reply" is not counted as blocked', () => {
    const lines = [
      'dnsmasq[37]: query[A] api.anthropic.com from 127.0.0.1',
      'dnsmasq[37]: ipset add co-allow4 160.79.104.10 api.anthropic.com',
      'dnsmasq[37]: reply api.anthropic.com is 160.79.104.10',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual([])
  })

  it('pids interleave correctly — pairing follows the pid, not line order', () => {
    const lines = [
      'dnsmasq[10]: query[A] blocked-first.com from 127.0.0.1',
      'dnsmasq[20]: query[A] allowed-first.com from 127.0.0.1',
      'dnsmasq[20]: reply allowed-first.com is 1.2.3.4',
      'dnsmasq[10]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['blocked-first.com'])
  })

  it('parses every listed record type as a REFUSED-paired query', () => {
    const types = ['A', 'AAAA', 'HTTPS', 'SVCB', 'CNAME', 'MX', 'TXT', 'SRV']
    for (const t of types) {
      const lines = [
        `dnsmasq[1]: query[${t}] example.com from 127.0.0.1`,
        'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
      ].join('\n')
      expect(parseQueryLog(lines)).toEqual(['example.com'])
    }
  })

  it('drops a PTR query (record type not matched by the grammar at all)', () => {
    const lines = [
      'dnsmasq[1]: query[PTR] 1.1.1.1.in-addr.arpa from 127.0.0.1',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual([])
  })

  it('drops an in-addr.arpa / ip6.arpa name even under a matched record type and a REFUSED pairing', () => {
    const lines = [
      'dnsmasq[1]: query[A] 1.1.1.1.in-addr.arpa from 127.0.0.1',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
      'dnsmasq[2]: query[AAAA] 1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.ip6.arpa from 127.0.0.1',
      'dnsmasq[2]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual([])
  })

  it('drops a single-label name', () => {
    const lines = [
      'dnsmasq[1]: query[A] localhost from 127.0.0.1',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual([])
  })

  it('reports a name as blocked even when it is (now) present in the caller\'s allowlist config — the log is ground truth', () => {
    // §3.8.3: "the previous rules are still active" — the container can
    // still genuinely refuse a name the host-side config has already moved
    // on from during a live-update failure window. The parser has no
    // allowlist parameter (deliberately) and must not re-derive "blocked"
    // from config membership.
    const lines = [
      'dnsmasq[1]: query[A] github.com from 127.0.0.1',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['github.com'])
  })

  it('lowercases and strips a trailing dot from the captured name', () => {
    const lines = [
      'dnsmasq[1]: query[A] Example.COM. from 127.0.0.1',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['example.com'])
  })

  it('dedupes repeated blocked queries for the same name', () => {
    const lines = [
      'dnsmasq[1]: query[A] example.com from 127.0.0.1',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
      'dnsmasq[2]: query[A] example.com from 127.0.0.1',
      'dnsmasq[2]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['example.com'])
  })

  it('ignores a line that does not match the dnsmasq log shape at all', () => {
    const line = 'this is not a dnsmasq query log line'
    expect(parseQueryLog(line)).toEqual([])
  })

  it('ignores a REFUSED line with no pending query for its pid', () => {
    const line = 'dnsmasq[1]: config error is REFUSED (EDE: not ready)'
    expect(parseQueryLog(line)).toEqual([])
  })

  it('drops an unresolved pending query when its pid is reused by a new query before any resolution line arrives', () => {
    const lines = [
      'dnsmasq[1]: query[A] never-resolved.com from 127.0.0.1',
      'dnsmasq[1]: query[A] second-query.com from 127.0.0.1', // pid 1 reused, no resolution for the first
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['second-query.com'])
  })

  it('ignores a captured name that fails the hostname grammar (control characters), even when REFUSED-paired', () => {
    const lines = [
      'dnsmasq[1]: query[A] \x00\x01\x02.com from 127.0.0.1',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual([])
  })

  it('does not hang or crash on a 10 KB hostile line', () => {
    const line = 'dnsmasq[1]: query[A] ' + 'x'.repeat(10 * 1024) + ' from 127.0.0.1'
    const start = Date.now()
    const result = parseQueryLog(line)
    expect(Date.now() - start).toBeLessThan(1000)
    // The captured group is capped at 253 chars by the regex, so this
    // 10 KB payload can never match \S{1,253} followed by " from 127.0.0.1"
    // — it's simply ignored, not truncated and parsed.
    expect(result).toEqual([])
  })

  it('ignores a query not from 127.0.0.1', () => {
    const lines = [
      'dnsmasq[1]: query[A] example.com from 10.0.0.5',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual([])
  })

  it('handles CRLF line endings', () => {
    const lines = [
      'dnsmasq[1]: query[A] example.com from 127.0.0.1\r',
      'dnsmasq[1]: config error is REFUSED (EDE: not ready)\r',
    ].join('\n')
    expect(parseQueryLog(lines)).toEqual(['example.com'])
  })

  it('returns no events for an empty log', () => {
    expect(parseQueryLog('')).toEqual([])
  })
})
