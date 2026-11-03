import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

// Boss TG 4749 (#851): "Fordítás mentése" must only SAVE what stands on the translation page (hand edits included).
// It must never translate again; only the "Újrafordítás" button (twRun) does. (Replaces the #840 rule that re-translated
// a stale page on save and threw the owner's German edits away.)
describe('Fordítás mentése never re-translates (#851)', () => {
  const i = JS.indexOf('function twSave(')
  const body = JS.slice(i, JS.indexOf('// ---- the translation page: Enter / paste', i))

  it('twSave never calls twRun and has no stale re-run branch', () => {
    expect(body).not.toContain('twRun(')
    expect(body).not.toContain('staleSecs')
    expect(body).not.toContain('resave_stale')
  })

  it('it saves every section that has a translation on the page, whatever the original did since', () => {
    expect(body).toContain('if (pv) list.push({ source_section: sec.id, title: pv.title, blocks: pv.blocks })')
    expect(body).not.toMatch(/pv\.sig === twSig\(sec\)\) list\.push/)
  })

  it('it first reads back the page edits, then posts them to translation-save', () => {
    expect(body.indexOf('twCollect()')).toBeLessThan(body.indexOf('/outline/translation-save'))
  })

  it('only the run (the re-translate button) ends with an automatic save, the save button does not run', () => {
    const j = JS.indexOf('function twRun(')
    expect(JS.slice(j, j + 3200)).toContain('twSave(true)')
    expect(JS).toMatch(/a === 'tw-save'\) twSave\(\)/)
  })
})
