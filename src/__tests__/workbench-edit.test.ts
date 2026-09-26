// #406, 4. pont -- KOZVETLEN SZERKESZTES, MINDEN MENTES UJ VERZIO: a szerver
// (verzio + valtoztatas egy tranzakcioban, szovegfajl uj fajlba) es a felulet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, setProjectArchived } from '../projects.js'
import { createWorkItem, addWorkItemPart, listWorkItemParts, listWorkItemVersions, getWorkItem } from '../workbench.js'
import { baseNameForNextVersion } from '../workbench-edit.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

let pid = ''
let itemId = ''

function setupDb() {
  initDatabase(':memory:')
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  const w = createWorkItem({ project_id: pid, title: 'Poszt', type: 'composite' })
  if (!w.ok) throw new Error('munkadarab')
  itemId = w.item.id
}

const texts = (versionId?: string) => listWorkItemParts(itemId, versionId).map((p) => p.text)

describe('resz-muveletek new_version=1-gyel: minden mentes UJ verzio', () => {
  beforeEach(setupDb)

  it('uj resz: v2 keletkezik, a v1 ures marad', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: 'Első sor' })
    expect(r.status).toBe(201)
    expect(r.body.version.version_no).toBe(2)
    expect(r.body.versions).toHaveLength(2)
    expect(r.body.item.current_version_id).toBe(r.body.version.id)
    const v1 = listWorkItemVersions(itemId).find((v) => v.version_no === 1)!
    expect(texts(v1.id)).toEqual([])
    expect(texts()).toEqual(['Első sor'])
  })

  it('javitas: a regi verzio szovege VALTOZATLAN, az uj verzioe az uj', async () => {
    const a = await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: 'Régi szöveg' })
    const v2 = a.body.version.id
    const r = await callWorkbench(`/api/workbench/items/${itemId}/parts/${a.body.part.id}?new_version=1`, 'PATCH', { text: 'Új szöveg' })
    expect(r.status).toBe(200)
    expect(r.body.version.version_no).toBe(3)
    expect(texts(v2)).toEqual(['Régi szöveg'])
    expect(texts()).toEqual(['Új szöveg'])
    // A valaszban a FRISS resz-azonosito all (a masolate), azzal lehet tovabb dolgozni.
    expect(r.body.part.id).not.toBe(a.body.part.id)
    expect(r.body.parts[0].id).toBe(r.body.part.id)
  })

  it('kivetel es atrendezes is uj verzio; a regi sorrend megmarad a regi verzioban', async () => {
    await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: 'egy' })
    const b = await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: 'ketto' })
    const before = b.body.version.id
    const second = b.body.parts[1].id
    const mv = await callWorkbench(`/api/workbench/items/${itemId}/parts/${second}/move?new_version=1`, 'POST', { dir: 'up' })
    expect(mv.status).toBe(200)
    expect(mv.body.parts.map((p: any) => p.text)).toEqual(['ketto', 'egy'])
    expect(texts(before)).toEqual(['egy', 'ketto'])
    const del = await callWorkbench(`/api/workbench/items/${itemId}/parts/${mv.body.parts[0].id}?new_version=1`, 'DELETE')
    expect(del.status).toBe(200)
    expect(texts()).toEqual(['egy'])
    expect(texts(mv.body.version.id)).toEqual(['ketto', 'egy'])
    expect(listWorkItemVersions(itemId)).toHaveLength(5)
  })

  it('HIBAS mentes (ures szoveg) NEM hagy maga utan ures verziot', async () => {
    const a = await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: 'szöveg' })
    const n = listWorkItemVersions(itemId).length
    const bad = await callWorkbench(`/api/workbench/items/${itemId}/parts/${a.body.part.id}?new_version=1`, 'PATCH', { text: '   ' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('text_required')
    expect(listWorkItemVersions(itemId)).toHaveLength(n)
    expect(getWorkItem(itemId)!.current_version_id).toBe(a.body.version.id)
    const empty = await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: '' })
    expect(empty.status).toBe(400)
    expect(listWorkItemVersions(itemId)).toHaveLength(n)
  })

  it('ismeretlen reszre 404, es nem keletkezik verzio', async () => {
    const n = listWorkItemVersions(itemId).length
    const r = await callWorkbench(`/api/workbench/items/${itemId}/parts/nincs?new_version=1`, 'PATCH', { text: 'x' })
    expect(r.status).toBe(404)
    expect(listWorkItemVersions(itemId)).toHaveLength(n)
  })

  it('a verziozas ELOTTI (version_id NULL) resz sem vesz el, es nem duplazodik', async () => {
    addWorkItemPart({ work_item_id: itemId, kind: 'text', text: 'régi adat' })
    getDb().prepare('UPDATE work_item_parts SET version_id = NULL WHERE work_item_id = ?').run(itemId)
    expect(texts()).toEqual(['régi adat'])
    const r = await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: 'új' })
    expect(r.status).toBe(201)
    expect(texts()).toEqual(['régi adat', 'új'])
  })

  it('a parameter NELKULI hivas a regi, helyben iro ut (az agens eszkozei ezt varjak)', async () => {
    const r = await callWorkbench(`/api/workbench/items/${itemId}/parts`, 'POST', { kind: 'text', text: 'helyben' })
    expect(r.status).toBe(201)
    expect(r.body.version).toBeUndefined()
    expect(listWorkItemVersions(itemId)).toHaveLength(1)
  })

  it('archivalt projektben semmi nem irodik (a szerver tartja be)', async () => {
    setProjectArchived(pid, true)
    const r = await callWorkbench(`/api/workbench/items/${itemId}/parts?new_version=1`, 'POST', { kind: 'text', text: 'x' })
    expect(r.status).toBe(409)
    expect(listWorkItemVersions(itemId)).toHaveLength(1)
  })
})

