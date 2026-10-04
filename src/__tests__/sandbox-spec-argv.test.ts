import { describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import {
  SANDBOX_IMAGE,
  LABEL,
  STOP_TIMEOUT_S,
  PERM_FLAGS,
  versionArgv,
  infoArgv,
  imageInspectArgv,
  buildArgv,
  createArgv,
  startArgv,
  firewallInitArgv,
  sessionExecArgv,
  stopArgv,
  rmArgv,
  inspectArgv,
  psArgv,
  blockedPollArgv,
  parseInspect,
} from '../main/services/sandbox-spec'
import type { Mount, BuildArgvOptions, CreateArgvOptions } from '../main/services/sandbox-spec'

// ---------------------------------------------------------------------------
// sandbox-spec-argv.test.ts (TRD §3.5, §10.9, C1, L1, X5, SEC-L1, SEC-L9)
// ---------------------------------------------------------------------------
// Golden-argv tests per builder, plus the security invariants that must hold
// across every argv-producing function: `-v` never appears (only `--mount`),
// `--network` never appears, `--publish` is always loopback-pinned, and
// docker inspect output is never logged raw (SEC-L9). The only-root-exec
// invariant itself (which builder is allowed `--user root`) is covered by
// the source-scan in sandbox-root-exec.test.ts, not here.
// ---------------------------------------------------------------------------

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
}

describe('PERM_FLAGS', () => {
  it('skip -> --dangerously-skip-permissions, auto -> --permission-mode auto (Phase 0 sign-off, TRD §14.6)', () => {
    expect(PERM_FLAGS.skip).toEqual(['--dangerously-skip-permissions'])
    expect(PERM_FLAGS.auto).toEqual(['--permission-mode', 'auto'])
  })
})

describe('versionArgv / infoArgv / imageInspectArgv', () => {
  it('versionArgv requests full JSON', () => {
    expect(versionArgv()).toEqual(['version', '--format', '{{json .}}'])
  })

  it('infoArgv requests only SecurityOptions as JSON', () => {
    expect(infoArgv()).toEqual(['info', '--format', '{{json .SecurityOptions}}'])
  })

  it('imageInspectArgv defaults to SANDBOX_IMAGE', () => {
    expect(imageInspectArgv()).toEqual(['image', 'inspect', '--format', '{{json .}}', SANDBOX_IMAGE])
  })

  it('imageInspectArgv accepts an override image (Docker suite, claude-sandbox:test)', () => {
    expect(imageInspectArgv('claude-sandbox:test')).toEqual([
      'image', 'inspect', '--format', '{{json .}}', 'claude-sandbox:test',
    ])
  })
})

