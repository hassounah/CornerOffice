import log from 'electron-log/main'
import { ZodSchema, ZodError } from 'zod'
import type { IpcResponse } from '../types/ipc'
import { IPC_ERROR_CODES } from '../types/ipc'

type AsyncHandler<TInput, TOutput> = (input: TInput) => Promise<TOutput>

/**
 * Wraps an IPC handler with:
 *  1. Optional zod input validation (returns VALIDATION_ERROR on failure)
 *  2. try/catch — returns IpcResponse error envelope on throw
 *  3. On success — returns { data: T, error: null }
 */
export function wrapHandler<TInput, TOutput>(
  handler: AsyncHandler<TInput, TOutput>,
  schema?: ZodSchema<TInput>
): (_event: Electron.IpcMainInvokeEvent, rawInput: unknown) => Promise<IpcResponse<TOutput>> {
  return async (_event, rawInput) => {
    // Validate input if schema provided
    let input: TInput
    if (schema) {
      const result = schema.safeParse(rawInput)
      if (!result.success) {
        const message = formatZodError(result.error)
        log.warn('[IPC] Validation error:', message)
        return {
          data: null,
          error: { code: IPC_ERROR_CODES.VALIDATION_ERROR, message },
        }
      }
      input = result.data
    } else {
      input = rawInput as TInput
    }

    try {
      const data = await handler(input)
      return { data, error: null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string })?.code ?? IPC_ERROR_CODES.INTERNAL_ERROR
      log.error('[IPC] Handler error:', message)
      return {
        data: null,
        error: { code, message },
      }
    }
  }
}

function formatZodError(err: ZodError): string {
  return err.issues.map((e) => `${e.path.map(String).join('.')}: ${e.message}`).join('; ')
}

/** Convenience: produce a NOT_READY stub handler that returns an error envelope. */
export function notReadyStub<T>(): () => Promise<IpcResponse<T>> {
  return async () => ({
    data: null,
    error: { code: IPC_ERROR_CODES.NOT_READY, message: 'Initializing…' },
  })
}
