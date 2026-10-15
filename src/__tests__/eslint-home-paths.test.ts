import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { ESLint } from 'eslint'

// #0038: the home-path guard (Corner Office / Claude paths only through app-home.ts and
// sandbox-paths.ts) and the CDP-flag guard. Snippets are linted against the real
// eslint.config.mjs, so the rule itself, not a copy of it, is tested.

const projectRoot = path.resolve(__dirname, '..', '..')
const COLD_START_TIMEOUT_MS = 60_000

let eslint: ESLint

async function syntaxErrors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(projectRoot, filePath) })
  return result.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message)
}

beforeAll(async () => {
  eslint = new ESLint({ cwd: projectRoot, overrideConfigFile: path.join(projectRoot, 'eslint.config.mjs') })
  await syntaxErrors('export {}\n', 'src/main/services/foo.ts')
}, COLD_START_TIMEOUT_MS)

const MAIN = 'src/main/services/foo.ts'

describe('home path guard', () => {
  it.each([
    ["path.join(home, '.claude')", "export const a = path.join(home, '.claude')\n"],
    ["'.corner-office'", "export const a = '.corner-office'\n"],
    ['a display template', 'export const a = `~/.corner-office/x`\n'],
    ['a path literal', "export const a = '/home/u/.claude/plugins'\n"],
    ['a template with an expression', 'export const a = `${base}/.claude/x`\n'],
  ])('errors on %s in main code', async (_name, code) => {
    const messages = await syntaxErrors(code, MAIN)
    expect(messages.some((m) => m.includes('coHome()'))).toBe(true)
  })

  it('errors in preload too', async () => {
    expect((await syntaxErrors("export const a = '.claude'\n", 'src/preload/foo.ts')).length).toBeGreaterThan(0)
  })

  it.each(["'.claude.json'", "'claude'", "'.claudeX'", "'x.corner-office-y'"])('does not error on %s', async (literal) => {
    expect(await syntaxErrors(`export const a = ${literal}\n`, MAIN)).toEqual([])
  })

  it.each(['src/main/services/app-home.ts', 'src/main/services/sandbox-paths.ts', 'src/main/agents/claude/descriptor.ts'])(
    'allows the literal in %s',
    async (file) => {
      expect(await syntaxErrors("export const a = '.claude'\n", file)).toEqual([])
    },
  )

  it.each(['src/main/services/git-runner.ts', 'src/main/services/docker-runner.ts'])('still guards %s', async (file) => {
    expect((await syntaxErrors("export const a = '.claude'\n", file)).length).toBeGreaterThan(0)
  })

  it('keeps the child_process dynamic-import ban in the main block', async () => {
    const messages = await syntaxErrors("export const load = () => import('child_process')\n", MAIN)
    expect(messages.some((m) => m.includes('Dynamic import of child_process'))).toBe(true)
  })

  it('does not guard the renderer or tests', async () => {
    expect(await syntaxErrors("export const a = '.claude'\n", 'src/renderer/utils/foo.ts')).toEqual([])
    expect(await syntaxErrors("export const a = '.claude'\n", 'src/__tests__/x.test.ts')).toEqual([])
  })
})

describe('CDP flag guard', () => {
  it.each([
    ["'--remote-allow-origins=*'", "export const a = '--remote-allow-origins=*'\n"],
    ["'--remote-debugging-address=0.0.0.0'", "export const a = '--remote-debugging-address=0.0.0.0'\n"],
    ['a template', 'export const a = `--remote-debugging-address=${x}`\n'],
  ])('errors on %s', async (_name, code) => {
    for (const file of [MAIN, 'src/main/services/docker-runner.ts', 'src/preload/foo.ts', 'src/renderer/utils/foo.ts']) {
      expect((await syntaxErrors(code, file)).some((m) => m.includes('--remote-allow-origins'))).toBe(true)
    }
  })

  it('does not error on remote-debugging-port', async () => {
    expect(await syntaxErrors("export const a = 'remote-debugging-port'\n", MAIN)).toEqual([])
  })

  it('Makefile and scripts contain neither flag', () => {
    const files = [path.join(projectRoot, 'Makefile')]
    const scriptsDir = path.join(projectRoot, 'scripts')
    for (const name of fs.readdirSync(scriptsDir)) files.push(path.join(scriptsDir, name))
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/remote-allow-origins|remote-debugging-address/)
    }
  })
})

describe('env-read grep (security L1)', () => {
  const NAMES = /CORNER_OFFICE_(SANDBOX|PROFILE|DEBUG_PORT)/

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('the bare env names appear in src/main and src/preload only in app-home.ts and one sandbox-spec.ts line', () => {
    const hits: string[] = []
    for (const dir of ['src/main', 'src/preload']) {
      for (const file of walk(path.join(projectRoot, dir))) {
        const rel = path.relative(projectRoot, file)
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line) => {
            if (NAMES.test(line)) hits.push(`${rel}:${line.trim()}`)
          })
      }
    }
    const outside = hits.filter((h) => !h.startsWith('src/main/services/app-home.ts:'))
    expect(outside).toEqual(["src/main/services/sandbox-spec.ts:'--env', 'CORNER_OFFICE_SANDBOX=1',"])
  })
})
