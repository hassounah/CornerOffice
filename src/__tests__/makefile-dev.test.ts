import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// `make dev` (#0038, step 1.9): banner, env prefix, PROFILE / DEBUG_PORT validation and
// the in-sandbox refusal. `make -n` prints the recipe without running it; the guard
// target runs for real because it is the part that must fail first.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../..')

function make(args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  // Start from a clean env: the sandbox this runs in sets CORNER_OFFICE_SANDBOX itself.
  const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }
  const r = spawnSync('make', args, { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' })
  return { status: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('make dev (dry run)', () => {
  it('defaults to the dev profile with the quiet banner and the env prefix', () => {
    const { status, stdout } = make(['-n', 'dev'])
    expect(status).toBe(0)
    expect(stdout).toContain('echo "==> profile: dev (~/.corner-office/profiles/dev)  [PROFILE= for your real data]"')
    expect(stdout).toContain('CORNER_OFFICE_PROFILE=dev CORNER_OFFICE_DEBUG_PORT= node_modules/.bin/electron-vite dev')
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

  it('passes a named profile and a debug port through', () => {
    const { stdout } = make(['-n', 'dev', 'PROFILE=x', 'DEBUG_PORT=9223'])
    expect(stdout).toContain('echo "==> profile: x (~/.corner-office/profiles/x)  [PROFILE= for your real data]"')
    expect(stdout).toContain('CORNER_OFFICE_PROFILE=x CORNER_OFFICE_DEBUG_PORT=9223 node_modules/.bin/electron-vite dev')
  })
})

describe('make dev-hints', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'co-make-'))
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('hints how to seed a profile that does not exist yet', () => {
    const { status, stdout } = make(['dev-hints', 'PROFILE=fresh'], { HOME: home })
    expect(status).toBe(0)
    expect(stdout).toContain(
      "New empty profile 'fresh'. To start from your real settings: cp ~/.corner-office/config.json ~/.corner-office/profiles/fresh/config.json",
    )
  })

  it('stays quiet for an existing profile', () => {
    mkdirSync(path.join(home, '.corner-office', 'profiles', 'there'), { recursive: true })
    const { status, stdout } = make(['dev-hints', 'PROFILE=there'], { HOME: home })
    expect(status).toBe(0)
    expect(stdout).not.toContain('New empty profile')
  })

  it('warns loudly, without refusing, for real data plus a debug port', () => {
    const { status, stderr, stdout } = make(['dev-hints', 'PROFILE=', 'DEBUG_PORT=9223'], { HOME: home })
    expect(status).toBe(0)
    expect(stderr).toContain('WARNING: DEBUG_PORT=9223 with your REAL data')
    expect(stderr).toContain('no authentication')
    expect(stderr).toContain('any local account')
    expect(stderr).toContain('Prefer a named profile')
    expect(stdout).not.toContain('New empty profile')
  })

  it('does not warn for a named profile or for real data without a port', () => {
    expect(make(['dev-hints', 'PROFILE=dev', 'DEBUG_PORT=9223'], { HOME: home }).stderr).not.toContain('WARNING')
    expect(make(['dev-hints', 'PROFILE='], { HOME: home }).stderr).toBe('')
  })

  it('runs after the guard and before the slow prerequisites', () => {
    const { stdout } = make(['-n', 'dev'])
    expect(stdout.indexOf('Inside a sandbox session')).toBeLessThan(stdout.indexOf('New empty profile'))
    expect(stdout.indexOf('New empty profile')).toBeLessThan(stdout.indexOf('process.versions.node'))
  })
})

describe('make dev-guard', () => {
  it('accepts the defaults, an empty PROFILE and a valid port', () => {
    expect(make(['dev-guard']).status).toBe(0)
    expect(make(['dev-guard', 'PROFILE=', 'DEBUG_PORT=9223']).status).toBe(0)
  })

  it('rejects a bad PROFILE with the exact message and exit 2', () => {
    const { status, stderr } = make(['dev-guard', 'PROFILE=Dev_1'])
    expect(status).toBe(2)
    expect(stderr).toContain(
      `PROFILE="Dev_1" is invalid. Use 1-32 lowercase letters, digits or '-', starting with a letter or digit. Example: make dev PROFILE=dev`,
    )
  })

  it.each(['abc', '80', '1023', '65536', '123456'])('rejects DEBUG_PORT=%s', (port) => {
    const { status, stderr } = make(['dev-guard', `DEBUG_PORT=${port}`])
    expect(status).toBe(2)
    expect(stderr).toContain(`DEBUG_PORT="${port}" is invalid. Use a port from 1024 to 65535, or leave it empty. Example: make dev DEBUG_PORT=9223`)
  })

  it('rejects values with an embedded newline', () => {
    expect(make(['dev-guard', 'PROFILE=dev\n/../x']).status).toBe(2)
    expect(make(['dev-guard', 'DEBUG_PORT=9223\nx']).status).toBe(2)
  })

  it('refuses inside a sandbox session before validating anything', () => {
    const { status, stdout } = make(['dev-guard'], { CORNER_OFFICE_SANDBOX: '1' })
    expect(status).toBe(2)
    expect(stdout).toContain('Inside a sandbox session use: make dev-sandbox')
  })

  it('runs the guard before the slow prerequisites', () => {
    const { stdout } = make(['-n', 'dev'])
    expect(stdout.indexOf('Inside a sandbox session')).toBeLessThan(stdout.indexOf('process.versions.node'))
  })
})
