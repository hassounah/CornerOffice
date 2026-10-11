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
  buildContext,
  removeTestImage,
  createCodexRig,
  execAsArgv,
  execAsRootArgv,
} from './helpers'
import type { TestIdentity, CodexRig } from './helpers'
import type { DockerRunner } from '../../main/services/docker-runner'
import { CODEX_VERSION } from '../../main/services/sandbox-image'

// ---------------------------------------------------------------------------
// codex.test.ts (#0037, TRD §10.4, §4.13) — the Codex sandbox, against a real
// container created through the real mount plan: the pinned install, the
// read-only overlays and shadows, and the hash check at build time.
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

  it('codex --version prints the pinned release', async () => {
    const result = await d.run(execAsArgv(rig.container.name, identity, ['codex', '--version']))
    expect(result.stdout).toContain(CODEX_VERSION)
  })

  it('/opt/codex is root-owned and the agent cannot write to it', async () => {
    const owner = await d.run(execAsRootArgv(rig.container.name, ['stat', '-c', '%u', '/opt/codex']))
    expect(owner.stdout.trim()).toBe('0')
    const write = await agentSh('touch /opt/codex/x')
    expect(write.exitCode).not.toBe(0)
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

  it('the Codex container has no ~/.claude', async () => {
    const result = await agentSh(`test -e "${identity.home}/.claude"`)
    expect(result.exitCode).not.toBe(0)
  })

  it('a sha512 mismatch fails the image build', async () => {
    const tag = `claude-sandbox:test-badsha-${process.pid}`
    const wrong = '0'.repeat(128)
    const build = d.run(
      [
        'build',
        '--tag', tag,
        '--build-arg', `AGENT_UID=${identity.uid}`,
        '--build-arg', `AGENT_GID=${identity.gid}`,
        '--build-arg', `AGENT_HOME=${identity.home}`,
        '--build-arg', 'WITH_NODE=0',
        '--build-arg', 'WITH_GO=0',
        '--build-arg', 'WITH_BUILD=0',
        '--build-arg', `CODEX_VERSION=${CODEX_VERSION}`,
        '--build-arg', `CODEX_SHA512_X64=${wrong}`,
        '--build-arg', `CODEX_SHA512_ARM64=${wrong}`,
        buildContext(),
      ],
      { timeoutMs: 4 * 60_000 },
    )
    await expect(build).rejects.toThrow()
    // Nothing was tagged by the failed build.
    const images = await d.run(['images', '-q', tag])
    expect(images.stdout.trim()).toBe('')
  }, 5 * 60_000)
})
