/**
 * Owner report 2026-11-09: the open Workbench document "jumps up and down" while reading.
 * Cause 1 (measured in a real browser): every full redraw restored scrollTop, then the page grew above the
 * viewport and Chrome's scroll anchoring moved scrollTop again (6000 -> 7741 -> 9766 ...), so each redraw
 * drifted the view. Fix: overflow-anchor off in the Workbench root.
 * Cause 2: scheduleDocPoll redrew the whole root every 3 s while any file was being read, even when nothing
 * changed. Fix: redraw only if the assets list changed.
 * Source test (the layout itself needs a real browser; checked there with Playwright).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CSS = readFileSync(join(ROOT, 'web', 'workbench.css'), 'utf8')
const JS = readFileSync(join(ROOT, 'web', 'workbench.js'), 'utf8')

describe('Workbench scroll stability', () => {
  it('switches scroll anchoring off in the Workbench root', () => {
    expect(CSS).toMatch(/#projectsRoot,\s*#projectsRoot \*\s*\{\s*overflow-anchor:\s*none/)
  })
  it('does not redraw on a document-read poll when the assets did not change', () => {
    const i = JS.indexOf('function scheduleDocPoll')
    expect(i).toBeGreaterThan(-1)
    const body = JS.slice(i, JS.indexOf('function docStateHtml', i))
    expect(body).toMatch(/JSON\.stringify\(WB\.detail\.assets\) !== before\) render\(\)/)
    expect(body).not.toMatch(/WB\.detail\.assets = r\.data\.assets \|\| \[\]\n\s*render\(\)/)
  })
})
