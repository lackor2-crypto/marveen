// #896: a stuck body scroll lock made a project overview unscrollable until a reload.
// web/app.js has no module system, so this pins the guard in source; the real behaviour is clicked in a browser.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_ROOT } from '../config.js'

const src = readFileSync(join(PROJECT_ROOT, 'web/app.js'), 'utf-8')

describe('page scroll lock guard (#896)', () => {
  it('releases the lock when no modal overlay is showing, and never sets it', () => {
    const i = src.indexOf('function releaseBodyScrollLockIfIdle')
    expect(i).toBeGreaterThan(0)
    const body = src.slice(i, src.indexOf('\n}\n', i))
    expect(body).toContain("document.body.style.overflow = ''")
    expect(body).not.toContain("overflow = 'hidden'")
    expect(body).toContain('modalOverlayShowing()')
  })
  it('watches class/hidden/style changes and page switches', () => {
    expect(src).toMatch(/new MutationObserver\(releaseBodyScrollLockIfIdle\)\.observe\(document\.body[^)]*'class', 'hidden', 'style'/)
    expect(src).toContain("addEventListener('hashchange', releaseBodyScrollLockIfIdle)")
  })
  it('does not treat a fading-in overlay (opacity 0 mid-transition) as closed', () => {
    const i = src.indexOf('function modalOverlayShowing')
    const body = src.slice(i, src.indexOf('\n}\n', i))
    expect(body).not.toContain('opacity')
  })
})
