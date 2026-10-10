import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'

vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { parse } from 'smol-toml'
import {
  buildOverlay,
  codexReadiness,
  codexStatePaths,
  findHostSocket,
  precreateCodexHome,
  precreateCodexState,
  prepareCodexConfig,
  refuseHostSockets,
  writeOverlay,
} from '../../main/agents/codex/sandbox-config'
import { sandboxPaths } from '../../main/services/sandbox-paths'
import type { SandboxPaths } from '../../main/services/sandbox-paths'

// ---------------------------------------------------------------------------
// codex/sandbox-config.ts (#0037 D8): precreate, the config.toml overlay, socket
// refusal and readiness, against a real temp home.
// ---------------------------------------------------------------------------

const SLUG = 'ws'
const WT = '/work/tree'
const roots: string[] = []
let home: string
let paths: SandboxPaths

function mkHome(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'co-codex-')))
  roots.push(dir)
  return dir
}

function writeHost(name: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(paths.codexDir, name)), { recursive: true })
  fs.writeFileSync(path.join(paths.codexDir, name), content)
}

/** A signed-in host: `~/.codex` with a real auth.json. */
function signedInHost(): void {
  fs.mkdirSync(paths.codexDir, { recursive: true })
  writeHost('auth.json', '{}')
}

beforeEach(() => {
  home = mkHome()
  paths = sandboxPaths(home)
})

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})

const mode = (p: string): number => fs.statSync(p).mode & 0o777

