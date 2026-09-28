#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// check-bundle.mjs — CI bundle-size and CSP-identity gate (plan.md §1.21,
// NFR-2, NFR-4; Be H2, Sec M-4).
//
// Run after `pnpm build`. Asserts:
//   1. the renderer's entry chunk is at most baseline.entryBytes + 3 KB;
//   2. the entry chunk contains none of @codemirror, cm-editor,
//      unifiedMergeView (CodeMirror must be lazy-loaded, never in the entry);
//   3. the CSP is byte-identical to origin/main in both places it lives —
//      src/renderer/index.html's <meta> tag, and setupCSP() in
//      src/main/index.ts. The CSP is the only thing blocking gray-matter's
//      bundled eval engine today (Sec M-4), so it must never drift silently.
//
// The entry chunk is found the reliable way: by reading
// out/renderer/index.html's own <script type="module" src="..."> tag,
// never by globbing "index-*.js" — more than one emitted chunk can
// coincidentally start with "index-" (a shared/vendor chunk, for example),
// and only the one actually referenced by the page is "the entry chunk".
// ---------------------------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUDGET_SLACK_BYTES = 3072
const FORBIDDEN_STRINGS = ['@codemirror', 'cm-editor', 'unifiedMergeView']

class BundleGateError extends Error {}

function fail(message) {
  throw new BundleGateError(message)
}

function findEntryChunk() {
  const htmlPath = path.join(ROOT, 'out', 'renderer', 'index.html')
  let html
  try {
    html = fs.readFileSync(htmlPath, 'utf-8')
  } catch {
    return fail(`Could not read ${htmlPath} — did "pnpm build" run first?`)
  }
  const match = html.match(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/)
  if (!match) return fail(`No <script type="module" src="..."> tag found in ${htmlPath}`)
  const entryPath = path.resolve(path.dirname(htmlPath), match[1])
  if (!fs.existsSync(entryPath)) return fail(`Entry chunk ${entryPath} (referenced by index.html) does not exist`)
  return entryPath
}

function checkEntrySize(entryPath) {
  const baselinePath = path.join(ROOT, 'scripts', 'bundle-baseline.json')
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'))
  const actualBytes = fs.statSync(entryPath).size
  const budget = baseline.entryBytes + BUDGET_SLACK_BYTES
  if (actualBytes > budget) {
    fail(
      `Entry chunk grew too much: ${actualBytes} bytes > budget ${budget} bytes ` +
        `(baseline ${baseline.entryBytes} + ${BUDGET_SLACK_BYTES} slack, measured on ${baseline.measuredOn}).\n` +
        `  ${path.relative(ROOT, entryPath)}`,
    )
  }
  console.log(`OK  entry size ${actualBytes} bytes <= budget ${budget} bytes`)
}

function checkNoCodeMirrorInEntry(entryPath) {
  const content = fs.readFileSync(entryPath, 'utf-8')
  const found = FORBIDDEN_STRINGS.filter((s) => content.includes(s))
  if (found.length > 0) {
    fail(
      `Entry chunk contains forbidden string(s): ${found.join(', ')}.\n` +
        `  CodeMirror must be lazy-loaded (a separate chunk), never in the entry.\n` +
        `  ${path.relative(ROOT, entryPath)}`,
    )
  }
  console.log('OK  entry chunk contains no CodeMirror strings')
}

function gitShowMain(relPath) {
  try {
    return execFileSync('git', ['show', `origin/main:${relPath}`], { cwd: ROOT, encoding: 'utf-8' })
  } catch (err) {
    return fail(`Could not read origin/main:${relPath} (${err.message})`)
  }
}

function extractCspMeta(html) {
  const match = html.match(/<meta http-equiv="Content-Security-Policy"[^>]*\/?>/)
  if (!match) return fail('No <meta http-equiv="Content-Security-Policy"> tag found')
  return match[0]
}

/** Extracts `function setupCSP(...) { ... }` verbatim, up to its own
 *  matching closing brace, by walking brace depth from its opening brace. */
function extractSetupCsp(source) {
  const marker = 'function setupCSP('
  const start = source.indexOf(marker)
  if (start === -1) return fail('No "function setupCSP(" found')
  const braceStart = source.indexOf('{', start)
  if (braceStart === -1) return fail('setupCSP has no opening brace')
  let depth = 0
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return fail('setupCSP has no matching closing brace')
}

function checkCspIdentity() {
  const indexHtmlRel = 'src/renderer/index.html'
  const mainIndexRel = 'src/main/index.ts'

  const currentHtml = fs.readFileSync(path.join(ROOT, indexHtmlRel), 'utf-8')
  const mainHtml = gitShowMain(indexHtmlRel)
  const currentCspMeta = extractCspMeta(currentHtml)
  const mainCspMeta = extractCspMeta(mainHtml)
  if (currentCspMeta !== mainCspMeta) {
    fail(
      `${indexHtmlRel}'s CSP <meta> tag differs from origin/main:\n` +
        `  main:    ${mainCspMeta}\n` +
        `  current: ${currentCspMeta}`,
    )
  }
  console.log(`OK  ${indexHtmlRel} CSP <meta> is byte-identical to origin/main`)

  const currentSource = fs.readFileSync(path.join(ROOT, mainIndexRel), 'utf-8')
  const mainSource = gitShowMain(mainIndexRel)
  const currentSetupCsp = extractSetupCsp(currentSource)
  const mainSetupCsp = extractSetupCsp(mainSource)
  if (currentSetupCsp !== mainSetupCsp) {
    fail(
      `${mainIndexRel}'s setupCSP() differs from origin/main:\n` +
        `--- origin/main ---\n${mainSetupCsp}\n` +
        `--- current ---\n${currentSetupCsp}`,
    )
  }
  console.log(`OK  ${mainIndexRel} setupCSP() is byte-identical to origin/main`)
}

function main() {
  try {
    const entryPath = findEntryChunk()
    checkEntrySize(entryPath)
    checkNoCodeMirrorInEntry(entryPath)
    checkCspIdentity()
  } catch (err) {
    if (err instanceof BundleGateError) {
      console.error(`\nBundle gate FAILED:\n${err.message}\n`)
      process.exitCode = 1
      return
    }
    throw err
  }
  console.log('\nBundle gate passed.')
}

main()
