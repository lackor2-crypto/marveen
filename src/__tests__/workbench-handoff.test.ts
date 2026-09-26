// #406, 12. pont -- PROJEKT ATADOCSOMAG: a terv (mi kerul bele, mi hianyzik),
// a ZIP tartalma, a vegpontok ES a felulet.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, addWorkItemPart } from '../workbench.js'
import { addDecision } from '../workbench-decisions.js'
import { planHandoff, buildHandoffZip, safeName } from '../workbench-handoff.js'
import { buildZip } from '../web/zip-writer.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody, untranslatedHungarian } from './helpers/workbench-harness.js'

/** A zip bejegyzesei (nev -> tartalom, flags). Csak amit a zip-writer ir. */
function unzip(buf: Buffer): Map<string, { data: Buffer; flags: number }> {
  const out = new Map<string, { data: Buffer; flags: number }>()
  let o = 0
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const flags = buf.readUInt16LE(o + 6)
    const method = buf.readUInt16LE(o + 8)
    const size = buf.readUInt32LE(o + 18)
    const nameLen = buf.readUInt16LE(o + 26)
    const extra = buf.readUInt16LE(o + 28)
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString('utf-8')
    const start = o + 30 + nameLen + extra
    const raw = buf.subarray(start, start + size)
    out.set(name, { data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw), flags })
    o = start + size
  }
  return out
}

let pid = ''
let depot = ''
const NOW = new Date(2026, 8, 26, 10, 0, 0)

function setup() {
  initDatabase(':memory:')
  depot = mkdtempSync(join(tmpdir(), 'marveen-wb-handoff-'))
  process.env['MARVEEN_DEPOT'] = depot
  const p = createProject({ name: 'Kovács weboldal' })
  if (!p.ok) throw new Error('projekt')
  pid = p.project.id
  updateProject(pid, { folder_path: 'Projektek/kovacs' })
  mkdirSync(join(depot, 'Projektek/kovacs'), { recursive: true })
}

function item(title: string, status: string, source?: string) {
  const r = createWorkItem({ project_id: pid, title, type: 'document', status, source_path: source })
  if (!r.ok) throw new Error('munkadarab')
  return r.item.id
}

