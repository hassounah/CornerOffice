/**
 * Extracts a human-readable display string from a tool's raw JSON input preview.
 * Returns the raw inputPreview unchanged for unknown tools or on parse failure.
 */
export function formatToolPreview(toolName: string, inputPreview: string): string {
  let parsed: Record<string, unknown>
  try {
    const raw: unknown = JSON.parse(inputPreview)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return inputPreview
    parsed = raw as Record<string, unknown>
  } catch {
    return inputPreview
  }

  const name = toolName.toLowerCase()

  if (name === 'read' || name === 'write' || name === 'edit') {
    const filePath = parsed.file_path
    if (typeof filePath === 'string' && filePath.length > 0) return filePath
    return inputPreview
  }

  if (name === 'bash') {
    const command = parsed.command
    if (typeof command === 'string' && command.length > 0) return command
    return inputPreview
  }

  if (name === 'grep' || name === 'glob') {
    const pattern = parsed.pattern
    if (typeof pattern !== 'string' || pattern.length === 0) return inputPreview
    const path = parsed.path
    if (typeof path === 'string' && path.length > 0) return `"${pattern}" in ${path}`
    return `"${pattern}"`
  }

  return inputPreview
}
