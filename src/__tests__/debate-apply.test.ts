// "Apply" of a finished review debate (#597, phase 4): the matching and the preview are pure; writing goes through the
// document model and is ONE step of the document's history. The database is a real in-memory one.
import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, listBlocks } from '../workbench-docmodel.js'
import { docHistoryState, undoDocStep, redoDocStep } from '../workbench-dochistory.js'
import { parseObjections, parseReplies } from '../debate-modes.js'
import { buildObjectionBoard } from '../debate-board.js'
import {
  applicableChanges, previewChanges, previewForItem, applyChanges, quotePattern, type ApplyChange, type DocBlockIn,
} from '../debate-apply.js'

const change = (id: string, quote: string, rewrite: string, kind: ApplyChange['kind'] = 'wording', status: ApplyChange['status'] = 'accepted'): ApplyChange =>
  ({ id, kind, quote, rewrite, status })
const blk = (id: string, text: string, kind = 'paragraph', section = 's1', position = 0): DocBlockIn => ({ id, kind, text, section_id: section, position })
const titles = new Map([['s1', 'Tenyallas']])

describe('az idezet keresese', () => {
  it('a szokozok, a gorbe idezojelek es a kotojelek kozti kulonbseg nem szamit', () => {
    const re = quotePattern('a "hatarido" 30  nap – tehat')
    expect('szerint a „hatarido” 30 nap - tehat').toMatch(re)
    expect('szerint a hatarido\n30 nap').not.toMatch(re)
  })
  it('a regex-jelek szoveg: nem minta', () => {
    expect('ar (3+4)*2 = 14.').toMatch(quotePattern('(3+4)*2'))
    expect('ar 7*2').not.toMatch(quotePattern('(3+4)*2'))
    expect('xay').not.toMatch(quotePattern('a.y'))
  })
})

describe('a valtoztatasok elonezete', () => {
  it('pontosan egy helyen megtalalt idezet: kesz; a regi es az uj szoveg a kornyezettel egyutt latszik', () => {
    const p = previewChanges([blk('b1', 'A hatarido 30 nap, es ezt kell betartani.')], titles, [change('K1', '30 nap', '15 nap')])
    expect(p[0]).toMatchObject({ id: 'K1', state: 'ready', action: 'replace', blockId: 'b1', sectionTitle: 'Tenyallas', old: '30 nap', new: '15 nap', ctxBefore: 'A hatarido ', ctxAfter: ', es ezt kell betartani.' })
  })

  it('sehol nem talalhato -> not_found; tobb helyen is -> ambiguous (a program nem talalgat)', () => {
    expect(previewChanges([blk('b1', 'semmi')], titles, [change('K1', '30 nap', 'x')])[0]).toMatchObject({ state: 'not_found', blockId: null })
    expect(previewChanges([blk('b1', '30 nap'), blk('b2', 'masik 30 nap')], titles, [change('K1', '30 nap', 'x')])[0].state).toBe('ambiguous')
    expect(previewChanges([blk('b1', '30 nap es 30 nap')], titles, [change('K1', '30 nap', 'x')])[0].state).toBe('ambiguous')
  })

  it('tablazatban vagy alairasban talalt idezet nem szoveg: nem irhato at', () => {
    expect(previewChanges([blk('b1', 'Osszeg: 30 nap', 'table')], titles, [change('K1', '30 nap', 'x')])[0].state).toBe('not_text')
  })

  it('"hianyzo resz": az uj szoveg a hely UTAN uj bekezdes, nem csereli az idezetet', () => {
    const p = previewChanges([blk('b1', 'Vege a levelnek.')], titles, [change('K2', 'Vege a levelnek.', 'Mellekletek: 1, 2.', 'missing')])
    expect(p[0]).toMatchObject({ action: 'insert', state: 'ready', old: '', new: 'Mellekletek: 1, 2.' })
  })

  it('a tablabol csak az elfogadott / reszben elfogadott, idezettel es uj szoveggel rendelkezo kifogas lesz valtoztatas', () => {
    const board = buildObjectionBoard([{ round: 1, responses: [
      { role: 'critic', ok: true, objections: parseObjections('K1 [accuracy]\nQUOTE: "a"\nOBJECTION: x\n\nK2 [wording]\nQUOTE: "b"\nOBJECTION: y\n\nK3 [wording]\nOBJECTION: z\n\nK4 [wording]\nQUOTE: "d"\nOBJECTION: w') },
      { role: 'defender', ok: true, replies: parseReplies('K1: ACCEPT\nREASON: r\nREWRITE: uj a\n\nK2: REJECT\nREASON: r\n\nK3: ACCEPT\nREASON: r\nREWRITE: uj c\n\nK4: PARTIAL\nREASON: r\nREWRITE: uj d') },
    ] }])
    expect(applicableChanges(board).map(c => [c.id, c.status])).toEqual([['K1', 'accepted'], ['K4', 'partial']])
  })
})

