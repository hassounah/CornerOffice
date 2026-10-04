import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// sandbox-assets.test.ts (TRD §3.4.1-§3.4.5, C1, L1, D4, D14)
// ---------------------------------------------------------------------------
// Structural checks only — these are shell scripts, a static dnsmasq config
// and a Dockerfile, none of which can be meaningfully exercised without a
// real Docker daemon. Behavior (the image actually builds, the firewall
// actually blocks/allows) is covered by the Docker-gated suite (step 2.4,
// [LOCAL-DOCKER]), not this file. Content is transcribed verbatim from the
// Phase 0 spike's tested output (phase0-results.md Appendices A-D).
// ---------------------------------------------------------------------------

const ASSETS_DIR = path.resolve(__dirname, '..', '..', 'resources', 'sandbox')

function readAsset(name: string): string {
  return fs.readFileSync(path.join(ASSETS_DIR, name), 'utf-8')
}

function firstSubstantiveLine(script: string): string | undefined {
  return script
    .split('\n')
    .find((l) => l.trim() !== '' && !l.trim().startsWith('#') && !l.startsWith('#!'))
    ?.trim()
}

describe('co-entrypoint.sh', () => {
  const script = readAsset('co-entrypoint.sh')

  it('is executable', () => {
    const mode = fs.statSync(path.join(ASSETS_DIR, 'co-entrypoint.sh')).mode
    expect((mode & 0o111) !== 0).toBe(true)
  })

  it('starts with a shebang', () => {
    expect(script.startsWith('#!/bin/bash\n')).toBe(true)
  })

  it("the first command sets PATH, before anything else runs (C1: never resolve through the agent-writable ~/.local/bin)", () => {
    expect(firstSubstantiveLine(script)).toBe('PATH=/usr/bin:/bin')
  })

  it('the PATH assignment is exported immediately after being set', () => {
    const lines = script.split('\n').map((l) => l.trim())
    const pathIdx = lines.indexOf('PATH=/usr/bin:/bin')
    expect(lines[pathIdx + 1]).toBe('export PATH')
  })

  it('every external command is invoked by absolute path — no bare "sleep" lookup', () => {
    // The only external (non-builtin) command this script runs is `sleep`.
    // export/trap/kill/wait/exit/while/true/do/done are all bash builtins
    // or keywords with no PATH lookup at all.
    const withoutAbsoluteSleep = script.split('/usr/bin/sleep').join('')
    expect(withoutAbsoluteSleep).not.toMatch(/\bsleep\b/)
  })

  it('traps TERM/INT to forward the signal to every agent process, then exits', () => {
    expect(script).toMatch(/trap\s+'kill -TERM -1.*'\s+TERM INT/)
  })
})

