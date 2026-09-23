// AI Munkapad (kanban #336, 1. fazis): a vegpontok a VALODI utvonalkezelon at.
//
// A unit-teszt (workbench-store) a tarolast meri; ez azt meri, amit a felulet
// tenylegesen lat: hogy a keres TORZSE megerkezik, hogy ismeretlen projektre
// 404 jon (nem ures lista -- "a nulla ket dolgot jelenthet"), es hogy MINDEN
// hiba ember-nyelvu mondatot visz magaval, a keres nyelven.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived, updateProject } from '../projects.js'
import type { RouteContext } from '../web/routes/types.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import { createWorkItem, addWorkItemPart, listWorkItemParts, updateWorkItemPart } from '../workbench.js'
import { PREVIEW_TEXT_MAX } from '../workbench-preview.js'

function ctxFor(path: string, method: string, body?: unknown, headers?: Record<string, string>) {
  const out: { status: number; body: any; headers: Record<string, string> } = { status: 200, body: null, headers: {} }
  const res: any = {
    writeHead(status: number, hdrs?: Record<string, string>) {
      out.status = status
      if (hdrs) out.headers = { ...out.headers, ...hdrs }
      return res
    },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req: any = Readable.from([Buffer.from(raw, 'utf-8')])
  req.headers = { 'content-type': 'application/json', ...(headers || {}) }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: {
      req, res, path: url.pathname, method, url,
      auth: { kind: 'session' as const, user: 'teszt' },
    } as unknown as RouteContext,
    out,
  }
}

async function call(path: string, method: string, body?: unknown, headers?: Record<string, string>) {
  const { ctx, out } = ctxFor(path, method, body, headers)
  const handled = await tryHandleWorkbench(ctx)
  return { handled, ...out }
}

let projectId = ''
let otherId = ''

beforeEach(() => {
  initDatabase(':memory:')
  const a = createProject({ name: 'Kovács weboldal' })
  const b = createProject({ name: 'Másik projekt' })
  if (!a.ok || !b.ok) throw new Error('a teszt-projektek nem jottek letre')
  projectId = a.project.id
  otherId = b.project.id
})

describe('utvonal-hatar', () => {
  it('a Munkapaden kivuli utakhoz hozza sem nyul', async () => {
    expect((await call('/api/projects', 'GET')).handled).toBe(false)
    expect((await call('/api/workbench/items', 'DELETE')).handled).toBe(false)
  })
})

describe('GET /api/workbench/items', () => {
  it('projekt nelkul emberi hibat ad, nem ures listat', async () => {
    const r = await call('/api/workbench/items', 'GET')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('project_required')
    expect(r.body.message).toMatch(/projekt/i)
  })

  it('ismeretlen projektre 404, nem ures lista', async () => {
    const r = await call('/api/workbench/items?project=nincsilyen', 'GET')
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('project_not_found')
  })

  it('ures projekt: ures lista + a valaszthato fajtak', async () => {
    const r = await call(`/api/workbench/items?project=${projectId}`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body.items).toEqual([])
    expect(r.body.project.name).toBe('Kovács weboldal')
    expect(r.body.types).toContain('document')
    expect(r.body.statuses).toContain('draft')
  })
})

