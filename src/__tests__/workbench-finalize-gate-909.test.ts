/**
 * #909 (Boss TG 5943): finalizing needs a trigger document or the owner's "none" mark, on EVERY route; and a finalized
 * item made from a PDF file has the Send panel (the PDF is what goes out).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { finalizeNeedsTrigger } from '../workbench-trigger.js'
import { hasPdfSource } from '../workbench-docxfinal.js'

const routes = readFileSync(join(__dirname, '..', 'web', 'routes', 'workbench.ts'), 'utf-8')
const js = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf-8')
const hu = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'hu.js'), 'utf-8')
const en = readFileSync(join(__dirname, '..', '..', 'web', 'lang', 'en.js'), 'utf-8')
const mail = readFileSync(join(__dirname, '..', 'workbench-maildraft.ts'), 'utf-8')

describe('finalizeNeedsTrigger', () => {
  const none = { folder: null, files: [], noTrigger: false }
  it('holds an item with nothing linked and no mark, with or without a trigger folder', () => {
    expect(finalizeNeedsTrigger(none, false)).toBe(true)
    expect(finalizeNeedsTrigger({ folder: 'A/Kiváltó irat', files: [], noTrigger: false }, false)).toBe(true)
  })
  it('lets it through with a linked file, the mark, or as a language version', () => {
    expect(finalizeNeedsTrigger({ folder: 'A/Kiváltó irat', files: ['x.pdf'], noTrigger: false }, false)).toBe(false)
    expect(finalizeNeedsTrigger({ ...none, noTrigger: true }, false)).toBe(false)
    expect(finalizeNeedsTrigger(none, true)).toBe(false)
  })
})

describe('both finalize routes ask the same gate', () => {
  it('the court-document finalize and the item approval finalize call finalizeTriggerHeld before doing anything', () => {
    const a = routes.indexOf("segs[2] === 'finalize' && method === 'POST'")
    expect(routes.slice(a, a + 900)).toContain('finalizeTriggerHeld(item)')
    const b = routes.indexOf("action === 'finalize' || action === 'reopen'")
    expect(routes.slice(b, b + 600)).toContain("action === 'finalize' && finalizeTriggerHeld(item)")
  })
  it('the refusal has a Hungarian and an English sentence', () => {
    const i = routes.indexOf('finalize_trigger_missing: {')
    expect(routes.slice(i, i + 700)).toMatch(/hu: '.+'[\s\S]*en: '.+'/)
  })
})

describe('the page answers a refused finalize with the owner own click', () => {
  it('both finalize handlers offer the "no trigger document" mark and run again', () => {
    expect(js).toContain("askNoTriggerThen(id, r, function () { finalizeDocument() })")
    expect(js).toContain("askNoTriggerThen(id, r, function () { approvalAction(action, true, body.reason) })")
    expect(hu).toContain('"workbench.trigger.finalize_ask"')
    expect(en).toContain('"workbench.trigger.finalize_ask"')
  })
})

describe('a PDF-made item has the Send panel', () => {
  it('is recognised by its file and carries the PDF itself as the attachment', () => {
    expect(hasPdfSource({ source_path: 'A/B/irat.PDF' })).toBe(true)
    expect(hasPdfSource({ source_path: 'A/B/irat.docx' })).toBe(false)
    expect(hasPdfSource({ source_path: null })).toBe(false)
    expect(mail).toContain("code: 'pdf_mail_no_file'")
    expect(js).toContain('isPdfDoneItem(it)')
  })
  it('the detail response carries the draft for it', () => {
    expect(routes).toContain('hasDocxFinalPanel(item) || hasPdfSource(item) ? { mail_draft')
  })
})
