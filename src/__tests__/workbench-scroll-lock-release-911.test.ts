/**
 * #911: the Simple-frame scroll lock (`wb-sh-locked` on the shared <main>) must never outlive the frame. Closing the
 * Workbench to the project overview, or restarting the Projects page, released nothing, so <main> stayed
 * overflow-y: hidden and the overview could not be scrolled. The release is shared, and the CSS holds the lock
 * only while a frame is on the page.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..', 'web')
const js = readFileSync(join(root, 'workbench.js'), 'utf8')
const css = readFileSync(join(root, 'workbench.css'), 'utf8')

describe('frame scroll lock is released with the frame (#911)', () => {
  it('one shared release removes the class from <main>', () => {
    const f = js.slice(js.indexOf('function releaseFrameScrollLock()'), js.indexOf('function scrollTechIntoView()'))
    expect(f).toContain("host.classList.remove('wb-sh-locked')")
  })
  it('closing the Workbench and restarting the Projects page both release it', () => {
    const close = js.slice(js.indexOf('function closeWorkbench()'), js.indexOf('function openProjectKanban()'))
    expect(close).toContain('releaseFrameScrollLock()')
    const reset = js.slice(js.indexOf('function resetWorkbench()'), js.indexOf('function resetWorkbench()') + 400)
    expect(reset).toContain('releaseFrameScrollLock()')
  })
  it('the CSS lock applies only while a frame body is on the page', () => {
    expect(css).toContain('main.projects-active.wb-sh-locked:has(.wb-fr-body) { overflow-y: hidden; }')
    expect(css).not.toContain('main.projects-active.wb-sh-locked { overflow-y: hidden; }')
  })
})