describe('atadocsomag: a szerver', () => {
  beforeEach(setup)
  afterEach(() => {
    delete process.env['MARVEEN_DEPOT']
    rmSync(depot, { recursive: true, force: true })
  })

  it('friss projekt: nincs munkadarab -> kimondja, nem ures zip', () => {
    const plan = planHandoff(pid, 'done')!
    expect(plan).toMatchObject({ all_count: 0, done_count: 0, items: [], files: 0 })
    expect(buildHandoffZip(pid, 'done', 'hu', NOW)).toMatchObject({ ok: false, code: 'handoff_no_items' })
  })

  it('van munka, de semmi sincs kesz: kulon kod, a "mind" viszont mukodik', () => {
    item('Vázlat', 'draft')
    expect(buildHandoffZip(pid, 'done', 'hu', NOW)).toMatchObject({ ok: false, code: 'handoff_nothing_done' })
    expect(buildHandoffZip(pid, 'all', 'hu', NOW)).toMatchObject({ ok: true })
  })

  it('a kesz munkadarab fajlja, szovege, kepe es a dontesek bekerulnek; a hianyzo fajl KIMONDVA', () => {
    writeFileSync(join(depot, 'Projektek/kovacs/ajanlat.pdf'), 'PDF-TARTALOM')
    writeFileSync(join(depot, 'Projektek/kovacs/logo.png'), 'PNG')
    const a = item('Ajánlat', 'done', 'ajanlat.pdf')
    const b = item('Poszt', 'done')
    addWorkItemPart({ work_item_id: b, kind: 'text', text: 'Nyári <akció>' })
    addWorkItemPart({ work_item_id: b, kind: 'image', asset_path: 'Projektek/kovacs/logo.png', caption: 'Logó' })
    item('Elveszett', 'done', 'nincs-meg.docx')
    item('Félkész', 'in_progress')
    addDecision({ project_id: pid, text: 'A logó kék marad.' })

    const plan = planHandoff(pid, 'done')!
    expect(plan).toMatchObject({ all_count: 4, done_count: 3, files: 2, problems: 1 })
    expect(plan.items.map((e) => e.folder)).toEqual(['01-Ajánlat', '02-Poszt', '03-Elveszett'])
    expect(plan.items[2].source).toMatchObject({ name: 'nincs-meg.docx', problem: 'missing' })

    const r = buildHandoffZip(pid, 'done', 'hu', NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.filename).toBe('Kovács weboldal-atadas-2026-09-26.zip')
    const z = unzip(r.zip)
    expect([...z.keys()].sort()).toEqual([
      'Kovács weboldal/01-Ajánlat/ajanlat.pdf',
      'Kovács weboldal/02-Poszt/logo.png',
      'Kovács weboldal/Tartalom.html',
    ])
    expect(z.get('Kovács weboldal/01-Ajánlat/ajanlat.pdf')!.data.toString()).toBe('PDF-TARTALOM')
    // Ekezetes nev: UTF-8 jelzo, kulonben Windowson olvashatatlan.
    expect(z.get('Kovács weboldal/Tartalom.html')!.flags & 0x0800).toBe(0x0800)
    const html = z.get('Kovács weboldal/Tartalom.html')!.data.toString('utf-8')
    expect(html).toContain('Nyári &lt;akció&gt;')
    expect(html).toContain('src="02-Poszt/logo.png"')
    expect(html).toContain(encodeURIComponent('01-Ajánlat') + '/ajanlat.pdf')
    expect(html).toContain('A logó kék marad.')
    expect(html).toContain('nincs-meg.docx (a fájl már nincs meg a helyén)')
    expect(html).not.toContain('Félkész')
  })

  it('angolul: Contents.html, handoff fajlnev', () => {
    item('Offer', 'done')
    const r = buildHandoffZip(pid, 'all', 'en', NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.filename).toBe('Kovács weboldal-handoff-2026-09-26.zip')
    const html = unzip(r.zip).get('Kovács weboldal/Contents.html')!.data.toString('utf-8')
    expect(html).toContain('This work item has no content yet.')
    expect(html).toContain('No decisions were recorded in this project.')
  })

  it('azonos nevu fajlok egy mappaban nem irjak felul egymast', () => {
    mkdirSync(join(depot, 'Projektek/kovacs/a'), { recursive: true })
    writeFileSync(join(depot, 'Projektek/kovacs/kep.png'), '1')
    writeFileSync(join(depot, 'Projektek/kovacs/a/kep.png'), '2')
    const b = item('Két kép', 'done')
    addWorkItemPart({ work_item_id: b, kind: 'image', asset_path: 'Projektek/kovacs/kep.png' })
    addWorkItemPart({ work_item_id: b, kind: 'image', asset_path: 'Projektek/kovacs/a/kep.png' })
    const r = buildHandoffZip(pid, 'done', 'hu', NOW)
    if (!r.ok) throw new Error('zip')
    const names = [...unzip(r.zip).keys()]
    expect(names).toContain('Kovács weboldal/01-Két kép/kep.png')
    expect(names).toContain('Kovács weboldal/01-Két kép/kep (2).png')
  })

  it('safeName: Windows-tiltott jelek nelkul, ures nevre tartalek', () => {
    expect(safeName('a/b:c*?"<>|d')).toBe('a_b_c_d')
    expect(safeName('  ...  ')).toBe('munkadarab')
  })

  it('zip-writer: ASCII nev byte-azonos marad (nincs UTF-8 jelzo)', () => {
    const z = unzip(buildZip([{ name: 'a/b.txt', data: 'x' }], NOW))
    expect(z.get('a/b.txt')!.flags).toBe(0)
  })

  it('vegpontok: terv JSON, letoltes zip fejlecekkel, hibak emberi mondattal', async () => {
    item('Kész anyag', 'done')
    const plan = await callWorkbench(`/api/workbench/handoff?project=${pid}&scope=done&lang=hu`, 'GET')
    expect(plan.status).toBe(200)
    expect(plan.body.plan).toMatchObject({ done_count: 1 })
    const dl = await callWorkbench(`/api/workbench/handoff/download?project=${pid}&scope=done&lang=hu`, 'GET')
    expect(dl.status).toBe(200)
    expect(dl.headers['Content-Type']).toBe('application/zip')
    expect(dl.headers['Content-Disposition']).toContain('attachment')
    expect(dl.raw.readUInt32LE(0)).toBe(0x04034b50)
    const bad = await callWorkbench(`/api/workbench/handoff?project=${pid}&scope=valami&lang=hu`, 'GET')
    expect(bad.status).toBe(400)
    expect(bad.body.message).toMatch(/Válaszd ki/)
    const other = createProject({ name: 'Üres' })
    if (!other.ok) throw new Error('projekt')
    const empty = await callWorkbench(`/api/workbench/handoff/download?project=${other.project.id}&scope=all&lang=en`, 'GET')
    expect(empty.status).toBe(409)
    expect(empty.body.message).toMatch(/no work items yet/)
  })
})

