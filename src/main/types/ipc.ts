// Standard IPC error envelope — all IPC handlers return this type
export type IpcResponse<T> =
  | { data: T; error: null }
  | { data: null; error: { code: string; message: string } };

// Well-known IPC error codes
export const IPC_ERROR_CODES = {
  NOT_READY: 'NOT_READY',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  LOCK_TIMEOUT: 'LOCK_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  STALE_WRITE: 'STALE_WRITE',
} as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[keyof typeof IPC_ERROR_CODES];
