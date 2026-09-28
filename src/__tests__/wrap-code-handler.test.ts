import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))
vi.mock('electron-log/main', () => ({ default: mockLog }))

import { wrapCodeHandler } from '../main/ipc/wrap-code-handler'
import type { WrapCodeHandlerDeps } from '../main/ipc/wrap-code-handler'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_URL = 'file:///app/out/renderer/index.html'
const mainFrame = { processId: 1, routingId: 1, url: APP_URL }

const okDeps: WrapCodeHandlerDeps = {
  getMainWindow: () => ({ webContents: { mainFrame } }) as unknown as Electron.BrowserWindow,
  isAppOrigin: (url: string) => url === APP_URL,
}

function makeEvent(senderFrame: unknown = mainFrame): Electron.IpcMainInvokeEvent {
  return { senderFrame } as unknown as Electron.IpcMainInvokeEvent
}

const schema = z.object({ name: z.string() })

// ---------------------------------------------------------------------------
// Sender / origin check (L3)
// ---------------------------------------------------------------------------

describe('wrapCodeHandler — sender/origin check', () => {
  it('gives PERMISSION_DENIED for a null senderFrame', async () => {
    const handler = wrapCodeHandler(async () => 'ok', schema, okDeps)
    const result = await handler(makeEvent(null), { name: 'a' })
    expect(result).toEqual({ data: null, error: { code: 'PERMISSION_DENIED', message: 'Access denied' } })
  })

  it('gives PERMISSION_DENIED for a foreign frame (different processId)', async () => {
    const handler = wrapCodeHandler(async () => 'ok', schema, okDeps)
    const foreignFrame = { processId: 99, routingId: 1, url: APP_URL }
    const result = await handler(makeEvent(foreignFrame), { name: 'a' })
    expect(result.error).toEqual({ code: 'PERMISSION_DENIED', message: 'Access denied' })
  })

  it('gives PERMISSION_DENIED when getMainWindow() returns null', async () => {
    const deps: WrapCodeHandlerDeps = { getMainWindow: () => null, isAppOrigin: () => true }
    const handler = wrapCodeHandler(async () => 'ok', schema, deps)
    const result = await handler(makeEvent(mainFrame), { name: 'a' })
    expect(result.error).toEqual({ code: 'PERMISSION_DENIED', message: 'Access denied' })
  })

  it('gives PERMISSION_DENIED when isAppOrigin rejects the sender URL', async () => {
    const deps: WrapCodeHandlerDeps = {
      getMainWindow: okDeps.getMainWindow,
      isAppOrigin: () => false,
    }
    const handler = wrapCodeHandler(async () => 'ok', schema, deps)
    const result = await handler(makeEvent(mainFrame), { name: 'a' })
    expect(result.error).toEqual({ code: 'PERMISSION_DENIED', message: 'Access denied' })
  })

  it('runs the handler when the sender is the main frame at the app origin', async () => {
    const handler = wrapCodeHandler(async (input: { name: string }) => `hi ${input.name}`, schema, okDeps)
    const result = await handler(makeEvent(mainFrame), { name: 'Alice' })
    expect(result).toEqual({ data: 'hi Alice', error: null })
  })
})

// ---------------------------------------------------------------------------
// zod validation
// ---------------------------------------------------------------------------

describe('wrapCodeHandler — zod validation', () => {
  it('gives VALIDATION_ERROR with the fixed "Invalid request" message', async () => {
    const handler = wrapCodeHandler(async () => 'ok', schema, okDeps)
    const result = await handler(makeEvent(mainFrame), { name: 123 })
    expect(result).toEqual({ data: null, error: { code: 'VALIDATION_ERROR', message: 'Invalid request' } })
  })

  it('the log spy never contains the raw input on a validation failure (Sec L-7)', async () => {
    mockLog.warn.mockClear()
    const handler = wrapCodeHandler(async () => 'ok', schema, okDeps)
    await handler(makeEvent(mainFrame), { name: 123, content: 'TOP SECRET CONTENT', extra: '/Users/amer/secret.env' })
    const logged = JSON.stringify(mockLog.warn.mock.calls)
    expect(logged).not.toContain('TOP SECRET CONTENT')
    expect(logged).not.toContain('/Users/amer/secret.env')
    expect(logged).not.toContain('rawInput')
  })
})

// ---------------------------------------------------------------------------
// Error allowlist
// ---------------------------------------------------------------------------

