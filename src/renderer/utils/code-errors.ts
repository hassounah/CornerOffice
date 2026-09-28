// ---------------------------------------------------------------------------
// code-errors.ts — copy for the code explorer's error codes (TRD §3.9.3)
//
// wrapCodeHandler guarantees only these five codes ever reach the renderer:
// PERMISSION_DENIED, NOT_FOUND, STALE_WRITE, TIMEOUT and VALIDATION_ERROR.
// Anything else (including a raw errno or a caught exception) is already
// mapped to INTERNAL_ERROR server-side, so the default case below also
// covers an unrecognized code defensively.
// ---------------------------------------------------------------------------

export function friendlyCodeError(error: unknown): string {
  const e = error as { code?: string; message?: string }
  switch (e?.code) {
    case 'PERMISSION_DENIED':
      return "This file can't be accessed"
    case 'NOT_FOUND':
      return 'File not found'
    case 'VALIDATION_ERROR':
      return e.message ?? 'Invalid request'
    case 'TIMEOUT':
      return 'Git took too long — try ⟳'
    case 'STALE_WRITE':
      return 'File changed on disk — click Reload to see the latest version'
    default:
      return 'Something went wrong'
  }
}
