import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, BLANK_LINE } from '../workbench-docmodel.js'
import { savedTranslationFor, saveShownTranslation } from '../workbench-doclang-translate.js'

const JS = readFileSync(join(__dirname, '..', '..', 'web', 'workbench.js'), 'utf8')

// #838 (Boss TG 4437): empty lines made with Enter in the translation column vanished on "Fordítás mentése", so the
// printed name slid up under the signature picture. The work item page keeps them (#565); the column must too.
describe('an empty line of the translation column is kept on save (#838)', () => {
  let src: WorkItemRow
  let secId = ''
  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('project')
    const w = createWorkItem({ project_id: p.project.id, title: 'Erklaerung', type: 'document' })
    if (!w.ok) throw new Error('item')
    src = w.item
    const s = addSection(src.id, 'Nyilatkozat')
    if (!s.ok) throw new Error('section')
    secId = s.section.id
    addBlock(src.id, secId, { text: 'Mit freundlichen Gruessen', author: 'owner' })
    addBlock(src.id, secId, { text: 'Korpas Laszlo', author: 'owner' })
  })

  it('the server stores and returns the blank lines of the shown translation, in place', () => {
    const r = saveShownTranslation(src, 'de', [{ source_section: secId, title: 'Erklaerung', blocks: [
      { kind: 'paragraph', text: 'Mit freundlichen Gruessen' },
      { kind: 'paragraph', text: BLANK_LINE },
      { kind: 'paragraph', text: BLANK_LINE },
      { kind: 'paragraph', text: BLANK_LINE },
      { kind: 'paragraph', text: 'Korpas Laszlo' },
    ] }], 'owner')
    expect(r).toMatchObject({ ok: true, saved: 1 })
    const back = savedTranslationFor(src, 'de')
    if (!back.ok || !back.found) throw new Error('not found')
    expect(back.sections[0]!.blocks.map((b) => b.text)).toEqual(['Mit freundlichen Gruessen', BLANK_LINE, BLANK_LINE, BLANK_LINE, 'Korpas Laszlo'])
  })

  it('twCollect keeps an empty paragraph line as a blank line (only a paragraph line, not a heading / table)', () => {
    const i = JS.indexOf('function twCollect(')
    const body = JS.slice(i, i + 9000)
    expect(body).toContain("replace(/\\u200B/g, '').trim()")
    expect(body).toContain("cur.blocks.push({ kind: 'paragraph', text: DP_BLANK })")
    expect(body).toContain("role === 'title' || kind !== 'paragraph' || tl != null")
  })

  it('a blank paragraph is drawn as an empty line (<br>), so it holds its place on the page', () => {
    const i = JS.indexOf('function twTextLook(')
    expect(JS.slice(i, i + 900)).toContain("if (b.kind === 'paragraph' && dpIsBlank(b.text)) inner = '<br>'")
  })
})
