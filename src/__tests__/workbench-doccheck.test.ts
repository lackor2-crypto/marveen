// #441 (v4 spec 1/A, K-1.19): kovetkezetesseg-ellenorzes. Veglegesites elott
// a Marveen gepi uton (szabalyokkal, nem AI-val) atnezi a neveket, az
// ugyszamot, a datumokat, az osszegeket es a cimeket; a jelzes a tulajdonos
// kattintasaval "szandekos" lehet, es akkor nem allitja meg a veglegesitest.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem, purgeWorkItem, setWorkItemDeleted } from '../workbench.js'
import { addSection, addBlock, addClaim, updateBlock, documentCheck, type SourceWorld } from '../workbench-docmodel.js'
import {
  findDates, findAmounts, parseAmount, findNames, findNameCandidates, nameStem, findCaseNumbers, findAddresses,
  consistencyIssues, ackConsistencyIssue, unackConsistencyIssue,
} from '../workbench-doccheck.js'
import { documentTrail } from '../workbench-docfinal.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { executeTool } from '../workbench-agent/execute.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

describe('felismeres', () => {
  it('datumok: magyar, nemet, angol, ISO; a nem letezo nap jelolve; a ketertelmu kimarad', () => {
    const d = findDates('2025. május 2-án, 2025.05.03., 17. März 2027, March 4, 2027, 2026-01-31, 1.2.2025, 2025. február 30., 03/04/2027')
    expect(d.map((x) => [x.iso, x.valid])).toEqual([
      ['2025-05-02', true], ['2025-05-03', true], ['2027-03-17', true], ['2027-03-04', true], ['2026-01-31', true],
      ['2025-02-01', true], ['2025-02-30', false],
    ])
    expect(findDates('2024. február 29.')[0]?.valid).toBe(true)
    expect(findDates('2025. február 29.')[0]?.valid).toBe(false)
  })

  it('osszegek: szamiras es penznem; penznem nelkuli szam nem osszeg', () => {
    expect(parseAmount('1 200 000')).toBe(120_000_000)
    expect(parseAmount('1.200.000,50')).toBe(120_000_050)
    expect(parseAmount('1,200,000.50')).toBe(120_000_050)
    expect(parseAmount('1200,5')).toBe(120_050)
    expect(parseAmount('abc')).toBeNull()
    expect(findAmounts('havi 150 000 Ft, összesen 1.800.000,- Ft, € 1.250,00 és 2 500 EUR; 12 hónap').map((a) => [a.cents, a.currency]))
      .toEqual([[15_000_000, 'HUF'], [180_000_000, 'HUF'], [125_000, 'EUR'], [250_000, 'EUR']])
    // Az evszam utan allo osszeg nem olvad bele az evszamba (11. pont 1/B probaeset).
    expect(findAmounts('Die Beklagte hat am 3. Januar 2026 900 Euro überwiesen.').map((a) => [a.cents, a.raw])).toEqual([[90_000, '900 Euro']])
    expect(findAmounts('12345 678 EUR').map((a) => a.cents)).toEqual([67_800])
    expect(findAmounts('2 026 900 Euro').map((a) => a.cents)).toEqual([202_690_000])
    // A magyar ragos alak is osszeg -- kulonben az allitas-forras egyeztetes nemam kimaradna.
    expect(findAmounts('900 eurót utalt, 100 000 forintot fizetett, 5000 forinttal kevesebb, 20 000 Ft-ot, 300 euróért').map((a) => [a.cents, a.currency]))
      .toEqual([[90_000, 'EUR'], [10_000_000, 'HUF'], [500_000, 'HUF'], [2_000_000, 'HUF'], [30_000, 'EUR']])
    // ...de nem minden "euro"-val kezdodo szo penznem.
    expect(findAmounts('900 europäische Unternehmen, 50 Europaletten')).toEqual([])
  })

  it('nevek: a mondat eleji szo nem nev-resz, hacsak mondat belsejeben is az; a megszolitas lemarad', () => {
    expect(findNames('Ezért Kovács Anna fizet. A felperes, Kovács Anna, vállalta.')).toEqual(['Kovács Anna', 'Kovács Anna'])
    expect(findNames('Kovács Anna a felperes. Tanúként Kovács Anna is.')).toEqual(['Kovács Anna', 'Kovács Anna'])
    expect(findNames('Tisztelt Fővárosi Törvényszék!')).toEqual(['Fővárosi Törvényszék'])
    expect(findNames('vertreten durch Herrn Thomas Müller; Herr Müller zahlte nicht.')).toEqual(['Thomas Müller'])
    expect(findNames('| Nagy Péter | 2025. május 2. |')).toEqual(['Nagy Péter'])
    // A ket szavas mondat eleji jelolt bizonytalan: az egy betus elteres-keresesbe nem szamit.
    expect(findNameCandidates('Ezért Kovács fizet. Azért Kovács nem.')).toEqual([{ name: 'Ezért Kovács', sure: false }, { name: 'Azért Kovács', sure: false }])
  })

  it('nevek: a magyar ragozas nem elteres', () => {
    expect(['Kovács Anna', 'Kovács Annát', 'Kovács Annán', 'Kovács Annának', 'Kovács Annára'].map(nameStem).every((s) => s.startsWith('kovacs ann'))).toBe(true)
    expect(nameStem('Nagy Péternek')).toBe('nagy peter')
  })

  it('ugyszamok es cimek', () => {
    expect(findCaseNumbers('a 12.P.20.123/2025/4. számú végzés, Pf.20.456/2025, 2 O 123/25, 1:23-cv-01234')).toEqual([
      '12.P.20.123/2025/4', 'Pf.20.456/2025', '2 O 123/25', '1:23-cv-01234',
    ])
    expect(findAddresses('1051 Budapest, Kossuth Lajos utca 5. és 80331 München, Karlstraße 7')).toEqual([
      { key: 'kossuth lajos utca 5', place: '1051 budapest', raw: '1051 Budapest, Kossuth Lajos utca 5' },
      { key: 'karlstrasse 7', place: '80331 munchen', raw: '80331 München, Karlstraße 7' },
    ])
  })
})

