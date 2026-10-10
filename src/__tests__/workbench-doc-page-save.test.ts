// #534 (b): the whole page in ONE call, ids kept.  The page is one continuous editable surface; the
// owner's typing is saved as the page's order (update / move / create / remove) in a single transaction.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addBlock, listBlocks, listSections } from '../workbench-docmodel.js'
import { docHistoryState } from '../workbench-dochistory.js'
import { callWorkbench } from './helpers/workbench-route-call.js'

describe('dokumentum-lap: az egesz oldal egy hivassal (#534 b)', () => {
  let depot = ''
  let itemId = ''
  const base = () => `/api/workbench/items/${itemId}/outline`
  const page = (sections: unknown, known?: unknown) => callWorkbench(base() + '/page', 'POST', { sections, known })
  const post = (sub: string, body: unknown = {}) => callWorkbench(base() + sub, 'POST', body)

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-page-'))
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

  async function seed() {
    const s = await post('/sections', { title: 'Tényállás' })
    const sec = s.body.outline.sections[0].id as string
    await post('/blocks', { section: sec, text: 'Első.' })
    await post('/blocks', { section: sec, text: 'Második.' })
    await post('/blocks', { section: sec, text: 'Harmadik.' })
    const bl = listBlocks(itemId)
    const known = [sec, ...bl.map((b) => b.id)]
    return { sec, a: bl[0].id, b: bl[1].id, c: bl[2].id, known }
  }

  it('szoveg csere, uj bekezdes, torles es athelyezes egy lepesben, az azonositok megmaradnak', async () => {
    const { sec, a, b, c, known } = await seed()
    const r = await page([{ id: sec, title: 'Tényállás', blocks: [
      { id: c },                                   // moved up, unchanged
      { id: a, text: 'Első, átírva.' },           // edited
      { text: 'Új bekezdés közé.' },              // created
    ] }], known)
    expect(r.status).toBe(200)
    expect(r.body.ids.sections[0].id).toBe(sec)
    const bl = listBlocks(itemId)
    expect(bl.map((x) => x.text)).toEqual(['Harmadik.', 'Első, átírva.', 'Új bekezdés közé.'])
    expect(bl[0].id).toBe(c)
    expect(bl[1].id).toBe(a)
    expect(r.body.ids.sections[0].blocks).toEqual([c, a, bl[2].id])
    expect(bl.some((x) => x.id === b)).toBe(false)           // b was known and is no longer listed
    expect(r.body.outline.sections[0].blocks.map((x: { text: string }) => x.text)).toEqual(bl.map((x) => x.text))
  })

  it('amit az oldal nem ismert (az agent kozben irta), nem torlodik', async () => {
    const { sec, a, known } = await seed()
    const added = addBlock(itemId, sec, { text: 'Az agent írta.', author: 'agent' })
    if (!added.ok) throw new Error('blokk')
    const r = await page([{ id: sec, title: 'Tényállás', blocks: [{ id: a }] }], known)
    expect(r.status).toBe(200)
    expect(listBlocks(itemId).map((x) => x.text)).toEqual(['Első.', 'Az agent írta.'])
  })

  it('uj fejezet egy fejezetcimmel, atmozgatott blokkal; a ures fejezet torlodik', async () => {
    const { sec, a, b, c, known } = await seed()
    const r = await page([
      { id: sec, title: 'Tényállás', blocks: [{ id: a }] },
      { title: 'Jogi álláspont', blocks: [{ id: b }, { id: c }, { text: 'Új.' }] },
    ], known)
    expect(r.status).toBe(200)
    const secs = listSections(itemId)
    expect(secs.map((s) => s.title)).toEqual(['Tényállás', 'Jogi álláspont'])
    expect(secs[0].id).toBe(sec)
    const bl = listBlocks(itemId)
    expect(bl.filter((x) => x.section_id === secs[1].id).map((x) => x.text)).toEqual(['Második.', 'Harmadik.', 'Új.'])
    const gone = await page([{ id: secs[1].id, title: 'Jogi álláspont', blocks: [{ id: b }, { id: c }, { id: bl[3].id }] }], [...known, secs[1].id, bl[3].id])
    expect(gone.status).toBe(200)
    expect(listSections(itemId).map((s) => s.title)).toEqual(['Jogi álláspont'])
    expect(listBlocks(itemId).map((x) => x.id)).toEqual([b, c, bl[3].id])
  })

  it('formazas (rich, igazitas, bekezdes-forma) a blokkal egyutt megy', async () => {
    const { sec, a, known } = await seed()
    const r = await page([{ id: sec, title: 'Tényállás', blocks: [{ id: a, text: 'Fontos szó.', rich: '<b>Fontos</b> szó.', align: 'c', pfmt: { h: 2 } }] }], known)
    expect(r.status).toBe(200)
    const out = r.body.outline.sections[0].blocks[0]
    expect(out.rich).toBe('<b>Fontos</b> szó.')
    expect(out.align).toBe('c')
    expect(out.pfmt).toEqual({ h: 2 })
  })

  it('egy rossz blokk az egesz oldalt visszagorgeti', async () => {
    const { sec, a, known } = await seed()
    const r = await page([{ id: sec, title: 'Tényállás', blocks: [{ id: a, text: 'Átírva.' }, { text: '' }] }], known)
    expect(r.status).toBe(400)
    expect(listBlocks(itemId).map((x) => x.text)).toEqual(['Első.', 'Második.', 'Harmadik.'])
  })

  it('egy lepes a tortenetben: egyetlen visszavonas az egesz oldal-mentest visszaadja', async () => {
    const { sec, a, c, known } = await seed()
    const before = listBlocks(itemId).map((x) => x.text)
    const r = await page([{ id: sec, title: 'Tényállás', blocks: [{ id: c }, { id: a, text: 'Más.' }] }], known)
    expect(r.status).toBe(200)
    expect(docHistoryState(itemId).can_undo).toBe(true)
    const u = await post('/undo')
    expect(u.status).toBe(200)
    expect(listBlocks(itemId).map((x) => x.text)).toEqual(before)
  })
})
