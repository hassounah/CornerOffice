// ---------------------------------------------------------------------------
// Re-exported for existing import paths (TopBar, AppearanceSettings, RealmShell,
// the doc-viewer components, App.tsx). The generalized unsaved-changes guard
// now lives in stores/dirty-registry.ts (TRD §3.7.1, Q2): any feature with
// in-progress edits registers a DirtySource there instead of this hook
// hard-coding the doc viewer.
// ---------------------------------------------------------------------------

export { useGuardDialogStore, useUnsavedGuard, guardAction, anyDirty } from '../stores/dirty-registry'
