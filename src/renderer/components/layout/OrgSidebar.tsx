import React, { useEffect, useId, useRef, useState } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useSidebarStore } from '../../stores/sidebar-store'
import { StatusIcon } from '../shared/StatusIcon'
import { GateDots } from '../shared/GateDots'
import { IconDashboard, IconInstincts, IconSettings } from '../icons'
import { AVAILABILITY_BADGE } from '../../utils/workspace-errors'
import type { Workspace } from '@main/types/workspace'

// ---------------------------------------------------------------------------
// Nav items
// ---------------------------------------------------------------------------

interface NavItem {
  label: string
  subtitle?: string
  path: string
  icon: React.ReactElement
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Dashboard',
    path: '/',
    icon: <IconDashboard size={16} stroke="currentColor" />,
  },
  {
    label: 'Homunculus',
    subtitle: 'Memory & Learning',
    path: '/homunculus',
    icon: <IconInstincts size={16} stroke="currentColor" />,
  },
  {
    label: 'Notifications',
    path: '/notifications',
    icon: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8 16a2 2 0 001.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 008 16zM8 1.5a.5.5 0 01.5.5v.54A4.502 4.502 0 0112.5 7c0 .834-.086 2.369-.5 3.5H4c-.414-1.131-.5-2.666-.5-3.5a4.502 4.502 0 014-4.46V2a.5.5 0 01.5-.5z" />
      </svg>
    ),
  },
  {
    label: 'Settings',
    path: '/settings',
    icon: <IconSettings size={16} stroke="currentColor" />,
  },
]

/** What focus moves to after a Hide or Show: a workspace row (by id) or the Hidden section's header. */
const HIDDEN_HEADER_TARGET = '\u0000hidden-header'

// ---------------------------------------------------------------------------
// Workspace row
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  workspace: Workspace
  isSelected: boolean
  onSelect: () => void
  compact?: boolean
  /** The "…" menu with Hide (main list), or the Show button (Hidden section). */
  action: { kind: 'hide' | 'show'; onAction: () => void }
  menuOpen: boolean
  onToggleMenu: () => void
  onCloseMenu: () => void
  registerRow: (slug: string, element: HTMLButtonElement | null) => void
}

