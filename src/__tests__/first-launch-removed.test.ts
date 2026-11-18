import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// The first-launch wizard is gone (#0039 4.5, TRD §4.7): an empty registry is the Dashboard's empty prompt, so there is
// no page, no route and no redirect target to maintain. `App.tsx` mounts its router internally, so the route table is
// checked at the source: a `/first-launch` route or import coming back fails here.
// ---------------------------------------------------------------------------

const renderer = path.resolve(__dirname, '../renderer')

describe('first-launch removal', () => {
  it('the page file no longer exists', () => {
    expect(fs.existsSync(path.join(renderer, 'pages', 'FirstLaunch.tsx'))).toBe(false)
  })

  it('App.tsx has no first-launch route or import', () => {
    const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8')
    expect(app).not.toMatch(/first-launch/i)
    expect(app).not.toMatch(/FirstLaunch/)
  })

  it('App.tsx routes "/" to the Dashboard, which shows the empty prompt itself', () => {
    const app = fs.readFileSync(path.join(renderer, 'App.tsx'), 'utf8')
    expect(app).toMatch(/<Route path="\/" element=\{<Dashboard \/>\} \/>/)
  })
})
