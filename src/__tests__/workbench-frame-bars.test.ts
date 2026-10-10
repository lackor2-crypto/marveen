// The frame's bars grow sideways, and what the owner looks for is on them (Boss, 2026-10-10).
// The behaviour was measured in a real browser on a separate empty instance (see the cards); this pins the structure.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const wb = readFileSync(join(root, 'web', 'workbench.js'), 'utf-8')
const css = readFileSync(join(root, 'web', 'workbench.css'), 'utf-8')

function fn(name: string): string {
  const i = wb.indexOf(`function ${name}(`)
  expect(i, `function ${name} missing`).toBeGreaterThan(-1)
  const next = wb.indexOf('\n  function ', i + 10)
  return wb.slice(i, next > -1 ? next : undefined)
}

describe('frame bars', () => {
  // #534, Boss TG 8748: "Piszkozat PDF / Veglegesites / Forditas melle" stand beside the tabs, not under them.
  it('the document tabs and the action buttons share one row', () => {
    expect(wb).toContain("'<div class=\"wb-sh-doc-bar\">' + head + actions + '</div>' + finalPanel")
    expect(css).toMatch(/\.wb-sh-doc-bar \{ display: flex; flex-wrap: wrap;/)
  })

  // #556, Boss TG 8751: MEASURED -- for a table, a presentation and a note no Finalize button was visible in the
  // frame (it sat only in the "more" panel). It is in the top bar for every kind now.
  it('Finalize is in the frame top bar for every kind; a drafted document keeps its own; a finalized item shows Reopen', () => {
    expect(fn('frTopHtml')).toContain('finalizeTopHtml(it)')
    const f = fn('finalizeTopHtml')
    expect(f).toContain('data-wb-act="item-finalize"')
    expect(f).toContain('data-wb-act="item-reopen"')
    expect(f).toContain("it.status === 'done'")
    expect(f).toContain("if (it.type === 'document' && !it.source_path) return ''")
    expect(f).toContain('archived()')
    // the Manual view: in the head of the item (measured: it was only at the very bottom, after scrolling)
    expect(fn('editorPanelHtml')).toContain("finalizeTopHtml(it, 'btn-secondary btn-compact') + '</div>'")
  })
})
