import { useEffect, useState } from 'react'

// ---------------------------------------------------------------------------
// useIsThemeLight — Fix #148. `useTheme.ts` is the single source of truth
// for the app's appearance setting (dark/light/system) and reduces all of it
// down to one class toggle: `.theme-light` on `document.documentElement`.
// Everything driven by CSS custom properties (`--co-code-*`, `--co-realm-*`)
// reacts to that class automatically, with no JS involved at all. Some
// things aren't CSS, though — CodeMirror's own internal light/dark
// classification (`EditorView.theme(spec, { dark })`, cm/themes.ts) is a
// structural option baked into an Extension, not a CSS value, so it needs an
// actual JS boolean to react to. This hook is that boolean: it reads the
// SAME class useTheme.ts toggles (via a MutationObserver, not a second
// settings-store subscription plus a second system-preference media query),
// so there is only ever one source of truth for "is the app in light mode
// right now" — this can never drift from what the CSS is already doing.
// ---------------------------------------------------------------------------

function readIsThemeLight(): boolean {
  return document.documentElement.classList.contains('theme-light')
}

export function useIsThemeLight(): boolean {
  const [isThemeLight, setIsThemeLight] = useState(readIsThemeLight)

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsThemeLight(readIsThemeLight())
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return isThemeLight
}