describe('precreateCodexHome', () => {
  it('does nothing, and never creates ~/.codex, when it is missing', () => {
    expect(precreateCodexHome(paths)).toEqual({ ok: true })
    expect(fs.existsSync(paths.codexDir)).toBe(false)
  })

  it('does nothing when ~/.codex is a symlink to a directory', () => {
    const target = path.join(home, 'elsewhere')
    fs.mkdirSync(target)
    fs.symlinkSync(target, paths.codexDir)
    expect(precreateCodexHome(paths)).toEqual({ ok: true })
    expect(fs.readdirSync(target)).toEqual([])
  })

  it('creates the mount targets empty and the shadowed dirs 0700, only when they are absent', () => {
    fs.mkdirSync(paths.codexDir)
    expect(precreateCodexHome(paths)).toEqual({ ok: true })

    for (const file of ['.env', 'AGENTS.md', 'config.toml']) {
      expect(fs.readFileSync(path.join(paths.codexDir, file), 'utf8')).toBe('')
      expect(mode(path.join(paths.codexDir, file))).toBe(0o600)
    }
    for (const dir of ['plugins', 'skills', 'prompts', 'agents', 'rules', 'app-server-daemon', 'log']) {
      expect(fs.statSync(path.join(paths.codexDir, dir)).isDirectory()).toBe(true)
      expect(mode(path.join(paths.codexDir, dir))).toBe(0o700)
    }
  })

  it('does not create hooks.json or AGENTS.override.md (left to the guard until D1c)', () => {
    fs.mkdirSync(paths.codexDir)
    precreateCodexHome(paths)
    expect(fs.existsSync(path.join(paths.codexDir, 'hooks.json'))).toBe(false)
    expect(fs.existsSync(path.join(paths.codexDir, 'AGENTS.override.md'))).toBe(false)
  })

  it('never overwrites an existing file or touches an existing directory', () => {
    fs.mkdirSync(paths.codexDir)
    writeHost('config.toml', 'model = "x"\n')
    writeHost('AGENTS.md', 'mine')
    fs.mkdirSync(path.join(paths.codexDir, 'skills'), { mode: 0o755 })
    precreateCodexHome(paths)
    expect(fs.readFileSync(path.join(paths.codexDir, 'config.toml'), 'utf8')).toBe('model = "x"\n')
    expect(fs.readFileSync(path.join(paths.codexDir, 'AGENTS.md'), 'utf8')).toBe('mine')
    expect(mode(path.join(paths.codexDir, 'skills'))).toBe(0o755)
  })

  it('a symlinked mount target gives config-invalid naming the file', () => {
    fs.mkdirSync(paths.codexDir)
    const target = path.join(home, 'real-agents.md')
    fs.writeFileSync(target, 'x')
    fs.symlinkSync(target, path.join(paths.codexDir, 'AGENTS.md'))

    expect(precreateCodexHome(paths)).toEqual({
      ok: false,
      detail: '~/.codex/AGENTS.md is a symbolic link. Replace it with a real file or folder, then Start again.',
    })
    expect(fs.readFileSync(target, 'utf8')).toBe('x')
  })

  it('a dangling symlink is refused too, not created through', () => {
    fs.mkdirSync(paths.codexDir)
    fs.symlinkSync(path.join(home, 'nowhere'), path.join(paths.codexDir, '.env'))
    const result = precreateCodexHome(paths)
    expect(result).toMatchObject({ ok: false })
    expect(fs.existsSync(path.join(home, 'nowhere'))).toBe(false)
  })

  it('a symlinked directory entry and a wrong-type entry are named', () => {
    fs.mkdirSync(paths.codexDir)
    fs.mkdirSync(path.join(home, 'real-plugins'))
    fs.symlinkSync(path.join(home, 'real-plugins'), path.join(paths.codexDir, 'plugins'))
    expect(precreateCodexHome(paths)).toMatchObject({ ok: false, detail: expect.stringContaining('~/.codex/plugins is a symbolic link') })

    fs.rmSync(path.join(paths.codexDir, 'plugins'))
    fs.writeFileSync(path.join(paths.codexDir, 'skills'), 'a file')
    expect(precreateCodexHome(paths)).toEqual({
      ok: false,
      detail: "~/.codex/skills isn't a folder. Fix or remove it, then Start again.",
    })

    fs.rmSync(path.join(paths.codexDir, 'skills'))
    fs.rmSync(path.join(paths.codexDir, '.env'))
    fs.mkdirSync(path.join(paths.codexDir, '.env'))
    expect(precreateCodexHome(paths)).toMatchObject({ ok: false, detail: "~/.codex/.env isn't a regular file. Fix or remove it, then Start again." })
  })

  it('reports an unwritable ~/.codex without leaking a path beyond the entry', () => {
    fs.mkdirSync(paths.codexDir, { mode: 0o500 })
    try {
      const result = precreateCodexHome(paths)
      // Running as root bypasses the permission; otherwise creation fails with fixed copy.
      if (!result.ok) expect(result.detail).toContain("couldn't be created")
    } finally {
      fs.chmodSync(paths.codexDir, 0o700)
    }
  })
})