describe('init-firewall.sh', () => {
  const script = readAsset('init-firewall.sh')

  it('is executable', () => {
    const mode = fs.statSync(path.join(ASSETS_DIR, 'init-firewall.sh')).mode
    expect((mode & 0o111) !== 0).toBe(true)
  })

  it('never uses eval — domains only ever appear as config data, never interpolated into a command', () => {
    expect(script).not.toMatch(/\beval\b/)
  })

  it('pins PATH and HOME on the first command, before anything else runs', () => {
    const first = firstSubstantiveLine(script)
    expect(first).toContain('PATH=/usr/sbin:/usr/bin:/sbin:/bin')
    expect(first).toContain('HOME=/root')
  })

  it('refuses to run unless it is root', () => {
    expect(script).toMatch(/if \[ "\$\(id -u\)" != 0 \]; then .* exit 1; fi/)
  })

  it('validates every domain (and the 500-line cap) before touching ipset or iptables rules', () => {
    const capIdx = script.indexOf('more than 500 domains')
    const domainRegexIdx = script.indexOf('DOMAIN_RE=')
    const ipsetIdx = script.indexOf('ipset create co-allow4')
    const iptablesIdx = script.indexOf('iptables-nft -F OUTPUT\niptables-nft -A OUTPUT -o lo')
    expect(capIdx).toBeGreaterThan(-1)
    expect(domainRegexIdx).toBeGreaterThan(-1)
    expect(ipsetIdx).toBeGreaterThan(capIdx)
    expect(iptablesIdx).toBeGreaterThan(capIdx)
  })

  it('rebuilds the OUTPUT chain and sets the DROP policy only after the REJECT rule', () => {
    const rejectIdx = script.indexOf('iptables-nft -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited')
    const dropIdx = script.indexOf('iptables-nft -P OUTPUT DROP')
    expect(rejectIdx).toBeGreaterThan(-1)
    expect(dropIdx).toBeGreaterThan(rejectIdx)
  })

  it('refuses a 127.0.0.0/8 upstream nameserver (fails closed rather than trusting a loopback resolver)', () => {
    expect(script).toContain('refusing loopback upstream')
    expect(script).toMatch(/127\.\*\)/)
  })

  it('exits 3 (fails closed) when no usable upstream nameserver remains', () => {
    expect(script).toContain('no usable upstream nameserver')
    expect(script).toMatch(/no usable upstream nameserver.*\n\s*exit 3/)
  })

  it('self-checks the policy and DNS resolution, and fails closed (exit 3) if either fails', () => {
    expect(script).toMatch(/self-check failed \(policy\)"[^\n]*exit 3/)
    expect(script).toMatch(/self-check failed \(dns\)"[^\n]*exit 3/)
  })

  it('uses the nft-backed iptables/ip6tables binaries (Phase 0 fix: legacy ip6tables fails on this kernel)', () => {
    expect(script).not.toMatch(/(?<!-)\biptables\b(?!-nft)/)
    expect(script).toContain('iptables-nft')
    expect(script).toContain('ip6tables-nft')
  })
})

describe('dnsmasq-base.conf', () => {
  const conf = readAsset('dnsmasq-base.conf')

  it('has no default server= line — a non-allowlisted name is never forwarded upstream', () => {
    expect(conf).not.toMatch(/^server=/m)
  })

  it('runs as the unprivileged codns user/group', () => {
    expect(conf).toContain('user=codns')
    expect(conf).toContain('group=codns')
  })

  it('logs queries to the codns-owned query log the Blocked poll reads', () => {
    expect(conf).toContain('log-queries')
    expect(conf).toContain('log-facility=/var/log/co-dns/queries.log')
  })

  it('only listens on loopback', () => {
    expect(conf).toContain('listen-address=127.0.0.1')
    expect(conf).toContain('bind-interfaces')
  })
})

describe('Dockerfile', () => {
  const dockerfile = readAsset('Dockerfile')

  it('strips every setuid/setgid bit and never installs sudo', () => {
    expect(dockerfile).toContain('chmod a-s')
    expect(dockerfile).not.toMatch(/\bsudo\b/)
  })

  it('runs the agent as a non-root user', () => {
    expect(dockerfile).toMatch(/^USER agent$/m)
  })

  it('copies exactly the three sibling assets into /opt/co-sandbox', () => {
    expect(dockerfile).toContain('COPY co-entrypoint.sh init-firewall.sh dnsmasq-base.conf /opt/co-sandbox/')
  })

  it('sets the entrypoint to co-entrypoint.sh by absolute path', () => {
    expect(dockerfile).toContain('ENTRYPOINT ["/opt/co-sandbox/co-entrypoint.sh"]')
  })

  it("the agent's PATH starts with its own writable ~/.local/bin (C1: never used by anything but the agent)", () => {
    expect(dockerfile).toMatch(/PATH=\$\{AGENT_HOME\}\/\.local\/bin:/)
  })

  it('validates build args are declared (AGENT_UID, AGENT_GID, AGENT_HOME — checked by sandbox-spec.ts before use)', () => {
    expect(dockerfile).toContain('ARG AGENT_UID')
    expect(dockerfile).toContain('ARG AGENT_GID')
    expect(dockerfile).toContain('ARG AGENT_HOME')
  })

  it('installs corepack as its own package alongside nodejs-22 (Phase 0 fix: not bundled in Wolfi)', () => {
    expect(dockerfile).toMatch(/apk add --no-cache nodejs-22 corepack && corepack enable/)
  })

  it("scopes the setuid-strip's `|| true` to the find alone, not the whole user-creation chain (Phase 0 fix)", () => {
    expect(dockerfile).toContain('{ find / -xdev -perm /6000 -type f -exec chmod a-s {} + || true; }')
  })

  it('pre-creates $AGENT_HOME/.corner-office/{sandboxes,events}, owned by the agent (TRD §14.6 #13)', () => {
    // Docker creates a missing mount-target parent directory as root — planMounts' worktree
    // (.corner-office/sandboxes/<slug>) and events (.corner-office/events/<slug>, /enabled)
    // targets must never be the first thing to touch these paths at mount time.
    expect(dockerfile).toContain('mkdir -p "$AGENT_HOME/.corner-office/sandboxes" "$AGENT_HOME/.corner-office/events"')
    expect(dockerfile).toContain('chown -R "$AGENT_UID:$AGENT_GID" "$AGENT_HOME/.corner-office"')
    expect(dockerfile).toContain('chmod -R 0755 "$AGENT_HOME/.corner-office"')
  })

  it('pre-creates .corner-office before the setuid strip runs (so it never gets caught by a swallowed failure)', () => {
    const mkdirIdx = dockerfile.indexOf('mkdir -p "$AGENT_HOME/.corner-office')
    const findIdx = dockerfile.indexOf('find / -xdev -perm /6000')
    expect(mkdirIdx).toBeGreaterThan(-1)
    expect(findIdx).toBeGreaterThan(mkdirIdx)
  })
})
