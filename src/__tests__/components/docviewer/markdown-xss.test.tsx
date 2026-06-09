import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'

/**
 * XSS baseline tests for react-markdown.
 *
 * These run against the REAL react-markdown (no mocks) to verify that
 * dangerous HTML is sanitized by default. This file is a HARD GATE for
 * the react-markdown 9→10 upgrade — if any assertion fails, the upgrade
 * must be rolled back.
 */
describe('react-markdown XSS sanitization', () => {
  it('does not render <script> tags', () => {
    const { container } = render(
      <ReactMarkdown>{`Hello <script>alert(1)</script> world`}</ReactMarkdown>,
    )
    expect(container.querySelector('script')).toBeNull()
  })

  it('does not render onerror attributes on img tags', () => {
    const { container } = render(
      <ReactMarkdown>{`<img onerror="alert(1)" src="x">`}</ReactMarkdown>,
    )
    const imgs = container.querySelectorAll('img')
    imgs.forEach((img) => {
      expect(img.getAttribute('onerror')).toBeNull()
    })
    // Verify no element in the DOM has an onerror attribute
    expect(container.querySelector('[onerror]')).toBeNull()
  })

  it('rehypePlugins={[]} means no plugins (no bypass)', () => {
    const { container } = render(
      <ReactMarkdown rehypePlugins={[]}>
        {`Hello <script>alert(1)</script> world`}
      </ReactMarkdown>,
    )
    expect(container.querySelector('script')).toBeNull()
  })

  it('a component callback receives href as string prop', () => {
    let receivedHref: unknown = undefined
    const { container } = render(
      <ReactMarkdown
        components={{
          a: ({ href, children }) => {
            receivedHref = href
            return <span data-testid="link">{children}</span>
          },
        }}
      >
        {`[click me](https://example.com)`}
      </ReactMarkdown>,
    )
    expect(typeof receivedHref).toBe('string')
    expect(receivedHref).toBe('https://example.com')
    expect(container.querySelector('[data-testid="link"]')).not.toBeNull()
  })
})
