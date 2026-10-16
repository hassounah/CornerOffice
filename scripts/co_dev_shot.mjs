#!/usr/bin/env node
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

// ---------------------------------------------------------------------------
// co_dev_shot.mjs — screenshot or read text from the headless dev app over CDP (#0038, TRD §3.8).
//
// Uses chromium.connectOverCDP from the existing @playwright/test: no browser is downloaded.
// stdout carries the result (screenshot path, text or eval JSON); stderr carries diagnostics.
// ---------------------------------------------------------------------------

/** Keep in sync with PROFILE_NAME_RE in src/main/services/app-home.ts (a test pins them equal). */
export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export const EXIT = { OK: 0, NO_CONNECTION: 2, EVAL_THREW: 3, TIMEOUT: 4, BAD_ARGS: 64 }

const DEFAULT_PORT = 9222
const DEFAULT_TIMEOUT_MS = 15_000
const NETWORK_IDLE_MS = 2_000

export const HELP = `Usage: node scripts/co_dev_shot.mjs [options]

Screenshot the dev app, or read it, over CDP on 127.0.0.1.

Options:
  --port N       CDP port (default ${DEFAULT_PORT})
  --out PATH     screenshot path (default ~/.corner-office/profiles/$PROFILE/shots/<ISO-time>.png)
  --text         print document.body.innerText instead of taking a screenshot
  --eval EXPR    evaluate EXPR in the page and print the JSON result
  --timeout MS   overall wait for connect and load (default ${DEFAULT_TIMEOUT_MS})
  --help         show this help

Environment:
  PROFILE        profile name for the default output path (default dev)

Output: stdout carries the screenshot path, the text or the eval result.
        stderr carries diagnostics and the page's console errors.

Exit codes: 0 ok; 2 no connection or no page; 3 eval threw; 4 timeout; 64 bad arguments.
`

export class UsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UsageError'
  }
}

function intOption(flag, raw, min, max) {
  const n = /^\d+$/.test(raw ?? '') ? Number(raw) : NaN
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${flag} needs an integer from ${min} to ${max}, got "${raw ?? ''}"`)
  }
  return n
}

/** Parse argv (without node and the script) and env. Throws UsageError on bad input. */
export function parseArgs(argv, env = {}) {
  const opts = { help: false, port: DEFAULT_PORT, out: null, text: false, eval: null, timeout: DEFAULT_TIMEOUT_MS, profile: 'dev' }
  const profile = env.PROFILE === undefined || env.PROFILE === '' ? 'dev' : env.PROFILE
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new UsageError(`PROFILE="${profile}" is invalid. Use 1-32 lowercase letters, digits or '-', starting with a letter or digit.`)
  }
  opts.profile = profile

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new UsageError(`${arg} needs a value`)
      return next
    }
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--text':
        opts.text = true
        break
      case '--port':
        opts.port = intOption('--port', value(), 1, 65535)
        break
      case '--timeout':
        opts.timeout = intOption('--timeout', value(), 1, 600_000)
        break
      case '--out':
        opts.out = value()
        break
      case '--eval':
        opts.eval = value()
        break
      default:
        throw new UsageError(`unknown option "${arg}"`)
    }
  }
  if (opts.text && opts.eval !== null) throw new UsageError('--text and --eval cannot be combined')
  return opts
}

/** Index of the first app page: neither devtools:// nor about:blank. -1 when there is none. */
export function pickPage(urls) {
  return urls.findIndex((u) => !u.startsWith('devtools://') && u !== 'about:blank')
}

/** `<home>/.corner-office/profiles/<profile>/shots/<ISO-time>.png`, with ':' replaced for file-name safety. */
export function defaultOutPath(profile, now, home = os.homedir()) {
  const stamp = now.toISOString().replace(/:/g, '-')
  return path.join(home, '.corner-office', 'profiles', profile, 'shots', `${stamp}.png`)
}

/** Map a thrown error to an exit code. The error may carry an explicit `exitCode`. */
export function exitCodeFor(error) {
  if (error instanceof UsageError) return EXIT.BAD_ARGS
  if (error && typeof error === 'object' && 'exitCode' in error && typeof error.exitCode === 'number') return error.exitCode
  if (error && typeof error === 'object' && error.name === 'TimeoutError') return EXIT.TIMEOUT
  return EXIT.NO_CONNECTION
}

/** Drop C0 (except \n and \t), DEL and C1 control characters: page text must not drive the user's terminal. */
export function stripControl(text) {
  let out = ''
  for (const ch of String(text)) {
    const c = ch.codePointAt(0)
    const control = c < 0x20 ? c !== 0x0a && c !== 0x09 : c >= 0x7f && c <= 0x9f
    if (!control) out += ch
  }
  return out
}

function fail(exitCode, message) {
  return Object.assign(new Error(message), { exitCode })
}

async function run(opts) {
  const endpoint = `http://127.0.0.1:${opts.port}`
  let browser
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: opts.timeout })
  } catch (err) {
    throw err?.name === 'TimeoutError' ? err : fail(EXIT.NO_CONNECTION, `cannot connect to ${endpoint}: ${err?.message ?? err}`)
  }
  try {
    const pages = browser.contexts().flatMap((c) => c.pages())
    const index = pickPage(pages.map((p) => p.url()))
    if (index < 0) throw fail(EXIT.NO_CONNECTION, `connected to ${endpoint} but found no app page`)
    const page = pages[index]

    page.on('console', (msg) => {
      if (msg.type() === 'error') process.stderr.write(`[console.error] ${stripControl(msg.text())}\n`)
    })
    page.on('pageerror', (err) => process.stderr.write(`[pageerror] ${stripControl(err.message)}\n`))

    await page.waitForLoadState('load', { timeout: opts.timeout })
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_MS }).catch(() => undefined)

    if (opts.eval !== null) {
      let result
      try {
        result = await page.evaluate(opts.eval)
      } catch (err) {
        throw fail(EXIT.EVAL_THREW, `--eval threw: ${err?.message ?? err}`)
      }
      process.stdout.write(`${stripControl(JSON.stringify(result) ?? 'null')}\n`)
    } else if (opts.text) {
      process.stdout.write(`${stripControl(await page.evaluate('document.body.innerText'))}\n`)
    } else {
      const out = opts.out ?? defaultOutPath(opts.profile, new Date())
      fs.mkdirSync(path.dirname(out), { recursive: true })
      await page.screenshot({ path: out })
      process.stdout.write(`${out}\n`)
    }
  } finally {
    // The browser is the running app: disconnect, never close it.
    await browser.close().catch(() => undefined)
  }
}

export async function main(argv, env) {
  try {
    const opts = parseArgs(argv, env)
    if (opts.help) {
      process.stdout.write(HELP)
      return EXIT.OK
    }
    await run(opts)
    return EXIT.OK
  } catch (err) {
    process.stderr.write(`co_dev_shot: ${err?.message ?? err}\n`)
    if (err instanceof UsageError) process.stderr.write('Run with --help for usage.\n')
    return exitCodeFor(err)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env)
}
