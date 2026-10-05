import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// vitest.perf.config.ts — Step 4.1's performance harness (TRD §7.4, §9.1).
// A separate config, run only via `pnpm test:perf`: this suite builds a real
// 50k-file git repo and exercises real fs/git operations against it, which
// is far too slow for the default `pnpm test`/CI suite and would contend for
// CPU with it, flaking the timing assertions (the same reason the existing
// fuzzy/tree-model budgets flake under full-suite load). vitest.config.ts's
// own `exclude` keeps this directory out of every other run.
// ---------------------------------------------------------------------------

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // unit tests only need the path string; never download Electron
    env: { ELECTRON_OVERRIDE_DIST_PATH: process.env.ELECTRON_OVERRIDE_DIST_PATH ?? resolve(__dirname, 'node_modules/.cache/no-electron') },
    include: ['src/__tests__/perf/**/*.test.ts'],
    // No coverage here — this suite exists to assert timing budgets, not to
    // contribute to the project's statement-coverage gate.
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@preload': resolve(__dirname, 'src/preload'),
    },
  },
})
