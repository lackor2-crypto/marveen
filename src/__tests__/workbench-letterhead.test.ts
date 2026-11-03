// Boss (2026-11-02): a letter to a court/authority needs a labelled, framed sender + recipient. The document check watches it.
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, documentCheck } from '../workbench-docmodel.js'
import { letterHeadMissing } from '../workbench-letterhead.js'
import { checkTodoTexts } from '../workbench-check-todos.js'

const P = (text: string) => ({ kind: 'paragraph', text })
const HEAD = { kind: 'table', text: 'Absender: Korpás László | Empfänger: Stadt Chemnitz\nErich-Steinfurth-Straße 25 | Wohngeldbehörde' }

describe('letterHeadMissing', () => {
  it('a letter with only a plain address line has no labelled head', () => {
    expect(letterHeadMissing([P('Sächsisches Landessozialgericht\nKauffahrtei 25'), P('Tisztelt Bíróság!')])).toBe(1)
  })
  it('a framed table with the German labels is a head', () => {
    expect(letterHeadMissing([HEAD, P('Sehr geehrte Frau Teege,')])).toBe(0)
  })
  it('Hungarian and English labels count too', () => {
    expect(letterHeadMissing([{ kind: 'table', text: 'Feladó: A | Címzett: B' }, P('Tisztelt Bíróság!')])).toBe(0)
    expect(letterHeadMissing([{ kind: 'table', text: 'Sender: A | Recipient: B' }, P('Dear Court,')])).toBe(0)
  })
  it('only one of the two labels is not enough', () => {
    expect(letterHeadMissing([P('Feladó: Korpás László'), P('Tisztelt Bíróság!')])).toBe(1)
  })
  it('a text that is not a letter (no salutation, no signature block) is left alone', () => {
    expect(letterHeadMissing([P('Jegyzet a tárgyalásról')])).toBe(0)
  })
  it('a signature block makes it a letter', () => {
    expect(letterHeadMissing([P('Nyilatkozat'), { kind: 'signature', text: 'Korpás László' }])).toBe(1)
  })
})

describe('letter head in the document check', () => {
  let itemId = ''
  let secId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Nyilatkozat', type: 'document' })
    if (!w.ok) throw new Error('item')
    itemId = w.item.id
    const s = addSection(itemId, { title: 'Nyilatkozat' })
    if (!s.ok) throw new Error('section')
    secId = s.section.id
  })
  const row = () => documentCheck(itemId).items.find((i) => i.key === 'letter_head_missing')

  it('a salutation without a head: an open point, which is a to-do and does NOT ask for an override', () => {
    addBlock(itemId, secId, { kind: 'paragraph', text: 'Tisztelt Bíróság!', author: 'agent' })
    const c = documentCheck(itemId)
    expect(row()).toMatchObject({ ok: false, count: 1 })
    expect(c.needs_override).toBe(false)
    expect(checkTodoTexts(c.items, 'hu').some((t) => t.startsWith('Levélfej'))).toBe(true)
    expect(checkTodoTexts(c.items, 'en').some((t) => t.startsWith('Letter head'))).toBe(true)
  })
  it('the head table clears the point', () => {
    addBlock(itemId, secId, { kind: 'table', text: HEAD.text, author: 'agent' })
    addBlock(itemId, secId, { kind: 'paragraph', text: 'Tisztelt Bíróság!', author: 'agent' })
    expect(row()).toBeUndefined()
  })
  it('glued subject/salutation is a to-do only (ok:true), it never blocks finalizing', () => {
    addBlock(itemId, secId, { kind: 'table', text: HEAD.text, author: 'agent' })
    addBlock(itemId, secId, { kind: 'paragraph', text: 'Chemnitz, 2026. 11. 03.\nTárgy: Kérés\nTisztelt Bíróság!\nSzöveg.', author: 'agent' })
    const item = documentCheck(itemId).items.find((i) => i.key === 'letter_spacing_missing')
    expect(item).toMatchObject({ ok: true })
    expect(item?.count).toBeGreaterThan(0)
  })
  it('both languages have the screen text', () => {
    for (const l of ['hu', 'en']) {
      expect(readFileSync(new URL(`../../web/lang/${l}.js`, import.meta.url), 'utf8')).toContain('"workbench.outline.check.letter_head_missing"')
    }
  })
})