describe('buildArgv', () => {
  function baseOpts(home: string, ctx: string): BuildArgvOptions {
    return {
      rebuild: false,
      toolchains: { node: true, go: false, buildBase: true },
      uid: 1000,
      gid: 1000,
      home,
      buildHash: 'abc123',
      ctx,
    }
  }

  it('builds the golden argv: --pull always, no --no-cache when not rebuilding, toolchain build-args and labels', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    const argv = buildArgv(baseOpts(home, ctx))

    expect(argv).toEqual([
      'build',
      '--pull',
      '--tag', SANDBOX_IMAGE,
      '--build-arg', 'WITH_NODE=1',
      '--build-arg', 'WITH_GO=0',
      '--build-arg', 'WITH_BUILD=1',
      '--build-arg', 'AGENT_UID=1000',
      '--build-arg', 'AGENT_GID=1000',
      '--build-arg', `AGENT_HOME=${home}`,
      '--label', `${LABEL.build}=abc123`,
      '--label', `${LABEL.toolchains}=node,build-base`,
      '--file', path.join(ctx, 'Dockerfile'),
      ctx,
    ])
  })

  it('adds --no-cache only when rebuild is true (D15)', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    const argv = buildArgv({ ...baseOpts(home, ctx), rebuild: true })
    expect(argv).toContain('--no-cache')
    expect(argv.indexOf('--no-cache')).toBe(argv.indexOf('--pull') + 1)
  })

  it('accepts an override image', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    const argv = buildArgv({ ...baseOpts(home, ctx), image: 'claude-sandbox:test' })
    expect(argv).toContain('claude-sandbox:test')
    expect(argv).not.toContain(SANDBOX_IMAGE)
  })

  it('omits a disabled toolchain from the label but still emits its build-arg as 0', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    const argv = buildArgv({
      ...baseOpts(home, ctx),
      toolchains: { node: false, go: false, buildBase: false },
    })
    expect(argv).toContain(`${LABEL.toolchains}=`)
    expect(argv).toContain('WITH_NODE=0')
    expect(argv).toContain('WITH_GO=0')
    expect(argv).toContain('WITH_BUILD=0')
  })

  it('throws on an invalid uid/gid', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    expect(() => buildArgv({ ...baseOpts(home, ctx), uid: 0, gid: 0 })).toThrow()
  })

  it('throws when home does not resolve on disk', () => {
    const ctx = mkTmp('co-argv-ctx-')
    expect(() => buildArgv({ ...baseOpts('/no/such/home', ctx), home: '/no/such/home' })).toThrow()
  })

  it('throws when home is not absolute', () => {
    const ctx = mkTmp('co-argv-ctx-')
    expect(() => buildArgv({ ...baseOpts('relative/home', ctx), home: 'relative/home' })).toThrow()
  })

  it('throws when home is not normalized (e.g. a trailing/traversal segment)', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    expect(() => buildArgv({ ...baseOpts(`${home}/.`, ctx), home: `${home}/.` })).toThrow()
  })

  // isSafeAbsolutePath shares FORBIDDEN_MOUNT_CHARS_RE with assertMountSafe —
  // a real on-disk directory whose name contains the char (Linux permits all
  // four in a filename) proves Rule 2 itself fires, not just the earlier
  // absolute/normalized/resolves checks (mirrors sandbox-spec-naming.test.ts's
  // assertMountSafe coverage for the same rule).
  it.each([',', '"', '\n', '\r'])('throws when home contains %j', (char) => {
    const parent = mkTmp('co-argv-home-')
    const dirty = path.join(parent, `bad${char}name`)
    fs.mkdirSync(dirty)
    const ctx = mkTmp('co-argv-ctx-')
    expect(() => buildArgv({ ...baseOpts(dirty, ctx), home: dirty })).toThrow()
  })

  it('enables just the go toolchain build-arg and label', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    const argv = buildArgv({ ...baseOpts(home, ctx), toolchains: { node: false, go: true, buildBase: false } })
    expect(argv).toContain('WITH_GO=1')
    expect(argv).toContain(`${LABEL.toolchains}=go`)
  })

  it('never emits -v (only --mount elsewhere; build has no mounts at all)', () => {
    const home = mkTmp('co-argv-home-')
    const ctx = mkTmp('co-argv-ctx-')
    expect(buildArgv(baseOpts(home, ctx))).not.toContain('-v')
  })
})

