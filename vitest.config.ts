import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.ts', 'src/__tests__/**/*.test.tsx'],
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
