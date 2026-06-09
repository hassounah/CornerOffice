import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Pipeline, Feature, IdeationItem, WorkspaceStatus } from '@main/types/workspace'
import { useWorkspaceStore } from '../../../stores/workspace-store'
import { useDocViewerStore } from '../../../stores/docviewer-store'
import { useChannelsStore } from '../../../stores/channels-store'
import { ChatPanel } from '../../channels/ChatPanel'
import { PermissionScroll } from '../../channels/PermissionScroll'
import { RealmDocViewer } from './RealmDocViewer'
import { useSettingsStore } from '../../../stores/settings-store'
import { useTerminalStore } from '../../../stores/terminal-store'
import { TerminalOverlay } from '../../terminal/TerminalOverlay'

// ---------------------------------------------------------------------------
// Asset imports
// ---------------------------------------------------------------------------

import wizardsStudyBg from '../../../../../assets/realm/study/Wizards_Study.png'
import gemAmber from '../../../../../assets/realm/study/Gem_Amber.png'
import gemGreen from '../../../../../assets/realm/study/Gem_Green.png'
import gemLocked from '../../../../../assets/realm/study/Purple_Gem_Locked.png'
import shieldDirect from '../../../../../assets/realm/ui/badges/Shield_Direct.png'
import shieldFull from '../../../../../assets/realm/ui/badges/Shield_Full.png'
import shieldLight from '../../../../../assets/realm/ui/badges/Shield_Light.png'
import spellBookAmber from '../../../../../assets/realm/study/Spell_Book_Amber_1.png'
import spellBookBlue from '../../../../../assets/realm/study/Spell_Book_Blue_1.png'
import spellBookRed from '../../../../../assets/realm/study/Spell_Book_Red_1.png'
import spellBookTeal from '../../../../../assets/realm/study/Spell_Book_Teal_1.png'
import spellBookOpen1 from '../../../../../assets/realm/study/Spell_Book_Open_1.png'
import spellBookOpen2 from '../../../../../assets/realm/study/Spell_Book_Open_2.png'
import memoryScrollImg from '../../../../../assets/realm/study/Memory_Scroll.png'
import chestFull from '../../../../../assets/realm/study/Chest_Scroll_Open_Full.png'
import chestEmpty from '../../../../../assets/realm/study/Chest_Scroll_Open_Empty.png'
import scrollSmall from '../../../../../assets/realm/study/Scroll_Small.png'
import scrollMedium from '../../../../../assets/realm/study/Scroll_Medium.png'
import settingsScrollActive from '../../../../../assets/realm/settings/Settings_Scroll_Active.png'
import settingsScrollInactive from '../../../../../assets/realm/settings/Settings_Scroll_Inactive.png'
import pillarLeft from '../../../../../assets/realm/study/Pillar_Left.png'
import pillarRight from '../../../../../assets/realm/study/Pillar_Right.png'
import bannerRoyalPurple from '../../../../../assets/realm/documents/Banner_Royal_Purple.png'
import bannerNavyBlue from '../../../../../assets/realm/documents/Banner_Navy_Blue.png'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SPELL_BOOK_SRCS = [spellBookAmber, spellBookBlue, spellBookRed, spellBookTeal]

function shieldSrc(type: 'direct' | 'light' | 'full'): string {
  return type === 'direct' ? shieldDirect : type === 'light' ? shieldLight : shieldFull
}

function gemSrc(gemGate: number, currentGate: number | null): string {
  if (currentGate === null) return gemGreen
  if (currentGate > gemGate) return gemGreen
  if (currentGate === gemGate) return gemAmber
  return gemLocked
}

function gemCount(type: 'direct' | 'light' | 'full'): number {
  return type === 'full' ? 3 : type === 'light' ? 1 : 0
}

function windowFilter(status: WorkspaceStatus): string {
  switch (status) {
    case 'active':    return 'brightness(1.15) saturate(1.3)'
    case 'waiting':   return 'brightness(0.75) hue-rotate(190deg) saturate(0.7)'
    case 'attention': return 'brightness(1.0) sepia(0.5) saturate(1.8)'
    case 'parked':    return 'brightness(0.7) saturate(0.4)'
    case 'idle':
    default:          return 'brightness(0.85) saturate(0.8)'
  }
}

