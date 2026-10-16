// #650 (Boss TG 3100/3105): a finalized document is locked (no editable page, no toolbar, no table edit mode);
// the Reopen button lifts it and both the "finalized" mark and Reopen carry an explanatory tooltip.
// Browser-measured 2026-10-16: finalized -> editable page 0, toolbar 0, table click keeps the grid.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const js = readFileSync(join(__dirname, '../../web/workbench.js'), 'utf8')
const hu = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf8')
const en = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf8')

describe('finalized document is locked', () => {
  it('docLocked() is archived or a finalized document, and the editing views use it', () => {
    expect(js).toMatch(/function docFinalLocked\(\)\s*\{[^}]*'document'[^}]*'done'/)
    expect(js).toMatch(/function docLocked\(\)\s*\{[^}]*archived\(\)[^}]*docFinalLocked\(\)/)
    for (const fn of ['outlineHtml', 'docPageHtml', 'docExtrasHtml', 'docTabsHtml', 'versionBarHtml']) {
      const i = js.indexOf('function ' + fn)
      expect(i, fn).toBeGreaterThan(-1)
      expect(js.slice(i, i + 3000), fn).toContain('docLocked()')
    }
  })
  it('the tooltips exist in both languages and are wired to the finalized mark and the Reopen button', () => {
    for (const k of ['workbench.finalize.done_tip', 'workbench.finalize.reopen_tip']) {
      expect(hu).toContain(k)
      expect(en).toContain(k)
      expect(js).toContain(k)
    }
  })
})
