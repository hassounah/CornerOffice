// ---------------------------------------------------------------------------
// platform.ts — renderer-side OS detection for keyboard-shortcut copy (TRD
// §2.4 Q7, §3.6.3, §3.8.3). navigator.platform is deprecated but remains the
// simplest reliable check without a preload round-trip; userAgent is the
// fallback for an environment where platform is empty (e.g. jsdom).
// ---------------------------------------------------------------------------

function platformString(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.platform || navigator.userAgent || ''
}

export function isMac(): boolean {
  return /mac/i.test(platformString())
}

export function isLinux(): boolean {
  return /linux/i.test(platformString())
}
