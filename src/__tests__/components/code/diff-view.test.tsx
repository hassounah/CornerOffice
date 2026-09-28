import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import { DiffView } from '../../../renderer/components/code/DiffView'
import type { CodeBaselineResponse, CodeFileResponse } from '../../../main/types/code'

// ---------------------------------------------------------------------------
// DiffView — the Changes view (TRD §3.6.8, FR-18, FR-19, FR-26). Real
// EditorView / MergeView instances are mounted (not mocks): jsdom's
// Range.getClientRects/getBoundingClientRect are stubbed globally in
// setup.ts (TRD §11 R12), and a probe confirmed a real MergeView mounts
// cleanly under that same stub. These tests query rendered DOM text/
// attributes, never layout.
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
})

function textSide(content: string, eol: 'lf' | 'crlf' | 'none' | 'mixed' = 'lf'): CodeBaselineResponse {
  return { kind: 'text', content, eol, bom: false, encoding: 'utf-8' }
}

function currentText(content: string, extra: Partial<CodeFileResponse & { kind: 'text' }> = {}): CodeFileResponse {
  return {
    kind: 'text',
    relPath: 'a.ts',
    name: 'a.ts',
    size: content.length,
    lastModified: new Date(0).toISOString(),
    content,
    encoding: 'utf-8',
    bom: false,
    eol: 'lf',
    highlight: true,
    editable: true,
    readOnlyReason: null,
    previewable: null,
    ...extra,
  }
}

function baseProps() {
  return {
    relPath: 'a.ts',
    highlight: false, // skip async language loading noise unless a test needs it
    skin: 'office' as const,
    layout: 'inline' as const,
    original: textSide('one\ntwo\nthree\n'),
    current: currentText('one\nTWO\nthree\n'),
    onQuickOpen: vi.fn(),
  }
}

describe('DiffView — inline layout', () => {
  it('mounts a real CodeMirror editor showing the current content', () => {
    const { container } = render(<DiffView {...baseProps()} />)
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.textContent).toContain('TWO')
  })

  it('shows the original (deleted) content in the diff too', () => {
    const { container } = render(<DiffView {...baseProps()} />)
    expect(container.textContent).toContain('two')
  })

  it('names the editor region with an aria-label of the open file', () => {
    const { container } = render(<DiffView {...baseProps()} relPath="src/x.ts" />)
    expect(container.querySelector('.cm-content')).toHaveAttribute('aria-label', 'src/x.ts — changes')
  })
})

describe('DiffView — split layout', () => {
  it('mounts two real CodeMirror editors, one per side', () => {
    const { container } = render(<DiffView {...baseProps()} layout="split" />)
    const editors = container.querySelectorAll('.cm-editor')
    expect(editors.length).toBe(2)
  })

  it('the left pane shows the original content, the right pane the current content', () => {
    const { container } = render(<DiffView {...baseProps()} layout="split" />)
    const editors = container.querySelectorAll('.cm-editor')
    expect(editors[0].textContent).toContain('two')
    expect(editors[0].textContent).not.toContain('TWO')
    expect(editors[1].textContent).toContain('TWO')
  })

  it('destroys the MergeView on unmount (no leaked DOM)', () => {
    const { container, unmount } = render(<DiffView {...baseProps()} layout="split" />)
    expect(container.querySelector('.cm-mergeView')).not.toBeNull()
    unmount()
    expect(container.querySelector('.cm-mergeView')).toBeNull()
  })

  // Fix #135 item 1: the two panes previously shared one aria-label
  // ("<relPath> — changes" on both), so a screen-reader user couldn't tell
  // which pane was old and which was new.
  it('gives each pane its own aria-label distinguishing before from after', () => {
    const { container } = render(<DiffView {...baseProps()} layout="split" relPath="src/x.ts" />)
    const editors = container.querySelectorAll('.cm-content')
    expect(editors).toHaveLength(2)
    const labels = Array.from(editors).map((el) => el.getAttribute('aria-label'))
    expect(labels).toEqual(['src/x.ts — before', 'src/x.ts — after'])
    // Distinct, and each still names the file.
    expect(new Set(labels).size).toBe(2)
  })
})

