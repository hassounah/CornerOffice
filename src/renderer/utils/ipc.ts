/** Local IpcResponse type — mirrors src/main/types/ipc.ts for renderer use. */
export type IpcResponse<T> =
  | { data: T; error: null }
  | { data: null; error: { code: string; message: string } }

/**
 * An IPC failure. `message` is the main process's message, unchanged, so code that
 * only reads `.message` keeps working; `code` lets callers branch on the failure kind.
 */
export class IpcError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
  }
}

/**
 * Unwrap an IpcResponse, throwing an IpcError if it contains an error.
 * Use in store actions to surface IPC errors as thrown exceptions.
 */
export function unwrapIpc<T>(response: IpcResponse<T>): T {
  if (response.error) throw new IpcError(response.error.code, response.error.message)
  return response.data
}