describe('createArgv', () => {
  // assertMountSafe requires every mount source/target to resolve via
  // fs.realpathSync — createArgv defense-in-depth-checks every mount, so the
  // fixture needs real, on-disk paths, not fabricated ones.
  function makeMounts(home: string, repo: string): Mount[] {
    const claudeDir = path.join(home, '.claude')
    const hooksDir = path.join(repo, '.git', 'hooks')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.mkdirSync(hooksDir, { recursive: true })
    return [
      { source: claudeDir, target: claudeDir, readonly: false, provenance: 'app' },
      { source: hooksDir, target: hooksDir, readonly: true, provenance: 'app' },
    ]
  }

  function makeBaseOpts(): CreateArgvOptions & { home: string; repo: string } {
    const home = mkTmp('co-argv-home-')
    const repo = mkTmp('co-argv-repo-')
    return {
      c: 'co-sandbox-my-ws',
      slug: 'my-ws',
      uid: 1000,
      gid: 1000,
      port: 20500,
      home,
      repo,
      base: 'main',
      specHash: 'deadbeef',
      mounts: makeMounts(home, repo),
      workTree: '/home/agent/.corner-office/sandboxes/my-ws',
    }
  }

  it('builds the golden argv per TRD §3.5', () => {
    const opts = makeBaseOpts()
    const [claudeMount, hooksMount] = opts.mounts
    const argv = createArgv(opts)

    expect(argv).toEqual([
      'create',
      '--name', 'co-sandbox-my-ws', '--hostname', 'co-sandbox-my-ws',
      '--label', `${LABEL.sandbox}=1`,
      '--label', `${LABEL.workspace}=my-ws`,
      '--label', `${LABEL.spec}=deadbeef`,
      '--init',
      '--user', '1000:1000',
      '--cap-add', 'NET_ADMIN',
      '--cap-add', 'NET_RAW',
      '--security-opt', 'no-new-privileges',
      '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
      '--tmpfs', '/run:rw,nosuid,nodev,noexec,mode=0755,size=4m',
      '--publish', '127.0.0.1:20500:20500',
      '--env', `HOME=${opts.home}`,
      '--env', 'CORNER_OFFICE_SANDBOX=1',
      '--env', 'CORNER_OFFICE_CHANNEL_PORT=20500',
      '--env', 'CORNER_OFFICE_BASE_BRANCH=main',
      '--mount', `type=bind,source=${claudeMount.source},target=${claudeMount.target}`,
      '--mount', `type=bind,source=${hooksMount.source},target=${hooksMount.target},readonly`,
      '--workdir', '/home/agent/.corner-office/sandboxes/my-ws',
      SANDBOX_IMAGE,
    ])
  })

  it('--publish is always loopback-pinned', () => {
    const opts = makeBaseOpts()
    const argv = createArgv(opts)
    const idx = argv.indexOf('--publish')
    expect(argv[idx + 1]).toMatch(/^127\.0\.0\.1:/)
  })

  it('never emits --network or -v', () => {
    const opts = makeBaseOpts()
    const argv = createArgv(opts)
    expect(argv).not.toContain('--network')
    expect(argv).not.toContain('-v')
  })

  it('accepts an override image', () => {
    const opts = makeBaseOpts()
    const argv = createArgv({ ...opts, image: 'claude-sandbox:test' })
    expect(argv[argv.length - 1]).toBe('claude-sandbox:test')
  })

  it('throws on an invalid slug', () => {
    const opts = makeBaseOpts()
    expect(() => createArgv({ ...opts, slug: '-bad' })).toThrow()
  })

  it('throws on an invalid uid/gid', () => {
    const opts = makeBaseOpts()
    expect(() => createArgv({ ...opts, uid: 0, gid: 0 })).toThrow()
  })

  it('throws on a base branch value with a control character', () => {
    const opts = makeBaseOpts()
    expect(() => createArgv({ ...opts, base: 'main\n' })).toThrow()
  })

  it('throws when home is not a real, symlink-free absolute path', () => {
    const opts = makeBaseOpts()
    expect(() => createArgv({ ...opts, home: '/no/such/home' })).toThrow()
  })

  // See buildArgv's equivalent test for why this needs a real on-disk path,
  // not just a nonexistent one.
  it.each([',', '"', '\n', '\r'])('throws when home contains %j', (char) => {
    const opts = makeBaseOpts()
    const dirty = path.join(mkTmp('co-argv-home-'), `bad${char}name`)
    fs.mkdirSync(dirty)
    expect(() => createArgv({ ...opts, home: dirty })).toThrow()
  })

  it('throws (defense in depth, SEC-L1) when a mount source fails assertMountSafe even though the caller should have already validated it', () => {
    const opts = makeBaseOpts()
    const bad: Mount = { source: '/no/such/path', target: '/no/such/path', readonly: false, provenance: 'app' }
    expect(() => createArgv({ ...opts, mounts: [bad] })).toThrow()
  })
})

describe('startArgv / stopArgv / rmArgv / inspectArgv / psArgv', () => {
  it('startArgv', () => {
    expect(startArgv('co-sandbox-my-ws')).toEqual(['start', 'co-sandbox-my-ws'])
  })

  it('stopArgv uses the endSession timeout', () => {
    expect(stopArgv('co-sandbox-my-ws', STOP_TIMEOUT_S.endSession)).toEqual(['stop', '--time', '10', 'co-sandbox-my-ws'])
  })

  it('stopArgv uses the quit timeout', () => {
    expect(stopArgv('co-sandbox-my-ws', STOP_TIMEOUT_S.quit)).toEqual(['stop', '--time', '5', 'co-sandbox-my-ws'])
  })

  it('rmArgv forces removal', () => {
    expect(rmArgv('co-sandbox-my-ws')).toEqual(['rm', '--force', 'co-sandbox-my-ws'])
  })

  it('inspectArgv requests full JSON (plan.md acceptance: needs .Mounts/.HostConfig.PortBindings, unlike TRD §3.5\'s pipe format)', () => {
    expect(inspectArgv('co-sandbox-my-ws')).toEqual(['inspect', '--format', '{{json .}}', 'co-sandbox-my-ws'])
  })

  it('psArgv filters by the sandbox label', () => {
    expect(psArgv()).toEqual([
      'ps', '--all', '--filter', `label=${LABEL.sandbox}=1`, '--format', '{{.Names}}\t{{.State}}\t{{.Image}}',
    ])
  })
})

