import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { WorkspaceParserService } from '@main/services/workspace-parser'
import { DocsParserService } from '@main/services/docs-parser'
import { resetActiveProfileForTests, setActiveProfile, type Profile } from '@main/services/app-home'
import { createWorkspaceRuntime, type RuntimeAppState } from '@main/services/workspace-runtime'
import type { GamificationState } from '@main/types/gamification'

// ---------------------------------------------------------------------------
// startup.perf.test.ts — registry startup cost (#0039, steps 0.2 / 2.3 / 3.7).
//
// Before the registry, startup scanned `$HOME` for `.rix` folders and parsed every hit before READY. That path
// no longer exists, so this test no longer measures against it. The numbers that matter now:
//
//  - `runtime.init()` is all startup waits for: it returns at once with `checking` stubs.
//  - The background probes + parses (the work that used to block READY) settle in proportion.
//
// BASELINE_MS is kept as the documented reference: the median of 5 runs of the OLD blocking path (a `$HOME`
// scan of 50 `.rix` folders plus a per-workspace parse, including readme and repo-root status), measured on
// "lappy" (linux x64), quiet, on 2026-11-16: 12.5 ms (it reads 40+ ms when other processes are busy, which is
// why every bound below is fastest-of-N and absolute or relative to it, never tight). An earlier narrower
// composition read 32.4 ms at commit e691dd9 (2026-11-15).
//
// Registry startup on the same machine, fastest of 5: `init()` about 0.2 ms; all 50 workspaces settle (probed
// and parsed in the background) in about 23 ms.
//
// Run via `pnpm test:perf` (excluded from the default suite).
// ---------------------------------------------------------------------------

const WORKSPACE_COUNT = 50
const RUNS = 5
/** Median of 5 runs, ms, of the old blocking `$HOME` scan + parse, on "lappy" (quiet) on 2026-11-16. A reference, not measured here. */
const BASELINE_MS = 12.5
/** `init()` must return at once: this absolute bound is generous for noise and still catches a probe that blocks it. */
const INIT_BOUND_MS = 50
/** Fully settled (probed and parsed in the background): in proportion to the old blocking path. */
const SETTLED_BOUND_MS = Math.max(BASELINE_MS * 8, 250)
/** The plan's outer cap (BE H-6). */
const OUTER_CAP_MS = Math.max(BASELINE_MS * 1.5, 2_000)

function buildHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'co-startup-perf-'))
  for (let i = 0; i < WORKSPACE_COUNT; i++) {
    const ws = path.join(home, 'projects', `ws-${i}`)
    const rix = path.join(ws, '.rix')
    fs.mkdirSync(path.join(rix, 'pipelines'), { recursive: true })
    fs.mkdirSync(path.join(ws, 'docs', 'IN_PROGRESS'), { recursive: true })
    fs.writeFileSync(
      path.join(rix, 'memory.md'),
      '# Memory\n\n## Settings\n- docs_root: docs\n- next_feature_id: 3\n\n## Project Context\nA project.\n\n## Backlog\n- item\n',
    )
    fs.writeFileSync(
      path.join(rix, 'history.md'),
      '## Feature A -- 2024-01-15\n- **Pipeline**: feature\n- **Gates passed**: 3\n- **Fix cycles**: 1\n',
    )
    fs.writeFileSync(path.join(rix, 'pipelines', 'feat-a.md'), '- **Feature**: A\n- **Status**: running\n')
    fs.writeFileSync(path.join(ws, 'docs', 'IN_PROGRESS', 'plan.md'), '# Plan\n')
  }
  return home
}

function profileFor(home: string): Profile {
  return {
    name: 'perf',
    home: path.join(home, '.corner-office'),
    homeDisplay: '~/.corner-office/profiles/perf',
    userDataDir: null,
    configDir: path.join(home, '.config', 'corner-office'),
    configDirDisplay: '~/.config/corner-office',
    logFile: null,
    debugPort: null,
    claudeHome: path.join(home, '.claude'),
    discoveryRoots: [home],
    warning: null,
  }
}

describe('registry startup', () => {
  let home: string

  beforeAll(() => {
    home = buildHome()
    resetActiveProfileForTests()
    setActiveProfile(profileFor(home))
  })

  afterAll(() => {
    resetActiveProfileForTests()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it(`init() of ${WORKSPACE_COUNT} workspaces returns at once, and everything settles in proportion`, { timeout: 120_000 }, async () => {
    const entries = Array.from({ length: WORKSPACE_COUNT }, (_, i) => {
      const wsPath = fs.realpathSync(path.join(home, 'projects', `ws-${i}`))
      return {
        id: `ws-${i}`,
        path: wsPath,
        selectedPath: wsPath,
        displayName: null,
        docsRoot: null,
        hidden: false,
        source: 'discovered' as const,
        addedAt: '2026-01-01T00:00:00.000Z',
      }
    })

    const initRuns: number[] = []
    const settledRuns: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const state: RuntimeAppState = {
        workspaces: new Map(),
        gamificationState: { velocity: {}, streak: {}, workspaceLevels: {} } as unknown as GamificationState,
      }
      const runtime = createWorkspaceRuntime({ appState: state, parser: new WorkspaceParserService(), docsParser: new DocsParserService(), push: () => {} })
      const start = performance.now()
      await runtime.init(entries)
      initRuns.push(performance.now() - start)
      // Right after init, every entry is a `checking` stub: startup did not wait for a single probe.
      expect([...state.workspaces.values()].every((w) => w.availability === 'checking')).toBe(true)
      await runtime.settled()
      settledRuns.push(performance.now() - start)
      expect([...state.workspaces.values()].filter((w) => w.availability === 'ok')).toHaveLength(WORKSPACE_COUNT)
    }

    // Fastest of RUNS: contention can only slow a run down, so the fastest is the real cost.
    const initFastest = Math.min(...initRuns)
    const settledFastest = Math.min(...settledRuns)
    process.stdout.write(
      `[startup.perf] registry init returned in ${initFastest.toFixed(1)} ms, settled in ${settledFastest.toFixed(1)} ms (fastest of ${RUNS}; old blocking path baseline median ${BASELINE_MS} ms)\n`,
    )
    expect(initFastest).toBeLessThan(INIT_BOUND_MS)
    expect(settledFastest).toBeLessThan(SETTLED_BOUND_MS)
    expect(settledFastest).toBeLessThan(OUTER_CAP_MS)
  })
})
