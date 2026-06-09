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
  { ignores: ['dist/', 'out/', 'release/', 'node_modules/'] },
)
