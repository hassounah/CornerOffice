import React, { useMemo } from 'react'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// YamlContent — shared YAML rendering for the doc viewer and the code
// explorer's Preview (TRD §3.6.7, H-U3). A pure component: no store access,
// no guard calls, no loading/error chrome, no Back button. Renders no links,
// so button-as-link (MarkdownContent's contract) does not apply here.
// ---------------------------------------------------------------------------

export interface YamlContentProps {
  content: string
}

const PARENT_NODE = Symbol('parent-node')

interface YamlEntry {
  key: string
  value: unknown
  depth: number
}

function flattenYaml(obj: unknown, prefix = '', depth = 0): YamlEntry[] {
  const entries: YamlEntry[] = []

  if (obj === null || obj === undefined) {
    if (prefix) entries.push({ key: prefix, value: obj, depth })
    return entries
  }

  if (typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>
    for (const key of Object.keys(record)) {
      const fullKey = prefix ? `${prefix}.${key}` : key
      const val = record[key]
      if (val !== null && typeof val === 'object') {
        entries.push({ key: fullKey, value: PARENT_NODE, depth })
        entries.push(...flattenYaml(val, fullKey, depth + 1))
      } else {
        entries.push({ key: fullKey, value: val, depth })
      }
    }
  } else if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      const fullKey = `${prefix}[${i}]`
      if (item !== null && typeof item === 'object') {
        entries.push({ key: fullKey, value: PARENT_NODE, depth })
        entries.push(...flattenYaml(item, fullKey, depth + 1))
      } else {
        entries.push({ key: fullKey, value: item, depth })
      }
    })
  } else {
    if (prefix) entries.push({ key: prefix, value: obj, depth })
  }

  return entries
}

function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

export function YamlContent({ content }: YamlContentProps): React.ReactElement {
  const { parsed, entries, error } = useMemo(() => {
    try {
      const parsed = yaml.load(content, { schema: yaml.JSON_SCHEMA })
      const entries = flattenYaml(parsed)
      return { parsed, entries, error: null }
    } catch (e) {
      return { parsed: null, entries: [], error: e instanceof Error ? e.message : 'Failed to parse YAML' }
    }
  }, [content])

  // Fall back to preformatted text if parsing fails
  if (error) {
    return (
      <div className="co-card p-4">
        <div className="text-xs text-co-text-muted mb-2">YAML parse error — showing raw content</div>
        <pre className="font-mono text-sm text-co-text-secondary whitespace-pre-wrap break-words">{content}</pre>
      </div>
    )
  }

  // Empty YAML document
  if (parsed === undefined || parsed === null || entries.length === 0) {
    return (
      <div className="co-card p-4">
        <div className="text-sm text-co-text-muted">Empty document</div>
      </div>
    )
  }

  return (
    <div className="co-card p-4">
      <div className="flex flex-col gap-1">
        {entries.map((entry) => (
          <div key={entry.key} className="flex gap-2 py-0.5" style={{ paddingLeft: `${entry.depth * 1}rem` }}>
            <span className="font-mono text-xs text-co-text-muted shrink-0">
              {entry.key.split('.').pop() ?? entry.key}
            </span>
            {entry.value !== PARENT_NODE && (
              <>
                <span className="text-co-text-muted text-xs">:</span>
                <span className="font-mono text-sm text-co-text-secondary break-all">
                  {formatValue(entry.value)}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