describe('precreateCodexState', () => {
  it('creates S with the overlay and empty env sources 0600, the dirs 0700, and the push-guard rules', () => {
    expect(precreateCodexState(paths, SLUG)).toEqual({ ok: true })
    const s = codexStatePaths(paths, SLUG)

    expect(mode(s.state)).toBe(0o700)
    for (const file of [s.configOverlay, s.env]) {
      expect(fs.readFileSync(file, 'utf8')).toBe('')
      expect(mode(file)).toBe(0o600)
    }
    for (const dir of [s.rulesDir, s.daemon, s.log, s.sqlite, s.quarantine]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true)
      expect(mode(dir)).toBe(0o700)
    }
    const rules = fs.readFileSync(s.rulesFile, 'utf8')
    expect(rules).toContain('["git", "push"]')
    expect(rules).toContain('["gh", "pr", "create"]')
    expect(rules).toContain('["gh", "pr", "merge"]')
    expect(rules).toContain('["gh", "api"]')
  })

  it('S/codex-env is empty and stays empty on a second prepare (SH-4)', () => {
    precreateCodexState(paths, SLUG)
    const s = codexStatePaths(paths, SLUG)
    fs.writeFileSync(s.env, '')
    precreateCodexState(paths, SLUG)
    expect(fs.readFileSync(s.env, 'utf8')).toBe('')
  })

  it('is idempotent and restores the app-owned rules file', () => {
    precreateCodexState(paths, SLUG)
    const s = codexStatePaths(paths, SLUG)
    fs.writeFileSync(s.rulesFile, 'tampered')
    expect(precreateCodexState(paths, SLUG)).toEqual({ ok: true })
    expect(fs.readFileSync(s.rulesFile, 'utf8')).toContain('git')
  })

  it('does not follow a symlink planted at S/codex-log', () => {
    const s = codexStatePaths(paths, SLUG)
    fs.mkdirSync(s.state, { recursive: true })
    const victim = path.join(home, 'victim')
    fs.mkdirSync(victim)
    fs.symlinkSync(victim, s.log)

    const result = precreateCodexState(paths, SLUG)

    expect(result).toEqual({
      ok: false,
      detail: `~/.corner-office/sandbox/${SLUG}/codex-log is a symbolic link. Replace it with a real file or folder, then Start again.`,
    })
    expect(fs.readdirSync(victim)).toEqual([])
  })

  it('does not write through a symlink planted at the rules file or the overlay', () => {
    precreateCodexState(paths, SLUG)
    const s = codexStatePaths(paths, SLUG)
    const victim = path.join(home, 'victim.txt')
    fs.writeFileSync(victim, 'keep')
    fs.rmSync(s.rulesFile)
    fs.symlinkSync(victim, s.rulesFile)

    expect(precreateCodexState(paths, SLUG)).toMatchObject({ ok: false, detail: expect.stringContaining('symbolic link') })
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep')

    fs.rmSync(s.configOverlay)
    fs.symlinkSync(victim, s.configOverlay)
    expect(writeOverlay(paths, SLUG, WT)).toMatchObject({ ok: false })
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
  })

  it('refuses a symlinked state directory', () => {
    const target = path.join(home, 'elsewhere')
    fs.mkdirSync(target)
    fs.mkdirSync(paths.sandboxStateRoot, { recursive: true })
    fs.symlinkSync(target, path.join(paths.sandboxStateRoot, SLUG))
    expect(precreateCodexState(paths, SLUG)).toMatchObject({ ok: false, detail: expect.stringContaining('is a symbolic link') })
    expect(fs.readdirSync(target)).toEqual([])
  })
})

describe('buildOverlay', () => {
  it('carries only the allowlisted keys and forces the app keys last', () => {
    const overlay = buildOverlay(
      {
        model: 'gpt-x',
        model_provider: 'mine',
        model_reasoning_effort: 'high',
        tui: { theme: 'dark' },
        plugins: { a: { enabled: true } },
        features: { shell_tool: true, daemon_auto_start: true },
        mcp_servers: { evil: { command: 'rm' } },
        notify: ['curl'],
        hooks: { x: 1 },
        otel: { endpoint: 'x' },
        marketplaces: { m: 1 },
        projects: { '/host/proj': { trust_level: 'trusted' } },
        approval_policy: 'never',
        sandbox_mode: 'danger-full-access',
        cli_auth_credentials_store: 'keyring',
        check_for_update_on_startup: true,
      },
      WT,
    )

    expect(overlay).toEqual({
      model: 'gpt-x',
      model_provider: 'mine',
      model_reasoning_effort: 'high',
      tui: { theme: 'dark' },
      plugins: { a: { enabled: true } },
      features: { shell_tool: true, daemon_auto_start: false },
      cli_auth_credentials_store: 'file',
      check_for_update_on_startup: false,
      projects: { [WT]: { trust_level: 'trusted' } },
    })
  })

  it('carries only the allowed model_providers sub-keys: headers, tokens, query params and auth are dropped', () => {
    const overlay = buildOverlay(
      {
        model_providers: {
          corp: {
            name: 'Corp',
            base_url: 'https://llm.example.com/v1',
            wire_api: 'responses',
            env_key: 'CORP_KEY',
            request_max_retries: 3,
            stream_max_retries: 2,
            stream_idle_timeout_ms: 1000,
            http_headers: { Authorization: 'Bearer secret' },
            env_http_headers: { X: 'Y' },
            query_params: { key: 'secret' },
            auth: { command: 'get-token' },
            experimental_bearer_token: 'secret',
          },
          junk: 'not a table',
          empty: { http_headers: { a: 'b' } },
          nested: { name: { not: 'scalar' } },
        },
      },
      WT,
    )

    expect(overlay.model_providers).toEqual({
      corp: {
        name: 'Corp',
        base_url: 'https://llm.example.com/v1',
        wire_api: 'responses',
        env_key: 'CORP_KEY',
        request_max_retries: 3,
        stream_max_retries: 2,
        stream_idle_timeout_ms: 1000,
      },
    })
    expect(JSON.stringify(overlay)).not.toContain('secret')
  })

  it('writes the app keys even from an empty host config, and ignores a non-table features', () => {
    expect(buildOverlay({}, WT)).toEqual({
      cli_auth_credentials_store: 'file',
      check_for_update_on_startup: false,
      features: { daemon_auto_start: false },
      projects: { [WT]: { trust_level: 'trusted' } },
    })
    expect(buildOverlay({ features: 'nope' }, WT).features).toEqual({ daemon_auto_start: false })
  })

  it('omits model_providers when none survive', () => {
    expect('model_providers' in buildOverlay({ model_providers: { a: { http_headers: {} } } }, WT)).toBe(false)
  })
})

