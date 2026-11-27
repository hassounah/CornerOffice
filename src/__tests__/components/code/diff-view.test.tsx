import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, fireEvent, cleanup, waitFor } from '@testing-library/react'
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
