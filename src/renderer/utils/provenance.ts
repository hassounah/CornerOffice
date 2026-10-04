// ---------------------------------------------------------------------------
// provenance.ts — reading `source` on notifications and activity items
// (TRD §3.17, SEC-H3). Main decides provenance; the renderer never re-derives
// it, it only reads the field. An absent `source` means host (the field is
// optional and host items omit it), but any value that is not exactly
// 'host' fails CLOSED: it is shown as sandbox, so an unexpected value can
// never pass sandbox-originated content off as the user's own.
// ---------------------------------------------------------------------------

export function isSandboxSource(source: unknown): boolean {
  return source !== undefined && source !== 'host'
}