describe('wrapCodeHandler — error allowlist', () => {
  const FIXED_MESSAGE: Record<string, string> = {
    PERMISSION_DENIED: 'Access denied',
    NOT_FOUND: 'Path not found',
    STALE_WRITE: 'File changed on disk',
    TIMEOUT: 'Request timed out',
  }

  it.each(Object.keys(FIXED_MESSAGE))(
    'passes through an allowlisted code (%s) with FIXED copy, never the thrown message',
    async (code) => {
      const hostileMessage = `ENOENT: no such file, open '/Users/amer/secret.env' (${code})`
      const handler = wrapCodeHandler(
        async () => {
          throw Object.assign(new Error(hostileMessage), { code })
        },
        schema,
        okDeps
      )
      const result = await handler(makeEvent(mainFrame), { name: 'a' })
      expect(result).toEqual({ data: null, error: { code, message: FIXED_MESSAGE[code] } })
      expect(JSON.stringify(result)).not.toContain('/Users/amer/secret.env')
      expect(JSON.stringify(result)).not.toContain('ENOENT')
    }
  )

  it('gives INTERNAL_ERROR for an injected EACCES whose message contains a path', async () => {
    const handler = wrapCodeHandler(
      async () => {
        throw Object.assign(new Error("EACCES: permission denied, open '/Users/amer/secret.env'"), {
          code: 'EACCES',
          errno: -13,
          path: '/Users/amer/secret.env',
        })
      },
      schema,
      okDeps
    )
    const result = await handler(makeEvent(mainFrame), { name: 'a' })
    expect(result).toEqual({ data: null, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
    expect(JSON.stringify(result)).not.toContain('/Users/amer/secret.env')
    expect(JSON.stringify(result)).not.toContain('EACCES')
    expect(JSON.stringify(result)).not.toContain('-13')
  })

  it('gives INTERNAL_ERROR for an injected TypeError', async () => {
    const handler = wrapCodeHandler(
      async () => {
        throw new TypeError('Cannot read properties of undefined')
      },
      schema,
      okDeps
    )
    const result = await handler(makeEvent(mainFrame), { name: 'a' })
    expect(result).toEqual({ data: null, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
  })

  it('gives INTERNAL_ERROR for an unrecognized error code', async () => {
    const handler = wrapCodeHandler(
      async () => {
        throw Object.assign(new Error('boom'), { code: 'SOME_OTHER_CODE' })
      },
      schema,
      okDeps
    )
    const result = await handler(makeEvent(mainFrame), { name: 'a' })
    expect(result.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' })
  })

  it('gives INTERNAL_ERROR for code "toString" — Object.hasOwn, not `in` (every object inherits toString)', async () => {
    const handler = wrapCodeHandler(
      async () => {
        throw Object.assign(new Error('boom'), { code: 'toString' })
      },
      schema,
      okDeps
    )
    const result = await handler(makeEvent(mainFrame), { name: 'a' })
    expect(result.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' })
  })

  it('the log spy never contains a path or errno on a caught error (Sec L-7)', async () => {
    mockLog.error.mockClear()
    const handler = wrapCodeHandler(
      async () => {
        throw Object.assign(new Error("EACCES: permission denied, open '/Users/amer/secret.env'"), {
          code: 'EACCES',
          errno: -13,
        })
      },
      schema,
      okDeps
    )
    await handler(makeEvent(mainFrame), { name: 'a' })
    const logged = JSON.stringify(mockLog.error.mock.calls)
    expect(logged).not.toContain('/Users/amer/secret.env')
    expect(logged).not.toContain('-13')
  })

  it('gives INTERNAL_ERROR for a non-Error thrown value (e.g. a rejected string)', async () => {
    const handler = wrapCodeHandler(
      async () => {
        throw '/Users/amer/secret.env not found'
      },
      schema,
      okDeps
    )
    const result = await handler(makeEvent(mainFrame), { name: 'a' })
    expect(result).toEqual({ data: null, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } })
  })

  it('the log spy never contains the content field on a caught error (Sec L-7)', async () => {
    mockLog.error.mockClear()
    const handler = wrapCodeHandler(
      async () => {
        throw Object.assign(new Error('write failed'), { code: 'EIO', content: 'TOP SECRET CONTENT' })
      },
      schema,
      okDeps
    )
    await handler(makeEvent(mainFrame), { name: 'a' })
    const logged = JSON.stringify(mockLog.error.mock.calls)
    expect(logged).not.toContain('TOP SECRET CONTENT')
  })
})