function WorkspaceRow({ workspace, isSelected, onSelect, compact, action, menuOpen, onToggleMenu, onCloseMenu, registerRow }: WorkspaceRowProps): React.ReactElement {
  const menuId = useId()
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const menuItemRef = useRef<HTMLButtonElement>(null)
  const badge = workspace.availability === 'ok' ? null : AVAILABILITY_BADGE[workspace.availability]
  const unavailable = badge !== null

  // Opening the menu moves focus to its item; a click elsewhere closes it (Escape is handled on the menu itself).
  useEffect(() => {
    if (!menuOpen) return
    menuItemRef.current?.focus()
    function onPointerDown(event: MouseEvent): void {
      const target = event.target as Node
      if (!menuButtonRef.current?.parentElement?.contains(target)) onCloseMenu()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [menuOpen, onCloseMenu])

  function handleMenuKeyDown(event: React.KeyboardEvent): void {
    // The sidebar list handles arrows for moving between workspaces; inside the menu they are not for it.
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onCloseMenu()
      menuButtonRef.current?.focus()
    }
  }

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        ref={(element) => registerRow(workspace.slug, element)}
        onClick={onSelect}
        className={[
          'w-full flex items-center gap-2.5 pl-3 pr-9 text-left transition-all duration-150 rounded-lg',
          compact ? 'py-1.5' : 'py-2',
          isSelected
            ? 'co-sidebar-active bg-white/[0.06] text-co-text-primary'
            : 'text-co-text-secondary hover:bg-white/[0.04] hover:text-co-text-primary',
          unavailable ? 'opacity-60' : '',
        ].join(' ')}
        aria-pressed={isSelected}
        title={workspace.path}
      >
        <StatusIcon status={workspace.status} size="sm" />

        <span className="flex-1 min-w-0 overflow-hidden">
          <span className="block text-[13px] font-medium truncate">{workspace.displayName}</span>
          {badge && (
            <span className="block text-[11px] text-co-status-attention truncate mt-0.5">{badge}</span>
          )}
          {!badge && workspace.level && !compact && (
            <span className="block text-[11px] text-co-text-muted truncate mt-0.5">
              Lv {workspace.level.number}
            </span>
          )}
        </span>

        {workspace.activePipelines.length > 0 && workspace.activePipelines.map((pipeline) => (
          <GateDots
            key={pipeline.slug}
            passed={pipeline.gate !== null ? pipeline.gate - 1 : 0}
            current={pipeline.gate !== null ? pipeline.gate - 1 : undefined}
          />
        ))}
      </button>

      {action.kind === 'hide' ? (
        <div className="absolute right-1 top-1/2 -translate-y-1/2" onKeyDown={handleMenuKeyDown}>
          <button
            type="button"
            ref={menuButtonRef}
            aria-label={`Actions for ${workspace.displayName}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            onClick={onToggleMenu}
            // Visible on hover and whenever focus is inside the row (keyboard users), always while its menu is open.
            className={[
              'px-1.5 py-0.5 rounded text-co-text-muted hover:text-co-text-primary hover:bg-white/[0.06] transition-opacity',
              'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
              menuOpen ? 'opacity-100' : '',
            ].join(' ')}
          >
            <span aria-hidden="true">…</span>
          </button>
          {menuOpen && (
            <div
              id={menuId}
              role="menu"
              aria-label={`${workspace.displayName} actions`}
              className="absolute right-0 top-full z-40 mt-1 min-w-[96px] rounded-md border border-co-border bg-co-bg-tertiary p-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                ref={menuItemRef}
                onClick={action.onAction}
                className="w-full text-left px-2 py-1 text-[12px] rounded text-co-text-secondary hover:text-co-text-primary hover:bg-white/[0.06]"
              >
                Hide
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Show ${workspace.displayName}`}
          onClick={action.onAction}
          className="absolute right-1 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded text-[11px] text-co-text-muted hover:text-co-text-primary hover:bg-white/[0.06]"
        >
          Show
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OrgSidebar
// ---------------------------------------------------------------------------

export function OrgSidebar(): React.ReactElement {
  const navigate = useNavigate()
  const location = useLocation()
  const hiddenHeadingId = useId()
  const hiddenListId = useId()

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const selectedSlug = useWorkspaceStore((s) => s.selectedSlug)
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace)
  const setHidden = useWorkspaceStore((s) => s.setHidden)
  const companyName = useSettingsStore((s) => s.config?.companyName ?? '')
  const compactView = useSettingsStore((s) => s.config?.appearance.compactView ?? false)
  const hiddenExpanded = useSidebarStore((s) => s.hiddenExpanded)
  const setHiddenExpanded = useSidebarStore((s) => s.setHiddenExpanded)
  const focusSeq = useSidebarStore((s) => s.focusSeq)

  const [menuSlug, setMenuSlug] = useState<string | null>(null)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const rows = useRef(new Map<string, HTMLButtonElement>())
  const hiddenHeaderRef = useRef<HTMLButtonElement>(null)
  const handledFocusSeq = useRef(focusSeq)

  const listed = workspaces.filter((w) => !w.hidden).sort(byActivity)
  const hidden = workspaces.filter((w) => w.hidden).sort(byActivity)
  const hiddenNeedAttention = hidden.filter((w) => w.status === 'attention').length

  const navigable = [...listed, ...(hiddenExpanded ? hidden : [])]

  function registerRow(slug: string, element: HTMLButtonElement | null): void {
    if (element) rows.current.set(slug, element)
    else rows.current.delete(slug)
  }

  // Focus follows a Hide or Show to the next item once the list has re-rendered without (or with) the moved row.
  useEffect(() => {
    if (pendingFocus === null) return
    const target = pendingFocus === HIDDEN_HEADER_TARGET ? hiddenHeaderRef.current : rows.current.get(pendingFocus) ?? null
    if (!target) return
    target.focus()
    setPendingFocus(null)
  }, [pendingFocus, workspaces])

  // The Dashboard's "N hidden · Show" footer: the section is already expanded by the store; put focus on its header.
  useEffect(() => {
    if (focusSeq === handledFocusSeq.current) return
    handledFocusSeq.current = focusSeq
    hiddenHeaderRef.current?.focus()
  }, [focusSeq, hidden.length])

  function handleWorkspaceSelect(slug: string): void {
    selectWorkspace(slug)
    navigate(`/workspace/${slug}`)
    setTimeout(() => {
      const main = document.getElementById('main-content')
      main?.focus()
    }, 0)
  }

  /** The row to focus after `slug` leaves `from`: the next one, else the previous one, else `fallback`. */
  function neighbour(from: Workspace[], slug: string, fallback: string): string {
    const index = from.findIndex((w) => w.slug === slug)
    return from[index + 1]?.slug ?? from[index - 1]?.slug ?? fallback
  }

  async function hideWorkspace(workspace: Workspace): Promise<void> {
    setMenuSlug(null)
    // After Hide, focus moves to the next sidebar item (UX H-2). With none left it goes to the Hidden header.
    const next = neighbour(listed, workspace.slug, HIDDEN_HEADER_TARGET)
    try {
      await setHidden(workspace.slug, true)
      setPendingFocus(next)
    } catch {
      // The store announces nothing on failure; the row is still there, so focus stays where it was.
      setPendingFocus(workspace.slug)
    }
  }

  async function showWorkspace(workspace: Workspace): Promise<void> {
    try {
      await setHidden(workspace.slug, false)
      // The Show button leaves with the row. Focus follows the workspace into the main list.
      setPendingFocus(workspace.slug)
    } catch {
      setPendingFocus(null)
    }
  }

  function handleWorkspaceKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (navigable.length === 0) return
    const currentIdx = navigable.findIndex((ws) => ws.slug === selectedSlug)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = navigable[(currentIdx + 1) % navigable.length]
      if (next) handleWorkspaceSelect(next.slug)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = navigable[(currentIdx - 1 + navigable.length) % navigable.length]
      if (prev) handleWorkspaceSelect(prev.slug)
    }
  }

  const currentPath = location.pathname

  function renderRow(ws: Workspace, kind: 'hide' | 'show'): React.ReactElement {
    return (
      <li key={ws.slug}>
        <WorkspaceRow
          workspace={ws}
          isSelected={selectedSlug === ws.slug}
          onSelect={() => handleWorkspaceSelect(ws.slug)}
          compact={compactView}
          action={{ kind, onAction: () => void (kind === 'hide' ? hideWorkspace(ws) : showWorkspace(ws)) }}
          menuOpen={menuSlug === ws.slug}
          onToggleMenu={() => setMenuSlug((current) => (current === ws.slug ? null : ws.slug))}
          onCloseMenu={() => setMenuSlug((current) => (current === ws.slug ? null : current))}
          registerRow={registerRow}
        />
      </li>
    )
  }

  return (
    <aside
      className="flex flex-col w-60 shrink-0 h-full overflow-y-auto border-r border-white/[0.04]"
      style={{ background: 'var(--co-sidebar-bg)', backdropFilter: 'blur(24px)' }}
      aria-label="Sidebar"
    >
      {/* Company name */}
      <div className="px-4 pt-5 pb-4">
        <h1 className="text-sm font-semibold text-co-text-primary tracking-tight truncate" title={companyName}>
          {companyName || 'Corner Office'}
        </h1>
      </div>

      {/* Workspaces */}
      <div
        className="flex-1 overflow-y-auto px-2 py-1"
        onKeyDown={handleWorkspaceKeyDown}
        role="group"
        aria-label="Workspaces"
      >
        {listed.length > 0 && (
          <section className="mb-2">
            <ul className="flex flex-col gap-0.5">{listed.map((ws) => renderRow(ws, 'hide'))}</ul>
          </section>
        )}

        {workspaces.length === 0 && (
          <p className="px-4 py-3 text-sm text-co-text-muted">No workspaces yet.</p>
        )}

        {hidden.length > 0 && (
          <section className="mt-3" aria-labelledby={hiddenHeadingId}>
            <button
              type="button"
              id={hiddenHeadingId}
              ref={hiddenHeaderRef}
              onClick={() => setHiddenExpanded(!hiddenExpanded)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-co-text-muted/60 hover:text-co-text-muted transition-colors"
              aria-expanded={hiddenExpanded}
              aria-controls={hiddenListId}
            >
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"
                className={`transition-transform duration-150 ${hiddenExpanded ? 'rotate-90' : ''}`}
              >
                <path d="M3 2l4 3-4 3V2z" />
              </svg>
              Hidden ({hidden.length})
              {hiddenNeedAttention > 0 && (
                <>
                  <span aria-hidden="true" className="ml-auto inline-block h-2 w-2 rounded-full bg-co-status-attention" />
                  <span aria-hidden="true" className="text-co-status-attention normal-case tracking-normal">{hiddenNeedAttention}</span>
                  <span className="sr-only">{`, ${hiddenNeedAttention} need${hiddenNeedAttention === 1 ? 's' : ''} attention`}</span>
                </>
              )}
            </button>
            <ul id={hiddenListId} className="flex flex-col gap-0.5" hidden={!hiddenExpanded}>
              {hiddenExpanded && hidden.map((ws) => renderRow(ws, 'show'))}
            </ul>
          </section>
        )}
      </div>

      {/* Navigation — bottom */}
      <nav className="border-t border-white/[0.04] py-2 px-2" aria-label="Main navigation">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.path === '/'
                ? currentPath === '/'
                : currentPath.startsWith(item.path)

            return (
              <li key={item.path}>
                <button
                  type="button"
                  onClick={() => navigate(item.path)}
                  className={[
                    'w-full flex items-center gap-3 px-3 py-2 text-[13px] rounded-lg transition-all duration-150',
                    isActive
                      ? 'co-sidebar-active text-co-text-primary bg-white/[0.06]'
                      : 'text-co-text-muted hover:text-co-text-secondary hover:bg-white/[0.04]',
                  ].join(' ')}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className={isActive ? 'text-co-accent' : 'opacity-60'}>
                    {item.icon}
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">{item.label}</span>
                    {item.subtitle && (
                      <span className="block text-[11px] text-co-text-muted truncate mt-0.5">
                        {item.subtitle}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function byActivity(a: Workspace, b: Workspace): number {
  if (!a.lastActivityTimestamp && !b.lastActivityTimestamp) return 0
  if (!a.lastActivityTimestamp) return 1
  if (!b.lastActivityTimestamp) return -1
  return b.lastActivityTimestamp.localeCompare(a.lastActivityTimestamp)
}
