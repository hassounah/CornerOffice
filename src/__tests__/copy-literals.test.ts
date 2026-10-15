import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// ---------------------------------------------------------------------------
// copy-literals.test.ts (#0037 C7, TRD §4.13, UX-M8)
//
// The renderer must not hard-code an agent's name in user-facing copy that
// applies to every agent: it takes the name from the agent's descriptor
// (`displayName`). This scan fails on the literal "Claude" anywhere in
// src/renderer/** code (comments are ignored), except for the named strings
// below, which are Claude-specific on purpose. Each exception says why, and
// an exception that no longer matches anything fails the test, so the list
// can only shrink or be justified.
// ---------------------------------------------------------------------------

const RENDERER_DIR = path.resolve(__dirname, '..', 'renderer')

/** Strings that stay Claude-specific. Matched as a substring of a code line in that file. */
const ALLOWED: readonly { file: string; text: string; why: string }[] = [
  {
    file: 'utils/sandbox-copy.ts',
    text: 'Update the Corner Office plugin in Claude Code',
    why: 'Channels exist only for Claude, so a rejected channel or outdated plugin is always the Claude plugin.',
  },
  ...[
    'Applies to Claude sessions in this workspace.',
    'That includes using your Claude sign-in',
    'Takes effect when your Claude session next starts.',
    'until your Claude session next starts.',
  ].map((text) => ({
    file: 'utils/sandbox-copy.ts',
    text,
    why: 'Dev app access (#0038 3a) publishes the CDP port of the claude container only, and the copy says so on purpose.',
  })),
  {
    file: 'components/channels/ChatPanel.tsx',
    text: 'Message Claude…',
    why: 'Chat runs over a session channel, which only Claude has; the panel is hidden for agents without channels.',
  },
  {
    file: 'components/sandbox/SandboxSettingsPanel.tsx',
    text: 'newer Claude Code',
    why: 'A rebuild pulls the latest Claude Code; Codex is pinned to a reviewed release and does not move.',
  },
  {
    file: 'components/settings/PluginStatus.tsx',
    text: 'Claude Code',
    why: 'This is the Claude plugin row (install commands, hook status); other agents render through AgentPluginRow.',
  },
]

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listSourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

/** The code on a line: block-comment text and trailing `// ...` comments removed; a comment-only line is empty. */
function codeOf(line: string, inBlockComment: { on: boolean }): string {
  let rest = line
  let out = ''
  while (rest.length > 0) {
    if (inBlockComment.on) {
      const end = rest.indexOf('*/')
      if (end === -1) return out
      inBlockComment.on = false
      rest = rest.slice(end + 2)
      continue
    }
    const start = rest.indexOf('/*')
    if (start === -1) {
      out += rest
      break
    }
    out += rest.slice(0, start)
    inBlockComment.on = true
    rest = rest.slice(start + 2)
  }
  return out.replace(/(^|\s)\/\/\s.*$/, '$1').replace(/^\s*\/\/.*$/, '')
}

interface Hit {
  file: string
  line: number
  code: string
}

function scan(pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of listSourceFiles(RENDERER_DIR)) {
    const block = { on: false }
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const code = codeOf(line, block)
        if (pattern.test(code)) hits.push({ file: path.relative(RENDERER_DIR, file).split(path.sep).join('/'), line: i + 1, code: code.trim() })
      })
  }
  return hits
}

const isAllowed = (hit: Hit): boolean => ALLOWED.some((a) => a.file === hit.file && hit.code.includes(a.text))

describe('the "Claude" literal scan over src/renderer', () => {
  const hits = scan(/Claude/)

  it('finds the allowed strings (the scan is looking at the right files)', () => {
    expect(hits.length).toBeGreaterThan(0)
  })

  it('has no hard-coded "Claude" outside the named exceptions', () => {
    const offenders = hits.filter((h) => !isAllowed(h)).map((h) => `${h.file}:${h.line}  ${h.code}`)
    expect(offenders).toEqual([])
  })

  it.each(ALLOWED.map((a) => [a.file, a.text, a] as const))('the exception "%s" / "%s" still matches something', (_file, _text, allowed) => {
    expect(hits.some((h) => h.file === allowed.file && h.code.includes(allowed.text))).toBe(true)
  })

  it('gives every exception a reason', () => {
    for (const a of ALLOWED) expect(a.why.length).toBeGreaterThan(20)
  })
})

describe('the codeOf helper', () => {
  it('drops comments and keeps string contents', () => {
    const block = { on: false }
    expect(codeOf("const a = 'x' // Claude here", block).trim()).toBe("const a = 'x'")
    expect(codeOf('  // Claude only in a comment', block).trim()).toBe('')
    expect(codeOf('{/* Claude in JSX comment */} <b>Hi</b>', block).trim()).toBe('{} <b>Hi</b>')
    expect(codeOf("const url = 'https://claude.ai'", block)).toBe("const url = 'https://claude.ai'")
  })

  it('tracks a block comment across lines', () => {
    const block = { on: false }
    expect(codeOf('/** Claude', block).trim()).toBe('')
    expect(codeOf(' * still Claude', block).trim()).toBe('')
    expect(codeOf(' */ const x = 1', block).trim()).toBe('const x = 1')
  })
})

describe('one product name for Codex', () => {
  it('never says "OpenAI Codex" or "Codex CLI" in renderer code', () => {
    const offenders = scan(/OpenAI Codex|Codex CLI|Codex Cli|codex-cli/i).map((h) => `${h.file}:${h.line}  ${h.code}`)
    expect(offenders).toEqual([])
  })
})
