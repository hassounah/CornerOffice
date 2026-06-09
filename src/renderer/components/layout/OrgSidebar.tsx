import React, { useState } from 'react'
import { useNavigate, useLocation } from 'react-router'
import { useWorkspaceStore } from '../../stores/workspace-store'
import { useSettingsStore } from '../../stores/settings-store'
import { StatusIcon } from '../shared/StatusIcon'
import { GateDots } from '../shared/GateDots'
import { IconDashboard, IconInstincts, IconSettings } from '../icons'
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

// ---------------------------------------------------------------------------
// Workspace row
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  workspace: Workspace
  isSelected: boolean
  onSelect: () => void
  compact?: boolean
}

function WorkspaceRow({ workspace, isSelected, onSelect, compact }: WorkspaceRowProps): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={[
        'w-full flex items-center gap-2.5 px-3 text-left transition-all duration-150 rounded-lg',
        compact ? 'py-1.5' : 'py-2',
        isSelected
          ? 'co-sidebar-active bg-white/[0.06] text-co-text-primary'
          : 'text-co-text-secondary hover:bg-white/[0.04] hover:text-co-text-primary',
      ].join(' ')}
      aria-pressed={isSelected}
      title={workspace.path}
    >
      <StatusIcon status={workspace.status} size="sm" />

      <span className="flex-1 min-w-0 overflow-hidden">
        <span className="block text-[13px] font-medium truncate">{workspace.displayName}</span>
        {workspace.level && !compact && (
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
  )
}

// ---------------------------------------------------------------------------
// OrgSidebar
// ---------------------------------------------------------------------------

export function OrgSidebar(): React.ReactElement {
  const navigate = useNavigate()
  const location = useLocation()
  const [archivedExpanded, setArchivedExpanded] = useState(false)

  const workspaces = useWorkspaceStore((s) => s.workspaces)
  const selectedSlug = useWorkspaceStore((s) => s.selectedSlug)
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace)
  const companyName = useSettingsStore((s) => s.config?.companyName ?? '')
  const compactView = useSettingsStore((s) => s.config?.appearance.compactView ?? false)

  const nonArchived = workspaces.filter((w) => !w.archived)
  const pinned = nonArchived.filter((w) => w.pinned).sort(byActivity)
  const regular = nonArchived.filter((w) => !w.pinned).sort(byActivity)
  const archived = workspaces.filter((w) => w.archived).sort(byActivity)

  const navigable = [
    ...pinned,
    ...regular,
    ...(archivedExpanded ? archived : []),
  ]

  function handleWorkspaceSelect(slug: string): void {
    selectWorkspace(slug)
    navigate(`/workspace/${slug}`)
    setTimeout(() => {
      const main = document.getElementById('main-content')
      main?.focus()
    }, 0)
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
        {pinned.length > 0 && (
          <section className="mb-2">
            <div className="px-2 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-co-text-muted/60">
                Pinned
              </span>
            </div>
            <ul className="flex flex-col gap-0.5">
              {pinned.map((ws) => (
                <li key={ws.slug}>
                  <WorkspaceRow
                    workspace={ws}
                    isSelected={selectedSlug === ws.slug}
                    onSelect={() => handleWorkspaceSelect(ws.slug)}
                    compact={compactView}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {regular.length > 0 && (
          <section className="mb-2">
            {pinned.length > 0 && (
              <div className="px-2 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-widest text-co-text-muted/60">
                  Workspaces
                </span>
              </div>
            )}
            <ul className="flex flex-col gap-0.5">
              {regular.map((ws) => (
                <li key={ws.slug}>
                  <WorkspaceRow
                    workspace={ws}
                    isSelected={selectedSlug === ws.slug}
                    onSelect={() => handleWorkspaceSelect(ws.slug)}
                    compact={compactView}
                  />
                </li>
              ))}
            </ul>
          </section>
        )}

        {workspaces.length === 0 && (
          <p className="px-4 py-3 text-sm text-co-text-muted">No workspaces found.</p>
        )}

        {archived.length > 0 && (
          <section className="mt-3">
            <button
              type="button"
              onClick={() => setArchivedExpanded((prev) => !prev)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-co-text-muted/60 hover:text-co-text-muted transition-colors"
              aria-expanded={archivedExpanded}
            >
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"
                className={`transition-transform duration-150 ${archivedExpanded ? 'rotate-90' : ''}`}
              >
                <path d="M3 2l4 3-4 3V2z" />
              </svg>
              Archived ({archived.length})
            </button>
            {archivedExpanded && (
              <ul className="flex flex-col gap-0.5 opacity-50">
                {archived.map((ws) => (
                  <li key={ws.slug}>
                    <WorkspaceRow
                      workspace={ws}
                      isSelected={selectedSlug === ws.slug}
                      onSelect={() => handleWorkspaceSelect(ws.slug)}
                    />
                  </li>
                ))}
              </ul>
            )}
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
