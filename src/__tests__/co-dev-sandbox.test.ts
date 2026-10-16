import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ELECTRON_TOOLCHAIN_COPY } from '../renderer/utils/sandbox-copy'

// ---------------------------------------------------------------------------
// scripts/co_dev_sandbox.sh (#0038, step 2.5), run against a stubbed PATH: fake Xvfb, socat,
// curl, ldd and electron-vite, a temp HOME and a temp repo root. PATH holds only the stubs and
// symlinks to the few real tools the script needs, so a real Xvfb on the machine never leaks in.
// ---------------------------------------------------------------------------

const SCRIPT = path.resolve(__dirname, '../../scripts/co_dev_sandbox.sh')
const REAL_TOOLS = [
  'bash', 'env', 'mkdir', 'cat', 'tail', 'grep', 'sleep', 'rm', 'dirname', 'ln', 'setsid', 'head',
  'seq', 'touch', 'tr', 'cut', 'sed', 'awk', 'basename', 'ldd',
]

let root: string
let bin: string
let home: string
let repo: string

function which(tool: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

function stub(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 })
}

function installRepo(opts: { electron: boolean }): void {
  fs.mkdirSync(path.join(repo, 'node_modules/.bin'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, 'node_modules/.bin/electron-vite'),
    [
      '#!/usr/bin/env bash',
      'env > "$HOME/env.txt"',
      'echo $$ > "$HOME/vite.pid"',
      'if [ "${EV_MODE:-}" = exit ]; then echo "boom: vite failed to start"; exit 1; fi',
      'touch "$HOME/up"',
      'exec sleep 600',
    ].join('\n') + '\n',
    { mode: 0o755 },
  )
  if (opts.electron) {
    fs.mkdirSync(path.join(repo, 'node_modules/electron/dist'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules/electron/dist/electron'), '')
    fs.mkdirSync(path.join(repo, 'node_modules/node-pty/build/Release'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'node_modules/node-pty/build/Release/pty.node'), '')
  }
}

// The Xvfb lock and socket live under the temp root, so the tests never touch the real /tmp/.X99-lock.
const xLock = (): string => path.join(root, 'X99-lock')
const xSocket = (): string => path.join(root, 'X99')

function run(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    env: {
      PATH: bin,
      HOME: home,
      CO_REPO_ROOT: repo,
      CORNER_OFFICE_SANDBOX: '1',
      CO_X_LOCK: xLock(),
      CO_X_SOCKET: xSocket(),
      ...env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

const TOOLCHAIN_LINE =
  '  [ ] Settings > Sandbox > Toolchains: turn on "Electron dev runtime" and rebuild the image (affects all workspaces)'
const ALLOWLIST_LINE = "  [ ] This workspace's sandbox settings > Allowlist: add electronjs.org"
const RESTART_LINE = '  [ ] Restart this session'

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-dev-sandbox-'))
  bin = path.join(root, 'bin')
  home = path.join(root, 'home')
  repo = path.join(root, 'repo')
  for (const d of [bin, home, repo]) fs.mkdirSync(d)
  for (const tool of REAL_TOOLS) {
    const found = which(tool)
    if (found) fs.symlinkSync(found, path.join(bin, tool))
  }
  stub('Xvfb', 'echo $$ > "$HOME/xvfb.pid"; exec sleep 600')
  stub('socat', 'printf "%s\\n" "$@" > "$HOME/socat.args"; exec sleep 600')
  // External URLs answer unless CURL_EXTERNAL_FAIL=1; the local CDP answers once the fake app touched $HOME/up.
  stub(
    'curl',
    [
      'url="${*: -1}"',
      'case "$url" in',
      '  https://*) [ "${CURL_EXTERNAL_FAIL:-}" = 1 ] && exit 6; exit 0 ;;',
      '  *) [ -e "$HOME/up" ] && exit 0; exit 7 ;;',
      'esac',
    ].join('\n'),
  )
  installRepo({ electron: true })
})

afterEach(() => {
  run(['--stop'])
  fs.rmSync(root, { recursive: true, force: true })
})

describe('validation and mode', () => {
  it('names PROFILE= for a bad profile', () => {
    const r = run([], { PROFILE: 'Dev_1' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('PROFILE="Dev_1" is invalid.')
  })

  it.each(['abc', '80', '70000'])('names DEBUG_PORT= for %s', (port) => {
    const r = run([], { DEBUG_PORT: port })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain(`DEBUG_PORT="${port}" is invalid.`)
  })

  it('rejects an unknown option', () => {
    expect(run(['--bogus']).status).toBe(64)
  })
})

describe('preflight', () => {
  it('outside a sandbox: exit 2 with the exact text', () => {
    const r = run([], { CORNER_OFFICE_SANDBOX: '' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('This target runs inside a Corner Office sandbox session. On the host use `make dev`.')
  })

  it('no Xvfb or socat: exactly the toolchain and restart lines', () => {
    fs.rmSync(path.join(bin, 'Xvfb'))
    fs.rmSync(path.join(bin, 'socat'))
    const r = run(['--wait'])
    expect(r.status).toBe(3)
    expect(r.stderr.trim().split('\n')).toEqual([
      "make dev-sandbox can't start yet. On the host, in Corner Office:",
      TOOLCHAIN_LINE,
      RESTART_LINE,
    ])
  })

  it('shows the allowlist line only when the external probe fails and Electron is missing', () => {
    fs.rmSync(path.join(repo, 'node_modules/electron'), { recursive: true })
    const blocked = run(['--wait'], { CURL_EXTERNAL_FAIL: '1' })
    expect(blocked.status).toBe(3)
    expect(blocked.stderr.trim().split('\n')).toEqual([
      "make dev-sandbox can't start yet. On the host, in Corner Office:",
      ALLOWLIST_LINE,
      RESTART_LINE,
    ])

    // Electron present: the probe is not even needed, so a failing curl adds no allowlist line.
    installRepo({ electron: true })
    const present = run(['--wait'], { CURL_EXTERNAL_FAIL: '1', EV_MODE: 'exit' })
    expect(present.stderr).not.toContain('Allowlist')
  })

  it('both problems give both lines and one restart line', () => {
    fs.rmSync(path.join(bin, 'Xvfb'))
    fs.rmSync(path.join(repo, 'node_modules/electron'), { recursive: true })
    const r = run(['--wait'], { CURL_EXTERNAL_FAIL: '1' })
    expect(r.status).toBe(3)
    expect(r.stderr.trim().split('\n')).toEqual([
      "make dev-sandbox can't start yet. On the host, in Corner Office:",
      TOOLCHAIN_LINE,
      ALLOWLIST_LINE,
      RESTART_LINE,
    ])
  })

  it('missing shared libraries in Electron count as the toolchain problem', () => {
    stub('ldd', 'echo "\tlibgbm.so.1 => not found"')
    const r = run(['--wait'])
    expect(r.status).toBe(3)
    expect(r.stderr).toContain(TOOLCHAIN_LINE)
  })

  it('the toolchain label in the checklist is the settings panel label', () => {
    // The panel's toolchain checkbox text starts with the name the checklist quotes.
    const name = 'Electron dev runtime'
    expect(ELECTRON_TOOLCHAIN_COPY.startsWith(name)).toBe(true)
    expect(fs.readFileSync(SCRIPT, 'utf8')).toContain(`"${name}"`)
  })

  it('everything present: no checklist', () => {
    const r = run(['--wait'], { EV_MODE: 'exit' })
    expect(r.stderr).not.toContain("can't start yet")
  })
})

describe('stale display', () => {
  // A pid that is certainly dead: a finished child.
  const deadPid = (): string => String(spawnSync('true').pid)

  it('a lock whose pid is dead is removed with its socket and the start continues', () => {
    fs.writeFileSync(xLock(), `${deadPid().padStart(10)}\n`)
    fs.writeFileSync(xSocket(), '')
    const r = run(['--wait'])
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('is in use')
  })

  it('a socket without a lock is stale too', () => {
    fs.writeFileSync(xSocket(), '')
    expect(run(['--wait']).status).toBe(0)
  })

  // This test process stands in for a live Xvfb: its own comm is passed as the expected name.
  const liveX = (): Record<string, string> => ({ CO_X_NAME: fs.readFileSync(`/proc/${process.pid}/comm`, 'utf8').trim() })

  it('a lock with a live pid blocks the start and names the pid', () => {
    fs.writeFileSync(xLock(), `${String(process.pid).padStart(10)}\n`)
    const r = run(['--wait'], liveX())
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`display :99 is in use by pid ${process.pid}; run make dev-sandbox-stop`)
    expect(fs.existsSync(xLock())).toBe(true)
  })

  it('a lock whose live pid is not Xvfb (a pid reused after a container restart) is stale', () => {
    fs.writeFileSync(xLock(), `${String(process.pid).padStart(10)}\n`)
    fs.writeFileSync(xSocket(), '')
    const r = run(['--wait'])
    expect(r.status).toBe(0)
    expect(r.stderr).not.toContain('is in use')
  })

  it('--stop removes a stale lock and socket but leaves a live one', () => {
    fs.writeFileSync(xLock(), `${deadPid()}\n`)
    fs.writeFileSync(xSocket(), '')
    expect(run(['--stop']).status).toBe(0)
    expect(fs.existsSync(xLock())).toBe(false)
    expect(fs.existsSync(xSocket())).toBe(false)

    fs.writeFileSync(xLock(), `${process.pid}\n`)
    run(['--stop'], liveX())
    expect(fs.existsSync(xLock())).toBe(true)
  })
})

describe('--wait', () => {
  it('a vite that exits at once: exit 1, the log tail on stderr and the log path named', () => {
    const r = run(['--wait'], { EV_MODE: 'exit' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('==> waiting for CDP on :9222 (up to 90 s)...')
    expect(r.stderr).toContain('boom: vite failed to start')
    expect(r.stderr).toContain(`Full log: ${home}/.corner-office/profiles/dev/logs/dev-sandbox.log`)
  })

  it('on success prints the banner with the unpublished host line, then --stop cleans up', () => {
    const r = run(['--wait'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('==> Corner Office dev profile "dev" (sandbox, headless Xvfb :99)')
    expect(r.stdout).toContain('host: not published. Ask the user to turn on Settings > Sandbox > Dev app access for this workspace in Corner Office (then recreate)')
    expect(r.stdout).toContain('shot: node scripts/co_dev_shot.mjs [--text]')
    const pidfile = path.join(home, '.corner-office/profiles/dev/dev-sandbox.pid')
    expect(fs.existsSync(pidfile)).toBe(true)

    expect(run(['--wait']).stderr).toContain('already running')

    const stopped = run(['--stop'])
    expect(stopped.status).toBe(0)
    expect(stopped.stdout).toContain('stopped')
    expect(fs.existsSync(pidfile)).toBe(false)
  })

  it('shows the published host line when Dev app access is on', () => {
    const r = run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: '23456', CO_ROUTE_FILE: routeFile(ROUTE_OK) })
    expect(r.stdout).toContain('host: 127.0.0.1:23456')
  })

  it('strips the host-attribution env and keeps CORNER_OFFICE_SANDBOX', () => {
    run(['--wait'], { CORNER_OFFICE_CHANNEL_PORT: '41000', CORNER_OFFICE_CDP_PUBLISH_PORT: '23456' })
    const env = fs.readFileSync(path.join(home, 'env.txt'), 'utf8')
    expect(env).not.toContain('CORNER_OFFICE_CHANNEL_PORT')
    expect(env).not.toContain('CORNER_OFFICE_CDP_PUBLISH_PORT')
    expect(env).toContain('CORNER_OFFICE_SANDBOX=1')
    expect(env).toContain('CORNER_OFFICE_PROFILE=dev')
    expect(env).toContain('CORNER_OFFICE_DEBUG_PORT=9222')
    expect(env).toContain('DISPLAY=:99')
  })

  it('creates the profile directories and the plugins symlink', () => {
    run(['--wait'])
    const profile = path.join(home, '.corner-office/profiles/dev')
    for (const d of ['logs', 'shots', 'claude']) expect(fs.statSync(path.join(profile, d)).isDirectory()).toBe(true)
    expect(fs.readlinkSync(path.join(profile, 'claude/plugins'))).toBe(path.join(home, '.claude/plugins'))
  })
})

const ROUTE_HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT'
const ROUTE_TAIL = '0003\t0\t0\t0\t00000000\t0\t0\t0'
const ROUTE_OK = `${ROUTE_HEADER}\neth0\t00000000\t0100A8C0\t${ROUTE_TAIL}\neth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n`

function routeFile(content: string): string {
  const file = path.join(root, 'route')
  fs.writeFileSync(file, content)
  return file
}

describe('Dev app access (3a.4)', () => {
  const socatArgs = (): string[] => fs.readFileSync(path.join(home, 'socat.args'), 'utf8').trim().split('\n')
  const log = (): string => fs.readFileSync(path.join(home, '.corner-office/profiles/dev/logs/dev-sandbox.log'), 'utf8')

  it('starts socat limited to the gateway, with an argv built from validated values only', () => {
    const r = run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: '23456', CO_ROUTE_FILE: routeFile(ROUTE_OK) })

    expect(r.status).toBe(0)
    expect(socatArgs()).toEqual([
      '-T',
      '600',
      'TCP-LISTEN:23456,bind=0.0.0.0,fork,reuseaddr,max-children=8,range=192.168.0.1/32',
      'TCP:127.0.0.1:9222',
    ])
    expect(r.stdout).toContain('host: 127.0.0.1:23456')
  })

  it('uses the debug port the launcher was given', () => {
    run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: '23456', DEBUG_PORT: '9333', CO_ROUTE_FILE: routeFile(ROUTE_OK) })
    expect(socatArgs()[3]).toBe('TCP:127.0.0.1:9333')
  })

  it.each([
    ['an empty route file', ''],
    ['a route file with no default route', `${ROUTE_HEADER}\neth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n`],
    ['a 0.0.0.0 gateway', `${ROUTE_HEADER}\neth0\t00000000\t00000000\t${ROUTE_TAIL}\n`],
    ['a malformed gateway', `${ROUTE_HEADER}\neth0\t00000000\t01zz\t${ROUTE_TAIL}\n`],
  ])('%s: no socat, the exact log line, and the banner says not published', (_name, content) => {
    const r = run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: '23456', CO_ROUTE_FILE: routeFile(content) })

    expect(r.status).toBe(0)
    expect(fs.existsSync(path.join(home, 'socat.args'))).toBe(false)
    expect(log()).toContain('Dev app access: could not read the gateway from /proc/net/route; not publishing')
    expect(r.stdout).toContain('host: not published')
    expect(r.stdout).not.toContain('127.0.0.1:23456')
  })

  it('a missing route file is also fail-closed', () => {
    const r = run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: '23456', CO_ROUTE_FILE: path.join(root, 'nope') })
    expect(fs.existsSync(path.join(home, 'socat.args'))).toBe(false)
    expect(r.stdout).toContain('host: not published')
  })

  it('a socat that dies at once is reported and the banner does not claim a publish', () => {
    stub('socat', 'exit 1')
    const r = run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: '23456', CO_ROUTE_FILE: routeFile(ROUTE_OK) })
    expect(log()).toContain('Dev app access: socat exited at once; not publishing')
    expect(r.stdout).toContain('host: not published')
  })

  it('without the env var there is no socat and the off host line', () => {
    const r = run(['--wait'], { CO_ROUTE_FILE: routeFile(ROUTE_OK) })
    expect(fs.existsSync(path.join(home, 'socat.args'))).toBe(false)
    expect(r.stdout).toContain('host: not published. Ask the user to turn on Settings > Sandbox > Dev app access for this workspace in Corner Office (then recreate)')
  })

  it.each(['abc', '80', '70000', '9222', '23456;touch x', '2345\n6'])('refuses an invalid port %j and starts nothing', (port) => {
    const r = run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: port, CO_ROUTE_FILE: routeFile(ROUTE_OK) })

    expect(r.status).toBe(2)
    expect(r.stderr).toContain('CORNER_OFFICE_CDP_PUBLISH_PORT=')
    expect(fs.existsSync(path.join(home, 'socat.args'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'xvfb.pid'))).toBe(false)
  })

  it('--stop still works with a bad port in the environment', () => {
    run(['--wait'], { CORNER_OFFICE_CDP_PUBLISH_PORT: '23456', CO_ROUTE_FILE: routeFile(ROUTE_OK) })
    expect(run(['--stop'], { CORNER_OFFICE_CDP_PUBLISH_PORT: 'abc' }).status).toBe(0)
    const pidfile = path.join(home, '.corner-office/profiles/dev/dev-sandbox.pid')
    expect(fs.existsSync(pidfile)).toBe(false)
  })
})