describe('atadocsomag: a felulet', () => {
  const PLAN = (over: Record<string, unknown> = {}) => ({
    project: { id: 'p1', name: 'Kovács weboldal' }, scope: 'done', all_count: 2, done_count: 1,
    items: [{ item_id: 'w1', title: 'Ajánlat', type: 'document', status: 'done', version_no: 1, folder: '01-Ajánlat', source: { rel: 'x', name: 'ajanlat.pdf', size: 2048, problem: null }, text_parts: 0, images: [] }],
    files: 1, total_bytes: 2048, problems: 0, too_large: false, ...over,
  })

  function open(h: ReturnType<typeof workbenchHarness>, reply: (url: string) => { status: number; body: unknown }) {
    h.respond((url) => {
      if (url.includes('/api/workbench/handoff')) return reply(url)
      return { status: 200, body: itemsBody([]) }
    })
    h.win.MarvinWorkbench.open('p1', 'Kovács weboldal')
    h.click({ 'data-wb-act': 'ho-open' })
  }

  it('terv + letolto link a valasztott korrel; forditott szovegek', async () => {
    const h = workbenchHarness()
    open(h, () => ({ status: 200, body: { plan: PLAN() } }))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.ho.summary'))
    expect(h.html()).toMatch(/\/api\/workbench\/handoff\/download\?project=p1&(amp;)?scope=done/)
    expect(h.html()).toContain('workbench.ho.intro')
    expect(untranslatedHungarian(h.html(), ['Kovács weboldal', 'Ajánlat'])).toBe('')
    h.click({ 'data-wb-act': 'ho-scope', 'data-wb-scope': 'all' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('scope=all'))).toBe(true))
  })

  it('hianyzo fajl: sarga figyelmeztetes a fajl nevevel es az okkal', async () => {
    const h = workbenchHarness()
    const p = PLAN()
    ;(p.items[0] as any).source = { rel: 'x', name: 'ajanlat.pdf', size: null, problem: 'missing' }
    open(h, () => ({ status: 200, body: { plan: { ...p, files: 0, problems: 1 } } }))
    await vi.waitFor(() => expect(h.html()).toContain('workbench.ho.problems'))
    expect(h.html()).toContain('wb-ho-warn')
    expect(h.html()).toContain('ajanlat.pdf')
    expect(h.html()).toContain('workbench.ho.problem.missing')
  })

  it('ures projekt / semmi sincs kesz / tul nagy: kulon mondat, nincs letoltes gomb', async () => {
    for (const [plan, key] of [
      [PLAN({ all_count: 0, done_count: 0, items: [] }), 'workbench.ho.no_items'],
      [PLAN({ done_count: 0, items: [] }), 'workbench.ho.nothing_done'],
      [PLAN({ too_large: true }), 'workbench.ho.too_large'],
    ] as const) {
      const h = workbenchHarness()
      open(h, () => ({ status: 200, body: { plan } }))
      await vi.waitFor(() => expect(h.html()).toContain(key))
      expect(h.html()).not.toContain('wb-ho-download')
    }
  })

  it('betoltesi hiba: a szerver mondata + ujraproba, nem "nincs munkadarab"', async () => {
    const h = workbenchHarness()
    open(h, () => ({ status: 500, body: { error: 'x', message: 'Belső hiba' } }))
    await vi.waitFor(() => expect(h.html()).toContain('Belső hiba'))
    expect(h.html()).toContain('data-wb-act="ho-refresh"')
    expect(h.html()).not.toContain('workbench.ho.no_items')
  })
})
