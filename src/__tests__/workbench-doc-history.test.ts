// #533 (Boss 2026-10-10): visszavonas es ujra a dokumentum-lapon -- a dokumentum es a birosagi beadvany
// ugyanaz a lap. A tortenet szerver-oldali (a vazlat tablainak pillanatkepei), ezert a lap mentese utan is
// mukodik; egy lepes = egy felhasznaloi muvelet; ures tortenetnel nincs mit visszavonni.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addBlock, addClaim, documentOutline, listBlocks, listSections, listClaims, type SourceWorld } from '../workbench-docmodel.js'
import { docHistoryState, docStepLabel, DOC_HISTORY_MAX } from '../workbench-dochistory.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

const world: SourceWorld = { resolveFile: () => null, ownerMessages: () => [{ id: 'm1', content: 'Ezt tényleg mondtam.', created_at: 1_790_000_000 }] }

describe('dokumentum-lap: visszavonas es ujra (#533)', () => {
  let depot = ''
  let itemId = ''
  const base = () => `/api/workbench/items/${itemId}/outline`
  const post = (sub: string, body: unknown = {}) => callWorkbench(base() + sub, 'POST', body)
  const patch = (sub: string, body: unknown) => callWorkbench(base() + sub, 'PATCH', body)
  const del = (sub: string) => callWorkbench(base() + sub, 'DELETE')
  const texts = () => listBlocks(itemId).map((b) => b.text)

  async function seed(): Promise<{ sec: string; a: string; b: string }> {
    const s = await post('/sections', { title: 'Tényállás' })
    const sec = s.body.outline.sections[0].id as string
    const a = await post('/blocks', { section: sec, text: 'Első bekezdés.' })
    const b = await post('/blocks', { section: sec, text: 'Második bekezdés.' })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    return { sec, a: listBlocks(itemId)[0].id, b: listBlocks(itemId)[1].id }
  }

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-dochist-'))
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    const w = createWorkItem({ project_id: p.project.id, title: 'Beadvany', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('friss munkadarab, ures tortenet: nincs mit visszavonni, a gomb tiltott, a vegpont 409', async () => {
    expect(docHistoryState(itemId)).toEqual({ can_undo: false, can_redo: false, undo: null, redo: null })
    const r = await post('/undo')
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('outline_nothing_to_undo')
    const g = await callWorkbench(base(), 'GET')
    expect(g.body.outline.history.can_undo).toBe(false)
    const redo = await post('/redo')
    expect(redo.status).toBe(409)
    expect(redo.body.error).toBe('outline_nothing_to_redo')
  })

  it('tobb lepes visszavonasa es ujra: minden szerkesztes egy lepes, visszafele sorban', async () => {
    const { a } = await seed()
    await patch('/blocks/' + a, { text: 'Első, javítva.' })
    await patch('/blocks/' + a, { text: 'Első, még egyszer javítva.' })
    expect(texts()[0]).toBe('Első, még egyszer javítva.')

    const u1 = await post('/undo')
    expect(u1.status).toBe(200)
    expect(u1.body.label).toBe('edit_block')
    expect(texts()[0]).toBe('Első, javítva.')
    expect(u1.body.outline.history).toMatchObject({ can_undo: true, can_redo: true })
    await post('/undo')
    expect(texts()[0]).toBe('Első bekezdés.')

    const r1 = await post('/redo')
    expect(r1.status).toBe(200)
    expect(texts()[0]).toBe('Első, javítva.')
    await post('/redo')
    expect(texts()[0]).toBe('Első, még egyszer javítva.')
    expect(docHistoryState(itemId).can_redo).toBe(false)
  })

  it('blokk torlesenek visszavonasa: a blokk, a helye ES az allitasa a forrasaival egyutt visszajon, azonos azonositoval', async () => {
    const { a, b } = await seed()
    const claim = addClaim(itemId, b, 'Második bekezdés.', [{ kind: 'owner', said: 'Ezt tényleg mondtam.' }], world, null)
    expect(claim.ok).toBe(true)
    const before = documentOutline(itemId).sections[0].blocks.map((x) => ({ id: x.id, text: x.text, claims: (x.claims || []).length }))
    expect(before[1].claims).toBe(1)

    const d = await del('/blocks/' + b)
    expect(d.status).toBe(200)
    expect(texts()).toEqual(['Első bekezdés.'])
    expect(listClaims(itemId)).toHaveLength(0)

    const u = await post('/undo')
    expect(u.status).toBe(200)
    expect(u.body.label).toBe('remove_block')
    const after = documentOutline(itemId).sections[0].blocks.map((x) => ({ id: x.id, text: x.text, claims: (x.claims || []).length }))
    expect(after).toEqual(before)
    expect(after[0].id).toBe(a)
    expect(listClaims(itemId)).toHaveLength(1)

    // Ujra: a torles megint megtortenik.
    await post('/redo')
    expect(texts()).toEqual(['Első bekezdés.'])
    expect(listClaims(itemId)).toHaveLength(0)
  })

  it('a visszaallitott irat-forras ujra ellenorzodik (nem mutat regi igazolast), a tulajdonosi kozles marad', async () => {
    const { a, b } = await seed()
    const owner = addClaim(itemId, a, 'Első bekezdés.', [{ kind: 'owner', said: 'Ezt tényleg mondtam.' }], world, null)
    const doc = addClaim(itemId, b, 'Második bekezdés.', [{ kind: 'document', path: 'Level/x.pdf', page: 1, quote: 'Második' }], world, null)
    expect(owner.ok && doc.ok).toBe(true)
    await del('/blocks/' + b)
    await post('/undo')
    const sources = listClaims(itemId).flatMap((c) => c.sources)
    const d = sources.find((s) => s.kind === 'document')
    const o = sources.find((s) => s.kind === 'owner')
    expect(d?.verdict).toBe('pending')
    expect(o?.verdict).toBe('recorded')
  })

  it('hozzaadas, athelyezes, fejezet atnevezese es formazas is visszavonhato; egy kerelem = egy lepes', async () => {
    const { sec, a, b } = await seed()
    // Athelyezes: a masodik blokk az elsore.
    await patch('/blocks/' + b, { section: sec, position: 0 })
    expect(texts()).toEqual(['Második bekezdés.', 'Első bekezdés.'])
    await post('/undo')
    expect(texts()).toEqual(['Első bekezdés.', 'Második bekezdés.'])

    // Fejezet atnevezese.
    await patch('/sections/' + sec, { title: 'Új cím' })
    expect(listSections(itemId)[0].title).toBe('Új cím')
    const ren = await post('/undo')
    expect(ren.body.label).toBe('rename_section')
    expect(listSections(itemId)[0].title).toBe('Tényállás')

    // Formazas: a szoveg es a formazas EGY kerelemben megy, egy lepes.
    await patch('/blocks/' + a, { text: 'Első bekezdés.', rich: '<b>Első</b> bekezdés.' })
    expect(listBlocks(itemId)[0].rich).toBe('<b>Első</b> bekezdés.')
    await post('/undo')
    expect(listBlocks(itemId)[0].rich ?? null).toBeNull()

    // Beszurt sor (tablazat/kep ugyanezen az uton megy): a hozzaadas visszavonasa eltavolitja.
    await post('/blocks', { section: sec, text: 'a\tb\n1\t2', kind: 'table' })
    expect(listBlocks(itemId)).toHaveLength(3)
    const added = await post('/undo')
    expect(added.body.label).toBe('add_block')
    expect(listBlocks(itemId)).toHaveLength(2)
  })

  it('a lap mentese / ujratoltese utan is mukodik (a tortenet a szerveren van, a GET nem veszi el)', async () => {
    const { a } = await seed()
    await patch('/blocks/' + a, { text: 'Mentett szöveg.' })
    // "Oldal-ujratoltes": a lap ujra lekeri a vazlatot, sokszor.
    for (let i = 0; i < 3; i++) {
      const g = await callWorkbench(base(), 'GET')
      expect(g.body.outline.history).toMatchObject({ can_undo: true, undo: 'edit_block' })
    }
    // Es egy MASIK modul-peldany (uj folyamat) is ugyanazt latja: a tortenet az adatbazisban van.
    const r = await post('/undo')
    expect(r.status).toBe(200)
    expect(texts()[0]).toBe('Első bekezdés.')
  })

  it('uj muvelet utan az "ujra" ag elvesz; az agens (doc.*) valtoztatasa sajat lepes, nem veszik el csendben', async () => {
    const { sec, a } = await seed()
    await patch('/blocks/' + a, { text: 'Egy.' })
    await post('/undo')
    expect(docHistoryState(itemId).can_redo).toBe(true)
    await patch('/blocks/' + a, { text: 'Más.' })
    expect(docHistoryState(itemId).can_redo).toBe(false)

    // Az agent a lap mogott hozzaad egy blokkot (nem a tulajdonosi uton).
    const ag = addBlock(itemId, sec, { text: 'Az agens bekezdese.', author: 'agent' })
    expect(ag.ok).toBe(true)
    expect(texts()).toContain('Az agens bekezdese.')
    const st = docHistoryState(itemId)
    expect(st).toMatchObject({ can_undo: true, undo: 'external' })
    // A tulajdonos kovetkezo muvelete ELOTT a lap-tortenet felveszi, igy a visszavonas elobb az agens lepeset veszi vissza,
    // a tulajdonos szerkesztese (Más.) erintetlen marad.
    await post('/undo')
    expect(texts()).not.toContain('Az agens bekezdese.')
    expect(texts()[0]).toBe('Más.')
  })

  it('a tortenet hossza korlatos, es a munkadarab torlesekor a tortenet is megy', async () => {
    const { a } = await seed()
    for (let i = 0; i < DOC_HISTORY_MAX + 5; i++) await patch('/blocks/' + a, { text: 'v' + i })
    const n = (getDb().prepare('SELECT COUNT(*) AS n FROM wb_doc_history WHERE work_item_id = ?').get(itemId) as { n: number }).n
    expect(n).toBeLessThanOrEqual(DOC_HISTORY_MAX + 1)
    let undone = 0
    for (;;) {
      const r = await post('/undo')
      if (r.status !== 200) break
      undone++
    }
    expect(undone).toBe(DOC_HISTORY_MAX)
  })

  it('a cimke a keres alakjabol jon, es csak a lap sajat muveleteit nevezi meg', () => {
    const L = (m: string, segs: string[], body: Record<string, unknown> = {}) => docStepLabel(m, ['i', 'outline', ...segs], body)
    expect(L('POST', ['blocks'])).toBe('add_block')
    expect(L('PATCH', ['blocks', 'x'], { text: 'a' })).toBe('edit_block')
    expect(L('PATCH', ['blocks', 'x'], { align: 'c' })).toBe('format_block')
    expect(L('PATCH', ['blocks', 'x'], { position: 0 })).toBe('move_block')
    expect(L('DELETE', ['blocks', 'x'])).toBe('remove_block')
    expect(L('DELETE', ['sections', 'x'])).toBe('remove_section')
    expect(L('POST', ['drop'])).toBe('drop')
    expect(L('POST', ['sent'])).toBeNull()
    expect(L('POST', ['annexes'])).toBeNull()
    expect(L('GET', ['blocks'])).toBeNull()
  })
})
