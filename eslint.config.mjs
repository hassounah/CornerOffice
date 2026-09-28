import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// ESLint 10 flat config — replaces .eslintrc.cjs
// Uses .mjs because package.json has no "type": "module"
export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'warn' },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
  // Main process — Node.js globals only
  {
    files: ['src/main/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.es2020 } },
  },
  // Renderer process — browser globals only
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.es2020 } },
  },
  // Preload — both Node.js and browser globals (Electron bridge)
  {
    files: ['src/preload/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.es2020 } },
  },
  // Tests — both globals (test utilities may use Node APIs)
  {
    files: ['src/__tests__/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.es2020 } },
  },
  // CI/dev Node scripts — outside the app bundle. Console output is the
  // whole point of a CLI diagnostic script (e.g. check-bundle.mjs), so
  // no-console's error/warn-only allowlist doesn't apply here.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.es2020 } },
    rules: { 'no-console': 'off' },
  },
  // child_process is banned everywhere except the hardened git runner
  // (Sec M-9): it is the only file allowed to spawn processes, so every
  // other main/preload/renderer file — and any dynamic import() of it — is
  // rejected. Tests are unrestricted (§D-7).
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}', 'src/renderer/**/*.{ts,tsx}'],
    ignores: ['src/main/services/git-runner.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'child_process', message: 'child_process may only be imported in git-runner.ts (Sec M-9).' },
          { name: 'node:child_process', message: 'child_process may only be imported in git-runner.ts (Sec M-9).' },
        ],
      }],
      'no-restricted-syntax': ['error', {
        selector: 'ImportExpression[source.value=/child_process$/]',
        message: 'Dynamic import of child_process may only be used in git-runner.ts (Sec M-9).',
      }],
    },
  },
  { ignores: ['dist/', 'out/', 'release/', 'node_modules/'] },
)