describe('POST /api/workbench/items', () => {
  it('letrehozas -> lista -> lekerdezes: a teljes ut a feluletrol', async () => {
    const created = await call('/api/workbench/items', 'POST', { project_id: projectId, title: 'Ajánlat', type: 'document' })
    expect(created.status).toBe(201)
    expect(created.body.item.title).toBe('Ajánlat')
    expect(created.body.item.project_id).toBe(projectId)
    // A v1 verzio a letrehozas reszekent keletkezik.
    expect(created.body.versions).toHaveLength(1)
    expect(created.body.versions[0].version_no).toBe(1)
    expect(created.body.item.current_version_id).toBe(created.body.versions[0].id)
    // Ki hozta letre: a bejelentkezett munkamenet, nem beegetett nev.
    expect(created.body.item.created_by).toBe('teszt')

    const id = created.body.item.id
    const list = await call(`/api/workbench/items?project=${projectId}`, 'GET')
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([id])

    const one = await call(`/api/workbench/items/${id}`, 'GET')
    expect(one.status).toBe(200)
    expect(one.body.item.id).toBe(id)
    expect(one.body.versions).toHaveLength(1)
    expect(one.body.project.id).toBe(projectId)
  })

  it('a masik projekt listajaban nem jelenik meg', async () => {
    await call('/api/workbench/items', 'POST', { project_id: projectId, title: 'Ajánlat' })
    const other = await call(`/api/workbench/items?project=${otherId}`, 'GET')
    expect(other.body.items).toEqual([])
  })

  it('cim nelkul emberi magyar mondatot ad', async () => {
    const r = await call('/api/workbench/items', 'POST', { project_id: projectId, title: '  ' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('title_required')
    expect(r.body.message).toMatch(/[áéíóöőúüű]/i)
  })

  it('angol nyelven angol mondatot ad', async () => {
    const r = await call('/api/workbench/items?lang=en', 'POST', { project_id: projectId, title: '' })
    expect(r.body.message).toBe('Give the work item a name (for example: "Offer for Mr Smith").')
  })

  it('ismeretlen fajta elutasitva, es semmi nem keletkezik', async () => {
    const r = await call('/api/workbench/items', 'POST', { project_id: projectId, title: 'X', type: 'hologram' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_type')
    const list = await call(`/api/workbench/items?project=${projectId}`, 'GET')
    expect(list.body.items).toEqual([])
  })

  it('ismeretlen projektre nem lehet munkadarabot tenni', async () => {
    const r = await call('/api/workbench/items', 'POST', { project_id: 'nincsilyen', title: 'X' })
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('project_not_found')
  })

  it('ertelmezhetetlen torzsre emberi hiba jon', async () => {
    const r = await call('/api/workbench/items', 'POST', 'nem json')
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('bad_json')
  })
})

describe('GET /api/workbench/items/:id', () => {
  it('ismeretlen munkadarabra 404, emberi mondattal', async () => {
    const r = await call('/api/workbench/items/nincsilyen', 'GET')
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('not_found')
    expect(r.body.message.length).toBeGreaterThan(10)
  })
})

// --- VEGYES munkadarab: a reszek vegpontjai (3. fazis) ----------------------
describe('reszek (vegyes munkadarab)', () => {
  let itemId = ''

  beforeEach(async () => {
    const r = await call('/api/workbench/items', 'POST', { project_id: projectId, title: 'Facebook-poszt', type: 'composite' })
    itemId = r.body.item.id
  })

  it('a munkadarab lekerdezese a RESZEKET is hozza (ures munkadarabnal ures listat)', async () => {
    const r = await call(`/api/workbench/items/${itemId}`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body.parts).toEqual([])
    expect(r.body.part_kinds).toEqual(['text', 'image'])
  })

  it('szoveg-resz felvetele, majd a lista frissen jon vissza', async () => {
    const r = await call(`/api/workbench/items/${itemId}/parts`, 'POST', { kind: 'text', text: 'Elkészült a felújítás.' })
    expect(r.status).toBe(201)
    expect(r.body.part.kind).toBe('text')
    expect(r.body.parts).toHaveLength(1)
  })

  it('ures szovegre emberi mondat jon, nem gepi kod', async () => {
    const r = await call(`/api/workbench/items/${itemId}/parts`, 'POST', { kind: 'text', text: '   ' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('text_required')
    expect(r.body.message).toMatch(/[a-zíűáéúőóüö]/i)
    expect(r.body.message).not.toBe(r.body.error)
  })

  it('a felirat javitasa nem torli a kep utjat', async () => {
    const add = await call(`/api/workbench/items/${itemId}/parts`, 'POST', { kind: 'image', asset_path: 'Projektek/foto.jpg' })
    const partId = add.body.part.id
    const r = await call(`/api/workbench/items/${itemId}/parts/${partId}`, 'PATCH', { caption: 'A bejárat' })
    expect(r.status).toBe(200)
    expect(r.body.part.caption).toBe('A bejárat')
    expect(r.body.part.asset_path).toBe('Projektek/foto.jpg')
  })

  it('mozgatas: a sorrend a valaszban jon vissza, rossz iranyra emberi hiba', async () => {
    const a = await call(`/api/workbench/items/${itemId}/parts`, 'POST', { kind: 'text', text: 'egy' })
    await call(`/api/workbench/items/${itemId}/parts`, 'POST', { kind: 'text', text: 'ketto' })
    const r = await call(`/api/workbench/items/${itemId}/parts/${a.body.part.id}/move`, 'POST', { dir: 'down' })
    expect(r.status).toBe(200)
    expect(r.body.parts.map((p: any) => p.text)).toEqual(['ketto', 'egy'])
    const bad = await call(`/api/workbench/items/${itemId}/parts/${a.body.part.id}/move`, 'POST', { dir: 'oldalra' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('bad_move')
  })

  it('a resz kivetele 200-at ad, ismeretlen reszre 404-et (nem csendes sikert)', async () => {
    const a = await call(`/api/workbench/items/${itemId}/parts`, 'POST', { kind: 'text', text: 'egy' })
    const r = await call(`/api/workbench/items/${itemId}/parts/${a.body.part.id}`, 'DELETE')
    expect(r.status).toBe(200)
    expect(r.body.parts).toEqual([])
    const nincs = await call(`/api/workbench/items/${itemId}/parts/nincs-ilyen`, 'DELETE')
    expect(nincs.status).toBe(404)
    expect(nincs.body.error).toBe('part_not_found')
  })

  it('kep-feltoltes mappa NELKULI projektben: megmondja, mi hianyzik es hol kell beallitani', async () => {
    // Friss telepites: a projektnek nincs mappaja. A valasz NEM gepi kod, es
    // nem is csendes siker -- megmondja a teendot.
    const { ctx, out } = ctxFor(`/api/workbench/items/${itemId}/parts/image?name=kep.jpg`, 'POST', 'BINARIS')
    await tryHandleWorkbench(ctx)
    expect(out.status).toBe(400)
    expect(['no_folder', 'no_depot']).toContain(out.body.error)
    expect(out.body.message.length).toBeGreaterThan(20)
  })
})

describe('archivalt projekt: CSAK OLVASHATO (a szerver tartja be, nem a kepernyo)', () => {
  it('archivalt projektben nem jon letre se munkadarab, se resz -- emberi mondattal', async () => {
    const item = createWorkItem({ project_id: projectId, title: 'Poszt', type: 'composite' })
    if (!item.ok) throw new Error('munkadarab')
    if (!setProjectArchived(projectId, true)) throw new Error('archivalas')

    const created = await call('/api/workbench/items', 'POST', { project_id: projectId, title: 'Új', type: 'note' })
    expect(created.status).toBe(409)
    expect(created.body.error).toBe('project_archived')
    expect(String(created.body.message)).toMatch(/archiválva/)

    const part = await call(`/api/workbench/items/${item.item.id}/parts`, 'POST', { kind: 'text', text: 'szöveg' })
    expect(part.status).toBe(409)
    expect(part.body.error).toBe('project_archived')

    const del = await call(`/api/workbench/items/${item.item.id}/parts/akarmi`, 'DELETE')
    expect(del.status).toBe(409)
  })

  it('az OLVASAS viszont megy: a meglevo reszeket latni kell', async () => {
    const item = createWorkItem({ project_id: projectId, title: 'Poszt', type: 'composite' })
    if (!item.ok) throw new Error('munkadarab')
    const p = addWorkItemPart({ work_item_id: item.item.id, kind: 'text', text: 'A poszt szövege' })
    if (!p.ok) throw new Error('resz')
    if (!setProjectArchived(projectId, true)) throw new Error('archivalas')

    const r = await call(`/api/workbench/items/${item.item.id}`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body.parts).toHaveLength(1)
    expect(r.body.project.archived).toBe(true)
  })
})

// --- 4. fazis: ELONEZET ----------------------------------------------------
//
// A legfontosabb, amit oriz: az ures elonezet MINDIG megmondja, MIERT ures --
// "meg nincs semmi" es "nem latok oda" KET kulon mondat, nem ugyanaz a csend.

describe('GET /api/workbench/items/:id/preview', () => {
  let depot = ''
  let itemId = ''

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-prev-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    const w = createWorkItem({ project_id: projectId, title: 'Ajánlat', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function useDepot() {
    process.env['MARVEEN_DEPOT'] = depot
    const up = updateProject(projectId, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('projektmappa: ' + up.code)
  }

  it('ures munkadarab: BARATSAGOS mondat, es kimondja, hogy nincs meg fajl', async () => {
    useDepot()
    const r = await call(`/api/workbench/items/${itemId}/preview`, 'GET')
    expect(r.status).toBe(200)
    expect(r.body.available).toBe(false)
    expect(r.body.reason).toBe('no_source')
    expect(String(r.body.message)).toMatch(/nincs megjeleníthető/i)
  })

  it('a sajat reszei a tartalom: kep/szoveg-reszeknel az elonezet "parts"', async () => {
    useDepot()
    const p = addWorkItemPart({ work_item_id: itemId, kind: 'text', text: 'A poszt szövege' })
    if (!p.ok) throw new Error('resz')
    const r = await call(`/api/workbench/items/${itemId}/preview`, 'GET')
    expect(r.body.available).toBe(true)
    expect(r.body.kind).toBe('parts')
  })

  it('PDF: megmutathato, es a KESZ cimet adja a meglevo fajl-kiszolgalohoz', async () => {
    useDepot()
    writeFileSync(join(depot, 'Projektek', 'teszt', 'ajanlat.pdf'), '%PDF-1.4 teszt')
    const w = createWorkItem({ project_id: projectId, title: 'PDF', type: 'document', source_path: 'ajanlat.pdf' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(r.body.available).toBe(true)
    expect(r.body.kind).toBe('pdf')
    expect(r.body.mime).toBe('application/pdf')
    expect(String(r.body.url)).toContain('/api/life/file?rel=')
    // A gyorsitotar-jelzes a verziohoz/fajlhoz kotott, nem allando.
    expect(String(r.body.etag).length).toBeGreaterThan(3)
  })

  it('a NULLA ket dolgot jelenthet: a HIANYZO fajl mas mondat, mint az "ures"', async () => {
    useDepot()
    const w = createWorkItem({ project_id: projectId, title: 'Eltűnt', type: 'document', source_path: 'nincs-ilyen.pdf' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(r.body.available).toBe(false)
    expect(r.body.reason).toBe('missing')
    expect(String(r.body.message)).not.toMatch(/nincs megjeleníthető tartalom/i)
    expect(String(r.body.message)).toMatch(/lemezen nincs ott|átnevezték/i)
  })

  it('nincs Raktar: SAJAT mondat, a teendovel -- nem "ures munkadarab"', async () => {
    delete process.env['MARVEEN_DEPOT']
    const w = createWorkItem({ project_id: projectId, title: 'PDF', type: 'document', source_path: 'ajanlat.pdf' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(r.body.available).toBe(false)
    expect(r.body.reason).toBe('no_depot')
    expect(String(r.body.message)).toMatch(/Raktár/)
  })

  it('amit a bongeszo nem tud megmutatni (docx), arra SAJAT mondat jon', async () => {
    useDepot()
    writeFileSync(join(depot, 'Projektek', 'teszt', 'szerzodes.docx'), 'PK teszt')
    const w = createWorkItem({ project_id: projectId, title: 'DOCX', type: 'document', source_path: 'szerzodes.docx' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(r.body.available).toBe(false)
    expect(r.body.reason).toBe('unsupported')
    expect(r.body.rel).toContain('szerzodes.docx')
  })

  it('szoveg: a tartalom jon vissza, hosszunal levagva es KIMONDVA', async () => {
    useDepot()
    writeFileSync(join(depot, 'Projektek', 'teszt', 'jegyzet.txt'), 'x'.repeat(PREVIEW_TEXT_MAX + 500))
    const w = createWorkItem({ project_id: projectId, title: 'Jegyzet', type: 'note', source_path: 'jegyzet.txt' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(r.body.available).toBe(true)
    expect(r.body.kind).toBe('text')
    expect(String(r.body.text).length).toBe(PREVIEW_TEXT_MAX)
    expect(r.body.truncated).toBe(true)
  })

  it('gyorsitotar: valtozatlan fajlra 304 jon, uj bajtok nelkul', async () => {
    useDepot()
    writeFileSync(join(depot, 'Projektek', 'teszt', 'jegyzet.txt'), 'rovid szoveg')
    const w = createWorkItem({ project_id: projectId, title: 'Jegyzet', type: 'note', source_path: 'jegyzet.txt' })
    if (!w.ok) throw new Error('munkadarab')
    const first = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(first.status).toBe(200)
    const tag = String(first.headers['ETag'] || '')
    expect(tag.length).toBeGreaterThan(3)

    const again = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET', undefined, { 'if-none-match': tag })
    expect(again.status).toBe(304)
    expect(again.body).toBe(null)

    // MAS nyelven MAS mondat jon: ugyanaz a jelzes ott nem ervenyes.
    const en = await call(`/api/workbench/items/${w.item.id}/preview?lang=en`, 'GET', undefined, { 'if-none-match': tag })
    expect(en.status).toBe(200)
  })

  it('angolul is emberi mondat jon (nem gepi kod)', async () => {
    useDepot()
    const r = await call(`/api/workbench/items/${itemId}/preview?lang=en`, 'GET')
    expect(String(r.body.message)).toMatch(/nothing to show/i)
  })
})

// --- 5. fazis: VERZIOZAS a vegpontokon --------------------------------------

describe('verziozas vegpontok', () => {
  it('POST /versions: uj verzio, es a lista a frissel ter vissza', async () => {
    const w = createWorkItem({ project_id: projectId, title: 'Poszt', type: 'composite' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/versions`, 'POST', {})
    expect(r.status).toBe(201)
    expect(r.body.version.version_no).toBe(2)
    expect(r.body.versions.length).toBe(2)
    expect(r.body.item.current_version_id).toBe(r.body.version.id)
  })

  it('POST /versions/:id/restore: UJ verzio lesz, a kozbensok megmaradnak', async () => {
    const w = createWorkItem({ project_id: projectId, title: 'Poszt', type: 'composite' })
    if (!w.ok) throw new Error('munkadarab')
    const p = addWorkItemPart({ work_item_id: w.item.id, kind: 'text', text: 'elso' })
    if (!p.ok) throw new Error('resz')
    await call(`/api/workbench/items/${w.item.id}/versions`, 'POST', {})
    const live = listWorkItemParts(w.item.id)
    updateWorkItemPart(live[0]!.id, { text: 'masodik' })

    const r = await call(`/api/workbench/items/${w.item.id}/versions/${w.version.id}/restore`, 'POST', {})
    expect(r.status).toBe(201)
    expect(r.body.version.version_no).toBe(3)
    expect(r.body.versions.length).toBe(3)
    expect(r.body.parts[0].text).toBe('elso')
    // A felulet szamot lat arrol, mibol allt vissza.
    expect(r.body.versions[0].restored_from_no).toBe(1)
  })

  it('MASIK munkadarab verzioja: sajat, EMBERI mondat -- nem "nem talalom"', async () => {
    const a = createWorkItem({ project_id: projectId, title: 'A' })
    const b = createWorkItem({ project_id: projectId, title: 'B' })
    if (!a.ok || !b.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${b.item.id}/versions/${a.version.id}/restore`, 'POST', {})
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('version_mismatch')
    expect(String(r.body.message)).toMatch(/nem ehhez a munkadarabhoz/i)
  })

  it('ismeretlen verzio: 404 es emberi mondat, nem ures valasz', async () => {
    const w = createWorkItem({ project_id: projectId, title: 'A' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/versions/nincs-ilyen/restore`, 'POST', {})
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('version_not_found')
    expect(String(r.body.message)).toMatch(/nincs meg/i)
  })

  it('archivalt projekt: a verziozas is csak-olvashato (a szerver mondja ki)', async () => {
    const w = createWorkItem({ project_id: projectId, title: 'A' })
    if (!w.ok) throw new Error('munkadarab')
    setProjectArchived(projectId, true)
    const a = await call(`/api/workbench/items/${w.item.id}/versions`, 'POST', {})
    expect(a.status).toBe(409)
    expect(a.body.error).toBe('project_archived')
    const b = await call(`/api/workbench/items/${w.item.id}/versions/${w.version.id}/restore`, 'POST', {})
    expect(b.status).toBe(409)
  })

  it('az elonezet a KERT regi verzio pillanatkepet mutatja, nem az elot', async () => {
    const w = createWorkItem({ project_id: projectId, title: 'Poszt', type: 'composite' })
    if (!w.ok) throw new Error('munkadarab')
    const p = addWorkItemPart({ work_item_id: w.item.id, kind: 'text', text: 'elso' })
    if (!p.ok) throw new Error('resz')
    await call(`/api/workbench/items/${w.item.id}/versions`, 'POST', {})
    const live = listWorkItemParts(w.item.id)
    updateWorkItemPart(live[0]!.id, { text: 'masodik' })

    const now = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(now.body.kind).toBe('parts')
    const old = await call(`/api/workbench/items/${w.item.id}/preview?version=${w.version.id}`, 'GET')
    expect(old.body.available).toBe(true)
    expect(old.body.kind).toBe('parts')
    expect(old.body.version_no).toBe(1)
  })
})
