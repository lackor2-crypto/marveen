// AI Munkapad (kanban #336, 1. fazis): a vegpontok a VALODI utvonalkezelon at.
//
// A unit-teszt (workbench-store) a tarolast meri; ez azt meri, amit a felulet
// tenylegesen lat: hogy a keres TORZSE megerkezik, hogy ismeretlen projektre
// 404 jon (nem ures lista -- "a nulla ket dolgot jelenthet"), es hogy MINDEN
// hiba ember-nyelvu mondatot visz magaval, a keres nyelven.
import { describe, it, expect, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { initDatabase } from '../db.js'
import { createProject, setProjectArchived } from '../projects.js'
import type { RouteContext } from '../web/routes/types.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import { createWorkItem, addWorkItemPart } from '../workbench.js'

function ctxFor(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    setHeader() { return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const raw = body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  const req: any = Readable.from([Buffer.from(raw, 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  return {
    ctx: {
      req, res, path: url.pathname, method, url,
      auth: { kind: 'session' as const, user: 'teszt' },
    } as unknown as RouteContext,
    out,
  }
}

async function call(path: string, method: string, body?: unknown) {
  const { ctx, out } = ctxFor(path, method, body)
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
