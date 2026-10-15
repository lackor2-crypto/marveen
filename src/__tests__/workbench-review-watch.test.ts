import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('review confirmation box stays in sync with the recorded review', () => {
  it('the review button starts a watcher, not two fixed one-shot refreshes', () => {
    const branch = src.slice(src.indexOf("a === 'outline-review'"), src.indexOf("a === 'outline-accept'"))
    expect(branch).toContain('watchReview()')
    expect(branch).not.toContain('setTimeout(refreshOutline')
  })

  it('the watcher polls until reviewed, with a limit, and re-reads on focus and visibility', () => {
    const fn = src.slice(src.indexOf('function watchReview()'), src.indexOf('function finalizeDocument()'))
    expect(fn).toContain('outline.reviewed')
    expect(fn).toContain('tries < 45')
    expect(fn).toContain("addEventListener('focus', check)")
    expect(fn).toContain("document.addEventListener('visibilitychange', check)")
    expect(fn).toContain('stop()')
  })
})
