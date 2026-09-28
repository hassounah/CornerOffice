import { Prec, type Extension } from '@codemirror/state'
import { keymap, type KeyBinding } from '@codemirror/view'
import { gotoLine, findNext, findPrevious, openSearchPanel } from '@codemirror/search'

// ---------------------------------------------------------------------------
// cm/keymap.ts — SourceView's keymap, at Prec.highest (TRD §3.6.5)
//
// Prec.highest wins over the default keymaps the `search` and `history`
// extensions install themselves, which is specifically needed for Mod-g:
// @codemirror/search's own default keymap binds it to findNext — this
// overrides that with gotoLine, the more useful binding for a code viewer.
// ---------------------------------------------------------------------------

// Shared by sourceKeymap and diffKeymap so the two can't silently drift on
// Mod-g/F3/Shift-F3/Mod-f behavior (Fix #135 item 2 — the diffKeymap comment
// already claimed this sharing; the code just didn't do it).
const navigationBindings: KeyBinding[] = [
  { key: 'Mod-g', run: gotoLine },
  { key: 'F3', run: findNext },
  { key: 'Shift-F3', run: findPrevious },
  { key: 'Mod-f', run: openSearchPanel },
]

export interface SourceKeymapCallbacks {
  /** Mod-s — save while editing. A no-op call in view mode is fine; the
   *  caller (SourceView.tsx / the store) decides whether a save applies. */
  onSave: () => void
  /** Mod-p — open quick-open. */
  onQuickOpen: () => void
}

export function sourceKeymap(callbacks: SourceKeymapCallbacks): Extension {
  const bindings: KeyBinding[] = [
    ...navigationBindings,
    {
      key: 'Mod-s',
      run: () => {
        callbacks.onSave()
        return true
      },
    },
    {
      key: 'Mod-p',
      run: () => {
        callbacks.onQuickOpen()
        return true
      },
    },
  ]
  return Prec.highest(keymap.of(bindings))
}

export interface DiffKeymapCallbacks {
  /** Mod-p — open quick-open. There is no `onSave` binding here: DiffView
   *  (2.18) is always read-only, so Mod-s has nothing to do. */
  onQuickOpen: () => void
}

/** Same navigation/search bindings as sourceKeymap (navigationBindings,
 *  above), minus the save binding. */
export function diffKeymap(callbacks: DiffKeymapCallbacks): Extension {
  const bindings: KeyBinding[] = [
    ...navigationBindings,
    {
      key: 'Mod-p',
      run: () => {
        callbacks.onQuickOpen()
        return true
      },
    },
  ]
  return Prec.highest(keymap.of(bindings))
}
