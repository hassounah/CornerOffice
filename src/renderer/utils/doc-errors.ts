export function friendlyDocError(error: unknown): string {
  const e = error as { code?: string; message?: string }
  switch (e?.code) {
    case 'PERMISSION_DENIED': return "This file can't be accessed"
    case 'NOT_FOUND': return 'File or directory not found'
    case 'VALIDATION_ERROR': return e.message ?? 'Invalid request'
    case 'TIMEOUT': return 'Request timed out — try again'
    default: return 'Something went wrong'
  }
}
