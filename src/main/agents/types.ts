// ---------------------------------------------------------------------------
// agents/types.ts — pure shared agent types (TRD §4.2). No Node imports, so the
// renderer can import descriptors (and these types) alongside main code.
// ---------------------------------------------------------------------------

export type SessionLocation = 'host' | 'sandbox'
export type AppPermissionMode = 'default' | 'auto' | 'skip'
export interface AgentCapabilities {
  channels: boolean
  plugin: boolean
}
export interface PermissionChoice {
  mode: AppPermissionMode
  label: string
  note: string
}
/** `command` is shown with a copy button. */
export interface ReadinessCopy {
  message: string
  command: string | null
}

export interface AgentDescriptor<Id extends string = string> {
  id: Id
  displayName: string
  binaryName: string
  capabilities: AgentCapabilities
  /** First = default. Empty sandbox list ⇔ handler has no `sandbox` (contract test). */
  permissionModes: Readonly<Record<SessionLocation, readonly PermissionChoice[]>>
  /** Hidden first segments under $HOME this agent's sandbox mounts may use (feeds assertMountSafe; snapshot-pinned). */
  homeEntries: readonly string[]
  copy: {
    /** Host exit 127. */
    notFound: string
    /** Keyed by handler readiness code. */
    readiness: Readonly<Record<string, ReadinessCopy>>
    /** Template: "{file} {problem}. Fix or remove it, then Start again." */
    configInvalid: string
    hostFirstRunNote: string | null
    sandboxFirstRunNote: string | null
    /** Shown when plugin.detect → unavailable. */
    noActivity: string | null
  }
  plugin: { minimumVersion: string | null; installCommands: readonly string[]; nextStep: string } | null
}
