import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
    // Step 4.1's performance harness builds a real 50k-file git repo and
    // exercises real fs/git operations against it — far too slow for every
    // PR, and mixing its timing assertions into the normal parallel suite is
    // exactly what makes them flake under load. Run only via `pnpm test:perf`
    // (vitest.perf.config.ts), never as part of this default config.
    // Step 2.4's Docker-gated suite builds a real image and needs a local
    // Docker daemon and network egress — run only via `pnpm test:docker`
    // (vitest.docker.config.ts), with CO_DOCKER_TESTS=1 set.
    exclude: ['src/__tests__/perf/**', 'src/__tests__/docker/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/main/**', 'src/preload/**', 'src/renderer/**'],
      exclude: ['src/__tests__/**', 'src/renderer/main.tsx', 'src/preload/index.ts', 'src/main/types/**', 'src/**/*.d.ts', 'src/renderer/styles/**', 'src/**/index.ts', 'src/renderer/components/terminal/**'],
      thresholds: { statements: 85 },
    },
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@preload': resolve(__dirname, 'src/preload'),
    },
  },
})
