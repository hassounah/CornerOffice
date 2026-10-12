import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import net from 'net'
import path from 'path'
import {
  dockerOk,
  docker,
  makeIdentity,
  removeIdentity,
  buildTestImage,
  removeTestImage,
  createCodexRig,
  execAsArgv,
} from './helpers'
import type { TestIdentity, CodexRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'

// ---------------------------------------------------------------------------
// codex.test.ts (#0037, TRD §10.4, §4.13) — the Codex sandbox, against a real
// container created through the real mount plan: the image's Codex
// install, and the read-only overlays and shadows.
// ---------------------------------------------------------------------------

const HOST_ENV = 'OPENAI_API_KEY=sk-not-a-real-key\n'

describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())('Codex sandbox — #0037', () => {
  let d: DockerRunner
  let identity: TestIdentity
  let rig: CodexRig
  let sockDir: string
  let sockServer: net.Server

  /** Runs `script` as the agent; a failing exit is returned, not thrown. */
  const agentSh = (script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> =>
    d.run(execAsArgv(rig.container.name, identity, ['/bin/sh', '-c', script]), { allowExit: [1, 2, 126, 127] })

  beforeAll(async () => {
    d = docker()
    identity = makeIdentity()
    await buildTestImage(d, identity)
    rig = await createCodexRig(d, identity, {
      hostFiles: {
        '.env': HOST_ENV,
        'AGENTS.md': 'host instructions\n',
        'hooks.json': '{"hooks":{}}\n',
      },
    })
    // A fake daemon socket on the host side, in the directory the container must see empty.
    sockDir = path.join(rig.codexDir, 'app-server-daemon')
    sockServer = net.createServer()
    await new Promise<void>((resolve) => sockServer.listen(path.join(sockDir, 'fake.sock'), resolve))
  }, 5 * 60_000)

  afterAll(async () => {
    sockServer?.close()
    if (rig) await rig.cleanup()
    await removeTestImage(d)
    if (identity) removeIdentity(identity)
  }, 60_000)

  it('codex runs from ~/.local/bin, installed outside the host-mounted ~/.codex', async () => {
    const version = await d.run(execAsArgv(rig.container.name, identity, ['codex', '--version']))
    expect(version.stdout).toMatch(/codex-cli \d+\.\d+\.\d+/)
    const target = await agentSh('readlink -f "$(command -v codex)"')
    expect(target.stdout.trim().startsWith(`${identity.home}/.local/share/codex/`)).toBe(true)
  })

  it.each(['config.toml', '.env', 'AGENTS.md', 'rules/x', 'plugins/x', 'skills/x'])(
    'writing ~/.codex/%s fails with a read-only filesystem',
    async (name) => {
      const result = await agentSh(`echo x > "${identity.home}/.codex/${name}"`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/read-only file system/i)
    },
  )

  it('control: a new top-level file is writable (the guard, not a mount, deals with it)', async () => {
    const result = await agentSh(`echo x > "${identity.home}/.codex/scratch.txt"`)
    expect(result.exitCode).toBe(0)
  })

  it('a pre-existing name-set file (hooks.json) is read-only', async () => {
    const result = await agentSh(`echo x > "${identity.home}/.codex/hooks.json"`)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toMatch(/read-only file system/i)
  })

  it('sessions/ stays writable', async () => {
    const result = await agentSh(`mkdir -p "${identity.home}/.codex/sessions" && echo x > "${identity.home}/.codex/sessions/x"`)
    expect(result.exitCode).toBe(0)
  })

  it('~/.codex/.env reads as 0 bytes while the host file is not empty (SH-4)', async () => {
    expect(fs.statSync(path.join(rig.codexDir, '.env')).size).toBeGreaterThan(0)
    const result = await d.run(execAsArgv(rig.container.name, identity, ['wc', '-c', `${identity.home}/.codex/.env`]))
    expect(result.stdout.trim().split(/\s+/)[0]).toBe('0')
  })

  it('~/.codex/app-server-daemon is empty while a socket exists on the host side', async () => {
    expect(fs.readdirSync(sockDir)).toContain('fake.sock')
    const result = await d.run(execAsArgv(rig.container.name, identity, ['ls', '-A', `${identity.home}/.codex/app-server-daemon`]))
    expect(result.stdout.trim()).toBe('')
  })

  // The image's Claude install leaves an empty ~/.claude and ~/.claude.json behind, so this checks the
  // mounts: no host Claude config reaches a Codex container except the homunculus subtree (TRD §11.2 #10).
  it('the Codex container mounts no host ~/.claude config except homunculus', async () => {
    const result = await d.run(['inspect', '--format', '{{range .Mounts}}{{println .Destination}}{{end}}', rig.container.name])
    const claudeMounts = result.stdout
      .split('\n')
      .filter((dest) => dest === `${identity.home}/.claude.json` || dest === `${identity.home}/.claude` || dest.startsWith(`${identity.home}/.claude/`))
    expect(claudeMounts.filter((dest) => dest !== `${identity.home}/.claude/homunculus`)).toEqual([])
  })
})