describe('writeOverlay', () => {
  beforeEach(() => {
    signedInHost()
    precreateCodexState(paths, SLUG)
  })

  it('writes valid TOML 0600 with the allowlisted keys and the trust entry for $WT', () => {
    writeHost('config.toml', 'model = "gpt-x"\nnotify = ["curl"]\n[mcp_servers.evil]\ncommand = "rm"\n')

    expect(writeOverlay(paths, SLUG, WT)).toEqual({ ok: true })

    const file = codexStatePaths(paths, SLUG).configOverlay
    expect(mode(file)).toBe(0o600)
    const parsed = parse(fs.readFileSync(file, 'utf8'))
    expect(parsed.model).toBe('gpt-x')
    expect(parsed.cli_auth_credentials_store).toBe('file')
    expect(parsed.check_for_update_on_startup).toBe(false)
    expect((parsed.features as Record<string, unknown>).daemon_auto_start).toBe(false)
    expect((parsed.projects as Record<string, unknown>)[WT]).toEqual({ trust_level: 'trusted' })
    expect(parsed.notify).toBeUndefined()
    expect(parsed.mcp_servers).toBeUndefined()
  })

  it('rewrites the overlay in place on every prepare and truncates a longer previous one', () => {
    fs.writeFileSync(codexStatePaths(paths, SLUG).configOverlay, 'x'.repeat(5000))
    writeHost('config.toml', '')
    expect(writeOverlay(paths, SLUG, WT)).toEqual({ ok: true })
    expect(fs.readFileSync(codexStatePaths(paths, SLUG).configOverlay, 'utf8').length).toBeLessThan(500)
  })

  it('invalid TOML in the host config gives the fixed copy, and writes nothing new', () => {
    writeHost('config.toml', 'model = = broken SECRET')
    const result = writeOverlay(paths, SLUG, WT)
    expect(result).toEqual({ ok: false, detail: "~/.codex/config.toml isn't valid TOML. Fix or remove it, then Start again." })
    expect(JSON.stringify(result)).not.toContain('SECRET')
  })

  it('refuses a host config over the 2 MB cap', () => {
    writeHost('config.toml', '#'.repeat(2 * 1024 * 1024 + 10))
    expect(writeOverlay(paths, SLUG, WT)).toMatchObject({ ok: false, detail: expect.stringContaining('too large') })
  })

  it('treats a missing host config as empty', () => {
    fs.rmSync(path.join(paths.codexDir, 'config.toml'), { force: true })
    expect(writeOverlay(paths, SLUG, WT)).toEqual({ ok: true })
  })
})

