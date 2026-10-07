// AI Munkapad (kanban #336, 1. fazis): a vegpontok a VALODI utvonalkezelon at.
//
// A unit-teszt (workbench-store) a tarolast meri; ez azt meri, amit a felulet
// tenylegesen lat: hogy a keres TORZSE megerkezik, hogy ismeretlen projektre
// 404 jon (nem ures lista -- "a nulla ket dolgot jelenthet"), es hogy MINDEN
// hiba ember-nyelvu mondatot visz magaval, a keres nyelven.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, getProject, setProjectArchived, updateProject } from '../projects.js'
import type { RouteContext } from '../web/routes/types.js'
import { tryHandleWorkbench } from '../web/routes/workbench.js'
import { createWorkItem, addWorkItemPart, listWorkItemParts, updateWorkItemPart } from '../workbench.js'
import { PREVIEW_TEXT_MAX } from '../workbench-preview.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { resetCapabilityProbes } from '../workbench-capabilities.js'
import { getEffectiveSettingValue, reloadOverridesForTest, setOverride } from '../settings-store.js'
import { setItemSensitive } from '../workbench-privacy.js'
import { executeTool } from '../workbench-agent/execute.js'
import { PROJECT_ROOT } from '../config.js'

// A valasz VALODI irhato folyam, nem objektum-mock: a kesz PDF-et a vegpont
// `createReadStream(...).pipe(res)`-szel adja ki, amihez a `pipe` igazi
// Writable-t var. Igy ugyanaz a harness meri a JSON-valaszokat es a bajtokat.
function ctxFor(path: string, method: string, body?: unknown, headers?: Record<string, string>) {
  const chunks: Buffer[] = []
  const out: { status: number; body: any; raw: Buffer; headers: Record<string, string>; done: Promise<void> } = {
    status: 200, body: null, raw: Buffer.alloc(0), headers: {}, done: Promise.resolve(),
  }
  const res: any = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) { chunks.push(Buffer.from(chunk)); cb() },
  })
  out.done = new Promise<void>((resolve) => { res.on('finish', () => resolve()) })
  res.writeHead = (status: number, hdrs?: Record<string, string>) => {
    out.status = status
    if (hdrs) out.headers = { ...out.headers, ...hdrs }
    return res
  }
  res.setHeader = (k: string, v: unknown) => { out.headers[k] = String(v); return res }
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
    collect() {
      out.raw = Buffer.concat(chunks)
      const s = out.raw.toString('utf-8')
      // Nem minden valasz JSON (a kesz PDF bajtjai nem azok) -- ilyenkor a
      // `body` marad null, es a teszt a `raw`-ot nezi.
      try { out.body = s ? JSON.parse(s) : null } catch { out.body = null }
    },
  }
}

