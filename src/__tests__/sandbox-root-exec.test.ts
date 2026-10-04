import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { firewallInitArgv, sessionExecArgv, blockedPollArgv, ROOT_EXEC_ENV } from '../main/services/sandbox-spec'

// ---------------------------------------------------------------------------
// sandbox-root-exec.test.ts (§7.1, §10.9, X5, SEC-L1)
// ---------------------------------------------------------------------------
// The only-root-exec security invariant: `firewallInitArgv` is the ONLY
// `docker exec` in the whole codebase allowed to run as root. Two layers:
//
//  1. Builder-level: call each `exec`-producing builder and inspect its
//     `--user` value directly.
//  2. Source-scan: grep every `src/main/services/sandbox-*.ts` file (present
//     and future — this glob isn't hand-maintained) for the `'exec'` literal
//     and the `'root'` literal across quote styles, and for the alternate
//     `--user=value` / `-u` spellings that would bypass an argv-shape check
//     that only looks at a literal `'--user'` element.
// ---------------------------------------------------------------------------

const SERVICES_DIR = path.resolve(__dirname, '..', 'main', 'services')

function sandboxSourceFiles(): string[] {
  return fs
    .readdirSync(SERVICES_DIR)
    .filter((f) => /^sandbox-.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .sort()
}

function countQuoted(content: string, literal: string): number {
  // Matches 'literal', "literal" and `literal` — a quote char, the literal
  // itself, then the SAME quote char — so it never matches the literal as a
  // substring of a larger token (e.g. `docs-root-unsafe` or `.root`).
  const re = new RegExp(`(['"\`])${literal}\\1`, 'g')
  return (content.match(re) ?? []).length
}

function userFlagValue(argv: readonly string[]): string | undefined {
  const idx = argv.indexOf('--user')
  return idx === -1 ? undefined : argv[idx + 1]
}

// ── Builder-level: exact --user value per exec-producing builder ───────────

describe('only-root-exec — builder-level', () => {
  it('firewallInitArgv is the only builder that runs as root, with the pinned ROOT_EXEC_ENV', () => {
    const argv = firewallInitArgv('co-sandbox-my-ws', 'allowlist')
    expect(userFlagValue(argv)).toBe('root')
    expect(argv).toEqual(expect.arrayContaining([...ROOT_EXEC_ENV]))
  })

  it('sessionExecArgv never runs as root, 0, or anything starting with 0: / root:', () => {
    for (const { uid, gid } of [{ uid: 1000, gid: 1000 }, { uid: 1001, gid: 1002 }]) {
      const argv = sessionExecArgv({ c: 'co-sandbox-my-ws', uid, gid, workTree: '/wt', permMode: 'skip', gitIdentity: null })
      const value = userFlagValue(argv)
      expect(value).toBeDefined()
      expect(value).toBe(`${uid}:${gid}`)
    }
    // sessionExecArgv now validates uid/gid via validateBuildIds (Fix 1.6,
    // Finding 2) — 0 and any other sub-1000 id are rejected outright, a
    // stronger guarantee than just checking the resulting --user string.
    for (const bad of [{ uid: 0, gid: 0 }, { uid: 1, gid: 1 }]) {
      expect(() => sessionExecArgv({ c: 'co-sandbox-my-ws', uid: bad.uid, gid: bad.gid, workTree: '/wt', permMode: 'skip', gitIdentity: null })).toThrow()
    }
    // This proves --user is a literal `${uid}:${gid}` computation, never a
    // hardcoded 'root' fallback, for every valid (>= 1000) id pair.
    const argv = sessionExecArgv({ c: 'co-sandbox-my-ws', uid: 1000, gid: 1000, workTree: '/wt', permMode: 'skip', gitIdentity: null })
    expect(userFlagValue(argv)).not.toBe('root')
    expect(userFlagValue(argv)).not.toBe('0')
    expect(userFlagValue(argv)).not.toMatch(/^0:/)
    expect(userFlagValue(argv)).not.toMatch(/^root:/)
  })

  it('blockedPollArgv always runs as the unprivileged codns user', () => {
    const argv = blockedPollArgv('co-sandbox-my-ws', 0)
    expect(userFlagValue(argv)).toBe('codns')
  })

  it('every exec-producing builder emits an explicit --user (never an implicit/default user)', () => {
    expect(firewallInitArgv('c', 'allowlist')).toContain('--user')
    expect(sessionExecArgv({ c: 'c', uid: 1000, gid: 1000, workTree: '/wt', permMode: 'skip', gitIdentity: null })).toContain('--user')
    expect(blockedPollArgv('c', 0)).toContain('--user')
  })
})

// ── Source scan over src/main/services/sandbox-*.ts ─────────────────────────

describe('only-root-exec — source scan (§7.1, X5)', () => {
  const files = sandboxSourceFiles()

  it('found at least sandbox-spec.ts to scan (sanity check the glob itself works)', () => {
    expect(files).toContain('sandbox-spec.ts')
  })

  it("the literal 'exec' appears only in sandbox-spec.ts", () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf-8')
      const count = countQuoted(content, 'exec')
      if (file === 'sandbox-spec.ts') {
        expect(count).toBeGreaterThan(0)
      } else {
        expect(count).toBe(0)
      }
    }
  })

  it("the root user value ('root') appears exactly once across every sandbox-*.ts file — the one firewallInitArgv exec", () => {
    let total = 0
    for (const file of files) {
      const content = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf-8')
      total += countQuoted(content, 'root')
    }
    expect(total).toBe(1)
  })

  it('never uses the --user=value spelling (only the two-element --user, value form)', () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf-8')
      expect(content).not.toMatch(/--user=/)
    }
  })

  it("never uses the short '-u' spelling of --user", () => {
    for (const file of files) {
      const content = fs.readFileSync(path.join(SERVICES_DIR, file), 'utf-8')
      expect(countQuoted(content, '-u')).toBe(0)
    }
  })
})