describe('firewallInitArgv', () => {
  it('is the only builder using --user root, with the pinned ROOT_EXEC_ENV', () => {
    const argv = firewallInitArgv('co-sandbox-my-ws', 'allowlist')
    expect(argv).toEqual([
      'exec', '--interactive', '--user', 'root',
      '--env', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', '--env', 'HOME=/root',
      'co-sandbox-my-ws', '/opt/co-sandbox/init-firewall.sh', 'allowlist',
    ])
  })

  it('supports the open mode (Recreate/no-allowlist path)', () => {
    const argv = firewallInitArgv('co-sandbox-my-ws', 'open')
    expect(argv[argv.length - 1]).toBe('open')
  })

  it('never puts domains on the argv itself — they are passed on stdin by the caller', () => {
    // firewallInitArgv's signature only ever takes a container name and a
    // fixed 'allowlist' | 'open' mode (enforced at compile time); this proves
    // the argv it actually returns is exactly that fixed shape, with nothing
    // appended for a domain list.
    const argv = firewallInitArgv('co-sandbox-my-ws', 'allowlist')
    expect(argv).toHaveLength(11)
    expect(argv).toEqual([
      'exec', '--interactive', '--user', 'root',
      '--env', 'PATH=/usr/sbin:/usr/bin:/sbin:/bin', '--env', 'HOME=/root',
    ].concat(['co-sandbox-my-ws', '/opt/co-sandbox/init-firewall.sh', 'allowlist']))
  })
})