describe('szovegfajl kozvetlen szerkesztese: UJ fajl + UJ verzio, a regi erintetlen', () => {
  let depot = ''
  beforeEach(() => {
    setupDb()
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-edit-'))
    mkdirSync(join(depot, 'Projektek', 'teszt', 'jegyzetek'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const up = updateProject(pid, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('projektmappa')
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function textItem(rel: string, body: string) {
    writeFileSync(join(depot, ...rel.split('/')), body)
    const w = createWorkItem({ project_id: pid, title: 'Jegyzet', type: 'note', source_path: rel })
    if (!w.ok) throw new Error('munkadarab')
    return w.item.id
  }

  it('a mentes uj fajlt ir ugyanabba a mappaba, az uj verzio arra mutat, a regi fajl es verzio marad', async () => {
    const id = textItem('Projektek/teszt/jegyzetek/terv.md', 'eredeti')
    const r = await callWorkbench(`/api/workbench/items/${id}/text`, 'POST', { text: 'átírt szöveg' })
    expect(r.status).toBe(201)
    expect(r.body.version.version_no).toBe(2)
    expect(r.body.name).toBe('terv (2).md')
    expect(r.body.item.source_path).toBe('Projektek/teszt/jegyzetek/terv (2).md')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'jegyzetek', 'terv.md'), 'utf-8')).toBe('eredeti')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'jegyzetek', 'terv (2).md'), 'utf-8')).toBe('átírt szöveg')
    const v1 = listWorkItemVersions(id).find((v) => v.version_no === 1)!
    expect(v1.source_path).toBe('Projektek/teszt/jegyzetek/terv.md')
    // A kovetkezo mentes NEM "terv (2) (2).md", hanem "terv (3).md".
    const r2 = await callWorkbench(`/api/workbench/items/${id}/text`, 'POST', { text: 'harmadik' })
    expect(r2.body.name).toBe('terv (3).md')
    expect(readdirSync(join(depot, 'Projektek', 'teszt', 'jegyzetek')).sort()).toEqual(['terv (2).md', 'terv (3).md', 'terv.md'])
  })

  it('nem szovegfajl forrast, levagott (tul hosszu) elonezetet es archivalt projektet NEM ir at', async () => {
    writeFileSync(join(depot, 'Projektek', 'teszt', 'kep.png'), 'PNG')
    const img = createWorkItem({ project_id: pid, title: 'Kép', type: 'image', source_path: 'Projektek/teszt/kep.png' })
    if (!img.ok) throw new Error('kep')
    const a = await callWorkbench(`/api/workbench/items/${img.item.id}/text`, 'POST', { text: 'x' })
    expect(a.status).toBe(400)
    expect(a.body.error).toBe('text_source_unsupported')

    const big = textItem('Projektek/teszt/nagy.txt', 'x'.repeat(30_000))
    const b = await callWorkbench(`/api/workbench/items/${big}/text`, 'POST', { text: 'rövid' })
    expect(b.status).toBe(400)
    expect(b.body.error).toBe('text_source_truncated')
    expect(readFileSync(join(depot, 'Projektek', 'teszt', 'nagy.txt'), 'utf-8')).toHaveLength(30_000)

    const small = textItem('Projektek/teszt/kicsi.txt', 'a')
    setProjectArchived(pid, true)
    const c = await callWorkbench(`/api/workbench/items/${small}/text`, 'POST', { text: 'b' })
    expect(c.status).toBe(409)
  })

  it('a fajlnev-szamozas levetele', () => {
    expect(baseNameForNextVersion('Projektek/x/terv (12).md')).toBe('terv.md')
    expect(baseNameForNextVersion('terv.md')).toBe('terv.md')
    expect(baseNameForNextVersion('README')).toBe('README')
  })
})