describe('socket refusal', () => {
  let servers: net.Server[] = []

  function listen(sockPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(sockPath), { recursive: true })
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      servers.push(server)
      server.once('error', reject)
      server.listen(sockPath, resolve)
    })
  }

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))))
    servers = []
  })

  it('a socket in ~/.codex refuses with config-invalid naming it', async () => {
    fs.mkdirSync(paths.codexDir)
    await listen(path.join(paths.codexDir, 'ipc', 'agent.sock'))

    expect(findHostSocket(paths.codexDir)).toBe('ipc/agent.sock')
    expect(refuseHostSockets(paths)).toEqual({
      ok: false,
      detail:
        '~/.codex/ipc/agent.sock is a socket that Codex in the sandbox could use to run commands on your computer. Stop the program that created it, then Start again.',
    })
  })

  it.each(['app-server-daemon', 'sessions', 'archived_sessions', 'log'])('a socket inside the shadowed or session dir %s is ignored', async (dir) => {
    fs.mkdirSync(paths.codexDir)
    await listen(path.join(paths.codexDir, dir, 'x.sock'))
    expect(findHostSocket(paths.codexDir)).toBeNull()
    expect(refuseHostSockets(paths)).toEqual({ ok: true })
  })

  it('does not look deeper than two levels', async () => {
    fs.mkdirSync(paths.codexDir)
    await listen(path.join(paths.codexDir, 'a', 'b', 'c', 's.sock'))
    expect(findHostSocket(paths.codexDir)).toBeNull()
    await listen(path.join(paths.codexDir, 'a', 'b', 's2.sock'))
    expect(findHostSocket(paths.codexDir)).toBe('a/b/s2.sock')
  })

  it('stops at the entry cap without refusing', () => {
    fs.mkdirSync(paths.codexDir)
    const dir = path.join(paths.codexDir, 'many')
    fs.mkdirSync(dir)
    for (let i = 0; i < 5_010; i++) fs.writeFileSync(path.join(dir, `f${i}`), '')
    expect(findHostSocket(paths.codexDir)).toBeNull()
  })

  it('does nothing when ~/.codex is missing', () => {
    expect(refuseHostSockets(paths)).toEqual({ ok: true })
  })

  it('survives an unreadable directory', () => {
    fs.mkdirSync(paths.codexDir)
    fs.mkdirSync(path.join(paths.codexDir, 'locked'), { mode: 0o000 })
    try {
      expect(findHostSocket(paths.codexDir)).toBeNull()
    } finally {
      fs.chmodSync(path.join(paths.codexDir, 'locked'), 0o700)
    }
  })
})

describe('prepareCodexConfig', () => {
  it('without ~/.codex it refuses with the never-run copy and creates nothing', () => {
    const result = prepareCodexConfig(paths, SLUG, WT)
    expect(result).toEqual({ ok: false, detail: 'Run Codex on this computer once first.' })
    expect(fs.existsSync(paths.codexDir)).toBe(false)
    expect(fs.existsSync(codexStatePaths(paths, SLUG).state)).toBe(false)
  })

  it('on a signed-in host it precreates both sides and writes the overlay', () => {
    signedInHost()
    expect(prepareCodexConfig(paths, SLUG, WT)).toEqual({ ok: true })
    expect(fs.existsSync(path.join(paths.codexDir, '.env'))).toBe(true)
    expect(fs.existsSync(codexStatePaths(paths, SLUG).rulesFile)).toBe(true)
    expect(parse(fs.readFileSync(codexStatePaths(paths, SLUG).configOverlay, 'utf8')).cli_auth_credentials_store).toBe('file')
  })

  it('stops at the first problem', () => {
    signedInHost()
    fs.mkdirSync(path.join(home, 'real'))
    fs.symlinkSync(path.join(home, 'real'), path.join(paths.codexDir, 'plugins'))
    expect(prepareCodexConfig(paths, SLUG, WT)).toMatchObject({ ok: false })
    expect(fs.existsSync(codexStatePaths(paths, SLUG).state)).toBe(false)
  })

  it('a socket refuses the start', () => {
    signedInHost()
    const sock = net.createServer()
    const sockPath = path.join(paths.codexDir, 'live.sock')
    return new Promise<void>((resolve) => {
      sock.listen(sockPath, () => {
        const result = prepareCodexConfig(paths, SLUG, WT)
        expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('is a socket') })
        sock.close(() => resolve())
      })
    })
  })
})

