// Code Explorer main-process payload types (TRD §3.3.3, §3.3.4, §3.3.6, §3.4.2)

// ── §3.3.3: code-fs.ts — safe open, listing, classification ──────────────────

export interface CodeTreeEntry {
  name: string
  relPath: string
  type: 'dir' | 'file' | 'symlink' | 'submodule' | 'other'
  symlink?: 'file-internal' | 'dir-internal' | 'external' | 'broken' | 'git-internal'
  ignored: boolean
  secret: boolean // requested name OR realpath basename matches (M6)
}

export interface CodeListDirResponse {
  relDir: string
  entries: CodeTreeEntry[]
  omitted: number
  ignoredParent: boolean
}

export type CodeFileResponse =
  | {
      kind: 'text'
      relPath: string
      name: string
      size: number
      lastModified: string
      content: string
      encoding: 'utf-8' | 'utf-8-lossy' | 'utf-16le' | 'utf-16be'
      bom: boolean
      eol: 'lf' | 'crlf' | 'none' | 'mixed'
      highlight: boolean
      editable: boolean
      readOnlyReason: null | 'too-large' | 'encoding' | 'mixed-eol' | 'symlink'
      previewable: null | 'markdown' | 'yaml' | 'svg'
    }
  | {
      kind: 'image'
      relPath: string
      name: string
      size: number
      lastModified: string
      mime: string
      dataBase64: string
    }
  | { kind: 'binary'; relPath: string; name: string; size: number; lastModified: string; mime: string | null }
  | { kind: 'too-large'; relPath: string; name: string; size: number; lastModified: string }
  | { kind: 'secret'; relPath: string; name: string; size: number; lastModified: string }

// getFileIndex(root, { includeIgnored }) — FR-13
export interface CodeFileIndexResponse {
  paths: string[]
  truncated: boolean
}

// ── §3.3.4: git-service.ts — repository operations ────────────────────────────

export type RepoState =
  | 'git'
  | 'not-git'
  | 'git-unavailable'
  | 'git-too-old'
  | 'git-untrusted'
  | 'git-unsafe'
  | 'root-mismatch'

export interface RepoInfo {
  state: RepoState
  stateDetail: string | null // e.g. 'git found inside a workspace'; fixed strings only
  gitVersionInfo: 'ok' | 'pre-2.39.1' // informational only (M5)
  gitVersion: string | null // the raw installed version, e.g. "2.34.1" — null when unavailable/too-old; feeds GitStateBanner's pre-2.39.1 notice
  liveGitUpdates: boolean // false when gitDir validation failed or watch caps hit
  hasCommits: boolean
  branch: string | null
  detached: boolean
  headShort: string | null
  isWorktree: boolean
  isShallow: boolean
  base:
    | { available: true; name: string; onBase: boolean }
    | { available: false; name: null; reason: 'no-commits' | 'no-base-branch' | 'no-merge-base' | 'not-git' }
}

export type CodeChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'

export interface CodeChange {
  relPath: string
  status: CodeChangeStatus
  oldPath?: string
  added: number | null
  removed: number | null
  conflicted?: boolean
}

export interface CodeStatusResponse {
  baseline: 'head' | 'branch'
  repo: RepoInfo
  changes: CodeChange[]
  // Non-git states (`not-git`, `git-unavailable`, etc.) report a zeroed object, never omitted (§D-12).
  totals: { files: number; added: number; removed: number; approximate: boolean }
  truncated: boolean
}

// §3.3.5: code:writeFile policy response
export interface CodeWriteResponse {
  relPath: string
  size: number
  lastModified: string
}

// §3.4.2: code:readBaseline response (6 variants)
export type CodeBaselineResponse =
  | {
      kind: 'text'
      content: string
      eol: 'lf' | 'crlf' | 'none' | 'mixed'
      bom: boolean
      encoding: 'utf-8' | 'utf-8-lossy' | 'utf-16le' | 'utf-16be'
    }
  | { kind: 'absent' }
  | { kind: 'binary'; size: number }
  | { kind: 'too-large'; size: number }
  | { kind: 'secret' }
  | { kind: 'unavailable' }

// §3.4.2: code:watch response
export interface CodeWatchResponse {
  watching: number
  limited: boolean
}

// ── §3.3.6: code-watcher.ts — scoped live updates (FR-27, FR-28) ──────────────

export interface CodeChangedPayload {
  workspaceSlug: string
  gen: number // renderer drops pushes whose gen ≠ current (H-B1)
  kind: 'file' | 'dir' | 'git'
  relPaths: string[] // repo-relative; [] for 'git'
  lastModified?: string // kind 'file' only: lstat mtime at emit time (own-write suppression without refetch)
}
