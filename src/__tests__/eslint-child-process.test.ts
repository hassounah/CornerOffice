import { describe, it, expect } from 'vitest'
import path from 'path'
import { ESLint } from 'eslint'

// The child_process ban (Sec M-9): only git-runner.ts may import it, and
// tests are unrestricted (§D-7). This lints in-memory snippets against the
// real eslint.config.mjs so the rule itself — not a copy of it — is tested.

const projectRoot = path.resolve(__dirname, '..', '..')

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({
    cwd: projectRoot,
    overrideConfigFile: path.join(projectRoot, 'eslint.config.mjs'),
  })
  const [result] = await eslint.lintText(code, { filePath: path.join(projectRoot, filePath) })
  return result.messages
}

const staticImport = "import { execFile } from 'child_process'\nexecFile('git', [])\n"
const staticImportNode = "import { execFile } from 'node:child_process'\nexecFile('git', [])\n"
const dynamicImport = "export async function load() {\n  return import('child_process')\n}\n"

describe('eslint child_process restriction (Sec M-9)', () => {
  it('errors on `import ... from "child_process"` in a main service', async () => {
    const messages = await lint(staticImport, 'src/main/services/foo.ts')
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true)
  })

  it('errors on `import ... from "node:child_process"` in a main service', async () => {
    const messages = await lint(staticImportNode, 'src/main/services/foo.ts')
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true)
  })

  it('errors on a dynamic import() of child_process in a main service', async () => {
    const messages = await lint(dynamicImport, 'src/main/services/foo.ts')
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(true)
  })

  it('errors on a static import in preload and renderer files too', async () => {
    const preloadMessages = await lint(staticImport, 'src/preload/foo.ts')
    const rendererMessages = await lint(staticImport, 'src/renderer/utils/foo.ts')
    expect(preloadMessages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true)
    expect(rendererMessages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(true)
  })

  it('does not error on a static import in git-runner.ts', async () => {
    const messages = await lint(staticImport, 'src/main/services/git-runner.ts')
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(false)
  })

  it('does not error on a dynamic import in git-runner.ts', async () => {
    const messages = await lint(dynamicImport, 'src/main/services/git-runner.ts')
    expect(messages.some((m) => m.ruleId === 'no-restricted-syntax')).toBe(false)
  })

  it('does not error in a test file', async () => {
    const messages = await lint(staticImport, 'src/__tests__/x.test.ts')
    expect(messages.some((m) => m.ruleId === 'no-restricted-imports')).toBe(false)
  })
})
