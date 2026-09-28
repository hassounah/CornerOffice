import { expect } from 'vitest'

// ---------------------------------------------------------------------------
// a11y.ts — shared nested-interactive check (TRD §5.2 step 2.11, UX L1: "Shared
// helpers/a11y.ts assertNoNestedInteractive"). Used by 2.11 (FileTree/TreeRow),
// 2.22 (FeatureCard/PipelineTrack) and, later, 3.3/3.4 (Realm PipelineTrack/
// FeatureRow) — centralized so the exact DOM query isn't duplicated (and
// potentially drifts) across every test file that needs it.
// ---------------------------------------------------------------------------

/**
 * Fails the current test if `container` has any interactive element nested
 * inside a `role="button"` (or a native `<button>`) ancestor — the exact
 * defect FR-3 / H-U1 exist to prevent: a screen reader or keyboard user
 * reaching a control they can't operate because it sits inside another
 * element's whole-row click/Enter/Space handler. The selector is the one
 * TRD §5.2 step 2.11 specifies verbatim.
 */
export function assertNoNestedInteractive(container: HTMLElement): void {
  const nested = container.querySelectorAll(
    '[role="button"] button, [role="button"] [role="button"], button button',
  )
  expect(nested).toHaveLength(0)
}