describe('sessionExecArgv', () => {
  it('builds the golden argv with a git identity present', () => {
    const argv = sessionExecArgv({
      c: 'co-sandbox-my-ws',
      uid: 1000,
      gid: 1000,
      workTree: '/home/agent/.corner-office/sandboxes/my-ws',
      permMode: 'skip',
      gitIdentity: { name: 'Amer Hassounah', email: 'amer@example.com' },
    })

    expect(argv).toEqual([
      'exec', '--interactive', '--tty', '--user', '1000:1000',
      '--workdir', '/home/agent/.corner-office/sandboxes/my-ws',
      '--env', 'TERM=xterm-256color', '--env', 'COLORTERM=truecolor', '--env', 'LANG=C.UTF-8',
      '--env', 'GIT_AUTHOR_NAME=Amer Hassounah',
      '--env', 'GIT_AUTHOR_EMAIL=amer@example.com',
      '--env', 'GIT_COMMITTER_NAME=Amer Hassounah',
      '--env', 'GIT_COMMITTER_EMAIL=amer@example.com',
      'co-sandbox-my-ws', 'claude', '--dangerously-skip-permissions',
      '--dangerously-load-development-channels', 'plugin:corner-office@amerh',
      '--teammate-mode', 'in-process',
    ])
  })

  it('omits all four GIT_* env flags entirely when gitIdentity is null', () => {
    const argv = sessionExecArgv({
      c: 'co-sandbox-my-ws',
      uid: 1000,
      gid: 1000,
      workTree: '/wt',
      permMode: 'skip',
      gitIdentity: null,
    })
    expect(argv.join(' ')).not.toContain('GIT_AUTHOR')
    expect(argv.join(' ')).not.toContain('GIT_COMMITTER')
  })

  it('uses PERM_FLAGS.auto for auto mode', () => {
    const argv = sessionExecArgv({
      c: 'co-sandbox-my-ws', uid: 1000, gid: 1000, workTree: '/wt', permMode: 'auto', gitIdentity: null,
    })
    expect(argv).toEqual(expect.arrayContaining(['--permission-mode', 'auto']))
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it('--user is always uid:gid, never root', () => {
    const argv = sessionExecArgv({
      c: 'co-sandbox-my-ws', uid: 1000, gid: 1000, workTree: '/wt', permMode: 'skip', gitIdentity: null,
    })
    const idx = argv.indexOf('--user')
    expect(argv[idx + 1]).toBe('1000:1000')
  })

  it('throws when the git identity has a control character (defense in depth)', () => {
    expect(() =>
      sessionExecArgv({
        c: 'co-sandbox-my-ws',
        uid: 1000,
        gid: 1000,
        workTree: '/wt',
        permMode: 'skip',
        gitIdentity: { name: 'evil\nname', email: 'a@b.com' },
      }),
    ).toThrow()
  })

  it('never emits -v', () => {
    const argv = sessionExecArgv({
      c: 'co-sandbox-my-ws', uid: 1000, gid: 1000, workTree: '/wt', permMode: 'skip', gitIdentity: null,
    })
    expect(argv).not.toContain('-v')
  })
})

describe('blockedPollArgv', () => {
  it('runs as codns with a pinned PATH/HOME and reads from byte offset+1 via -c, not --bytes', () => {
    expect(blockedPollArgv('co-sandbox-my-ws', 0)).toEqual([
      'exec', '--user', 'codns', '--env', 'PATH=/usr/bin:/bin', '--env', 'HOME=/', 'co-sandbox-my-ws',
      '/usr/bin/tail', '-c', '+1', '/var/log/co-dns/queries.log',
    ])
  })

  it('advances the tail offset by 1 for a nonzero byte offset (tail -c +N is 1-indexed)', () => {
    const argv = blockedPollArgv('co-sandbox-my-ws', 512)
    expect(argv).toContain('+513')
  })

  it('never uses the long --bytes flag (Phase 0 fix: busybox tail rejects it)', () => {
    expect(blockedPollArgv('co-sandbox-my-ws', 0)).not.toContain('--bytes')
  })
})

describe('parseInspect (SEC-L9)', () => {
  const valid = {
    State: { Status: 'running', Running: true },
    Image: 'sha256:abc',
    Config: { Labels: { [LABEL.sandbox]: '1' } },
    Mounts: [{ Source: '/a', Destination: '/b', RW: true }],
    HostConfig: { PortBindings: { '20500/tcp': [{ HostIp: '127.0.0.1', HostPort: '20500' }] } },
  }

  it('parses a well-formed docker inspect JSON payload', () => {
    const result = parseInspect(JSON.stringify(valid))
    expect(result).not.toBeNull()
    expect(result?.State.Running).toBe(true)
    expect(result?.Mounts[0].Source).toBe('/a')
  })

  it('returns null and logs no raw content for malformed JSON', () => {
    mockLog.warn.mockClear()
    const secret = '{"State": not json, "leak": "/home/amer/very-secret-path"'
    const result = parseInspect(secret)
    expect(result).toBeNull()
    expect(mockLog.warn).toHaveBeenCalledTimes(1)
    const loggedText = mockLog.warn.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(loggedText).not.toContain('very-secret-path')
  })

  it('returns null and logs only zod issue paths — never the raw object — on a schema failure', () => {
    mockLog.warn.mockClear()
    const bad = { ...valid, State: { Status: 'running' /* missing Running */ } }
    const result = parseInspect(JSON.stringify(bad))
    expect(result).toBeNull()
    expect(mockLog.warn).toHaveBeenCalledTimes(1)
    const [, fields] = mockLog.warn.mock.calls[0]
    expect(fields).toContain('State.Running')
    const loggedText = mockLog.warn.mock.calls.map((c) => JSON.stringify(c)).join(' ')
    expect(loggedText).not.toContain('sha256:abc')
    expect(loggedText).not.toContain('/a')
  })

  it('accepts a null Config.Labels and a null HostConfig.PortBindings (a freshly created, unlabeled or unpublished container)', () => {
    const result = parseInspect(JSON.stringify({ ...valid, Config: { Labels: null }, HostConfig: { PortBindings: null } }))
    expect(result).not.toBeNull()
    expect(result?.Config.Labels).toBeNull()
  })
})
