// #549 (owner, 2026-10-10): the document view's action buttons are small, and small is the default in the workbench.
// Measured in Chromium on an isolated instance (button heights on a desktop and on a phone-wide window).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.css'), 'utf8')
const src = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

describe('small buttons in the workbench (#549)', () => {
  it('every compact button inside the workbench gets the small size, a finger-sized one on a phone', () => {
    expect(css).toContain('.wb-root .btn-compact { padding: 5px 12px; font-size: 13px; gap: 4px; }')
    expect(css).toContain('@media (max-width: 700px) { .wb-root .btn-compact { padding: 10px 12px; } }')
  })
  it('the five buttons the owner named are compact buttons (so the rule reaches them)', () => {
    const line = (needle: string): string => src.split('\n').find((l) => l.includes(needle)) || ''
    for (const k of ["t('workbench.sh.doc.draft_pdf')) + '</a> '", "data-wb-act=\"sh-final\"", "data-wb-act=\"tw-toggle\"", "data-wb-act=\"tw-run\"", "data-wb-act=\"tw-save\""]) {
      const l = line(k)
      expect(l, k).not.toBe('')
      // the anchor's class sits on the line before its label
      const at = src.indexOf(l)
      expect(src.slice(Math.max(0, at - 260), at + l.length), k).toContain('btn-compact')
    }
  })
})