async function call(path: string, method: string, body?: unknown, headers?: Record<string, string>) {
  const { ctx, out, collect } = ctxFor(path, method, body, headers)
  const handled = await tryHandleWorkbench(ctx)
  // Ha a vegpont hozza sem nyult az uthoz, a valasz sosem zarodik le -- akkor
  // nincs mire varni.
  if (handled) await out.done
  collect()
  return { handled, status: out.status, body: out.body, raw: out.raw, headers: out.headers }
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
    const r = await call(`/api/workbench/items/${itemId}/parts/image?name=kep.jpg`, 'POST', 'BINARIS')
    expect(r.status).toBe(400)
    expect(['no_folder', 'no_depot']).toContain(r.body.error)
    expect(r.body.message.length).toBeGreaterThan(20)
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

// #336 atvizsgalas: a resz-vegpontok eddig csak a resz azonositojat neztek.
// Egy MASIK munkadarab URL-jen at (akar egy archivalt projekte) at lehetett
// irni, es egy REGI verzio pillanatkepe is szerkesztheto/torolheto volt.
describe('reszek: csak a SAJAT munkadarab ELO resze irhato', () => {
  it('masik munkadarab reszet nem lehet a sajat URL-en at irni, mozgatni, torolni', async () => {
    const a = createWorkItem({ project_id: otherId, title: 'Idegen', type: 'composite' })
    const b = createWorkItem({ project_id: projectId, title: 'Sajat', type: 'composite' })
    if (!a.ok || !b.ok) throw new Error('munkadarab')
    const p = addWorkItemPart({ work_item_id: a.item.id, kind: 'text', text: 'idegen szoveg' })
    if (!p.ok) throw new Error('resz')
    setProjectArchived(otherId, true)

    const patch = await call(`/api/workbench/items/${b.item.id}/parts/${p.part.id}`, 'PATCH', { text: 'feltort' })
    expect(patch.status).toBe(404)
    const move = await call(`/api/workbench/items/${b.item.id}/parts/${p.part.id}/move`, 'POST', { dir: 'up' })
    expect(move.status).toBe(404)
    const del = await call(`/api/workbench/items/${b.item.id}/parts/${p.part.id}`, 'DELETE')
    expect(del.status).toBe(404)
    expect(listWorkItemParts(a.item.id).map((x) => x.text)).toEqual(['idegen szoveg'])
  })

  it('egy REGI verzio resze nem irhato at es nem torolheto -- a tortenet valtozatlan', async () => {
    const w = createWorkItem({ project_id: projectId, title: 'Poszt', type: 'composite' })
    if (!w.ok) throw new Error('munkadarab')
    const p = addWorkItemPart({ work_item_id: w.item.id, kind: 'text', text: 'elso' })
    if (!p.ok) throw new Error('resz')
    await call(`/api/workbench/items/${w.item.id}/versions`, 'POST', {})
    const old = listWorkItemParts(w.item.id, w.version.id)
    expect(old).toHaveLength(1)
    const oldId = old[0]!.id

    const patch = await call(`/api/workbench/items/${w.item.id}/parts/${oldId}`, 'PATCH', { text: 'atirt tortenet' })
    expect(patch.status).toBe(404)
    const del = await call(`/api/workbench/items/${w.item.id}/parts/${oldId}`, 'DELETE')
    expect(del.status).toBe(404)
    expect(listWorkItemParts(w.item.id, w.version.id).map((x) => x.text)).toEqual(['elso'])

    // Az ELO resz tovabbra is szerkesztheto.
    const live = listWorkItemParts(w.item.id)
    const ok = await call(`/api/workbench/items/${w.item.id}/parts/${live[0]!.id}`, 'PATCH', { text: 'masodik' })
    expect(ok.status).toBe(200)
  })
})

describe('GET /api/workbench/items/:id/preview', () => {
  let depot = ''
  let itemId = ''

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-prev-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    // Az atalakitott PDF gyorsitotara SOHA ne a valodi `store/`-ba keruljon.
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    resetLibreOfficeProbe()
    const w = createWorkItem({ project_id: projectId, title: 'Ajánlat', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
    delete process.env['MARVEEN_RENDER_CACHE']
    resetLibreOfficeProbe()
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

  it('a docx-et a bongeszo nem tudja, DE atalakithato -- sajat, teendot mondo allapot', async () => {
    useDepot()
    writeFileSync(join(depot, 'Projektek', 'teszt', 'szerzodes.docx'), 'PK teszt')
    const w = createWorkItem({ project_id: projectId, title: 'DOCX', type: 'document', source_path: 'szerzodes.docx' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(r.body.available).toBe(false)
    // Ez NEM "unsupported": van teendo (atalakitas), es a felulet gombot ad ra.
    expect(r.body.reason).toBe('needs_conversion')
    expect(r.body.kind).toBe('office')
    expect(r.body.office).toEqual({ ext: 'docx', ready: false })
    expect(r.body.rel).toContain('szerzodes.docx')
    expect(String(r.body.message)).toMatch(/PDF/i)
  })

  it('amit tenyleg nem lehet megmutatni (zip), arra tovabbra is "unsupported" jon', async () => {
    useDepot()
    writeFileSync(join(depot, 'Projektek', 'teszt', 'mentes.zip'), 'PK teszt')
    const w = createWorkItem({ project_id: projectId, title: 'ZIP', type: 'document', source_path: 'mentes.zip' })
    if (!w.ok) throw new Error('munkadarab')
    const r = await call(`/api/workbench/items/${w.item.id}/preview`, 'GET')
    expect(r.body.available).toBe(false)
    expect(r.body.reason).toBe('unsupported')
    expect(r.body.office).toBe(null)
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

// ---------------------------------------------------------------------------
// KEPESSEGEK es PDF-ATALAKITAS (7. fazis, spec 8 + 24)
//
// Amit ez oriz: a "nincs telepitve LibreOffice" es a "nem tudtam megkerdezni"
// KET KULON valasz, ket kulon teendovel -- es EGYIK sem latszik sikernek. A
// teszt sajat, hamis `soffice`-szal dolgozik, tehat ugyanazt meri azon a gepen
// is, ahol van LibreOffice, es azon is, ahol nincs.

describe('Munkapad: kepessegek es atalakitas PDF-re (7. fazis)', () => {
  let depot = ''
  let docxItemId = ''
  const savedEnv: Record<string, string | undefined> = {}

  /** A `--version` valaszol, a `--convert-to` pedig a kert mappaba ir egy PDF-et. */
  const WORKING = `
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"
done
printf '%%PDF-1.4 teszt' > "$out/atalakitott.pdf"
exit 0
`

  function fakeSoffice(body: string): string {
    const f = join(depot, `fake-soffice-${Math.random().toString(36).slice(2)}.sh`)
    writeFileSync(f, `#!/bin/sh\n${body}\n`, 'utf-8')
    chmodSync(f, 0o755)
    process.env['MARVEEN_SOFFICE'] = f
    resetLibreOfficeProbe()
    return f
  }

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-conv-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    writeFileSync(join(depot, 'Projektek', 'teszt', 'szerzodes.docx'), 'PK teszt')
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) savedEnv[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    // Alapbol: a beallitott ut NEM letezik -- igy a teszt sosem a gep sajat
    // LibreOffice-at meri, es a "nincs meg" ut is vegigjarhato.
    process.env['MARVEEN_SOFFICE'] = join(depot, 'nincs-ilyen-soffice')
    resetLibreOfficeProbe()
    const up = updateProject(projectId, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('projektmappa: ' + up.code)
    const w = createWorkItem({ project_id: projectId, title: 'Szerződés', type: 'document', source_path: 'szerzodes.docx' })
    if (!w.ok) throw new Error('munkadarab')
    docxItemId = w.item.id
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmSync(depot, { recursive: true, force: true })
  })

  /** A lista tobb kepesseget ad vissza (8. fazis), ezert KULCS szerint
   *  keresunk -- a sorrendre epiteni torekeny volna. */
  function capOf(body: any, key: string): any {
    return (body.capabilities || []).find((c: any) => c.key === key)
  }

  describe('GET /api/workbench/capabilities', () => {
    it('ha nem tudtam megkerdezni, az NEM "nincs telepitve" -- sajat allapot, valodi hibauzenettel', async () => {
      const r = await call('/api/workbench/capabilities', 'GET')
      expect(r.status).toBe(200)
      const cap = capOf(r.body, 'office_to_pdf')
      expect(cap.key).toBe('office_to_pdf')
      expect(cap.available).toBe(false)
      expect(cap.state).toBe('check_failed')
      // A `detail` a VALODI hibauzenet, nem talalgatas -- es megnevezi a beallitast.
      expect(String(cap.detail)).toContain('MARVEEN_SOFFICE=')
      expect(String(cap.message)).toMatch(/nem azt jelenti|nem tudtam|nem sikerült/i)
      expect(cap.extensions).toContain('docx')
      // Nem alapfunkcio: a hianya nem veszjelzes.
      expect(cap.optional).toBe(true)
    })

    it('ha ott van, kiirja a valodi verziot es az utat', async () => {
      const f = fakeSoffice(WORKING)
      const r = await call('/api/workbench/capabilities', 'GET')
      const cap = capOf(r.body, 'office_to_pdf')
      expect(cap.available).toBe(true)
      expect(cap.state).toBe('ok')
      expect(String(cap.version)).toContain('LibreOffice')
      expect(cap.path).toBe(f)
      expect(String(cap.message)).toMatch(/elérhető/i)
    })

    it('a valasz a keres nyelven szol (en)', async () => {
      const r = await call('/api/workbench/capabilities?lang=en', 'GET')
      const cap = capOf(r.body, 'office_to_pdf')
      expect(String(cap.title)).toMatch(/preview/i)
      expect(String(cap.what_for)).toMatch(/Workbench/)
    })
  })

  describe('POST /api/workbench/items/:id/convert', () => {
    it('LibreOffice nelkul NEM siker: 501, ember-nyelvu mondat + a valodi hibauzenet', async () => {
      const r = await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      expect(r.status).toBe(501)
      expect(r.body.error).toBe('convert_check_failed')
      expect(String(r.body.message).length).toBeGreaterThan(20)
      expect(String(r.body.detail)).toContain('MARVEEN_SOFFICE=')
      expect(r.body.capability.state).toBe('check_failed')
    })

    it('ha nincs telepitve, a mondat megmondja MIT es HOGYAN kell telepiteni', async () => {
      delete process.env['MARVEEN_SOFFICE']
      resetLibreOfficeProbe()
      // Ezen a gepen lehet, hogy VAN LibreOffice -- akkor ez az ut nem
      // ertelmezheto, es a teszt nem allit semmit rola.
      const cap = capOf((await call('/api/workbench/capabilities', 'GET')).body, 'office_to_pdf')
      if (cap.available) return
      const r = await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      expect(r.status).toBe(501)
      expect(String(r.body.message)).toMatch(/libreoffice/i)
      expect(String(r.body.message)).toMatch(/apt|install/i)
    })

    it('atalakit, masodszor mar a gyorsitotarbol veszi', async () => {
      fakeSoffice(WORKING)
      const first = await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      expect(first.status).toBe(200)
      expect(first.body.ok).toBe(true)
      expect(first.body.cached).toBe(false)
      expect(first.body.ext).toBe('docx')
      expect(String(first.body.url)).toContain(`/api/workbench/items/${docxItemId}/converted`)

      const second = await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      expect(second.status).toBe(200)
      expect(second.body.cached).toBe(true)
      // Nem maradhat ideiglenes mappa a gyorsitotarban.
      expect(readdirSync(join(depot, 'render-cache')).filter((n) => n.startsWith('tmp-'))).toEqual([])
    })

    it('ami nem irodai dokumentum, arra nem is indul atalakitas', async () => {
      writeFileSync(join(depot, 'Projektek', 'teszt', 'jegyzet.txt'), 'szia')
      const w = createWorkItem({ project_id: projectId, title: 'Jegyzet', type: 'note', source_path: 'jegyzet.txt' })
      if (!w.ok) throw new Error('munkadarab')
      const r = await call(`/api/workbench/items/${w.item.id}/convert`, 'POST', {})
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('convert_unsupported')
    })

    it('ARCHIVALT projektben is megnezheto a dokumentum (az elonezet olvasas, nem iras)', async () => {
      fakeSoffice(WORKING)
      setProjectArchived(projectId, true)
      const r = await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      expect(r.status).toBe(200)
      expect(r.body.ok).toBe(true)
    })
  })

  describe('GET /api/workbench/items/:id/converted', () => {
    it('amig nincs kesz: 409 + a teendot mondo mondat, nem ures valasz', async () => {
      const r = await call(`/api/workbench/items/${docxItemId}/converted`, 'GET')
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('convert_not_ready')
      expect(String(r.body.message).length).toBeGreaterThan(10)
    })

    it('ha kesz: a PDF BAJTJAI jonnek, eltarolas nelkul', async () => {
      fakeSoffice(WORKING)
      await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      const r = await call(`/api/workbench/items/${docxItemId}/converted`, 'GET')
      expect(r.status).toBe(200)
      expect(r.headers['Content-Type']).toBe('application/pdf')
      expect(r.headers['Cache-Control']).toBe('private, no-store')
      expect(r.raw.toString('utf-8')).toContain('%PDF')
      expect(Number(r.headers['Content-Length'])).toBe(r.raw.length)
      expect(String(r.headers['Content-Disposition'])).toContain('inline')
    })

    it('letolteskor a fajlnev a dokumentume, .pdf vegzodessel', async () => {
      fakeSoffice(WORKING)
      await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      const r = await call(`/api/workbench/items/${docxItemId}/converted?download=1`, 'GET')
      expect(r.status).toBe(200)
      const cd = String(r.headers['Content-Disposition'])
      expect(cd).toContain('attachment')
      expect(decodeURIComponent(cd)).toContain('szerzodes.pdf')
    })

    it('a forras valtozasa utan NEM a regi PDF jon vissza', async () => {
      fakeSoffice(WORKING)
      await call(`/api/workbench/items/${docxItemId}/convert`, 'POST', {})
      // A dokumentum megvaltozott: a gyorsitotar kulcsa a forras allapotabol jon.
      writeFileSync(join(depot, 'Projektek', 'teszt', 'szerzodes.docx'), 'PK teszt -- MASODIK valtozat')
      const r = await call(`/api/workbench/items/${docxItemId}/converted`, 'GET')
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('convert_not_ready')
    })
  })

  describe('POST /api/workbench/items/:id/document', () => {
    it('visszatoltott dokumentum = UJ VERZIO, a regi megmarad', async () => {
      const r = await call(
        `/api/workbench/items/${docxItemId}/document?name=szerzodes-javitott.docx&prompt=${encodeURIComponent('kézi javítás')}`,
        'POST', 'PK ujabb tartalom')
      expect(r.status).toBe(201)
      expect(r.body.ok).toBe(true)
      expect(r.body.renamed).toBe(false)
      expect(r.body.name).toBe('szerzodes-javitott.docx')
      expect(r.body.item.current_version_id).toBe(r.body.version.id)
      expect(r.body.version.source_path).toContain('szerzodes-javitott.docx')
      expect(r.body.versions.length).toBeGreaterThanOrEqual(2)
    })

    it('foglalt nevnel ATNEVEZ, es KIMONDJA az uj nevet -- semmit nem ir felul', async () => {
      const r = await call(`/api/workbench/items/${docxItemId}/document?name=szerzodes.docx`, 'POST', 'PK masik')
      expect(r.status).toBe(201)
      expect(r.body.renamed).toBe(true)
      expect(r.body.name).not.toBe('szerzodes.docx')
      // Az eredeti bajtjai valtozatlanok maradtak.
      expect(readdirSync(join(depot, 'Projektek', 'teszt'))).toContain('szerzodes.docx')
    })

    it('ures fajlra emberi hiba jon, nem ures verzio', async () => {
      const r = await call(`/api/workbench/items/${docxItemId}/document?name=ures.docx`, 'POST', '')
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('empty_file')
    })

    it('ARCHIVALT projektbe nem lehet visszatolteni (a szerver mondja ki)', async () => {
      setProjectArchived(projectId, true)
      const r = await call(`/api/workbench/items/${docxItemId}/document?name=uj.docx`, 'POST', 'PK')
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('project_archived')
    })
  })
})

// ---------------------------------------------------------------------------
// 8. FAZIS -- KEPESSEG-KEZELO: mi mukodik ezen a gepen, es mi a teendo azzal,
// ami nem. A lenyeg: a felhasznalo a FELULETROL vegig tudja csinalni (utat
// beir, ujramer), es a "nem lattam oda" sosem latszik "nincs"-nek.
// ---------------------------------------------------------------------------
describe('Munkapad: kepesseg-kezelo (8. fazis)', () => {
  const OVERRIDES = join(PROJECT_ROOT, 'store', 'config-overrides.json')
  let before: string | null = null
  const SAVED = { soffice: process.env['MARVEEN_SOFFICE'], ffmpeg: process.env['MARVEEN_FFMPEG'] }

  beforeEach(() => {
    // A beallitas-fajl allapotat visszaadjuk a teszt utan: nyomtalan munka.
    before = existsSync(OVERRIDES) ? readFileSync(OVERRIDES, 'utf8') : null
    process.env['MARVEEN_SOFFICE'] = join(tmpdir(), 'nincs-ilyen-soffice-' + Date.now())
    process.env['MARVEEN_FFMPEG'] = join(tmpdir(), 'nincs-ilyen-ffmpeg-' + Date.now())
    resetCapabilityProbes()
  })

  afterEach(() => {
    if (before === null) rmSync(OVERRIDES, { force: true })
    else writeFileSync(OVERRIDES, before)
    reloadOverridesForTest()
    if (SAVED.soffice === undefined) delete process.env['MARVEEN_SOFFICE']; else process.env['MARVEEN_SOFFICE'] = SAVED.soffice
    if (SAVED.ffmpeg === undefined) delete process.env['MARVEEN_FFMPEG']; else process.env['MARVEEN_FFMPEG'] = SAVED.ffmpeg
    resetCapabilityProbes()
  })

  function capOf2(body: any, key: string): any {
    return (body.capabilities || []).find((c: any) => c.key === key)
  }

  it('a lista TOBB kepesseget ad, mindegyik emberi mondattal es szinttel', async () => {
    const r = await call('/api/workbench/capabilities', 'GET')
    expect(r.status).toBe(200)
    const keys = r.body.capabilities.map((c: any) => c.key)
    expect(keys).toContain('office_to_pdf')
    expect(keys).toContain('video_render')
    expect(keys).toContain('ai_agent')
    for (const c of r.body.capabilities) {
      expect(String(c.message).length).toBeGreaterThan(5)
      expect(['core', 'recommended', 'extra']).toContain(c.tier)
    }
  })

  it('"Ellenorzes most": UJRA mer -- a regi meresbol valaszolni pont a javitast rejtene el', async () => {
    const bad = await call('/api/workbench/capabilities/video_render/test', 'POST', {})
    expect(bad.status).toBe(200)
    expect(bad.body.capability.state).toBe('check_failed')
    // Most "telepitjuk" -- es az ellenorzes AZONNAL az uj allapotot mondja.
    const dir = mkdtempSync(join(tmpdir(), 'wb-ff-'))
    const bin = join(dir, 'ffmpeg')
    writeFileSync(bin, '#!/bin/sh\necho "ffmpeg version 7.1"\n')
    chmodSync(bin, 0o755)
    process.env['MARVEEN_FFMPEG'] = bin
    const ok = await call('/api/workbench/capabilities/video_render/test', 'POST', {})
    expect(ok.body.capability.state).toBe('ok')
    expect(String(ok.body.capability.version)).toContain('ffmpeg version 7.1')
    rmSync(dir, { recursive: true, force: true })
  })

  it('az utat a FELULETROL be lehet irni, es a valasz rogton az uj meres', async () => {
    delete process.env['MARVEEN_FFMPEG']
    resetCapabilityProbes()
    const dir = mkdtempSync(join(tmpdir(), 'wb-ff2-'))
    const bin = join(dir, 'ffmpeg')
    writeFileSync(bin, '#!/bin/sh\necho "ffmpeg version 6.0"\n')
    chmodSync(bin, 0o755)
    const r = await call('/api/workbench/capabilities/video_render/setting', 'POST', { value: bin })
    expect(r.status).toBe(200)
    expect(r.body.saved).toBe(true)
    expect(r.body.capability.state).toBe('ok')
    expect(r.body.capability.path).toBe(bin)
    expect(r.body.capability.setting.value).toBe(bin)
    rmSync(dir, { recursive: true, force: true })
  })

  it('rossz ut eseten a VALODI hibauzenet jon, es megnevezi a beallitast', async () => {
    delete process.env['MARVEEN_FFMPEG']
    resetCapabilityProbes()
    const r = await call('/api/workbench/capabilities/video_render/setting', 'POST', { value: '/nincs/ilyen/ffmpeg' })
    expect(r.body.capability.state).toBe('check_failed')
    expect(String(r.body.capability.detail)).toContain('WORKBENCH_FFMPEG_PATH=/nincs/ilyen/ffmpeg')
  })

  it('#404: a Munkapad-ugynokhoz nem irhato beallitas (sajat API-kulcs nincs)', async () => {
    const r = await call('/api/workbench/capabilities/ai_agent/setting', 'POST', { value: 'sk-ant-regi' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('capability_no_setting')
  })

  it('ismeretlen kepesseg: 404 emberi mondattal, nem ures valasz', async () => {
    const r = await call('/api/workbench/capabilities/nincs-ilyen/test', 'POST', {})
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('capability_unknown')
    expect(String(r.body.message).length).toBeGreaterThan(20)
  })

  it('amihez nem tartozik beallitas, oda nem lehet erteket irni', async () => {
    const r = await call('/api/workbench/capabilities/pdf_preview/setting', 'POST', { value: 'x' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('capability_no_setting')
  })

  it('a vegpont NEM altalanos config-iro: csak a kepesseg sajat kulcsat irja', async () => {
    // Ha valaki mas kulcsot kuld a testben, az nem szamit -- a kulcsot a
    // kepesseg leirasa adja, nem a keres.
    const r = await call('/api/workbench/capabilities/video_render/setting', 'POST', { value: '/tmp/x', key: 'MAIN_AGENT_MODEL' })
    expect(r.status).toBe(200)
    expect(r.body.capability.setting.key).toBe('WORKBENCH_FFMPEG_PATH')
    expect(getEffectiveSettingValue('MAIN_AGENT_MODEL')).not.toBe('/tmp/x')
  })
})

// ============================================================================
// 9. FAZIS -- GRAFIKA / RAJZVASZON (spec 9)
//
// Amit itt merunk: a rajz STRUKTURALT (stabil azonositok), minden mentes UJ
// VERZIO (a regi nem vesz el), a kep fuggoseg nelkul elkeszul, es a KET NULLA
// kulon valasz: "meg nincs rajz" (kezdoallapot) vs "nem latok oda" (hiba).
// ============================================================================
describe('Munkapad: rajzvaszon (9. fazis)', () => {
  let depot = ''
  let itemId = ''

  beforeEach(() => {
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-canvas-'))
    mkdirSync(join(depot, 'Projektek', 'teszt'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const up = updateProject(projectId, { folder_path: 'Projektek/teszt' })
    if (!up.ok) throw new Error('projektmappa: ' + up.code)
    const w = createWorkItem({ project_id: projectId, title: 'Nyári plakát', type: 'graphic' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
  })

  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  const url = (suffix: string) => `/api/workbench/items/${itemId}/canvas${suffix}`

  it('kep-feltoltes: a fajl a munkadarab SAJAT mappajaba kerul, nem a projekt gyokerebe (Boss, TG 2865)', async () => {
    const r = await call(`/api/workbench/items/${itemId}/parts/image?name=anyu.jpg`, 'POST', 'BINARIS')
    expect(r.status).toBe(201)
    expect(r.body.file.rel).not.toBe('anyu.jpg')
    expect(r.body.file.rel).toMatch(/\/Feltöltések\/anyu\.jpg$/)
    const root = readdirSync(join(depot, 'Projektek', 'teszt'))
    expect(root).not.toContain('anyu.jpg')
  })

  it('uj projekt mappa nelkul: az elso feltoltesnel a mappa magatol letrejon, es a projektben megjegyzodik (Boss, TG 2886)', async () => {
    const cleared = updateProject(projectId, { folder_path: null })
    if (!cleared.ok) throw new Error('mappa torles')
    const r = await call(`/api/workbench/items/${itemId}/parts/image?name=anyu.jpg`, 'POST', 'BINARIS')
    expect(r.status).toBe(201)
    expect(r.body.file.rel).toMatch(/\/Feltöltések\/anyu\.jpg$/)
    const now = getProject(projectId)!
    expect(now.folder_path).toBeTruthy()
    expect(existsSync(join(depot, ...String(now.folder_path).split('/')))).toBe(true)
    // A second upload reuses the same folder, no second one.
    const again = await call(`/api/workbench/items/${itemId}/parts/image?name=masik.jpg`, 'POST', 'BINARIS')
    expect(again.status).toBe(201)
    expect(getProject(projectId)!.folder_path).toBe(now.folder_path)
  })

  it('meg nincs rajz: URES vaszon jon, es KIMONDJA, hogy meg nincs (nem hiba)', async () => {
    const r = await call(url(''), 'GET')
    expect(r.status).toBe(200)
    expect(r.body.exists).toBe(false)
    expect(r.body.canvas.objects).toEqual([])
    expect(r.body.canvas.width).toBeGreaterThan(0)
  })

  it('mentes: fajl keletkezik a PROJEKT mappajaban, es UJ VERZIO lesz belole', async () => {
    const r = await call(url(''), 'PUT', {
      canvas: {
        width: 1000, height: 800,
        objects: [{ id: 'headline', type: 'text', x: 100, y: 100, width: 800, height: 120, fontSize: 72, text: 'Ride for less' }],
      },
    })
    expect(r.status).toBe(201)
    expect(r.body.ok).toBe(true)
    expect(r.body.name).toMatch(/\.canvas\.json$/)
    expect(r.body.version.version_no).toBeGreaterThanOrEqual(1)
    // A fajl VALOBAN ott van a lemezen, nem csak az adatbazisban.
    const files = readdirSync(join(depot, 'Projektek', 'teszt'))
    expect(files.some((f) => f.endsWith('.canvas.json'))).toBe(true)
    // ...es visszaolvasva ugyanaz all benne.
    const back = await call(url(''), 'GET')
    expect(back.body.exists).toBe(true)
    expect(back.body.canvas.objects[0].id).toBe('headline')
  })

  it('"30%-kal nagyobbra es kozepre": a munkapeldanyba ment, verzio NELKUL, a verzio erintetlen (K-2.2)', async () => {
    const put = await call(url(''), 'PUT', {
      canvas: { width: 1000, height: 800, objects: [{ id: 'headline', type: 'text', x: 0, y: 0, width: 800, height: 120, fontSize: 72, text: 'Ride for less' }] },
    })
    const before = (await call(`/api/workbench/items/${itemId}`, 'GET')).body.versions
    const r = await call(url('/ops'), 'POST', {
      ops: [{ op: 'scale', id: 'headline', factor: 1.3 }, { op: 'center', id: 'headline', axis: 'both' }],
    })
    expect(r.status).toBe(200)
    expect(r.body.canvas.objects[0].fontSize).toBeCloseTo(93.6, 1)
    expect(r.body.applied).toHaveLength(2)
    // A LENYEG: az automatikus mentes NEM gyart verziot.
    expect(r.body.created).toBe(false)
    expect(r.body.versions.length).toBe(before.length)
    expect(r.body.draft.since_version).toBe(true)
    expect(r.body.message).toMatch(/Verzió mentése/)
    // ...de MENTVE van: visszaolvasva a modositott rajz jon.
    const back = await call(url(''), 'GET')
    expect(back.body.canvas.objects[0].fontSize).toBeCloseTo(93.6, 1)
    expect(back.body.draft.since_version).toBe(true)
    expect(back.body.history.can_undo).toBe(true)
    expect(back.body.history.undo.label).toBe('scale,center')
    // A verzio FAJLJA valtozatlan a lemezen: semmi nem irodott felul.
    const onDisk = JSON.parse(readFileSync(join(depot, 'Projektek', 'teszt', put.body.name), 'utf-8'))
    expect(onDisk.objects[0].fontSize).toBe(72)
    // ...es verzio-mentes utan a regi verzio a SAJAT allapotat mutatja.
    await call(url('/version'), 'POST', {})
    const old = await call(url(`?version=${encodeURIComponent(before[0].id)}`), 'GET')
    expect(old.body.canvas.objects[0].fontSize).toBe(72)
    expect(old.body.current).toBe(false)
    expect(old.body.history).toBeNull()
  })

  // A spec 11. fejezetenek 2. fazisu probaesete, szo szerint:
  // "Facebook-poszt -> Story-valtozat, 10 kezi es Agent-modositas, visszavonas"
  // Kesz, ha: egy munkadarab, 2 jelentos verzio (nem 10), a visszavonas
  // mindket fajta modositasnal mukodik.
  it('2. FAZIS PROBAESET: Facebook-poszt -> Story-valtozat, 10 modositas, visszavonas', async () => {
    const itemsBefore = (await call(`/api/workbench/items?project=${projectId}`, 'GET')).body.items.length
    // A munkadarab ures kezdoverzioja mar a proba elott megvan: a proba
    // KOZBEN keletkezett verziokat szamoljuk.
    const startVersions = (await call(`/api/workbench/items/${itemId}`, 'GET')).body.versions.length
    // 1. jelentos verzio: a Facebook-poszt (1200x630).
    await call(url(''), 'PUT', { canvas: { width: 1200, height: 630, objects: [
      { id: 'hatter', type: 'rect', x: 0, y: 0, width: 1200, height: 630, fill: '#ffeecc' },
      { id: 'cim', type: 'text', x: 60, y: 40, width: 800, height: 120, fontSize: 72, text: 'Nyári akció' },
      { id: 'logo', type: 'ellipse', x: 1040, y: 470, width: 120, height: 120 },
    ] } })
    // 2. jelentos verzio: a Story-valtozat.
    const v = await call(url('/variant'), 'POST', { platform: 'story_reel' })
    expect(v.status).toBe(201)
    const versionsAfterVariant = v.body.versions.length
    // 10 modositas: 5 kezi, 5 Agent (az Agent 5 kulon kerese).
    for (let i = 0; i < 5; i++) {
      const r = await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'cim', dx: 0, dy: 10 }] })
      expect(r.status).toBe(200)
    }
    for (let i = 0; i < 5; i++) {
      const r = executeTool('canvas.edit', { ops: [{ op: 'move', id: 'logo', dx: -10, dy: 0 }] }, { projectId, workItemId: itemId, lang: 'hu', turnId: `turn-${i}` })
      expect(r.ok).toBe(true)
    }
    const mid = await call(url(''), 'GET')
    // Egy munkadarab, es a 10 modositas NEM gyartott verziot.
    expect((await call(`/api/workbench/items?project=${projectId}`, 'GET')).body.items.length).toBe(itemsBefore)
    const versions = (await call(`/api/workbench/items/${itemId}`, 'GET')).body.versions
    expect(versions.length).toBe(versionsAfterVariant)
    expect(versions.length - startVersions).toBe(2)
    expect(versions[0].reason).toBe('variant')
    // Visszavonas: elobb az Agent utolso kerese, aztan tovabb a kezi lepesekig.
    const logoX = mid.body.canvas.objects.find((o: { id: string }) => o.id === 'logo').x
    const u1 = await call(url('/undo'), 'POST', {})
    expect(u1.body.step.source).toBe('agent')
    expect(u1.body.canvas.objects.find((o: { id: string }) => o.id === 'logo').x).toBe(logoX + 10)
    for (let i = 0; i < 4; i++) await call(url('/undo'), 'POST', {})
    const u6 = await call(url('/undo'), 'POST', {})
    expect(u6.body.step.source).toBe('owner')
    const cimY = mid.body.canvas.objects.find((o: { id: string }) => o.id === 'cim').y
    expect(u6.body.canvas.objects.find((o: { id: string }) => o.id === 'cim').y).toBe(cimY - 10)
  })

  it('AI-kepszerkesztes (K-2.11, K-2.12): kulcs nelkul es erzekenynel nem fut, penz csak megerositve, uj fajl, visszavonhato', async () => {
    writeFileSync(join(depot, 'Projektek', 'teszt', 'auto.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
    await call(url(''), 'PUT', { canvas: { width: 100, height: 100, objects: [{ id: 'auto', type: 'image', src: 'auto.png', x: 0, y: 0, width: 100, height: 100 }] } })
    const off = await call(url('/ai-edit'), 'GET')
    expect(off.body.available).toBe(false)
    expect(off.body.reason).toBe('ai_edit_not_configured')
    expect(setOverride('WORKBENCH_GEMINI_API_KEY', 'k-test').ok).toBe(true)
    const realFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: Buffer.from('uj-kep').toString('base64') } }] } }],
        usageMetadata: { promptTokenCount: 1300, candidatesTokenCount: 1120 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const on = await call(url('/ai-edit'), 'GET')
      expect(on.body.available).toBe(true)
      expect(on.body.estimate_usd).toBeGreaterThan(0.05)
      // Megerosites nelkul nem fut: a tulajdonos nem latta az arat.
      const noConfirm = await call(url('/ai-edit'), 'POST', { object_id: 'auto', instruction: 'legyen piros' })
      expect(noConfirm.body.error).toBe('ai_edit_confirm_cost')
      expect(calls).toBe(0)
      const r = await call(url('/ai-edit'), 'POST', { object_id: 'auto', instruction: 'legyen piros', confirm_cost: true })
      expect(r.status).toBe(200)
      expect(calls).toBe(1)
      expect(r.body.file.name).toBe('auto-ai.png')
      expect(readFileSync(join(depot, 'Projektek', 'teszt', 'auto-ai.png'), 'utf-8')).toBe('uj-kep')
      // A regi fajl megmaradt, az elem az ujra mutat, AI-jelolessel.
      expect(readFileSync(join(depot, 'Projektek', 'teszt', 'auto.png')).length).toBe(8)
      expect(r.body.canvas.objects[0].src).toMatch(/auto-ai\.png$/)
      expect(r.body.canvas.objects[0].ai.prompt).toBe('legyen piros')
      expect(r.body.cost_usd).toBeGreaterThan(0)
      expect(r.body.history.undo.label).toBe('ai_edit')
      const u = await call(url('/undo'), 'POST', {})
      expect(u.body.canvas.objects[0].src).toBe('auto.png')
      // Erzekeny munkadarabnal nem fut, es a szolgaltatot meg sem hivja.
      setItemSensitive(itemId, true, 'test')
      const sens = await call(url('/ai-edit'), 'POST', { object_id: 'auto', instruction: 'legyen kek', confirm_cost: true })
      expect(sens.status).toBe(403)
      expect(sens.body.error).toBe('ai_edit_sensitive')
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = realFetch
      setOverride('WORKBENCH_GEMINI_API_KEY', '')
    }
  })

  it('valtozat mas platformra (K-2.9): uj verzio az uj meretben, az eredeti megmarad; a GET a platformokat is adja', async () => {
    await call(url(''), 'PUT', { canvas: { width: 1080, height: 1080, objects: [{ id: 'cim', type: 'text', x: 90, y: 20, width: 900, height: 120, fontSize: 80, text: 'Akció' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'cim', dx: 0, dy: 10 }] })
    const g = await call(url(''), 'GET')
    expect(g.body.platforms.platforms.some((p: { id: string }) => p.id === 'story_reel')).toBe(true)
    expect(g.body.platform).toBe('instagram_square')
    const before = (await call(`/api/workbench/items/${itemId}`, 'GET')).body.versions.length
    const v = await call(url('/variant'), 'POST', { platform: 'story_reel' })
    expect(v.status).toBe(201)
    expect([v.body.canvas.width, v.body.canvas.height]).toEqual([1080, 1920])
    // A verziozatlan munka elobb verzio lett, aztan a valtozat is: ketto uj.
    expect(v.body.versions.length).toBe(before + 2)
    const top = v.body.versions[0]
    expect(top.reason).toBe('variant')
    expect(top.label).toMatch(/Story/)
    expect(v.body.versions[1].reason).toBe('manual')
    const bad = await call(url('/variant'), 'POST', { platform: 'myspace' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('canvas_unknown_platform')
  })

  it('visszavonas es ujra (K-2.1): lepesenkent vissza, elore, es a hatar KIMONDVA', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'rect', x: 0, y: 0, width: 10, height: 10 }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'a', dx: 5, dy: 0 }] })
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'a', dx: 0, dy: 7 }] })
    const u1 = await call(url('/undo'), 'POST', {})
    expect(u1.status).toBe(200)
    expect(u1.body.canvas.objects[0]).toMatchObject({ x: 5, y: 0 })
    expect(u1.body.step).toEqual({ label: 'move', source: 'owner' })
    expect(u1.body.history.can_redo).toBe(true)
    const u2 = await call(url('/undo'), 'POST', {})
    expect(u2.body.canvas.objects[0]).toMatchObject({ x: 0, y: 0 })
    // Vissza a verzio allapotaba: nincs verziozatlan valtozas.
    expect(u2.body.draft.since_version).toBe(false)
    const r1 = await call(url('/redo'), 'POST', {})
    expect(r1.body.canvas.objects[0]).toMatchObject({ x: 5, y: 0 })
    // Uj lepes a visszavonas utan: az "ujra" ag elvesz, ahogy minden szerkesztoben.
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'a', dx: 1, dy: 1 }] })
    const noRedo = await call(url('/redo'), 'POST', {})
    expect(noRedo.status).toBe(409)
    expect(noRedo.body.error).toBe('canvas_nothing_to_redo')
    expect(String(noRedo.body.message).length).toBeGreaterThan(20)
    // A PUT maga is egy lepes (a teljes vaszon cserejet is vissza lehet vonni).
    await call(url('/undo'), 'POST', {})
    await call(url('/undo'), 'POST', {})
    const toEmpty = await call(url('/undo'), 'POST', {})
    expect(toEmpty.status).toBe(200)
    expect(toEmpty.body.canvas.objects).toEqual([])
    const none = await call(url('/undo'), 'POST', {})
    expect(none.status).toBe(409)
    expect(none.body.error).toBe('canvas_nothing_to_undo')
  })

  it('egy csoport (pl. egy szerkeszto-urlap) EGY visszavonasi lepes, akarhany mentes megy le', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 't', type: 'text', text: 'a' }] } })
    for (const text of ['ab', 'abc', 'abcd']) {
      const r = await call(url('/ops'), 'POST', { ops: [{ op: 'update', id: 't', patch: { text } }], group: 'form:t:1' })
      expect(r.status).toBe(200)
    }
    const u = await call(url('/undo'), 'POST', {})
    expect(u.body.canvas.objects[0].text).toBe('a')
    expect(u.body.history.can_redo).toBe(true)
    const r = await call(url('/redo'), 'POST', {})
    expect(r.body.canvas.objects[0].text).toBe('abcd')
  })

  it('"Verzio mentese" (K-2.3): nevvel UJ verzio; valtozas nelkul NEM gyart masodikat', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'rect' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'a', dx: 3, dy: 3 }] })
    const v = await call(url('/version'), 'POST', { label: 'Ügyfélnek küldve' })
    expect(v.status).toBe(201)
    expect(v.body.created).toBe(true)
    expect(v.body.draft.since_version).toBe(false)
    const listed = v.body.versions.find((x: { id: string }) => x.id === v.body.version.id)
    expect(listed.label).toBe('Ügyfélnek küldve')
    expect(listed.reason).toBe('manual')
    // A fajlnev nem no tovabb: "rajz.canvas (2).json", nem "(2) (2)".
    expect(String(v.body.name)).not.toMatch(/\(\d+\) \(\d+\)/)
    // A visszavonas a verzio utan is megmarad.
    expect(v.body.history.can_undo).toBe(true)
    const again = await call(url('/version'), 'POST', {})
    expect(again.status).toBe(200)
    expect(again.body.created).toBe(false)
    expect(again.body.versions.length).toBe(v.body.versions.length)
    expect(again.body.message).toMatch(/nem változott/)
    // Nev megadasa valtozas nelkul: a mostani verzio kapja meg.
    const named = await call(url('/version'), 'POST', { label: 'Végleges' })
    expect(named.body.created).toBe(false)
    expect(named.body.versions.find((x: { id: string }) => x.id === v.body.version.id).label).toBe('Végleges')
  })

  it('"Verzio mentese" rajz nelkul: kimondja, hogy meg nincs mibol (nem ures verzio)', async () => {
    const r = await call(url('/version'), 'POST', { label: 'x' })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('canvas_nothing_to_version')
  })

  it('a generikus "uj verzio" rajznal a LATOTT (munkapeldany) allapotot menti', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'text', text: 'regi' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'update', id: 'a', patch: { text: 'uj' } }] })
    const v = await call(`/api/workbench/items/${itemId}/versions`, 'POST', {})
    expect(v.status).toBe(201)
    const read = await call(url(`?version=${encodeURIComponent(v.body.version.id)}`), 'GET')
    expect(read.body.canvas.objects[0].text).toBe('uj')
  })

  it('regi verziora nem lehet vakon muveletet kuldeni: 409 emberi mondattal', async () => {
    const first = await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'rect' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'a', dx: 1, dy: 1 }] })
    await call(url('/version'), 'POST', {})
    const r = await call(url('/ops'), 'POST', { version: first.body.version.id, ops: [{ op: 'move', id: 'a', dx: 1, dy: 1 }] })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('canvas_old_version')
  })

  it('visszaallitas kozben verziozatlan munkaval: a munka ARVA lesz, nem vesz el; verzio lehet belole', async () => {
    const first = await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'text', text: 'egy' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'update', id: 'a', patch: { text: 'ketto' } }] })
    await call(url('/version'), 'POST', {})
    await call(url('/ops'), 'POST', { ops: [{ op: 'update', id: 'a', patch: { text: 'harom (nem mentett)' } }] })
    const restored = await call(`/api/workbench/items/${itemId}/versions/${first.body.version.id}/restore`, 'POST', {})
    expect(restored.status).toBe(201)
    const g = await call(url(''), 'GET')
    expect(g.body.canvas.objects[0].text).toBe('egy')
    expect(g.body.orphans).toHaveLength(1)
    expect(g.body.orphans[0].objects).toBe(1)
    // Az uj vonalon a regi lepesek nem vonhatok vissza (mas allapotrol szolnak).
    expect(g.body.history.can_undo).toBe(false)
    const back = await call(url(`/orphans/${g.body.orphans[0].base_version_id}/restore`), 'POST', {})
    expect(back.status).toBe(201)
    expect(back.body.canvas.objects[0].text).toBe('harom (nem mentett)')
    expect(back.body.orphans).toEqual([])
    expect(back.body.versions.find((x: { id: string }) => x.id === back.body.version.id).reason).toBe('draft')
  })

  it('arva munkapeldany eldobasa: eltunik, a verziok erintetlenek; masodszor 404', async () => {
    const first = await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'rect' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'a', dx: 9, dy: 9 }] })
    await call(`/api/workbench/items/${itemId}/versions/${first.body.version.id}/restore`, 'POST', {})
    const g = await call(url(''), 'GET')
    const base = g.body.orphans[0].base_version_id
    const versions = (await call(`/api/workbench/items/${itemId}`, 'GET')).body.versions.length
    const d = await call(url(`/orphans/${base}`), 'DELETE')
    expect(d.status).toBe(200)
    expect(d.body.orphans).toEqual([])
    expect((await call(`/api/workbench/items/${itemId}`, 'GET')).body.versions.length).toBe(versions)
    const again = await call(url(`/orphans/${base}`), 'DELETE')
    expect(again.status).toBe(404)
    expect(again.body.error).toBe('canvas_orphan_not_found')
  })

  it('ARCHIVALT projektben visszavonni es verziot menteni sem lehet', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'rect' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'move', id: 'a', dx: 1, dy: 1 }] })
    setProjectArchived(projectId, true)
    for (const [p, m] of [['/undo', 'POST'], ['/redo', 'POST'], ['/version', 'POST']] as const) {
      const r = await call(url(p), m, {})
      expect(r.status).toBe(409)
      expect(r.body.error).toBe('project_archived')
    }
  })

  it('jovahagyasra kuldes elott a verziozatlan rajz verzio lesz ("veglegesiteskor")', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'text', text: 'regi' }] } })
    await call(url('/ops'), 'POST', { ops: [{ op: 'update', id: 'a', patch: { text: 'jovahagyando' } }] })
    const s = await call(`/api/workbench/items/${itemId}/approval`, 'POST', { action: 'submit' })
    expect(s.status).toBe(200)
    const detail = (await call(`/api/workbench/items/${itemId}`, 'GET')).body
    const cur = detail.versions.find((x: { id: string }) => x.id === detail.item.current_version_id)
    expect(cur.reason).toBe('finalize')
    const read = await call(url(`?version=${encodeURIComponent(cur.id)}`), 'GET')
    expect(read.body.canvas.objects[0].text).toBe('jovahagyando')
  })

  it('MASODIK mentes: az atnevezett fajl (nev (2).json) is rajz marad, nem tunik el', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'text', text: 'elso' }] } })
    const second = await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'text', text: 'masodik' }] } })
    expect(second.body.renamed).toBe(true)
    expect(second.body.name).toMatch(/\(2\)/)
    // A LENYEG: visszaolvasva tovabbra is RAJZ, nem "meg nincs rajz".
    const back = await call(url(''), 'GET')
    expect(back.body.exists).toBe(true)
    expect(back.body.canvas.objects[0].text).toBe('masodik')
    // ...es az elonezet is kep marad.
    const p = await call(`/api/workbench/items/${itemId}/preview`, 'GET')
    expect(p.body.kind).toBe('canvas')
  })

  it('nem letezo elemre hivatkozo modositas: 400, es FELSOROLJA, mi van a vaszonon', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'headline', type: 'text', text: 'x' }] } })
    const r = await call(url('/ops'), 'POST', { ops: [{ op: 'center', id: 'cim' }] })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('canvas_object_not_found')
    // EMBERI mondat a kepernyore, MERT tenyek a reszletekbe.
    expect(String(r.body.message).length).toBeGreaterThan(20)
    expect(String(r.body.detail)).toMatch(/headline/)
  })

  it('a kep SVG-kent all elo, fuggoseg nelkul, es letoltheto', async () => {
    await call(url(''), 'PUT', {
      canvas: { width: 600, height: 400, objects: [{ id: 'headline', type: 'text', text: 'Ride for less', fontSize: 40 }] },
    })
    const r = await call(url('.svg'), 'GET')
    expect(r.status).toBe(200)
    expect(r.headers['Content-Type']).toMatch(/image\/svg\+xml/)
    const svg = r.raw.toString('utf-8')
    expect(svg).toMatch(/^<svg /)
    expect(svg).toContain('Ride for less')
    const dl = await call(url('.svg?download=1'), 'GET')
    expect(String(dl.headers['Content-Disposition'])).toMatch(/attachment/)
  })

  it('a vaszonra tett KEP beagyazva megy a kivitt kepbe (a letoltott fajl mashol is mukodik)', async () => {
    // 1x1 png, hogy legyen VALODI kep a lemezen.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    writeFileSync(join(depot, 'Projektek', 'teszt', 'logo.png'), png)
    await call(url(''), 'PUT', {
      canvas: { objects: [{ id: 'logo', type: 'image', src: 'Projektek/teszt/logo.png', width: 100, height: 100 }] },
    })
    const svg = (await call(url('.svg'), 'GET')).raw.toString('utf-8')
    expect(svg).toContain('data:image/png;base64,')
  })

  it('HIANYZO kep: a helyen lathato tabla all, nem tunik el csendben', async () => {
    await call(url(''), 'PUT', {
      canvas: { objects: [{ id: 'logo', type: 'image', src: 'Projektek/teszt/nincs-ilyen.png', width: 100, height: 100 }] },
    })
    const svg = (await call(url('.svg'), 'GET')).raw.toString('utf-8')
    expect(svg).toContain('nincs-ilyen.png')
    expect(svg).toMatch(/not found/i)
  })

  it('a romlott vaszon-fajl NEM "ures rajz": sajat hibakod, es a korabbi verziok emlitese', async () => {
    const save = await call(url(''), 'PUT', { canvas: { objects: [] } })
    writeFileSync(join(depot, 'Projektek', 'teszt', save.body.name), '{ ez nem json')
    const r = await call(url(''), 'GET')
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('canvas_bad_json')
    // A rendszer sajat hibauzenete megy tovabb -- nem talalgatjuk az okot.
    expect(String(r.body.detail).length).toBeGreaterThan(5)
  })

  it('nincs Raktar: "nem latok oda" -- KULON mondat, nem "meg nincs rajz"', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'rect' }] } })
    delete process.env['MARVEEN_DEPOT']
    const r = await call(url(''), 'GET')
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('canvas_no_depot')
    expect(String(r.body.message)).toMatch(/Raktár/i)
    // Es KIMONDJA, hogy ez NEM azt jelenti, hogy elveszett.
    expect(String(r.body.message)).toMatch(/nem azt jelenti/i)
  })

  it('ertelmezhetetlen elem: 400, emberi mondat + a MERT reszlet', async () => {
    const r = await call(url(''), 'PUT', { canvas: { objects: [{ type: 'hologram' }] } })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('canvas_bad_object')
    expect(String(r.body.detail)).toMatch(/hologram/)
  })

  it('ARCHIVALT projektben a rajz olvashato, de nem irhato', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [] } })
    setProjectArchived(projectId, true)
    expect((await call(url(''), 'GET')).status).toBe(200)
    const w = await call(url('/ops'), 'POST', { ops: [{ op: 'canvas', width: 400 }] })
    expect(w.status).toBe(409)
    expect(w.body.error).toBe('project_archived')
  })

  it('a rajz ELONEZETE kep, nem nyers JSON (a felhasznalo a KEPET latja)', async () => {
    await call(url(''), 'PUT', { canvas: { objects: [{ id: 'a', type: 'text', text: 'Szia' }] } })
    const p = await call(`/api/workbench/items/${itemId}/preview`, 'GET')
    expect(p.body.available).toBe(true)
    expect(p.body.kind).toBe('canvas')
    expect(p.body.text).toBeNull()
  })

  it('ismeretlen munkadarab: 404, nem ures vaszon', async () => {
    const r = await call('/api/workbench/items/nincs-ilyen/canvas', 'GET')
    expect(r.status).toBe(404)
  })
})
