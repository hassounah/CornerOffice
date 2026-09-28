import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { YamlContent } from '../../../renderer/components/docviewer/YamlContent'

// ---------------------------------------------------------------------------
// YamlContent is a pure component (TRD §3.6.7, H-U3): no store access, no
// guard, no Back button. These tests exercise it directly, independent of
// the YamlViewer wrapper (already covered in docviewer-components.test.tsx).
// ---------------------------------------------------------------------------

describe('YamlContent — parsed entries', () => {
  it('renders flat key-value entries', () => {
    render(<YamlContent content={'name: Alice\nage: 30'} />)
    expect(screen.getByText('name')).toBeDefined()
    expect(screen.getByText('Alice')).toBeDefined()
    expect(screen.getByText('age')).toBeDefined()
    expect(screen.getByText('30')).toBeDefined()
  })

  it('renders nested objects as parent nodes with indented children', () => {
    render(<YamlContent content={'person:\n  name: Bob\n  age: 25'} />)
    expect(screen.getByText('person')).toBeDefined()
    expect(screen.getByText('Bob')).toBeDefined()
    expect(screen.getByText('25')).toBeDefined()
  })

  it('renders null and boolean values with formatValue', () => {
    render(<YamlContent content={'a: null\nb: true\nc: false'} />)
    expect(screen.getByText('null')).toBeDefined()
    expect(screen.getByText('true')).toBeDefined()
    expect(screen.getByText('false')).toBeDefined()
  })

  it('renders array entries with bracket indices', () => {
    const { container } = render(<YamlContent content={'items:\n  - one\n  - two'} />)
    expect(container.textContent).toContain('items[0]')
    expect(container.textContent).toContain('one')
    expect(container.textContent).toContain('items[1]')
    expect(container.textContent).toContain('two')
  })

  it('renders an array of objects as parent nodes with indented children', () => {
    const { container } = render(
      <YamlContent content={'items:\n  - name: a\n    n: 1\n  - name: b\n    n: 2'} />
    )
    expect(container.textContent).toContain('items[0]')
    expect(container.textContent).toContain('a')
    expect(container.textContent).toContain('items[1]')
    expect(container.textContent).toContain('b')
  })
})

describe('YamlContent — bare scalar top-level document', () => {
  it('a top-level plain-string document has no entries — shows "Empty document"', () => {
    render(<YamlContent content="just a string, no keys" />)
    expect(screen.getByText('Empty document')).toBeDefined()
  })
})

describe('YamlContent — error fallback', () => {
  it('shows the parse-error notice and the raw content preformatted', () => {
    const raw = ': invalid: [yaml'
    render(<YamlContent content={raw} />)
    expect(screen.getByText('YAML parse error — showing raw content')).toBeDefined()
    expect(screen.getByText(raw)).toBeDefined()
  })
})

describe('YamlContent — empty document', () => {
  it('shows "Empty document" for an empty string', () => {
    render(<YamlContent content="" />)
    expect(screen.getByText('Empty document')).toBeDefined()
  })

  it('shows "Empty document" for a YAML null document ("null")', () => {
    render(<YamlContent content="null" />)
    expect(screen.getByText('Empty document')).toBeDefined()
  })
})

describe('YamlContent — no links, no Back button (pure component)', () => {
  it('never renders an anchor, button-as-link or Back button of its own', () => {
    const { container } = render(<YamlContent content={'name: Alice'} />)
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).not.toContain('Back to folder')
  })
})