// ---------------------------------------------------------------------------
// Sub-sections
// ---------------------------------------------------------------------------

function PipelineTrack({ pipeline }: { pipeline: Pipeline }): React.ReactElement {
  const gates = gemCount(pipeline.pipelineType)

  const gemSlots = gates > 0
    ? Array.from({ length: gates }, (_, i) => gemSrc(i + 1, pipeline.gate))
    : []

  return (
    <section
      aria-label="Active pipeline"
      style={{
        background: 'rgba(10, 6, 2, 0.65)',
        border: '1px solid rgba(201,168,76,0.3)',
        borderRadius: 6,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <img src={shieldSrc(pipeline.pipelineType)} alt={pipeline.pipelineType} style={{ width: 48, height: 58, objectFit: 'contain' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: '#c9a84c', fontSize: 20, fontWeight: 'bold', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {pipeline.featureName}
        </div>
        <div style={{ color: '#9c8a6a', fontSize: 15 }}>
          {pipeline.pipelineType} · {pipeline.stage}{pipeline.gate ? ` · gate ${pipeline.gate}` : ''}
        </div>
      </div>

      {/* Gate progress: pillar — gems horizontal — pillar */}
      {gates > 0 && (
        <div
          aria-label={`Gate progress: ${pipeline.gate ?? 0} of ${gates}`}
          style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}
        >
          <img src={pillarLeft} alt="" aria-hidden="true" style={{ width: 44, height: 63, objectFit: 'contain' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, margin: '0 -2px' }}>
            {gemSlots.map((src, i) => (
              <img
                key={i}
                src={src}
                alt={pipeline.gate !== null && pipeline.gate > i + 1 ? `gate ${i + 1} passed` : pipeline.gate === i + 1 ? `gate ${i + 1} current` : `gate ${i + 1} locked`}
                style={{ width: 45, height: 44, objectFit: 'contain' }}
              />
            ))}
          </div>
          <img src={pillarRight} alt="" aria-hidden="true" style={{ width: 44, height: 63, objectFit: 'contain' }} />
        </div>
      )}
    </section>
  )
}

function EmptyPipelineState(): React.ReactElement {
  return (
    <div
      aria-label="No active pipeline"
      style={{
        background: 'rgba(10, 6, 2, 0.5)',
        border: '1px dashed rgba(201,168,76,0.2)',
        borderRadius: 6,
        padding: '12px 16px',
        color: '#9c8a6a',
        fontSize: 14,
        fontStyle: 'italic',
        textAlign: 'center',
      }}
    >
      No quests underway
    </div>
  )
}

// Medieval labels for each quest stage
const QUEST_STAGE: Record<string, { label: string; icon: string; color: string }> = {
  in_progress: { label: 'Active Quests', icon: '⚔', color: '#c9a84c' },
  todo:        { label: 'Pending Quests', icon: '📜', color: '#9c8a6a' },
  done:        { label: 'Completed Quests', icon: '🏆', color: '#6b8a4a' },
}

function FeatureRow({ feature, workspaceSlug, onOpen }: {
  feature: Feature
  workspaceSlug: string | null
  onOpen: (f: Feature) => void
}): React.ReactElement {
  const isDone = feature.status === 'done'
  const isTodo = feature.status === 'todo'
  const textColor = isDone ? '#8aad6a' : isTodo ? '#9c8a6a' : '#e8d5a3'
  const iconImg = isDone ? scrollSmall : scrollMedium
  const iconOpacity = isDone ? 0.5 : isTodo ? 0.6 : 1

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        cursor: workspaceSlug ? 'pointer' : 'default',
        borderRadius: 3, padding: '3px 6px',
      }}
      onClick={() => onOpen(feature)}
      role={workspaceSlug ? 'button' : undefined}
      tabIndex={workspaceSlug ? 0 : undefined}
      aria-label={workspaceSlug ? `Open ${feature.name}` : undefined}
      onKeyDown={(e) => { if (workspaceSlug && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(feature) } }}
      onMouseEnter={(e) => { if (workspaceSlug) (e.currentTarget as HTMLElement).style.background = 'rgba(201,168,76,0.1)' }}
      onMouseLeave={(e) => { if (workspaceSlug) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <img src={iconImg} alt="" aria-hidden="true" style={{ width: 22, height: 22, objectFit: 'contain', opacity: iconOpacity }} />
      <span style={{ fontSize: 14, color: textColor, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
        {feature.name}
      </span>
      {feature.pipelineType && (
        <img
          src={shieldSrc(feature.pipelineType)}
          alt={feature.pipelineType}
          style={{ width: 18, height: 22, objectFit: 'contain', opacity: 0.6, flexShrink: 0 }}
        />
      )}
    </div>
  )
}

function FeatureBoard({ features, workspaceSlug }: { features: Feature[]; workspaceSlug: string | null }): React.ReactElement {
  const openFolder = useDocViewerStore((s) => s.openFolder)

  const inProgress = features.filter((f) => f.status === 'in_progress')
  const todo = features.filter((f) => f.status === 'todo')
  const done = features.filter((f) => f.status === 'done')

  function handleFeatureClick(f: Feature): void {
    if (workspaceSlug) openFolder(f.directory, workspaceSlug)
  }

  const groups = [
    { key: 'in_progress', items: inProgress },
    { key: 'todo', items: todo },
    { key: 'done', items: done },
  ]

  const hasAny = features.length > 0

  return (
    <section
      aria-label="Feature board"
      style={{
        background: 'rgba(10, 6, 2, 0.6)',
        border: '1px solid rgba(201,168,76,0.25)',
        borderRadius: 6,
        padding: '10px 12px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ color: '#c9a84c', fontSize: 14, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
        Feature Board
      </div>
      {!hasAny ? (
        <div style={{ color: '#9c8a6a', fontSize: 14, fontStyle: 'italic' }}>No quests recorded</div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {groups.map(({ key, items }) => {
            if (items.length === 0) return null
            const stage = QUEST_STAGE[key]
            return (
              <div key={key}>
                <div style={{
                  fontSize: 12, color: stage.color, textTransform: 'uppercase', letterSpacing: 0.5,
                  marginBottom: 4, paddingBottom: 3,
                  borderBottom: `1px solid ${stage.color}33`,
                }}>
                  {stage.label} ({items.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {items.map((f) => (
                    <FeatureRow key={f.id} feature={f} workspaceSlug={workspaceSlug} onOpen={handleFeatureClick} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Bookshelf({ items, workspaceSlug }: { items: IdeationItem[]; workspaceSlug: string | null }): React.ReactElement {
  const openFile = useDocViewerStore((s) => s.openFile)
  const mode = useDocViewerStore((s) => s.mode)
  const activeFileName = useDocViewerStore((s) => s.file?.name ?? null)

  return (
    <section
      aria-label={`Bookshelf — ${items.length} ideation item${items.length !== 1 ? 's' : ''}`}
      style={{
        background: 'rgba(10, 6, 2, 0.6)',
        border: '1px solid rgba(201,168,76,0.25)',
        borderRadius: 6,
        padding: '6px 10px',
      }}
    >
      <div style={{ color: '#c9a84c', fontSize: 14, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>
        Bookshelf
      </div>
      {items.length === 0 ? (
        <div style={{ color: '#6b5c44', fontSize: 14, fontStyle: 'italic' }}>Shelves gather dust</div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {items.map((item, i) => {
            const isOpen = mode === 'file' && activeFileName === item.filename
            const spineImg = SPELL_BOOK_SRCS[i % SPELL_BOOK_SRCS.length]
            const openImg = i % 2 === 0 ? spellBookOpen1 : spellBookOpen2
            return (
              <img
                key={item.filename}
                src={isOpen ? openImg : spineImg}
                alt={item.title}
                title={item.title}
                style={{ width: isOpen ? 110 : 100, height: 100, objectFit: 'contain', cursor: workspaceSlug ? 'pointer' : 'default' }}
                onClick={() => { if (workspaceSlug) openFile(item.path, workspaceSlug) }}
              />
            )
          })}
        </div>
      )}
    </section>
  )
}

function MemoryScrollZone({ context }: { context: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false)

  return (
    <section aria-label="Memory scroll">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((p) => !p)}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          width: '100%',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
          opacity: expanded ? 1 : undefined,
          transition: 'opacity 0.15s ease',
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '0.8' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = '1' }}
      >
        <img src={memoryScrollImg} alt="" aria-hidden="true" style={{ width: 40, height: 46, objectFit: 'contain', flexShrink: 0, marginTop: 2 }} />
        {!expanded && (
          <p
            style={{
              color: '#9c8a6a',
              fontSize: 13,
              margin: 0,
              fontStyle: 'italic',
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {context || 'No memory recorded'}
          </p>
        )}
        {expanded && (
          <span style={{ color: '#c9a84c', fontSize: 13, fontStyle: 'italic' }}>Memory Scroll ▲</span>
        )}
      </button>

      {expanded && (
        <div
          style={{
            marginTop: 8,
            marginLeft: 32,
            maxHeight: 400,
            overflowY: 'auto',
            background: 'rgba(10, 6, 2, 0.65)',
            border: '1px solid rgba(201,168,76,0.3)',
            borderRadius: 6,
            padding: '10px 12px',
          }}
        >
          <div style={{ color: '#e8d5a3', fontSize: 13, lineHeight: 1.6 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {context || 'No memory recorded'}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </section>
  )
}

function ChestScroll({ pipeline, hasHandoff, workspaceSlug }: { pipeline: Pipeline | null; hasHandoff: boolean; workspaceSlug: string | null }): React.ReactElement {
  const openFile = useDocViewerStore((s) => s.openFile)
  const filled = pipeline !== null && hasHandoff

  function handleClick(): void {
    if (filled && pipeline?.taskList && workspaceSlug) {
      openFile(pipeline.taskList, workspaceSlug)
    }
  }

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: filled && workspaceSlug ? 'pointer' : 'default' }}
      aria-label={filled ? 'Handoff scroll present' : 'Chest empty'}
      onClick={filled && workspaceSlug ? handleClick : undefined}
      role={filled && workspaceSlug ? 'button' : undefined}
      tabIndex={filled && workspaceSlug ? 0 : undefined}
      onKeyDown={(e) => { if (filled && workspaceSlug && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); handleClick() } }}
    >
      <img
        src={filled ? chestFull : chestEmpty}
        alt={filled ? 'Handoff scroll' : 'Empty chest'}
        style={{ width: 52, height: 46, objectFit: 'contain' }}
      />
      <span style={{ color: '#9c8a6a', fontSize: 14, fontStyle: 'italic' }}>
        {filled ? 'Handoff scroll prepared' : 'Awaiting task list'}
      </span>
    </div>
  )
}

function ReadmeBanner({ content, onOpen }: { content: string | null; onOpen: () => void }): React.ReactElement {
  const hasContent = content !== null

  return (
    <div
      role={hasContent ? 'button' : undefined}
      tabIndex={hasContent ? 0 : undefined}
      aria-label={hasContent ? 'Open README' : 'No README found'}
      title={hasContent ? undefined : 'No README found'}
      onClick={hasContent ? onOpen : undefined}
      onKeyDown={(e) => { if (hasContent && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: hasContent ? 'pointer' : 'default',
        opacity: hasContent ? 1 : 0.35,
        transition: 'opacity 0.15s ease',
      }}
    >
      <img
        src={bannerRoyalPurple}
        alt="README"
        style={{ width: 80, height: 'auto', objectFit: 'contain' }}
      />
    </div>
  )
}

function DocsRootBanner({ docsRootExists, onOpen }: { docsRootExists: boolean; onOpen: () => void }): React.ReactElement {
  return (
    <div
      role={docsRootExists ? 'button' : undefined}
      tabIndex={docsRootExists ? 0 : undefined}
      aria-label={docsRootExists ? 'Browse documents' : 'Docs directory not found — try refreshing'}
      title={docsRootExists ? undefined : 'Docs directory not found — try refreshing'}
      onClick={docsRootExists ? onOpen : undefined}
      onKeyDown={(e) => { if (docsRootExists && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen() } }}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: docsRootExists ? 'pointer' : 'default',
        opacity: docsRootExists ? 1 : 0.35,
        transition: 'opacity 0.15s ease',
      }}
    >
      <img
        src={bannerNavyBlue}
        alt="Browse Docs"
        style={{ width: 80, height: 'auto', objectFit: 'contain' }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// WizardsStudy
// ---------------------------------------------------------------------------

export function WizardsStudy({ workspaceSlug }: { workspaceSlug: string | null }): React.ReactElement {
  const workspace = useWorkspaceStore((s) => workspaceSlug ? s.workspaces.find((w) => w.slug === workspaceSlug) : undefined)
  const wsLoading = useWorkspaceStore((s) => s.loading)
  const fetchOne = useWorkspaceStore((s) => s.fetchOne)
  const docViewerClose = useDocViewerStore((s) => s.close)
  const openFolder = useDocViewerStore((s) => s.openFolder)
  const hasSessions = useChannelsStore((s) => {
    if (!workspace) return false
    const normalizedPath = workspace.path.replace(/\/+$/, '')
    return s.sessions.some((sess) => sess.workspaceDir.replace(/\/+$/, '') === normalizedPath)
  })
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  // Fetch fresh workspace data when the Study opens
  useEffect(() => {
    if (workspaceSlug) void fetchOne(workspaceSlug)
  }, [workspaceSlug, fetchOne])

  // Reset doc viewer state when the Study overlay unmounts
  useEffect(() => {
    return () => { docViewerClose() }
  }, [docViewerClose])

  // Terminal session controls
  const sessionState = useTerminalStore((s) => s.sessions[workspaceSlug ?? ''] ?? 'none')
  const terminalOverlayVisible = useTerminalStore((s) => s.overlayVisible[workspaceSlug ?? ''] ?? false)
  const spawnError = useTerminalStore((s) => s.spawnError[workspaceSlug ?? ''] ?? null)
  const { spawn, kill, showOverlay, hideOverlay, clearSpawnError } = useTerminalStore()
  const terminalFontSize = useSettingsStore((s) => s.config?.terminal?.fontSize ?? 14)
  const terminalWorkspaceBounds = useSettingsStore((s) => s.config?.terminal?.windowBounds?.workspace)
  const updateConfig = useSettingsStore((s) => s.updateConfig)

  // README overlay state
  const [readmeOverlayVisible, setReadmeOverlayVisible] = useState(false)

  // Two-tap End Session confirmation state (P15: component-local)
  const [isConfirming, setIsConfirming] = useState(false)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear confirmation timer on unmount (P15)
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current)
    }
  }, [])

  function handleEndSession(): void {
    if (!workspaceSlug) return
    if (isConfirming) {
      if (confirmTimerRef.current !== null) {
        clearTimeout(confirmTimerRef.current)
        confirmTimerRef.current = null
      }
      setIsConfirming(false)
      void kill(workspaceSlug)
    } else {
      setIsConfirming(true)
      confirmTimerRef.current = setTimeout(() => {
        confirmTimerRef.current = null
        setIsConfirming(false)
      }, 3_000)
    }
  }

  if (!workspace) {
    const message = wsLoading
      ? 'Loading workspace…'
      : `Workspace "${workspaceSlug ?? ''}" not found`
    return (
      <div
        ref={dialogRef}
        tabIndex={-1}
        style={{
          width: 1920,
          height: 1080,
          maxWidth: '95%',
          maxHeight: '95%',
          background: '#1e140a',
          border: '2px solid rgba(201,168,76,0.4)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#c9a84c',
          fontFamily: 'serif',
          outline: 'none',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="Wizard's Study"
      >
        <span style={{ color: '#9c8a6a' }}>{message}</span>
      </div>
    )
  }

  const { activePipelines, features, ideationItems, projectContext, status, displayName } = workspace
  const primaryPipeline = activePipelines.find((p) => p.taskList !== null) ?? activePipelines[0] ?? null
  const hasHandoff = primaryPipeline?.taskList !== null && primaryPipeline?.taskList !== undefined

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      style={{ position: 'relative', width: 1920, height: 1080, maxWidth: '95%', maxHeight: '95%', borderRadius: 8, overflow: 'hidden', fontFamily: 'serif', color: '#e8d5a3', outline: 'none' }}
      role="dialog"
      aria-modal="true"
      aria-label={`Wizard's Study — ${displayName}`}
      onKeyDown={(e) => { if (e.key === 'Escape' && readmeOverlayVisible) { e.stopPropagation(); setReadmeOverlayVisible(false) } }}
    >
      {/* Background with weather-driven filter */}
      <img
        src={wizardsStudyBg}
        alt=""
        aria-hidden="true"
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          objectFit: 'cover',
          filter: windowFilter(status),
          transition: 'filter 1.5s ease',
        }}
      />
      {/* Readability overlay */}
      <div
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, background: 'rgba(10, 6, 2, 0.50)', pointerEvents: 'none' }}
      />

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1, padding: '18px 22px', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {primaryPipeline && (
            <img
              src={shieldSrc(primaryPipeline.pipelineType)}
              alt={primaryPipeline.pipelineType}
              style={{ width: 40, height: 48, objectFit: 'contain' }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 22, color: '#c9a84c' }}>{displayName}</h2>
            <p style={{ margin: 0, fontSize: 12, color: '#9c8a6a' }}>{workspace.path}</p>
          </div>
          {/* Session controls — inline with header (A6, A9, A15) */}
          {workspaceSlug && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {sessionState === 'none' && (
                <button
                  onClick={() => void spawn(workspaceSlug)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    backgroundImage: `url(${settingsScrollInactive})`,
                    backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
                    width: 200, height: 48,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}
                  aria-label="Start Session"
                >
                  <span style={{ fontSize: 14, color: '#ff6a00', fontFamily: '"Palatino Linotype", "Book Antiqua", Palatino, serif', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase' as const, textShadow: '0 0 4px rgba(255,80,0,0.9), 0 0 10px rgba(255,120,0,0.6), 0 0 20px rgba(255,60,0,0.3), 0 1px 2px rgba(0,0,0,0.9)', WebkitTextStroke: '0.3px rgba(180,60,0,0.5)' }}>Start Session</span>
                </button>
              )}
              {sessionState === 'starting' && (
                <button
                  disabled
                  style={{
                    background: 'none', border: 'none', cursor: 'not-allowed', padding: 0,
                    backgroundImage: `url(${settingsScrollActive})`,
                    backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
                    width: 200, height: 48,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: 'co-study-pulse 1.5s ease-in-out infinite',
                  }}
                  aria-label="Starting session…"
                >
                  <span style={{ fontSize: 13, color: '#1a0f05', fontFamily: 'serif', fontWeight: 700, textShadow: '0 1px 0 rgba(255,255,255,0.3), 0 0 4px rgba(255,255,255,0.15)' }}>Starting…</span>
                </button>
              )}
              {(sessionState === 'running' || sessionState === 'stopping') && (
                <button
                  onClick={handleEndSession}
                  disabled={sessionState === 'stopping'}
                  style={{
                    background: 'none', border: 'none',
                    cursor: sessionState === 'stopping' ? 'not-allowed' : 'pointer',
                    padding: 0,
                    backgroundImage: `url(${isConfirming ? settingsScrollActive : settingsScrollInactive})`,
                    backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
                    width: 200, height: 48,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    opacity: sessionState === 'stopping' ? 0.5 : 1,
                    filter: isConfirming ? 'drop-shadow(0 0 8px rgba(245,158,11,0.6))' : 'none',
                  }}
                  aria-label={isConfirming ? 'Confirm End Session' : 'End Session'}
                >
                  <span style={isConfirming ? {
                    fontSize: 13, color: '#1a0f05', fontFamily: '"Palatino Linotype", "Book Antiqua", Palatino, serif', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase' as const, textShadow: '0 1px 0 rgba(255,255,255,0.3), 0 0 4px rgba(255,255,255,0.15)',
                  } : {
                    fontSize: 14, color: '#ff6a00', fontFamily: '"Palatino Linotype", "Book Antiqua", Palatino, serif', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase' as const, textShadow: '0 0 4px rgba(255,80,0,0.9), 0 0 10px rgba(255,120,0,0.6), 0 0 20px rgba(255,60,0,0.3), 0 1px 2px rgba(0,0,0,0.9)', WebkitTextStroke: '0.3px rgba(180,60,0,0.5)',
                  }}>
                    {sessionState === 'stopping' ? 'ENDING…' : isConfirming ? 'CONFIRM END?' : 'END SESSION'}
                  </span>
                </button>
              )}
              {sessionState === 'running' && (
                <button
                  onClick={() => terminalOverlayVisible ? hideOverlay(workspaceSlug) : showOverlay(workspaceSlug)}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                    backgroundImage: `url(${terminalOverlayVisible ? settingsScrollActive : settingsScrollInactive})`,
                    backgroundSize: '100% 100%', backgroundRepeat: 'no-repeat',
                    width: 200, height: 48,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    // Attention glow only when overlay hidden — when visible, the terminal itself is the attention surface
                    filter: !terminalOverlayVisible && status === 'attention' ? 'drop-shadow(0 0 12px rgba(245,158,11,0.9))' : terminalOverlayVisible ? 'drop-shadow(0 0 8px rgba(201,168,76,0.4))' : 'none',
                    animation: !terminalOverlayVisible && status === 'attention' ? 'co-attention-pulse 1.5s ease-in-out infinite' : undefined,
                  }}
                  aria-label={terminalOverlayVisible ? 'Hide Session' : 'Show Session'}
                >
                  <span style={terminalOverlayVisible ? {
                    fontSize: 13, color: '#1a0f05', fontFamily: '"Palatino Linotype", "Book Antiqua", Palatino, serif', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase' as const, textShadow: '0 1px 0 rgba(255,255,255,0.3), 0 0 4px rgba(255,255,255,0.15)',
                  } : {
                    fontSize: 14, color: '#ff6a00', fontFamily: '"Palatino Linotype", "Book Antiqua", Palatino, serif', fontWeight: 700, letterSpacing: '1.5px', textTransform: 'uppercase' as const, textShadow: '0 0 4px rgba(255,80,0,0.9), 0 0 10px rgba(255,120,0,0.6), 0 0 20px rgba(255,60,0,0.3), 0 1px 2px rgba(0,0,0,0.9)', WebkitTextStroke: '0.3px rgba(180,60,0,0.5)',
                  }}>
                    {terminalOverlayVisible ? 'HIDE SESSION' : 'SHOW SESSION'}
                  </span>
                </button>
              )}
            </div>
          )}

          <span
            style={{
              fontSize: 14,
              padding: '4px 12px',
              borderRadius: 4,
              border: '1px solid rgba(201,168,76,0.3)',
              color: status === 'active' ? '#c9a84c' : '#9c8a6a',
              textTransform: 'capitalize',
            }}
          >
            {status}
          </span>
        </div>

        {/* Spawn error banner (amendment A4) */}
        {spawnError && workspaceSlug && (
          <div
            style={{
              backgroundColor: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.4)',
              borderRadius: 4,
              padding: '6px 12px',
              color: '#f87171',
              fontSize: 13,
              fontFamily: 'Menlo, Consolas, "Courier New", monospace',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span>{spawnError}</span>
            <button
              onClick={() => clearSpawnError(workspaceSlug)}
              style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 16, padding: '0 4px', lineHeight: 1 }}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        {/* Pipeline track */}
        {activePipelines.length > 0
          ? activePipelines.map((p) => <PipelineTrack key={p.slug} pipeline={p} />)
          : <EmptyPipelineState />
        }

        {/* Main grid: feature board + right column + chat column (always 3-col) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 0.5fr) minmax(180px, 0.5fr) 1fr', gap: 10, flex: 1, minHeight: 0 }}>
          <FeatureBoard features={features} workspaceSlug={workspaceSlug} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Bookshelf items={ideationItems.slice(0, 8)} workspaceSlug={workspaceSlug} />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <ReadmeBanner content={workspace.readmeContent} onOpen={() => setReadmeOverlayVisible(true)} />
              <DocsRootBanner docsRootExists={workspace.docsRootExists} onOpen={() => { if (workspaceSlug) openFolder(workspace.docsRoot, workspaceSlug) }} />
            </div>
            <MemoryScrollZone context={projectContext} />
          </div>

          {/* Chat column — always visible */}
          {(
            <div
              data-testid="chat-panel-container"
              style={{
                background: 'rgba(10,6,2,0.6)',
                border: status === 'attention'
                  ? '1px solid rgba(245,158,11,0.6)'
                  : '1px solid rgba(201,168,76,0.2)',
                boxShadow: status === 'attention'
                  ? '0 0 12px rgba(245,158,11,0.3), inset 0 0 8px rgba(245,158,11,0.1)'
                  : 'none',
                transition: 'border-color 0.3s ease, box-shadow 0.3s ease',
                borderRadius: 6,
                display: 'flex',
                flexDirection: 'column',
                minHeight: 0,
                overflow: 'hidden',
              }}
            >
              {workspaceSlug && hasSessions ? (
                <>
                  <ChatPanel workspaceSlug={workspaceSlug} className="flex-1 min-h-0" />
                  <PermissionScroll workspaceSlug={workspaceSlug} />
                </>
              ) : (
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    color: '#6b5a40',
                  }}
                >
                  {/* Quill pen icon */}
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M20.71 4.04c.39-.39.39-1.02 0-1.41-.39-.39-1.02-.39-1.41 0L12 9.93 9.07 7l-.71.71 2.93 2.93-7.78 7.78-.01.01A2 2 0 0 0 3 19.99V21h1.01a2 2 0 0 0 1.41-.59l7.78-7.78 2.93 2.93.71-.71-2.93-2.93 7.8-7.87z"
                      fill="currentColor"
                    />
                  </svg>
                  <span style={{ fontSize: 12, fontFamily: 'serif', textAlign: 'center', lineHeight: 1.4, padding: '0 12px' }}>
                    No active sessions
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Chest scroll */}
        <ChestScroll pipeline={primaryPipeline} hasHandoff={hasHandoff} workspaceSlug={workspaceSlug} />
      </div>

      {/* Session control animations */}
      <style>{`
        @keyframes co-study-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
        @keyframes co-attention-pulse { 0%, 100% { filter: drop-shadow(0 0 6px rgba(245,158,11,0.6)); } 50% { filter: drop-shadow(0 0 14px rgba(245,158,11,1.0)); } }
      `}</style>

      {/* README overlay */}
      {readmeOverlayVisible && workspace.readmeContent !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="README"
          data-testid="readme-overlay"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            background: 'rgba(10, 6, 2, 0.85)',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 8,
            overflow: 'hidden',
          }}
          onKeyDown={(e) => { if (e.key === 'Escape') setReadmeOverlayVisible(false) }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 18px', borderBottom: '1px solid rgba(201,168,76,0.3)', flexShrink: 0 }}>
            <span style={{ color: '#c9a84c', fontSize: 16, textTransform: 'uppercase', letterSpacing: 1 }}>README</span>
            <button
              type="button"
              onClick={() => setReadmeOverlayVisible(false)}
              aria-label="Close README"
              style={{ background: 'none', border: 'none', color: '#9c8a6a', cursor: 'pointer', fontSize: 22, lineHeight: 1, padding: '0 4px' }}
            >
              ×
            </button>
          </div>
          <div
            className="co-prose"
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '16px 20px',
              color: '#e8d5a3',
              fontSize: 14,
              lineHeight: 1.7,
            }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 style={{ color: '#c9a84c' }}>{children}</h1>,
                h2: ({ children }) => <h2 style={{ color: '#c9a84c' }}>{children}</h2>,
                h3: ({ children }) => <h3 style={{ color: '#c9a84c' }}>{children}</h3>,
                h4: ({ children }) => <h4 style={{ color: '#c9a84c' }}>{children}</h4>,
                strong: ({ children }) => <strong style={{ color: '#e8d5a3' }}>{children}</strong>,
                a: ({ href, children }) => (
                  <a
                    href={href}
                    style={{ color: '#c9a84c', textDecoration: 'underline' }}
                    onClick={(e) => e.preventDefault()}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {workspace.readmeContent}
            </ReactMarkdown>
          </div>
        </div>
      )}

      {/* TerminalOverlay — mounts when overlay is visible and session is active */}
      {workspaceSlug && terminalOverlayVisible && (sessionState === 'starting' || sessionState === 'running') && (
        <TerminalOverlay
          workspaceSlug={workspaceSlug}
          workspaceName={displayName}
          fontSize={terminalFontSize}
          windowBounds={terminalWorkspaceBounds}
          onBoundsChange={(bounds) => {
            void updateConfig({ terminal: { windowBounds: { workspace: bounds } } } as Parameters<typeof updateConfig>[0])
          }}
          onHide={() => hideOverlay(workspaceSlug)}
        />
      )}

      {/* Doc viewer overlay — renders null when mode=closed, otherwise overlays the dashboard */}
      <RealmDocViewer />
    </div>
  )
}
