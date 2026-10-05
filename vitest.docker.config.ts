import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// ---------------------------------------------------------------------------
// vitest.docker.config.ts — Step 2.4's Docker-gated integration suite (TRD
// §7.2). Mirrors vitest.perf.config.ts's shape: a separate config, run only
// via `pnpm test:docker`, never part of `pnpm test`/CI (real image builds
// and real network egress checks are far too slow and environment-dependent
// for every PR — the whole reason this suite exists is to validate the real
// Docker/network behaviour the unit tests can only assume). Every file in
// `src/__tests__/docker/` starts with
// `describe.skipIf(!process.env.CO_DOCKER_TESTS || !dockerOk())`, so running
// this config without CO_DOCKER_TESTS=1 collects the files but skips every
// test in them — the opt-in is the env var, not just this config's existence.
// vitest.config.ts's own `exclude` keeps this directory out of the default run.
// ---------------------------------------------------------------------------

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // unit tests only need the path string; never download Electron
    env: { ELECTRON_OVERRIDE_DIST_PATH: process.env.ELECTRON_OVERRIDE_DIST_PATH ?? resolve(__dirname, 'node_modules/.cache/no-electron') },
    include: ['src/__tests__/docker/**/*.test.ts'],
    // Real docker build + network calls — the default 5s test timeout is
    // nowhere near enough for an image build or a firewall self-check.
    testTimeout: 5 * 60_000,
    hookTimeout: 5 * 60_000,
    // Every file in this suite builds/tags the SAME `claude-sandbox:test`
    // image and creates real containers with real published ports. Running
    // files in parallel (vitest's default) makes concurrent `docker build`
    // calls serialize against each other unpredictably (observed: one
    // file's beforeAll exceeded the 5-minute hook timeout waiting behind
    // another's build) and lets two files' independently-seeded port
    // counters collide on the same host port. One file at a time avoids both.
    fileParallelism: false,
    // No coverage here — this suite exists to validate real Docker/network
    // behavior, not to contribute to the project's statement-coverage gate.
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@preload': resolve(__dirname, 'src/preload'),
    },
  },
})
