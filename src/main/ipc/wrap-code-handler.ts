import log from 'electron-log/main'
import { ZodSchema } from 'zod'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import type { IpcResponse } from '../types/ipc'
import { IPC_ERROR_CODES } from '../types/ipc'
import { isMainFrameSender } from './app-origin'
import type { IsAppOrigin } from './app-origin'

// ---------------------------------------------------------------------------
// wrap-code-handler.ts — the code:* IPC wrapper (TRD §3.4.1, M2, L3)
//
// Every code:* channel is registered through wrapCodeHandler, never the plain
// wrapHandler: it adds the sender/origin check (L3) and a strict error-code
// allowlist with fixed copy (Sec L-7) — the opposite of wrapHandler, which
// passes through whatever code and message the handler throws.
// ---------------------------------------------------------------------------

type AsyncHandler<TInput, TOutput> = (input: TInput) => Promise<TOutput>

export interface WrapCodeHandlerDeps {
  getMainWindow: () => BrowserWindow | null
  isAppOrigin: IsAppOrigin
}

// Only these codes ever reach the renderer, each with FIXED copy (TRD §3.4.1)
// — never the thrown error's own message. A future handler could throw one of
// these codes with a message that embeds a path or git stderr; the lookup
// below is what keeps that from ever reaching the renderer, not an assumption
// that every producer already uses a safe string. Anything else — an
// unrecognized code, a raw errno, a TypeError, an aborted call — becomes
// INTERNAL_ERROR; the real error is logged, redacted, never returned.
const FIXED_MESSAGE: Readonly<Record<string, string>> = {
  [IPC_ERROR_CODES.PERMISSION_DENIED]: 'Access denied',
  [IPC_ERROR_CODES.NOT_FOUND]: 'Path not found',
  [IPC_ERROR_CODES.STALE_WRITE]: 'File changed on disk',
  [IPC_ERROR_CODES.TIMEOUT]: 'Request timed out',
}

// Matches a POSIX or Windows absolute path (or a drive-relative Windows path)
// so a raw errno message never reaches the log with the real path intact.
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:)?[/\\][^\s'"]+/g

function redactPaths(message: string): string {
  return message.replace(ABSOLUTE_PATH_PATTERN, '[REDACTED_PATH]')
}

/**
 * Reduce an unknown thrown value to the minimum the log needs to be useful:
 * a name and a path-redacted message. Never spreads the raw error object, so
 * extra properties a Node error carries (`path`, `syscall`, `errno`) can
 * never leak into the log even if this function's own redaction misses one.
 */
function describeErrorForLog(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: redactPaths(err.message) }
  }
  return { name: 'UnknownError', message: redactPaths(String(err)) }
}

/**
 * wrapCodeHandler(handler, schema, deps):
 *  1. Sender check (L3): the main frame of the app's own window, at the app
 *     origin. Otherwise PERMISSION_DENIED.
 *  2. zod validation. A failure returns VALIDATION_ERROR with the fixed
 *     message "Invalid request" — never the raw input, only the zod issues'
 *     paths and codes are logged.
 *  3. try/catch with the allowlist above.
 */
export function wrapCodeHandler<TInput, TOutput>(
  handler: AsyncHandler<TInput, TOutput>,
  schema: ZodSchema<TInput>,
  deps: WrapCodeHandlerDeps,
): (event: IpcMainInvokeEvent, rawInput: unknown) => Promise<IpcResponse<TOutput>> {
  return async (event, rawInput) => {
    const senderFrame = event.senderFrame
    if (!isMainFrameSender(event, deps.getMainWindow) || !senderFrame || !deps.isAppOrigin(senderFrame.url)) {
      return { data: null, error: { code: IPC_ERROR_CODES.PERMISSION_DENIED, message: 'Access denied' } }
    }

    const result = schema.safeParse(rawInput)
    if (!result.success) {
      log.warn(
        '[code-ipc] Validation error',
        result.error.issues.map((issue) => ({ path: issue.path, code: issue.code }))
      )
      return { data: null, error: { code: IPC_ERROR_CODES.VALIDATION_ERROR, message: 'Invalid request' } }
    }

    try {
      const data = await handler(result.data)
      return { data, error: null }
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      // Object.hasOwn, not `in`: `'toString' in FIXED_MESSAGE` is true (every
      // object inherits it from Object.prototype), which would let a handler
      // that threw { code: 'toString' } return the inherited function itself
      // as "message" instead of falling through to INTERNAL_ERROR below.
      if (code && Object.hasOwn(FIXED_MESSAGE, code)) {
        return { data: null, error: { code, message: FIXED_MESSAGE[code] } }
      }
      log.error('[code-ipc] Handler error', describeErrorForLog(err))
      return { data: null, error: { code: IPC_ERROR_CODES.INTERNAL_ERROR, message: 'Something went wrong' } }
    }
  }
}
