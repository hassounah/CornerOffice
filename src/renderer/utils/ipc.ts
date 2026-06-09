/** Local IpcResponse type — mirrors src/main/types/ipc.ts for renderer use. */
export type IpcResponse<T> =
  | { data: T; error: null }
  | { data: null; error: { code: string; message: string } }

/**
 * Unwrap an IpcResponse, throwing if it contains an error.
 * Use in store actions to surface IPC errors as thrown exceptions.
 */
export function unwrapIpc<T>(response: IpcResponse<T>): T {
  if (response.error) throw new Error(response.error.message)
  return response.data
}
