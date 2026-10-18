// #705: the left menu is open by default and stays open after a reload; collapsing it is never persisted.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf8')
const block = app.slice(app.indexOf("document.getElementById('sidebarCollapseBtn')"), app.indexOf('const mobileMenuBtn'))

describe('sidebar default open (#705)', () => {
  it('the collapse block exists', () => {
    expect(block.length).toBeGreaterThan(100)
  })
  it('never stores the collapsed state', () => {
    expect(block).not.toMatch(/localStorage\.setItem|sessionStorage\.setItem/)
  })
  it('drops a stale "collapsed" value left by an older version', () => {
    expect(block).toMatch(/localStorage\.removeItem\(KEY\)/)
  })
  it('starts expanded', () => {
    expect(block).toMatch(/let collapsed = false\s*\n\s*apply\(collapsed\)/)
  })
})