describe('--stop', () => {
  it('with no pidfile is a no-op', () => {
    const r = run(['--stop'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('not running')
  })
})

// ---------------------------------------------------------------------------
// Review fixes (2.5): whole-string validation, a careful --stop, the --run gate, no orphans.
// ---------------------------------------------------------------------------

const pidfilePath = (): string => path.join(home, '.corner-office/profiles/dev/dev-sandbox.pid')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('whole-string validation', () => {
  it('rejects a PROFILE with an embedded newline and creates nothing', () => {
    const r = run(['--wait'], { PROFILE: 'dev\n/../../..' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('is invalid')
    expect(fs.existsSync(path.join(home, '.corner-office'))).toBe(false)
  })

  it('rejects a PROFILE with a trailing newline', () => {
    expect(run([], { PROFILE: 'dev\n' }).status).toBe(2)
  })

  it('rejects a DEBUG_PORT with an embedded newline', () => {
    const r = run(['--wait'], { DEBUG_PORT: '9222\nx' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('DEBUG_PORT=')
  })
})

describe('--stop trusts nothing in the pidfile', () => {
  function writePidfile(content: string): void {
    fs.mkdirSync(path.dirname(pidfilePath()), { recursive: true })
    fs.writeFileSync(pidfilePath(), content)
  }

  it.each(['0', '1', '-1', 'abc', '12 34', ''])('ignores pidfile content %j and removes the pidfile', (content) => {
    writePidfile(content)
    const r = run(['--stop'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('stopped')
    expect(fs.existsSync(pidfilePath())).toBe(false)
  })

  it('does not signal a live process that is not the launcher', () => {
    const bystander = spawnSync('bash', ['-c', 'sleep 600 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' })
    const pid = Number(bystander.stdout.trim())
    try {
      writePidfile(String(pid))
      expect(run(['--stop']).status).toBe(0)
      expect(alive(pid)).toBe(true)
      expect(fs.existsSync(pidfilePath())).toBe(false)
    } finally {
      process.kill(pid, 'SIGKILL')
    }
  })
})

describe('--run gate', () => {
  it('refuses outside a sandbox session', () => {
    const r = run(['--run'], { CORNER_OFFICE_SANDBOX: '', CO_DEV_SANDBOX_CHILD: '1' })
    expect(r.status).toBe(2)
    expect(fs.existsSync(path.join(home, '.corner-office'))).toBe(false)
  })

  it('refuses when --wait did not start it', () => {
    const r = run(['--run'])
    expect(r.status).toBe(64)
    expect(r.stderr).toContain('--run is internal')
  })
})

describe('--stop ends the whole tree', () => {
  it('leaves no vite or Xvfb process behind', () => {
    expect(run(['--wait']).status).toBe(0)
    const vite = Number(fs.readFileSync(path.join(home, 'vite.pid'), 'utf8'))
    const xvfb = Number(fs.readFileSync(path.join(home, 'xvfb.pid'), 'utf8'))
    expect(alive(vite)).toBe(true)
    expect(alive(xvfb)).toBe(true)

    expect(run(['--stop']).status).toBe(0)
    // Reaping is asynchronous: give the killed processes a moment to disappear.
    const deadline = Date.now() + 5000
    while ((alive(vite) || alive(xvfb)) && Date.now() < deadline) spawnSync('sleep', ['0.1'])
    expect(alive(vite)).toBe(false)
    expect(alive(xvfb)).toBe(false)
  })
})