describe('a felulet', () => {
  const ITEM = { id: 'w1', title: 'Jegyzet', type: 'note', status: 'draft', current_version_id: 'v1' }
  const PART = { id: 'pt1', kind: 'text', position: 1, text: 'Régi', version_id: 'v1' }

  function setup(preview: Record<string, unknown>, opts: { parts?: unknown[]; archived?: boolean } = {}) {
    const h = workbenchHarness()
    const project = { id: 'p1', name: 'Kovács weboldal', archived: !!opts.archived }
    h.respond((url, init) => {
      if (url.includes('/text') && init?.method === 'POST') {
        return { status: 201, body: { ok: true, item: { ...ITEM, current_version_id: 'v2' }, version: { id: 'v2', version_no: 2 }, versions: [{ id: 'v2', version_no: 2 }, { id: 'v1', version_no: 1 }], name: 'terv (2).md' } }
      }
      if (url.includes('/parts')) {
        return { status: 200, body: { ok: true, parts: [{ ...PART, id: 'pt2', text: 'Új' }], part: { ...PART, id: 'pt2' }, version: { id: 'v2', version_no: 2 }, item: { ...ITEM, current_version_id: 'v2' }, versions: [{ id: 'v2', version_no: 2, created_at: 2 }, { id: 'v1', version_no: 1, created_at: 1 }] } }
      }
      if (url.includes('/preview')) return { status: 200, body: preview }
      if (url.includes('/api/workbench/items/w1')) return { status: 200, body: { item: ITEM, versions: [{ id: 'v1', version_no: 1, created_at: 1 }], parts: opts.parts || [], project } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    return h
  }

  async function select(h: ReturnType<typeof workbenchHarness>) {
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-item="w1"'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-editor-head'))
  }

  it('a resz-mentes, -felvetel, -kivetel es -mozgatas mind UJ VERZIOT ker (new_version=1)', async () => {
    const h = setup({ available: true, kind: 'parts' }, { parts: [PART] })
    await select(h)
    await vi.waitFor(() => expect(h.html()).toContain('workbench.edit.hint_n'))
    h.click({ 'data-wb-act': 'part-edit', 'data-wb-part': 'pt1' })
    h.inputs.wbPartText = { value: 'Új', focus() {} }
    h.click({ 'data-wb-act': 'part-save', 'data-wb-part': 'pt1' })
    await vi.waitFor(() => expect(h.html()).toContain('Új'))
    const patch = h.fetchCalls.find((c) => c.init?.method === 'PATCH')!
    expect(patch.url).toContain('/parts/pt1?new_version=1')
    // A felulet a friss verziot mutatja, es a verziolista is frissult.
    expect(h.html()).toContain('"n":2')
    h.click({ 'data-wb-act': 'part-up', 'data-wb-part': 'pt2' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/parts/pt2/move?new_version=1'))).toBe(true))
  })

  it('SZOVEGFAJL: "Szoveg szerkesztese" -> mezo -> mentes UJ verziokent; a valasz fajlneve a toastban', async () => {
    const h = setup({ available: true, kind: 'text', text: 'eredeti', truncated: false, version_id: 'v1' })
    await select(h)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="text-edit"'))
    h.click({ 'data-wb-act': 'text-edit' })
    expect(h.html()).toContain('id="wbTextEdit"')
    expect(h.html()).toContain('>eredeti</textarea>')
    // Gepeles kozben egy ujrarajzolas NEM viheti el a begepelt szoveget.
    h.fire('input', { target: { id: 'wbTextEdit', value: 'átírt' } })
    h.win.MarvinWorkbench.isOpen()
    h.click({ 'data-wb-act': 'layout-toggle' })
    expect(h.html()).toContain('>átírt</textarea>')
    h.inputs.wbTextEdit = { value: 'átírt', focus() {} }
    h.click({ 'data-wb-act': 'text-save' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.edit.text_saved'))
    const post = h.fetchCalls.find((c) => c.url.includes('/items/w1/text'))!
    expect(JSON.parse(String(post.init!.body))).toEqual({ text: 'átírt' })
    expect(h.toasts.join(' ')).toContain('terv (2).md')
    expect(h.html()).not.toContain('id="wbTextEdit"')
  })

  it('Ctrl+S a szerkesztoben ment (uj verzio)', async () => {
    const h = setup({ available: true, kind: 'text', text: 'eredeti', truncated: false })
    await select(h)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="text-edit"'))
    h.click({ 'data-wb-act': 'text-edit' })
    h.inputs.wbTextEdit = { value: 'ctrl-s', focus() {} }
    let prevented = false
    h.fire('keydown', { target: { id: 'wbTextEdit' }, key: 's', ctrlKey: true, preventDefault() { prevented = true } })
    expect(prevented).toBe(true)
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/items/w1/text'))).toBe(true))
  })

  it('levagott elonezet, regebbi verzio, archivalt projekt: NINCS szerkeszto gomb (es kimondjuk, miert)', async () => {
    const cut = setup({ available: true, kind: 'text', text: 'eleje', truncated: true })
    await select(cut)
    await vi.waitFor(() => expect(cut.html()).toContain('wb-preview-text'))
    expect(cut.html()).not.toContain('data-wb-act="text-edit"')

    const arch = setup({ available: true, kind: 'text', text: 'x', truncated: false }, { archived: true })
    await select(arch)
    await vi.waitFor(() => expect(arch.html()).toContain('wb-preview-text'))
    expect(arch.html()).not.toContain('data-wb-act="text-edit"')
  })

  it('minden sajat szoveg a t()-n megy at', async () => {
    const h = setup({ available: true, kind: 'text', text: 'eredeti', truncated: false })
    await select(h)
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="text-edit"'))
    h.click({ 'data-wb-act': 'text-edit' })
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal'])).toBe('')
  })
})