function seedRead(abs: string, name: string, pages: string[]): void {
  ensureDocReadTables()
  const sha = sha256OfFile(abs)
  const db = getDb()
  db.prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
    VALUES (?, ?, 'pdf', 'done', ?, ?, NULL, ?, 0)`).run(sha, name, pages.length, pages.length, DOCREAD_VERSION)
  pages.forEach((t, i) => db.prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, ?, ?, \'text\', NULL, 0)').run(sha, i + 1, t))
}

describe('a dokumentumban', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  let itemId = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const world = (): SourceWorld => ({
    resolveFile: (p) => (p === 'Iratok/szerzodes.pdf' ? { abs: join(projDir(), 'Iratok', 'szerzodes.pdf'), name: 'szerzodes.pdf' } : null),
    ownerMessages: () => [],
  })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-doccheck-'))
    mkdirSync(join(projDir(), 'Iratok'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    project = getProject(pid) as ProjectRow
    const w = createWorkItem({ project_id: pid, title: 'Beadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    writeFileSync(join(projDir(), 'Iratok', 'szerzodes.pdf'), 'PDF')
    seedRead(join(projDir(), 'Iratok', 'szerzodes.pdf'), 'szerzodes.pdf', ['A bérleti szerződés 2024. május 2-án jött létre, a havi bérleti díj 150.000,- Ft.'])
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function blocks(...texts: [string, 'paragraph' | 'table'][]): string[] {
    const s = addSection(itemId, '2. Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    return texts.map(([text, kind]) => {
      const b = addBlock(itemId, s.section.id, { text, kind, author: 'agent' })
      if (!b.ok) throw new Error('blokk')
      return b.block.id
    })
  }
  const kinds = () => consistencyIssues(itemId).map((i) => [i.kind, i.values])

  it('a rendben levo szoveg nem ad jelzest (ragozas, mondatkezdes, irat-sorszam)', () => {
    blocks(
      ['Kovács Anna felperes (1051 Budapest, Kossuth Lajos utca 5.) a 12.P.20.123/2025/4. számú végzést 2025. május 2-án kapta meg. Ezért Kovács Annát terheli.', 'paragraph'],
      ['Azért Kovács Annával szemben a 12.P.20.123/2025/7. számú ítélet is szól. Kovács Annának 1051 Budapest, Kossuth Lajos utca 5. a címe.', 'paragraph'],
      ['Tétel | Összeg\n---|---\nBérleti díj | 150 000\nRezsi | 50 000\nÖsszesen | 200 000', 'table'],
      ['Dátum | Esemény\n2025. január 3. | szerződés\n2025. február 1. | felszólítás\n2025. március 5. | per', 'table'],
      // Reszosszeg nem szamit ketszer; az ures cella nulla.
      ['Tétel | Ft\nBér | 100 000\nRezsi | \nRészösszeg | 100 000\nKötbér | 20 000\nÖsszesen | 120 000 Ft', 'table'],
    )
    expect(consistencyIssues(itemId)).toEqual([])
    expect(documentCheck(itemId).items.find((i) => i.key === 'consistency')).toMatchObject({ ok: true, count: 0, total: 0 })
    // Mondat eleji kotoszo + vezeteknev: nem ket kulonbozo nev.
    blocks(['Ezért Kovács fizet. Azért Kovács nem fizet.', 'paragraph'])
    expect(consistencyIssues(itemId)).toEqual([])
  })

  it('nevek, ugyszam, cim, datum, tablazat: a valodi elteresek jelzest kapnak', () => {
    blocks(
      ['Korpás László és Kovács Anna a 12.P.20.123/2025 számú ügyben. Tanú: Korpas Laszlo és Kovács Ana. Lásd még 12.P.20.132/2025.', 'paragraph'],
      ['Lakcím: 1051 Budapest, Kossuth Lajos utca 5. Kézbesítés: 1052 Budapest, Kossuth Lajos utca 5. Határidő: 2025. február 30.', 'paragraph'],
      ['Tétel | Összeg\n---|---\nBérleti díj | 150 000\nRezsi | 50 000\nÖsszesen | 210 000', 'table'],
      ['Dátum | Esemény\n2025. január 3. | szerződés\n2025. március 5. | per\n2025. február 1. | felszólítás', 'table'],
    )
    expect(kinds()).toEqual(expect.arrayContaining([
      ['name_variant', ['Korpás László', 'Korpas Laszlo']],
      ['name_variant', ['Kovács Anna', 'Kovács Ana']],
      ['case_number_variant', ['12.P.20.123/2025', '12.P.20.132/2025']],
      ['date_invalid', ['2025. február 30']],
      ['address_variant', ['1051 Budapest, Kossuth Lajos utca 5', '1052 Budapest, Kossuth Lajos utca 5']],
      ['amount_sum', ['Összesen: 210 000', '200 000']],
      ['date_order', ['2025. március 5', '2025. február 1']],
    ]))
    expect(kinds()).toHaveLength(7)
    const where = consistencyIssues(itemId).find((i) => i.kind === 'amount_sum')?.where
    expect(where).toBe('2. Tényállás')
  })

  it('allitas es forrasa: a datum es az osszeg egyezzen az idezettel (mas irasmodban is)', () => {
    const [ok, bad] = blocks(
      ['A szerződés 2024.05.02. napján jött létre, a bér havi 150 000 Ft.', 'paragraph'],
      ['A szerződés 2024. május 3-án jött létre, a bér havi 160 000 Ft.', 'paragraph'],
    ) as [string, string]
    const src = [{ kind: 'document', path: 'Iratok/szerzodes.pdf', page: 1, quote: '2024. május 2-án jött létre, a havi bérleti díj 150.000,- Ft' }]
    expect(addClaim(itemId, ok, 'A szerződés 2024.05.02. napján jött létre, a bér havi 150 000 Ft.', src, world(), 'agent').ok).toBe(true)
    expect(addClaim(itemId, bad, 'A szerződés 2024. május 3-án jött létre, a bér havi 160 000 Ft.', src, world(), 'agent').ok).toBe(true)
    expect(kinds()).toEqual([
      ['claim_date_mismatch', ['2024. május 3', '2024. május 2']],
      ['claim_amount_mismatch', ['160 000 Ft', '150.000,- Ft']],
    ])
    expect(consistencyIssues(itemId).map((i) => i.where)).toEqual(['2. Tényállás', '2. Tényállás'])
  })

  it('szandekos jeloles: nem allitja meg a veglegesitest, visszavonhato; a szoveg javitasa eltunteti', () => {
    const [b] = blocks(['Korpás László, más helyen Korpas Laszlo.', 'paragraph'])
    const [issue] = consistencyIssues(itemId)
    expect(issue).toMatchObject({ kind: 'name_variant', acked: false })
    const check = () => documentCheck(itemId)
    expect(check().ready).toBe(false)
    expect(check().items.find((i) => i.key === 'consistency')).toMatchObject({ ok: false, count: 1, total: 1, detail: ['name_variant: Korpás László / Korpas Laszlo'] })

    expect(ackConsistencyIssue(itemId, issue!.key, 'teszt')).toBe(true)
    expect(consistencyIssues(itemId)[0]).toMatchObject({ acked: true, acked_by: 'teszt' })
    expect(check().items.find((i) => i.key === 'consistency')).toMatchObject({ ok: true, count: 0, total: 1 })
    expect(check().ready).toBe(true)
    // A nyomban is ott van, ki jelolte szandekosnak.
    const trail = documentTrail(getWorkItem(itemId)!) as { consistency: { kind: string; marked_intentional_by: string | null }[] }
    expect(trail.consistency).toEqual([expect.objectContaining({ kind: 'name_variant', marked_intentional_by: 'teszt' })])

    unackConsistencyIssue(itemId, issue!.key)
    expect(check().ready).toBe(false)
    // Nem letezo jelzes nem jelolheto.
    expect(ackConsistencyIssue(itemId, 'nincs-ilyen', 'teszt')).toBe(false)

    expect(updateBlock(itemId, b!, { text: 'Korpás László, más helyen Korpás László.', author: 'owner' }).ok).toBe(true)
    expect(consistencyIssues(itemId)).toEqual([])
  })

  it('utvonalak: csak a tulajdonos jelolhet; eltunt jelzesnel friss lista jon', async () => {
    blocks(['Korpás László, más helyen Korpas Laszlo.', 'paragraph'])
    const base = `/api/workbench/items/${itemId}/outline`
    const get = await callWorkbench(base, 'GET')
    expect(get.status).toBe(200)
    const key = get.body.outline.consistency[0].key as string
    expect(get.body.outline.check.items.find((i: { key: string }) => i.key === 'consistency')).toMatchObject({ ok: false, count: 1 })

    const agent = await callWorkbench(`${base}/consistency/${key}/ack`, 'POST', {}, undefined, { kind: 'token' })
    expect(agent.status).toBe(403)
    expect(agent.body.error).toBe('outline_owner_only')

    const ack = await callWorkbench(`${base}/consistency/${key}/ack`, 'POST', {})
    expect(ack.status).toBe(200)
    expect(ack.body.outline.consistency[0]).toMatchObject({ key, acked: true, acked_by: 'teszt' })
    expect(ack.body.outline.check.ready).toBe(true)

    const undo = await callWorkbench(`${base}/consistency/${key}/ack`, 'DELETE')
    expect(undo.status).toBe(200)
    expect(undo.body.outline.consistency[0].acked).toBe(false)

    const gone = await callWorkbench(`${base}/consistency/deadbeef/ack`, 'POST', {})
    expect(gone.status).toBe(404)
    expect(gone.body.error).toBe('outline_consistency_gone')
    expect(gone.body.message).toContain('már nincs a dokumentumban')
    expect(gone.body.outline.consistency).toHaveLength(1)
  })

  it('az agent a doc.check-ben latja a jelzeseket, de elnemitani nem tudja', () => {
    blocks(['Korpás László, más helyen Korpas Laszlo.', 'paragraph'])
    const r = executeTool('doc.check', {}, { projectId: pid, workItemId: itemId, lang: 'hu' })
    expect(r.ok).toBe(true)
    const data = (r as { data: { ready: boolean; consistency: { kind: string; values: string[]; marked_intentional_by_owner: boolean }[] } }).data
    expect(data.ready).toBe(false)
    expect(data.consistency).toEqual([{ kind: 'name_variant', values: ['Korpás László', 'Korpas Laszlo'], section: null, marked_intentional_by_owner: false }])
  })

  it('a munkadarab vegleges torlese a jeloleseket is viszi', () => {
    blocks(['Korpás László, más helyen Korpas Laszlo.', 'paragraph'])
    ackConsistencyIssue(itemId, consistencyIssues(itemId)[0]!.key, 'teszt')
    setWorkItemDeleted(itemId, true)
    expect(purgeWorkItem(itemId).ok).toBe(true)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM wb_doc_consistency_acks').get() as { n: number }).n).toBe(0)
  })
})

describe('a felulet: kovetkezetesseg', () => {
  it('a jelzesek emberi mondattal, "Szandekos" gombbal; a jelolt visszavonhato', async () => {
    const h = workbenchHarness({ confirm: true })
    const ITEM = { id: 'w1', title: 'Beadvány', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Beadvany', source_path: null }
    const OUTLINE = {
      sections: [{ id: 's1', title: '1. Tényállás', status: 'done', problems: 0, blocks: [{ id: 'b1', kind: 'paragraph', text: 'Korpás László, Korpas Laszlo.', owner_edited_at: null, missing: [], claims: [] }] }],
      check: { ready: false, items: [{ key: 'consistency', ok: false, count: 1, total: 2, detail: ['name_variant: Korpás László / Korpas Laszlo'] }] },
      consistency: [
        { key: 'k1', kind: 'name_variant', values: ['Korpás László', 'Korpas Laszlo'], where: null, acked: false, acked_at: null, acked_by: null },
        { key: 'k2', kind: 'amount_sum', values: ['Összesen: 210 000', '200 000'], where: '1. Tényállás', acked: true, acked_at: 1, acked_by: 'teszt' },
      ],
      annexes: [], settings: { annex_scheme: 'k', annex_prefix: 'K', annex_mode: 'separate', schemes: ['k'], modes: ['separate'] },
      content_hash: 'h', reviewed: false, final: null,
    }
    h.respond((url) => {
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/outline')) return { status: 200, body: { ok: true, outline: OUTLINE } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [], outline: OUTLINE } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-outline-check'))
    const html = h.html()
    expect(html).toContain('workbench.outline.check.consistency')
    expect(html).toContain('workbench.consistency.hint')
    expect(html).toContain('workbench.consistency.kind.name_variant')
    expect(html).toContain('data-wb-act="outline-consistency-ack" data-wb-key="k1"')
    expect(html).toContain('workbench.consistency.acked')
    expect(html).toContain('data-wb-act="outline-consistency-unack" data-wb-key="k2"')
    // A nyers gepi sor ("name_variant: ...") nem kerul a tulajdonos ele.
    expect(html).not.toContain('name_variant: Korpás')
    h.click({ 'data-wb-act': 'outline-consistency-ack', 'data-wb-key': 'k1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/consistency/k1/ack') && c.init?.method === 'POST')).toBe(true))
    h.click({ 'data-wb-act': 'outline-consistency-unack', 'data-wb-key': 'k2' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/consistency/k2/ack') && c.init?.method === 'DELETE')).toBe(true))
  })
})