describe('beiras a dokumentumba', () => {
  let itemId = ''
  let sectionId = ''
  const text = () => listBlocks(itemId).map(b => b.text)

  beforeEach(() => {
    initDatabase(':memory:')
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Valaszbeadvany', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    const s = addSection(itemId, 'Tenyallas')
    if (!s.ok) throw new Error('fejezet')
    sectionId = s.section.id
    for (const t of ['A hatarido 30 nap.', 'Kerjuk szepen a bizonyitekot.', 'Vege a levelnek.']) {
      const b = addBlock(itemId, sectionId, { text: t, author: 'owner' })
      if (!b.ok) throw new Error('blokk')
    }
  })

  const CHANGES = [
    change('K1', '30 nap', '15 nap', 'accuracy'),
    change('K2', 'Kerjuk szepen', 'Kerjuk', 'wording', 'partial'),
    change('K3', 'Vege a levelnek.', 'Mellekletek: 1, 2.', 'missing'),
  ]

  it('csak a bepipalt kerul be; a tobbi erintetlen; a valasz megmondja, mi tortent', () => {
    const r = applyChanges(itemId, CHANGES, new Set(['K1']))
    expect(r.applied).toEqual(['K1'])
    expect(r.skipped.map(s => [s.id, s.reason])).toEqual([['K2', 'not_ticked'], ['K3', 'not_ticked']])
    expect(text()).toEqual(['A hatarido 15 nap.', 'Kerjuk szepen a bizonyitekot.', 'Vege a levelnek.'])
  })

  it('semmi nincs bepipalva -> semmi nem tortenik, nincs uj lepes az elozmenyben', () => {
    const r = applyChanges(itemId, CHANGES, new Set())
    expect(r.applied).toEqual([])
    expect(text()).toEqual(['A hatarido 30 nap.', 'Kerjuk szepen a bizonyitekot.', 'Vege a levelnek.'])
    expect(docHistoryState(itemId).can_undo).toBe(false)
  })

  it('csere es beszuras egyutt: a hianyzo resz uj bekezdes az idezett hely utan, a tobbi bekezdes helyben marad', () => {
    const r = applyChanges(itemId, CHANGES, new Set(['K1', 'K2', 'K3']))
    expect(r.applied).toEqual(['K1', 'K2', 'K3'])
    expect(text()).toEqual(['A hatarido 15 nap.', 'Kerjuk a bizonyitekot.', 'Vege a levelnek.', 'Mellekletek: 1, 2.'])
  })

  it('AZ EGESZ egyetlen lepes az elozmenyben: egy Visszavonas mindent visszaad, az Ujra pedig megint beirja', () => {
    applyChanges(itemId, CHANGES, new Set(['K1', 'K2', 'K3']))
    const h = docHistoryState(itemId)
    expect(h).toMatchObject({ can_undo: true, undo: 'debate_apply' })
    expect(undoDocStep(itemId)).toMatchObject({ ok: true })
    expect(text()).toEqual(['A hatarido 30 nap.', 'Kerjuk szepen a bizonyitekot.', 'Vege a levelnek.'])
    expect(redoDocStep(itemId)).toMatchObject({ ok: true })
    expect(text()).toEqual(['A hatarido 15 nap.', 'Kerjuk a bizonyitekot.', 'Vege a levelnek.', 'Mellekletek: 1, 2.'])
  })

  it('ami kozben megvaltozott a dokumentumban, azt nem irja be: nincs meg az idezet -> kihagyva, a tobbi megy', () => {
    const b = listBlocks(itemId)[0]
    addBlock(itemId, sectionId, { text: 'Masik 30 nap is van.', author: 'owner' })
    const r = applyChanges(itemId, CHANGES, new Set(['K1', 'K2']))
    expect(r.applied).toEqual(['K2'])
    expect(r.skipped.find(s => s.id === 'K1')).toEqual({ id: 'K1', reason: 'ambiguous' })
    expect(listBlocks(itemId)[0].text).toBe(b.text)
  })

  it('az elonezet ugyanazt latja, mint a beiras (a mostani dokumentumon szamolva)', () => {
    expect(previewForItem(itemId, CHANGES).map(p => [p.id, p.state])).toEqual([['K1', 'ready'], ['K2', 'ready'], ['K3', 'ready']])
    applyChanges(itemId, CHANGES, new Set(['K1']))
    expect(previewForItem(itemId, CHANGES).map(p => [p.id, p.state])).toEqual([['K1', 'not_found'], ['K2', 'ready'], ['K3', 'ready']])
  })

  it('ket valtoztatas ugyanabban a bekezdesben egymas utan is jo: a masodik a mar atirt szoveget latja', () => {
    const one = addBlock(itemId, sectionId, { text: 'Alfa beta gamma.', author: 'owner' })
    if (!one.ok) throw new Error('blokk')
    const r = applyChanges(itemId, [change('K1', 'Alfa', 'A'), change('K2', 'gamma', 'G')], new Set(['K1', 'K2']))
    expect(r.applied).toEqual(['K1', 'K2'])
    expect(text()).toContain('A beta G.')
  })
})
