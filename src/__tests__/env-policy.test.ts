import { describe, it, expect } from 'vitest'
import { ENV_DENYLIST, sanitizedEnv } from '../main/services/env-policy'

describe('sanitizedEnv', () => {
  it('removes every denylisted key', () => {
    const base: NodeJS.ProcessEnv = {
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ASAR: '1',
      NODE_OPTIONS: '--inspect',
      LD_PRELOAD: '/evil.so',
      CLAUDECODE: '1',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_ACCESS_KEY_ID: 'key-id',
      AWS_SESSION_TOKEN: 'session-tok',
      GH_TOKEN: 'gh-tok',
      GITHUB_TOKEN: 'github-tok',
      NPM_TOKEN: 'npm-tok',
      OPENAI_API_KEY: 'oai-key',
      DATABASE_URL: 'postgres://...',
    }
    const env = sanitizedEnv(base)
    for (const key of ENV_DENYLIST) {
      expect(env[key]).toBeUndefined()
    }
  })

  it('keeps everything else', () => {
    const env = sanitizedEnv({ PATH: '/usr/bin', HOME: '/home/user', SHELL: '/bin/bash' })
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/user', SHELL: '/bin/bash' })
  })

  it('drops keys with an undefined value without throwing', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', GARBAGE: undefined }
    const env = sanitizedEnv(base)
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('returns a fresh object each call (mutating the result does not affect the denylist)', () => {
    const env = sanitizedEnv({ PATH: '/usr/bin' })
    env.TERM = 'xterm-256color'
    expect(sanitizedEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' })
  })
})
