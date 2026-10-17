import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

// ---------------------------------------------------------------------------
// `make dev` and `make dev-stop` (#0038): host recipe, sandbox recipe, stop. `make -n`
// prints the recipe without running it. The app validates PROFILE / DEBUG_PORT, not the Makefile.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../..')

function make(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  // Start from a clean env: the sandbox this runs in sets CORNER_OFFICE_SANDBOX itself.
  const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
  const r = spawnSync('make', args, { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('make dev on the host (dry run)', () => {
  it('defaults to the dev profile with the quiet banner and the env prefix', () => {
    const { status, stdout } = make(['-n', 'dev'])
    expect(status).toBe(0)
    expect(stdout).toContain('echo "==> profile: dev (~/.corner-office/profiles/dev)  [PROFILE= for your real data]"')
    expect(stdout).toContain('CORNER_OFFICE_PROFILE=dev CORNER_OFFICE_DEBUG_PORT= node_modules/.bin/electron-vite dev')
    expect(stdout).not.toContain('co_dev_sandbox.sh')
    expect(stdout).not.toContain('WARNING')
  })

  it('PROFILE= selects the real data with the loud banner', () => {
    const { status, stdout } = make(['-n', 'dev', 'PROFILE='])
    expect(status).toBe(0)
    expect(stdout).toContain('echo "==> profile: default (REAL DATA, ~/.corner-office)"')
    expect(stdout).toContain('CORNER_OFFICE_PROFILE= CORNER_OFFICE_DEBUG_PORT= node_modules/.bin/electron-vite dev')
  })

  it('PROFILE=default is also loud', () => {
    expect(make(['-n', 'dev', 'PROFILE=default']).stdout).toContain('profile: default (REAL DATA')
  })

  it('passes a named profile and a debug port through, without a warning', () => {
    const { stdout } = make(['-n', 'dev', 'PROFILE=x', 'DEBUG_PORT=9223'])
    expect(stdout).toContain('echo "==> profile: x (~/.corner-office/profiles/x)  [PROFILE= for your real data]"')
    expect(stdout).toContain('CORNER_OFFICE_PROFILE=x CORNER_OFFICE_DEBUG_PORT=9223 node_modules/.bin/electron-vite dev')
    expect(stdout).not.toContain('WARNING')
  })

  it('warns about real data plus a debug port', () => {
    const { stdout } = make(['-n', 'dev', 'PROFILE=', 'DEBUG_PORT=9223'])
    expect(stdout).toContain('WARNING: DEBUG_PORT=9223 with your REAL data (no profile).')
    expect(stdout).toContain('no authentication')
    expect(stdout).toContain('Prefer a named profile: make dev PROFILE=dev DEBUG_PORT=9223')
  })

  it('sends the warning to stderr and still starts the app', () => {
    const { stdout } = make(['-n', 'dev', 'PROFILE=', 'DEBUG_PORT=9223'])
    expect(stdout).toMatch(/>&2/)
    expect(stdout).toContain('CORNER_OFFICE_DEBUG_PORT=9223 node_modules/.bin/electron-vite dev')
  })
})

describe('make dev inside a sandbox session (dry run)', () => {
  it('runs the launcher with --wait and nothing else', () => {
    const { status, stdout } = make(['-n', 'dev'], { CORNER_OFFICE_SANDBOX: '1' })
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('scripts/co_dev_sandbox.sh --wait')
  })
})

describe('make dev-stop (dry run)', () => {
  it('runs the launcher with --stop', () => {
    const { status, stdout } = make(['-n', 'dev-stop'])
    expect(status).toBe(0)
    expect(stdout.trim()).toBe('scripts/co_dev_sandbox.sh --stop')
  })
})

describe('removed targets', () => {
  it.each(['dev-guard', 'dev-hints', 'dev-sandbox', 'dev-sandbox-stop'])('%s no longer exists', (target) => {
    expect(make(['-n', target]).status).not.toBe(0)
  })
})