describe('DiffView — quick-open keymap', () => {
  it('a real Mod-P keydown through .cm-content calls onQuickOpen (inline)', () => {
    const onQuickOpen = vi.fn()
    const { container } = render(<DiffView {...baseProps()} onQuickOpen={onQuickOpen} />)
    const content = container.querySelector('.cm-content')
    fireEvent.keyDown(content!, { key: 'p', code: 'KeyP', ctrlKey: true })
    expect(onQuickOpen).toHaveBeenCalledTimes(1)
  })
})

describe('DiffView — added file (no baseline)', () => {
  it('an "absent" original renders as an empty-original diff, not a card', () => {
    const { container } = render(
      <DiffView {...baseProps()} original={{ kind: 'absent' }} current={currentText('brand new file\n')} />,
    )
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.textContent).toContain('brand new file')
  })
})

describe('DiffView — deleted file (no current content)', () => {
  it('a synthetic {kind:"deleted"} current renders as an all-removed diff, not a card', () => {
    const { container } = render(
      <DiffView {...baseProps()} original={textSide('gone now\n')} current={{ kind: 'deleted' }} />,
    )
    expect(container.querySelector('.cm-editor')).not.toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.textContent).toContain('gone now')
  })
})

describe('DiffView — cards', () => {
  it('shows the binary card when the original is binary, with both byte counts', () => {
    const { container } = render(
      <DiffView {...baseProps()} original={{ kind: 'binary', size: 1024 }} current={{ ...currentText(''), kind: 'binary', mime: 'application/octet-stream', size: 2048 } as CodeFileResponse} />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('Binary file changed (1,024 bytes → 2,048 bytes)')
  })

  it('shows the binary card with a computed UTF-8 byte count for a text side (baseline text has no `size` field)', () => {
    const { container } = render(
      <DiffView
        {...baseProps()}
        original={textSide('hello')} // 5 ASCII bytes — CodeBaselineResponse's text kind has no `size`
        current={{ ...currentText(''), kind: 'binary', mime: 'application/octet-stream', size: 2048 } as CodeFileResponse}
      />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('Binary file changed (5 bytes → 2,048 bytes)')
  })

  it('shows the binary card with "0 bytes" for a new binary file (no baseline at all)', () => {
    const { container } = render(
      <DiffView
        {...baseProps()}
        original={{ kind: 'absent' }}
        current={{ ...currentText(''), kind: 'binary', mime: 'application/octet-stream', size: 512 } as CodeFileResponse}
      />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('Binary file changed (0 bytes → 512 bytes)')
  })

  it('shows the too-large card when either side is too-large', () => {
    const { container } = render(
      <DiffView {...baseProps()} original={{ kind: 'too-large', size: 5_000_000 }} />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('Too large to compare.')
  })

  it('shows the unavailable card when the baseline blob could not be fetched locally', () => {
    const { container } = render(<DiffView {...baseProps()} original={{ kind: 'unavailable' }} />)
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('Base version not available locally (partial clone).')
  })

  it('shows the secret card naming the ORIGINAL side when only the original is an unrevealed secret, with a Reveal action wired to onReveal', () => {
    const onReveal = vi.fn()
    const { container, getByText } = render(
      <DiffView {...baseProps()} original={{ kind: 'secret' }} onReveal={onReveal} />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('The previous version of this file may contain secrets. Contents hidden.')
    fireEvent.click(getByText('Reveal'))
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('shows the secret card naming the CURRENT side when only the current file is an unrevealed secret', () => {
    const { container } = render(
      <DiffView {...baseProps()} current={{ ...currentText(''), kind: 'secret' } as CodeFileResponse} />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('The current version of this file may contain secrets. Contents hidden.')
  })

  it('shows the secret card naming BOTH sides when both original and current are unrevealed secrets', () => {
    const { container } = render(
      <DiffView
        {...baseProps()}
        original={{ kind: 'secret' }}
        current={{ ...currentText(''), kind: 'secret' } as CodeFileResponse}
      />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('Both versions of this file may contain secrets. Contents hidden.')
  })

  it('omits the Reveal action when no onReveal is given', () => {
    const { container, queryByText } = render(<DiffView {...baseProps()} original={{ kind: 'secret' }} />)
    expect(container.textContent).toContain('The previous version of this file may contain secrets. Contents hidden.')
    expect(queryByText('Reveal')).toBeNull()
  })

  it('shows the EOL-only card when both sides are the same text apart from line endings', () => {
    const { container } = render(
      <DiffView {...baseProps()} original={textSide('a\nb\n', 'lf')} current={currentText('a\r\nb\r\n', { eol: 'crlf' })} />,
    )
    expect(container.querySelector('.cm-editor')).toBeNull()
    expect(container.textContent).toContain('Only line endings changed (LF → CRLF)')
  })

  it('renders a real diff, not a card, when both sides are ordinary changed text', () => {
    const { container } = render(<DiffView {...baseProps()} />)
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('.cm-editor')).not.toBeNull()
  })

  it('priority: secret wins over unavailable/binary even when the OTHER side is unavailable or binary', () => {
    const { container } = render(
      <DiffView
        {...baseProps()}
        original={{ kind: 'secret' }}
        current={{ ...currentText(''), kind: 'binary', mime: null, size: 10 } as CodeFileResponse}
      />,
    )
    expect(container.textContent).toContain('The previous version of this file may contain secrets. Contents hidden.')
    expect(container.textContent).not.toContain('Binary file changed')
  })

  it('priority: unavailable wins over binary/too-large on the current side', () => {
    const { container } = render(
      <DiffView
        {...baseProps()}
        original={{ kind: 'unavailable' }}
        current={{ ...currentText(''), kind: 'too-large', size: 999 } as CodeFileResponse}
      />,
    )
    expect(container.textContent).toContain('Base version not available locally (partial clone).')
    expect(container.textContent).not.toContain('Too large to compare')
  })

  it('priority: binary wins over too-large when the two sides disagree', () => {
    const { container } = render(
      <DiffView
        {...baseProps()}
        original={{ kind: 'too-large', size: 999 }}
        current={{ ...currentText(''), kind: 'binary', mime: null, size: 10 } as CodeFileResponse}
      />,
    )
    expect(container.textContent).toContain('Binary file changed')
    expect(container.textContent).not.toContain('Too large to compare')
  })
})

describe('DiffView — review safety (TRD §3.6.6): a real merge DOM, not a synthetic chunk', () => {
  // review-safety.test.ts (2.14) already unit-tests deletedChunkInvisibleMarker
  // against a HAND-INJECTED `.cm-deletedChunk` node. This suite instead lets
  // the REAL @codemirror/merge diff algorithm produce the deleted-chunk
  // widget, proving the plugin composes correctly with the real merge DOM
  // it will actually run against — the specific gap this task calls out.

  it('inline: wraps an invisible character inside a REAL deleted chunk', async () => {
    const rtlOverride = String.fromCharCode(0x202e)
    const original = textSide(`kept line\nremoved${rtlOverride}line\nkept line 2\n`)
    const current = currentText('kept line\nkept line 2\n')
    const { container } = render(<DiffView {...baseProps()} original={original} current={current} />)

    await waitFor(() => {
      expect(container.querySelector('.cm-deletedChunk')).not.toBeNull()
    })
    const marker = container.querySelector('.cm-deletedChunk .cm-co-invisible')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('title')).toBe('U+202E RIGHT-TO-LEFT OVERRIDE')
  })

  it('inline: wraps an invisible character inside a real INSERTED (current-doc) line too', () => {
    const zwsp = String.fromCharCode(0x200b)
    const original = textSide('kept line\nkept line 2\n')
    const current = currentText(`kept line\nadded${zwsp}line\nkept line 2\n`)
    const { container } = render(<DiffView {...baseProps()} original={original} current={current} />)

    const marker = container.querySelector('.cm-co-invisible')
    expect(marker).not.toBeNull()
    expect(marker?.getAttribute('title')).toBe('U+200B ZERO WIDTH SPACE')
  })

  it('split: both panes flag an invisible character on their own side', () => {
    const rtlOverride = String.fromCharCode(0x202e)
    const zwsp = String.fromCharCode(0x200b)
    const original = textSide(`only${rtlOverride}original\n`)
    const current = currentText(`only${zwsp}current\n`)
    const { container } = render(<DiffView {...baseProps()} layout="split" original={original} current={current} />)

    const editors = container.querySelectorAll('.cm-editor')
    expect(editors[0].querySelector('.cm-co-invisible')?.getAttribute('title')).toBe('U+202E RIGHT-TO-LEFT OVERRIDE')
    expect(editors[1].querySelector('.cm-co-invisible')?.getAttribute('title')).toBe('U+200B ZERO WIDTH SPACE')
  })
})

describe('DiffView — language loading', () => {
  it('loads a language when highlight is true (settles without throwing)', async () => {
    const { container } = render(<DiffView {...baseProps()} highlight={true} relPath="a.ts" />)
    await waitFor(() => expect(container.querySelector('.cm-editor')).not.toBeNull())
  })

  it('does not attempt to load a language when highlight is false', () => {
    const { container } = render(<DiffView {...baseProps()} highlight={false} />)
    expect(container.querySelector('.cm-editor')).not.toBeNull()
  })
})

describe('DiffView — theme', () => {
  it('mounts under both skins', () => {
    const { container: office } = render(<DiffView {...baseProps()} skin="office" />)
    const { container: realm } = render(<DiffView {...baseProps()} skin="realm" />)
    expect(office.querySelector('.cm-editor')).not.toBeNull()
    expect(realm.querySelector('.cm-editor')).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Fix #148: officeTheme/realmTheme are now functions of CodeMirror's own
// internal dark/light flag — this proves DiffView's OWN wiring (the `theme`
// prop threaded through InlineDiff, and the `theme` variable SplitDiff
// builds inside its effect) actually varies with `.theme-light`, for both
// layouts. CodeMirror applies an opaque, auto-generated class marking the
// editor light vs dark (cm/themes.test.ts checks the real facet directly);
// here it's enough to prove `.cm-editor`'s className actually differs
// between the two — a stable, layout-agnostic signal that something
// changed, without hard-coding CodeMirror's internal class name.
// ---------------------------------------------------------------------------

describe('DiffView — CodeMirror\'s own dark/light classification (Fix #148)', () => {
  afterEach(async () => {
    // Awaited: useIsThemeLight.ts's MutationObserver callback fires as its
    // own microtask, one tick after this class change, not synchronously
    // within it — an unawaited toggle here would leave that update to land
    // during the NEXT test instead, un-wrapped in any act() boundary of its
    // own (confirmed empirically: this was bleeding "not wrapped in act()"
    // warnings forward onto unrelated later tests before this fix).
    await act(async () => {
      document.documentElement.classList.remove('theme-light')
    })
  })

  it('inline layout: .cm-editor\'s class differs between dark (default) and light (.theme-light)', async () => {
    const { container: dark } = render(<DiffView {...baseProps()} layout="inline" />)
    const darkClass = dark.querySelector('.cm-editor')!.className

    await act(async () => {
      document.documentElement.classList.add('theme-light')
    })
    const { container: light } = render(<DiffView {...baseProps()} layout="inline" />)
    const lightClass = light.querySelector('.cm-editor')!.className

    expect(lightClass).not.toBe(darkClass)
  })

  it('split layout: each pane\'s class differs between dark (default) and light (.theme-light)', async () => {
    let dark!: ReturnType<typeof render>['container']
    await act(async () => {
      dark = render(<DiffView {...baseProps()} layout="split" />).container
    })
    const darkClasses = Array.from(dark.querySelectorAll('.cm-editor')).map((el) => el.className)
    expect(darkClasses.length).toBeGreaterThan(0)

    await act(async () => {
      document.documentElement.classList.add('theme-light')
    })
    let light!: ReturnType<typeof render>['container']
    await act(async () => {
      light = render(<DiffView {...baseProps()} layout="split" />).container
    })
    const lightClasses = Array.from(light.querySelectorAll('.cm-editor')).map((el) => el.className)

    expect(lightClasses).toHaveLength(darkClasses.length)
    lightClasses.forEach((cls, i) => expect(cls).not.toBe(darkClasses[i]))
  })
})

// ---------------------------------------------------------------------------
// Fix #150: SplitDiff builds a raw @codemirror/merge MergeView, so a live
// `isThemeLight` change used to be just one more dependency in the effect
// that tears the whole view down and rebuilds it from scratch (Fix #148) —
// correct for relPath/skin/etc. (a genuinely different file/comparison,
// which the caller already remounts via a `key` for anyway), but wrong for
// a global, app-wide appearance toggle that can flip at any moment while
// the user is scrolled through the SAME diff. It silently reset scroll to
// the top. Now it reconfigures a Compartment on the SAME view's two panes
// instead — checked here two ways: the exact same DOM nodes survive the
// toggle (proving no destroy+rebuild happened at all), and a scrollTop set
// before the toggle is still there after it.
// ---------------------------------------------------------------------------

describe('DiffView — split layout: a live theme toggle reconfigures in place (Fix #150)', () => {
  afterEach(async () => {
    await act(async () => {
      document.documentElement.classList.remove('theme-light')
    })
  })

  it('the exact same .cm-editor DOM nodes survive a live .theme-light toggle (no destroy+rebuild)', async () => {
    const { container } = render(<DiffView {...baseProps()} layout="split" />)
    const editorsBefore = Array.from(container.querySelectorAll('.cm-editor'))
    expect(editorsBefore.length).toBeGreaterThan(0)

    await act(async () => {
      document.documentElement.classList.add('theme-light')
    })

    const editorsAfter = Array.from(container.querySelectorAll('.cm-editor'))
    expect(editorsAfter).toHaveLength(editorsBefore.length)
    editorsAfter.forEach((el, i) => expect(el).toBe(editorsBefore[i]))
  })

  it('a scroll position set before the toggle survives it, in both panes', async () => {
    const { container } = render(<DiffView {...baseProps()} layout="split" />)
    const scrollersBefore = Array.from(container.querySelectorAll<HTMLElement>('.cm-scroller'))
    expect(scrollersBefore.length).toBeGreaterThan(0)
    scrollersBefore.forEach((el) => {
      el.scrollTop = 42
    })

    await act(async () => {
      document.documentElement.classList.add('theme-light')
    })

    // Same nodes (not new ones from a rebuild) is the real proof; the
    // scrollTop assertion right after is what a rebuild would actually
    // have broken for a user.
    const scrollersAfter = Array.from(container.querySelectorAll<HTMLElement>('.cm-scroller'))
    expect(scrollersAfter).toHaveLength(scrollersBefore.length)
    scrollersAfter.forEach((el, i) => {
      expect(el).toBe(scrollersBefore[i])
      expect(el.scrollTop).toBe(42)
    })
  })

  it('.cm-editor\'s class still differs correctly after the live toggle (the reconfigure actually re-themed it)', async () => {
    const { container } = render(<DiffView {...baseProps()} layout="split" />)
    const classesBefore = Array.from(container.querySelectorAll('.cm-editor')).map((el) => el.className)

    await act(async () => {
      document.documentElement.classList.add('theme-light')
    })

    const classesAfter = Array.from(container.querySelectorAll('.cm-editor')).map((el) => el.className)
    classesAfter.forEach((cls, i) => expect(cls).not.toBe(classesBefore[i]))
  })
})
