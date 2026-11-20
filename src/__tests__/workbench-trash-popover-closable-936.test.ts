import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..', '..')
const js = readFileSync(join(root, 'web', 'workbench.js'), 'utf8')
const hu = readFileSync(join(root, 'web', 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(root, 'web', 'lang', 'en.js'), 'utf8')

// #936: the Trash drop-down (.wb-pop) opens by itself after a delete and lies over the folder tree.
// It must be closable without hunting for the toggle: Close button, click outside, Escape.
describe('Workbench Trash drop-down can be closed (#936)', () => {
  it('has its own Close button inside the drop-down', () => {
    const i = js.indexOf('<div class="wb-trash">\' + head + \'<div class="wb-pop">')
    expect(i).toBeGreaterThan(0)
    const fn = js.slice(js.lastIndexOf('function trashHtml', i), i)
    expect(fn).toContain('data-wb-act="trash-close"')
  })
  it('handles trash-close by closing the drop-down', () => {
    expect(js).toMatch(/a === 'trash-close'\) \{ WB\.trashOpen = false/)
  })
  it('closes on a click outside .wb-trash', () => {
    expect(js).toMatch(/\(WB\.trashOpen \|\| WB\.rescueOpen\) && !e\.target\.closest\('\.wb-trash'\)/)
    expect(js).toContain('item-(restore|purge)')
  })
  it('closes on Escape', () => {
    expect(js).toMatch(/e\.key === 'Escape' && WB\.open && \(WB\.trashOpen \|\| WB\.rescueOpen\)/)
  })
  it('the Close label exists in both languages and the bar is styled', () => {
    expect(hu).toContain('"workbench.trash.close"')
    expect(en).toContain('"workbench.trash.close"')
    expect(readFileSync(join(root, 'web', 'workbench.css'), 'utf8')).toContain('.wb-pop-bar')
  })
})
