import type { DocFileResponse } from '../../main/types/docs'

// Extensions that the document viewer renders as text and can be edited.
// Must stay in sync with the ALLOWED_EXTENSIONS set in the write handler.
export const EDITABLE_EXTENSIONS = new Set(['md', 'yaml', 'yml', 'txt'])

export function isEditable(file: DocFileResponse | null): boolean {
  return !!file && EDITABLE_EXTENSIONS.has(file.extension)
}