describe('codexReadiness', () => {
  it('never-run when ~/.codex is missing, a file, or a symlink', () => {
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'never-run' })
    fs.writeFileSync(paths.codexDir, 'file')
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'never-run' })
    fs.rmSync(paths.codexDir)
    fs.mkdirSync(path.join(home, 'real'))
    fs.symlinkSync(path.join(home, 'real'), paths.codexDir)
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'never-run' })
  })

  it('not-signed-in without a regular auth.json (missing, a directory, or a symlink)', () => {
    fs.mkdirSync(paths.codexDir)
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'not-signed-in' })
    fs.mkdirSync(path.join(paths.codexDir, 'auth.json'))
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'not-signed-in' })
    fs.rmdirSync(path.join(paths.codexDir, 'auth.json'))
    fs.writeFileSync(path.join(home, 'tok'), '{}')
    fs.symlinkSync(path.join(home, 'tok'), path.join(paths.codexDir, 'auth.json'))
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'not-signed-in' })
  })

  it('keyring when the host config keeps the sign-in anywhere but a file', () => {
    signedInHost()
    writeHost('config.toml', 'cli_auth_credentials_store = "keyring"\n')
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'keyring' })
    writeHost('config.toml', 'cli_auth_credentials_store = "auto"\n')
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'keyring' })
  })

  it('ready with file storage, no setting, an unparseable config, or an oversized one', () => {
    signedInHost()
    expect(codexReadiness(paths)).toEqual({ ok: true })
    writeHost('config.toml', 'cli_auth_credentials_store = "file"\n')
    expect(codexReadiness(paths)).toEqual({ ok: true })
    writeHost('config.toml', 'broken = = =')
    expect(codexReadiness(paths)).toEqual({ ok: true })
    writeHost('config.toml', '#'.repeat(2 * 1024 * 1024 + 10))
    expect(codexReadiness(paths)).toEqual({ ok: true })
  })

  it('config-invalid when a mounted entry is a symlink or the wrong type', () => {
    signedInHost()
    fs.writeFileSync(path.join(paths.codexDir, 'skills'), 'a file')
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'config-invalid' })
    fs.rmSync(path.join(paths.codexDir, 'skills'))
    fs.writeFileSync(path.join(home, 'real'), '')
    fs.symlinkSync(path.join(home, 'real'), path.join(paths.codexDir, '.env'))
    expect(codexReadiness(paths)).toEqual({ ok: false, code: 'config-invalid' })
  })

  it('writes nothing, ever (fs spy)', () => {
    signedInHost()
    fs.writeFileSync(path.join(paths.codexDir, 'skills'), 'x')
    const writers = ['writeFileSync', 'mkdirSync', 'openSync', 'rmSync', 'renameSync', 'chmodSync'] as const
    const spies = writers.map((name) => vi.spyOn(fs, name))
    // openSync is also how the capped read opens a file; only O_WRONLY/O_RDWR/O_CREAT opens count as writes.
    codexReadiness(paths)
    const writeCalls = spies.flatMap((spy, i) =>
      writers[i] === 'openSync' ? spy.mock.calls.filter((call) => typeof call[1] === 'number' && (call[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0) : spy.mock.calls,
    )
    spies.forEach((spy) => spy.mockRestore())
    expect(writeCalls).toEqual([])
  })
})
