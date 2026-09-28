import type { CodeChangeStatus, CodeTreeEntry } from '@main/types/code'

// ---------------------------------------------------------------------------
// tree-row-presentation.ts — pure icon/tooltip/inert/color-mapping helpers
// for TreeRow.tsx (TRD §3.6.2 visual semantics table). Split out of
// TreeRow.tsx itself (a component file) so these plain values/functions
// don't defeat Fast Refresh there (react-refresh/only-export-components).
// ---------------------------------------------------------------------------

export const ROW_HEIGHT = 22
export const ROW_INDENT_PX = 16

/**
 * Splits a name into its stem and extension (the extension keeps its dot,
 * e.g. "file.ts" -> { stem: "file", ext: ".ts" }). A leading dot doesn't
 * count as an extension boundary (a dotfile like ".env" has no stem/ext
 * split, same as a name with no dot at all, or a trailing dot).
 *
 * Used only for a name containing a flagged invisible/bidi character (Fix
 * #123): a placeholder token (⟨U+202E⟩) is much wider than the character it
 * replaces, so plain tail-truncation can push the real extension — exactly
 * what a reviewer needs to see to catch a Trojan-Source-style spoof — past
 * the ellipsis. Rendering the extension in its own never-truncated span
 * keeps it visible regardless of how wide the stem gets.
 */
export function splitStemExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
}

interface SpecialInfo {
  icon: string
  tooltip: string
  inert: boolean
}

// Ignored vs inert (UX Medium): "ignored" is purely a 50%-opacity dimming
// with no icon of its own, and always takes precedence over this table —
// TreeRow checks `entry.ignored` FIRST and never calls into this function's
// result when it's true, even for an entry that would otherwise qualify (a
// filtered-out node_modules directory stays fully interactive, just dimmed).
function specialInfo(entry: CodeTreeEntry): SpecialInfo | null {
  if (entry.type === 'submodule') {
    return { icon: '⧉', tooltip: 'Submodule — open it as its own workspace', inert: true }
  }
  if (entry.type === 'other') {
    return { icon: '◇', tooltip: 'Special file', inert: true }
  }
  if (entry.type === 'symlink') {
    switch (entry.symlink) {
      case 'external':
        return { icon: '⤳', tooltip: 'Link points outside the workspace', inert: true }
      case 'broken':
        return { icon: '⚠', tooltip: 'Broken link', inert: true }
      case 'git-internal':
        return { icon: '⛔', tooltip: 'Blocked: points inside .git', inert: true }
      case 'dir-internal':
        return { icon: '↪', tooltip: 'Linked folder — not expandable', inert: true }
      case 'file-internal':
        // Openable read-only — same glyph as a linked folder, not inert.
        return { icon: '↪', tooltip: 'Linked file (read-only)', inert: false }
      default:
        return null
    }
  }
  return null
}

export function entrySpecialInfo(entry: CodeTreeEntry): { icon: string; tooltip: string } | null {
  const info = specialInfo(entry)
  return info ? { icon: info.icon, tooltip: info.tooltip } : null
}

/** Not openable at all: submodule, special file (FIFO/socket/device), or a
 *  symlink that's external, broken, git-internal, or an internal directory
 *  link (not expandable). An internal FILE symlink is openable (read-only)
 *  and is never inert. `ignored` always wins over this (Fix #123): an
 *  ignored entry stays fully interactive (just dimmed), even one that would
 *  otherwise qualify as inert — matching specialInfo's own precedence rule,
 *  which every CALLER of isInert must also get for free. */
export function isInert(entry: CodeTreeEntry): boolean {
  return !entry.ignored && specialInfo(entry)?.inert === true
}

export const CHANGE_MARKER: Record<CodeChangeStatus, { letter: string; className: string }> = {
  modified: { letter: 'M', className: 'text-co-status-waiting' },
  added: { letter: 'A', className: 'text-co-status-active' },
  deleted: { letter: 'D', className: 'text-co-status-attention line-through' },
  renamed: { letter: 'R', className: 'text-blue-400' },
  untracked: { letter: 'U', className: 'text-co-accent-teal' },
}

export function domIdForRowKey(key: string): string {
  return `co-tree-row-${encodeURIComponent(key)}`
}
