import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'
import { Terminal } from '@xterm/xterm'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { FitAddon } from './FitAddon'

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/** Fixed dark terminal theme — zinc palette. Claude Code's TUI is designed for dark backgrounds. */
const TERMINAL_THEME = {
  background: '#18181b',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: 'rgba(58, 130, 246, 0.35)',
  black: '#18181b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
} as const

// ---------------------------------------------------------------------------
// Handle interface
// ---------------------------------------------------------------------------

export interface TerminalPanelHandle {
  /** Returns false when no match found — caller can show no-results feedback. */
  search(query: string): boolean
  /** Returns false when no match found. */
  searchNext(query: string): boolean
  /** Returns false when no match found. */
  searchPrevious(query: string): boolean
  clearSearch(): void
  selectAll(): void
  clearTerminal(): void
  getSelection(): string
  hasSelection(): boolean
  focus(): void
  writeText(text: string): void
}

// ---------------------------------------------------------------------------
// Search decoration options — regex:false prevents ReDoS from user-supplied patterns
// ---------------------------------------------------------------------------

const SEARCH_DECORATIONS = {
  matchBackground: '#ffff0040',
  activeMatchBackground: '#ffff00a0',
  matchOverviewRuler: '#ffff0080',
  activeMatchColorOverviewRuler: '#ffff00c0',
} as const

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TerminalPanelProps {
  workspaceSlug: string
  fontSize?: number
  onReady?: () => void
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(
  function TerminalPanel({ workspaceSlug, fontSize = 14, onReady }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const searchAddonRef = useRef<SearchAddon | null>(null)
    const fitAddonRef = useRef<FitAddon | null>(null)
    // Keep onReady in a ref so the effect closure never goes stale
    const onReadyRef = useRef(onReady)
    useEffect(() => { onReadyRef.current = onReady }, [onReady])

    useImperativeHandle(ref, () => ({
      search(query: string): boolean {
        if (!searchAddonRef.current) return false
        // regex: false prevents ReDoS from user-supplied patterns
        return searchAddonRef.current.findNext(query, { regex: false, decorations: SEARCH_DECORATIONS })
      },
      searchNext(query: string): boolean {
        if (!searchAddonRef.current) return false
        return searchAddonRef.current.findNext(query, { regex: false, decorations: SEARCH_DECORATIONS })
      },
      searchPrevious(query: string): boolean {
        if (!searchAddonRef.current) return false
        return searchAddonRef.current.findPrevious(query, { regex: false, decorations: SEARCH_DECORATIONS })
      },
      clearSearch(): void {
        searchAddonRef.current?.clearDecorations()
      },
      selectAll(): void {
        terminalRef.current?.selectAll()
      },
      clearTerminal(): void {
        terminalRef.current?.clear()
      },
      getSelection(): string {
        return terminalRef.current?.getSelection() ?? ''
      },
      hasSelection(): boolean {
        return terminalRef.current?.hasSelection() ?? false
      },
      focus(): void {
        terminalRef.current?.focus()
      },
      writeText(text: string): void {
        if (!terminalRef.current) return
        const PASTE_WARN_LIMIT = 10_240
        if (text.length > PASTE_WARN_LIMIT) {
          console.warn(`[TerminalPanel] writeText: large paste (${text.length} bytes)`)
        }
        terminalRef.current.paste(text)
      },
    }), [])

    useEffect(() => {
      const container = containerRef.current
      if (!container) return

      // ── 1. Terminal instance ─────────────────────────────────────────────────
      const terminal = new Terminal({
        theme: TERMINAL_THEME,
        scrollback: 5000,
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: 'Menlo, Consolas, "Courier New", monospace',
        fontSize,
      })

      terminalRef.current = terminal

      // ── 2. Custom FitAddon ───────────────────────────────────────────────────
      const fitAddon = new FitAddon()
      terminal.loadAddon(fitAddon)
      fitAddonRef.current = fitAddon

      // ── 3. Open terminal into DOM (must happen before WebGL addon) ──────────
      terminal.open(container)

      // ── 4. WebGL addon — silent canvas fallback on failure ─────────────────
      try {
        const webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          webglAddon.dispose()
        })
        terminal.loadAddon(webglAddon)
      } catch {
        // WebGL not available — canvas fallback is automatic
      }

      // ── 4b. SearchAddon ───────────────────────────────────────────────────────
      const searchAddon = new SearchAddon()
      terminal.loadAddon(searchAddon)
      searchAddonRef.current = searchAddon

      // ── 4c. WebLinksAddon ─────────────────────────────────────────────────────
      const webLinksAddon = new WebLinksAddon((event, uri) => {
        event.preventDefault()
        void window.cornerOffice.shell.openExternal(uri, workspaceSlug)
      })
      terminal.loadAddon(webLinksAddon)

      // ── 5. Initial fit ────────────────────────────────────────────────────────
      fitAddon.fit()

      // ── onReady gate (amendment A5) ──────────────────────────────────────────
      let readyFired = false
      let readyTimeout: ReturnType<typeof setTimeout> | null = null

      function fireReady(): void {
        if (readyFired) return
        readyFired = true
        if (readyTimeout !== null) {
          clearTimeout(readyTimeout)
          readyTimeout = null
        }
        terminal.focus()
        onReadyRef.current?.()
      }

      // ── 5. Scrollback replay ─────────────────────────────────────────────────
      const cornerOffice = window.cornerOffice
      if (cornerOffice) {
        void cornerOffice.terminal
          .getScrollback(workspaceSlug)
          .then((response) => {
            const scrollback = response.data?.scrollback ?? ''
            if (scrollback.length > 0) {
              // Write buffered output from PTY, then fit + signal ready
              terminal.write(scrollback, () => {
                fitAddon.fit()
                terminal.scrollToBottom()
                void cornerOffice.terminal.resize(workspaceSlug, terminal.cols, terminal.rows)
                fireReady()
              })
            } else {
              // Fresh spawn: fire onReady after first data ≥10 bytes or 3s timeout (A5)
              readyTimeout = setTimeout(fireReady, 3_000)
            }
          })
          .catch(() => {
            // On IPC error fall back to timeout path
            readyTimeout = setTimeout(fireReady, 3_000)
          })
      }

      // ── 6. Data listener ─────────────────────────────────────────────────────
      const unsubData = cornerOffice?.on('terminal:data', (payload: unknown) => {
        const { workspaceSlug: slug, data } = payload as { workspaceSlug: string; data: string }
        if (slug !== workspaceSlug) return
        terminal.write(data)
        // Amendment A5: first data ≥10 bytes lifts the ready gate (fresh spawn path)
        if (!readyFired && data.length >= 10) {
          fireReady()
        }
      })

      // ── 7. Input handler ─────────────────────────────────────────────────────
      const inputDisposable = terminal.onData((data) => {
        void cornerOffice?.terminal.write(workspaceSlug, data)
      })

      // ── 8. Resize handling ───────────────────────────────────────────────────
      const onResizeDisposable = terminal.onResize(({ cols, rows }) => {
        void cornerOffice?.terminal.resize(workspaceSlug, cols, rows)
      })

      let resizeTimer: ReturnType<typeof setTimeout> | null = null
      const resizeObserver = new ResizeObserver(() => {
        if (resizeTimer !== null) clearTimeout(resizeTimer)
        resizeTimer = setTimeout(() => {
          resizeTimer = null
          fitAddon.fit()
        }, 200)
      })
      resizeObserver.observe(container)

      // ── Cleanup (P17) ────────────────────────────────────────────────────────
      return () => {
        terminalRef.current = null
        searchAddonRef.current = null
        fitAddonRef.current = null
        if (readyTimeout !== null) clearTimeout(readyTimeout)
        if (resizeTimer !== null) clearTimeout(resizeTimer)
        resizeObserver.disconnect()
        onResizeDisposable.dispose()
        inputDisposable.dispose()
        unsubData?.()
        searchAddon.dispose()
        terminal.dispose()
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [workspaceSlug])

    // ── fontSize hot-reload (separate from terminal lifecycle) ────────────────
    useEffect(() => {
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      if (!terminal || !fitAddon) return
      terminal.options.fontSize = fontSize
      fitAddon.fit()
    }, [fontSize])

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
  }
)
