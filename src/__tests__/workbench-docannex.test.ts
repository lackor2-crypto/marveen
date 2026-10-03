// #441 (v4 spec 1/A, K-1.18): mellekletjegyzek. A szovegben allo hivatkozasok
// es a jegyzek MINDIG egyeznek: atrendezesnel, levetelnel, semavaltasnal a
// szoveg is atirodik; hianyzo vagy folosleges mellekletnel a veglegesites all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject, getProject, type ProjectRow } from '../projects.js'
import { createWorkItem, getWorkItem, createWorkItemVersion } from '../workbench.js'
import { addSection, addBlock, addClaim, documentCheck, documentOutline, listClaims } from '../workbench-docmodel.js'
import {
  addAnnex, annexCheck, annexLabel, annexRefs, fromLetters, letters, listAnnexes, removeAnnex, setDocSettings, updateAnnex,
} from '../workbench-docannex.js'
import { buildFodt } from '../workbench-docrender.js'
import { contentHash, renderInputFor } from '../workbench-docfinal.js'
import { ensureWorkItemFolder, renameWorkItem } from '../workbench-assets.js'
import { resolveProjectFile } from '../workbench-docmodel-world.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { executeTool } from '../workbench-agent/execute.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

describe('cimkek es hivatkozasok', () => {
  it('betus sorszam (Exhibit A ... Z, AA)', () => {
    expect([1, 2, 26, 27, 52, 53].map(letters)).toEqual(['A', 'B', 'Z', 'AA', 'AZ', 'BA'])
    for (const n of [1, 5, 26, 27, 200]) expect(fromLetters(letters(n))).toBe(n)
  })

  it('a harom sema cimkeje', () => {
    expect(annexLabel({ annex_scheme: 'k', annex_prefix: 'K' }, 3)).toBe('K3')
    expect(annexLabel({ annex_scheme: 'anlage', annex_prefix: 'B' }, 2)).toBe('Anlage B2')
    expect(annexLabel({ annex_scheme: 'exhibit', annex_prefix: 'K' }, 3)).toBe('Exhibit C')
  })

  it('felismeri a hivatkozast, a tartomanyt; szo belsejeben nem', () => {
    const k = { annex_scheme: 'k' as const, annex_prefix: 'K' }
    expect(annexRefs('A K1. melléklet szerint, lásd még (K 3).', k)).toEqual([1, 3])
    expect(annexRefs('A K1–K4. alatt csatolt iratok', k)).toEqual([1, 2, 3, 4])
    expect(annexRefs('K2-5 mellékletek', k)).toEqual([2, 3, 4, 5])
    expect(annexRefs('KK1, AK2, K12a, 5K1', k)).toEqual([])
    const de = { annex_scheme: 'anlage' as const, annex_prefix: 'K' }
    expect(annexRefs('Beweis: Anlage K1 bis Anlage K3; Anl. K7', de)).toEqual([1, 2, 3, 7])
    const en = { annex_scheme: 'exhibit' as const, annex_prefix: 'K' }
    expect(annexRefs('See Exhibit A and Exhibit C; not Exhibits.', en)).toEqual([1, 3])
    // A mar hianyzonak jelolt hivatkozas nem szamit.
    expect(annexRefs('⚠ Hiányzó adat: a hivatkozott melléklet nincs a jegyzékben (K2) es K1', k)).toEqual([1])
    // A nemet sema cimkeje nem K-hivatkozas (kulonben semavaltaskor "Anlage Anlage K1" lenne).
    expect(annexRefs('Beweis: Anlage K1, Anl. K2, Anl.K3, Anlage K4; und K5', k)).toEqual([5])
  })
})

describe('a mellekletjegyzek a dokumentumban', () => {
  let depot = ''
  let pid = ''
  let project: ProjectRow
  let itemId = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const resolve = (p: string) => resolveProjectFile(project, p)

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docannex-'))
    mkdirSync(join(projDir(), 'Iratok'), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    project = getProject(pid) as ProjectRow
    const w = createWorkItem({ project_id: pid, title: 'Válaszbeadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    for (const f of ['szerzodes.pdf', 'szamla.pdf', 'level.pdf', 'foto.jpg']) writeFileSync(join(projDir(), 'Iratok', f), f)
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  function annex(path: string, title: string, position?: number): string {
    const r = addAnnex(itemId, { path, title, position }, resolve, 'teszt')
    if (!r.ok) throw new Error(r.detail)
    return r.annex.id
  }
  function text(): string {
    return documentOutline(itemId).sections.flatMap((s) => s.blocks.map((b) => b.text)).join('\n')
  }

  it('szamozas a sorrendbol; atrendezesnel a szoveg es az allitas is atszamozodik, az allitas megmarad', () => {
    const a1 = annex('Iratok/szerzodes.pdf', 'Bérleti szerződés')
    const a2 = annex('Iratok/szamla.pdf', 'Számla')
    const s = addSection(itemId, '1. Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text: 'A szerződést K1 alatt, a számlát K2 alatt csatolom.', author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    const c = addClaim(itemId, b.block.id, 'a számlát K2 alatt csatolom', [{ kind: 'owner', said: 'a számla megvan' }],
      { resolveFile: resolve, ownerMessages: () => [{ id: 'm', content: 'a számla megvan', created_at: 1 }] }, 'agent')
    expect(c.ok).toBe(true)
    expect(listAnnexes(itemId, resolve).map((a) => [a.label, a.refs, a.exists])).toEqual([['K1', 1, true], ['K2', 1, true]])

    const moved = updateAnnex(itemId, a2, { position: 0 })
    expect(moved.ok && moved.rewritten).toBe(1)
    expect(text()).toBe('A szerződést K2 alatt, a számlát K1 alatt csatolom.')
    expect(listClaims(itemId).map((x) => x.text)).toEqual(['a számlát K1 alatt csatolom'])
    expect(listAnnexes(itemId).map((a) => [a.label, a.title])).toEqual([['K1', 'Számla'], ['K2', 'Bérleti szerződés']])
    expect(a1).toBeTruthy()
  })

  it('levetel: a kovetkezok feljebb lepnek, a levett hivatkozasa hianyjeloles lesz, ami megallitja a veglegesitest', () => {
    annex('Iratok/szerzodes.pdf', 'Szerződés')
    const a2 = annex('Iratok/szamla.pdf', 'Számla')
    annex('Iratok/level.pdf', 'Levél')
    const s = addSection(itemId, 'Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Lásd K1, K2 és K3.', author: 'agent' })
    expect(documentCheck(itemId, resolve).ready).toBe(true)
    const r = removeAnnex(itemId, a2)
    expect(r.ok).toBe(true)
    expect(text()).toBe('Lásd K1, ⚠ Hiányzó adat: a hivatkozott melléklet nincs a jegyzékben (K2) és K2.')
    expect(listAnnexes(itemId).map((a) => a.title)).toEqual(['Szerződés', 'Levél'])
    const chk = documentCheck(itemId, resolve)
    expect(chk.ready).toBe(false)
    expect(chk.items.find((i) => i.key === 'missing_data')?.ok).toBe(false)
    expect(chk.items.find((i) => i.key === 'annexes')).toMatchObject({ ok: true, count: 2, total: 2 })
    // Egy ujabb atrendezes a halott hivatkozashoz nem nyul.
    const list = listAnnexes(itemId)
    updateAnnex(itemId, list[1]!.id, { position: 0 })
    expect(text()).toBe('Lásd K2, ⚠ Hiányzó adat: a hivatkozott melléklet nincs a jegyzékben (K2) és K1.')
  })

  it('ellenorzes: hivatkozas nelkuli melleklet, nem letezo mellekletre mutato hivatkozas, eltunt fajl', () => {
    annex('Iratok/szerzodes.pdf', 'Szerződés')
    annex('Iratok/szamla.pdf', 'Számla')
    const s = addSection(itemId, 'Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Lásd K1 és K5.', author: 'agent' })
    rmSync(join(projDir(), 'Iratok', 'szerzodes.pdf'))
    const ax = annexCheck(itemId, resolve)
    expect(ax).toEqual({ total: 2, ok: 0, dangling: ['K5'], unreferenced: ['K2'], missing_files: ['K1'], unsupported: [] })
    const chk = documentCheck(itemId, resolve)
    expect(chk.ready).toBe(false)
    const keys = chk.items.map((i) => i.key)
    expect(keys).toEqual(expect.arrayContaining(['annexes', 'annex_unreferenced', 'annex_dangling', 'annex_missing_file']))
    // Melleklet es hivatkozas nelkul nincs ilyen sor (nem zaj).
    const other = createWorkItem({ project_id: pid, title: 'Másik', type: 'document' })
    if (!other.ok) throw new Error('masik')
    expect(documentCheck(other.item.id).items.some((i) => i.key.startsWith('annex'))).toBe(false)
  })

  it('beszuras kozepre: az elore megirt, nem letezo mellekletre mutato hivatkozas nem mutat csendben rossz mellekletre', () => {
    annex('Iratok/szerzodes.pdf', 'Szerződés')
    const s = addSection(itemId, 'Tényállás')
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'K1 és K2 szerint.', author: 'agent' })
    annex('Iratok/szamla.pdf', 'Számla', 0)
    expect(text()).toBe('K2 és ⚠ Hiányzó adat: a hivatkozott melléklet nincs a jegyzékben (K2) szerint.')
  })

  it('semavaltas es betujel: a hivatkozasok a szovegben is atirodnak; rossz ertek elutasitva', () => {
    annex('Iratok/szerzodes.pdf', 'Szerződés')
    annex('Iratok/szamla.pdf', 'Számla')
    const s = addSection(itemId, 'Tényállás')
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Lásd K1 és K2.', author: 'agent' })
    expect(setDocSettings(itemId, { annex_scheme: 'anlage' }).ok).toBe(true)
    expect(text()).toBe('Lásd Anlage K1 és Anlage K2.')
    expect(setDocSettings(itemId, { annex_prefix: 'b' }).ok).toBe(true)
    expect(text()).toBe('Lásd Anlage B1 és Anlage B2.')
    expect(setDocSettings(itemId, { annex_scheme: 'exhibit' }).ok).toBe(true)
    expect(text()).toBe('Lásd Exhibit A és Exhibit B.')
    expect(setDocSettings(itemId, { annex_scheme: 'k', annex_prefix: 'K' }).ok).toBe(true)
    expect(text()).toBe('Lásd K1 és K2.')
    expect(setDocSettings(itemId, { annex_scheme: 'bates' }).ok).toBe(false)
    expect(setDocSettings(itemId, { annex_prefix: 'K1' }).ok).toBe(false)
    expect(setDocSettings(itemId, { annex_mode: 'zip' }).ok).toBe(false)
  })

  it('a nemetre forditott szoveg utan beallitott Anlage-sema nem rontja el a hivatkozasokat (11. pont 1/B)', () => {
    // A nyelvi valtozat mellekletjegyzek nelkul indul; a Marvin elobb fordit
    // ("Anlage K1"), aztan allitja a semat, aztan veszi fel a mellekleteket.
    const s = addSection(itemId, 'Sachverhalt')
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Miete laut Mietvertrag (Anlage K1), Zahlung (Anlage K2); siehe auch K3.', author: 'agent' })
    expect(setDocSettings(itemId, { annex_scheme: 'anlage' }).ok).toBe(true)
    // A mar nemet cimke valtozatlan; a csupasz K3 atcimkezodik -- egyik sem lesz "torolt melleklet".
    expect(text()).toBe('Miete laut Mietvertrag (Anlage K1), Zahlung (Anlage K2); siehe auch Anlage K3.')
    // A jegyzekben meg nem szereplo melleklet ettol meg megallitja a veglegesitest.
    expect(annexCheck(itemId, resolve)).toMatchObject({ total: 0, dangling: ['Anlage K1', 'Anlage K2', 'Anlage K3'] })
    annex('Iratok/szerzodes.pdf', 'Mietvertrag')
    annex('Iratok/szamla.pdf', 'Kontoauszug')
    expect(annexCheck(itemId, resolve)).toMatchObject({ total: 2, dangling: ['Anlage K3'], unreferenced: [] })
    // Vissza magyarra: a nemet cimkebol K-cimke lesz, duplazas nelkul.
    expect(setDocSettings(itemId, { annex_scheme: 'k' }).ok).toBe(true)
    expect(text()).toBe('Miete laut Mietvertrag (K1), Zahlung (K2); siehe auch K3.')
  })

  it('nem letezo fajl es ketszer ugyanaz a fajl nem veheto fel', () => {
    expect(addAnnex(itemId, { path: 'Iratok/nincs.pdf', title: 'x' }, resolve, null)).toMatchObject({ ok: false, code: 'file_missing' })
    expect(addAnnex(itemId, { path: '../../etc/passwd', title: 'x' }, resolve, null)).toMatchObject({ ok: false, code: 'file_missing' })
    annex('Iratok/szerzodes.pdf', 'Szerződés')
    expect(addAnnex(itemId, { path: 'Iratok/szerzodes.pdf', title: 'ujra' }, resolve, null)).toMatchObject({ ok: false, code: 'duplicate' })
    // Leiras nelkul a fajl nevebol.
    const r = addAnnex(itemId, { path: 'Iratok/foto.jpg' }, resolve, null)
    expect(r.ok && r.annex.title).toBe('foto')
  })

  it('a PDF vegen a jegyzek (cimke + leiras, fajlut nelkul); a leiras modositasa megvaltoztatja az ujjlenyomatot', () => {
    const id = annex('Iratok/szerzodes.pdf', 'Bérleti szerződés')
    const s = addSection(itemId, 'Tényállás')
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'Lásd K1.', author: 'agent' })
    const item = getWorkItem(itemId)
    if (!item) throw new Error('munkadarab')
    const input = renderInputFor(item)
    expect(input.annexes).toEqual([{ label: 'K1', title: 'Bérleti szerződés' }])
    const xml = buildFodt(input, { title: 'Beadvány', author: null, draft: false, lang: 'hu' })
    expect(xml).toContain('>Mellékletek</text:h>')
    expect(xml).toContain('<text:p text:style-name="AnnexLine">K1 – Bérleti szerződés</text:p>')
    expect(xml).not.toContain('szerzodes.pdf')
    const h1 = contentHash(item)
    updateAnnex(itemId, id, { title: 'Bérleti szerződés (2024)' })
    expect(contentHash(item)).not.toBe(h1)
    setDocSettings(itemId, { annex_scheme: 'anlage' })
    expect(buildFodt(renderInputFor(item), { title: 'B', author: null, draft: false, lang: 'hu' })).toContain('>Anlagen</text:h>')
  })

  it('#478: a munkadarab atnevezese NEM mozgatja a mappat -- a mellekletek, irat-forrasok es a vegleges PDF utja a helyen marad', () => {
    const item = getWorkItem(itemId)
    if (!item) throw new Error('munkadarab')
    const f = ensureWorkItemFolder(item)
    if (!f.ok) throw new Error('mappa')
    const folderAbs = join(projDir(), f.folder)
    writeFileSync(join(folderAbs, 'idezes.pdf'), 'PDF')
    ensureDocReadTables()
    const sha = sha256OfFile(join(folderAbs, 'idezes.pdf'))
    getDb().prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at) VALUES (?, 'idezes.pdf', 'pdf', 'done', 1, 1, NULL, ?, 0)`).run(sha, DOCREAD_VERSION)
    getDb().prepare(`INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 1, 'Termin am 17. März 2027', 'text', NULL, 0)`).run(sha)
    annex(`${f.folder}/idezes.pdf`, 'Idézés')
    const s = addSection(itemId, 'Tényállás')
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text: 'A tárgyalás 2027. március 17-én lesz (K1).', author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    const c = addClaim(itemId, b.block.id, 'A tárgyalás 2027. március 17-én lesz', [{ kind: 'document', path: `${f.folder}/idezes.pdf`, page: 1, quote: 'Termin am 17. März 2027' }],
      { resolveFile: resolve, ownerMessages: () => [] }, 'agent')
    expect(c.ok && c.claim.strength).toBe('verified')
    const depotRel = `Projektek/Iroda/${f.folder}/Beadvány – Végleges – 2026-09-29.pdf`
    writeFileSync(join(depot, depotRel), '%PDF')
    createWorkItemVersion(itemId, { prompt: 'Végleges – 2026-09-29', metadata_json: JSON.stringify({ final: true, content_hash: 'x', pdf_path: depotRel }) })

    const r = renameWorkItem(item, 'Válasz a keresetre')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.folder).toMatchObject({ ok: true, renamed: false, reason: 'independent' })
    expect(getWorkItem(itemId)?.title).toBe('Válasz a keresetre')
    // #478: a munkadarab neve fuggetlen a mappatol -- a mappa es MINDEN hivatkozas (mellekletek, forrasok, vegleges PDF) a helyen marad.
    const folderAfter = getWorkItem(itemId)?.folder as string
    expect(folderAfter).toBe(f.folder)
    expect(listAnnexes(itemId, resolve).map((a) => [a.path, a.exists])).toEqual([[`${f.folder}/idezes.pdf`, true]])
    expect(listClaims(itemId)[0]!.sources[0]!.path).toBe(`${f.folder}/idezes.pdf`)
    const meta = JSON.parse((getDb().prepare("SELECT metadata_json FROM work_item_versions WHERE work_item_id = ? AND metadata_json LIKE '%pdf_path%'").get(itemId) as { metadata_json: string }).metadata_json)
    expect(meta.pdf_path).toBe(`Projektek/Iroda/${f.folder}/Beadvány – Végleges – 2026-09-29.pdf`)
    expect(existsSync(join(depot, meta.pdf_path))).toBe(true)
  })

  it('utvonalak: felvetel, atrendezes, levetel, beallitas; a vazlat a jegyzeket es a beallitast is viszi', async () => {
    const base = `/api/workbench/items/${itemId}/outline`
    const s = await callWorkbench(`${base}/sections`, 'POST', { title: 'Tényállás' })
    const sid = s.body.outline.sections[0].id
    await callWorkbench(`${base}/blocks`, 'POST', { section: sid, text: 'Lásd K1 és K2.' })
    const a1 = await callWorkbench(`${base}/annexes`, 'POST', { path: 'Iratok/szerzodes.pdf', title: 'Szerződés' })
    expect(a1.status).toBe(201)
    const a2 = await callWorkbench(`${base}/annexes`, 'POST', { path: 'Iratok/szamla.pdf', title: 'Számla' })
    expect(a2.body.outline.annexes.map((a: { label: string; refs: number; exists: boolean }) => [a.label, a.refs, a.exists])).toEqual([['K1', 1, true], ['K2', 1, true]])
    expect(a2.body.outline.settings).toMatchObject({ annex_scheme: 'k', annex_prefix: 'K', annex_mode: 'separate' })
    expect(a2.body.outline.check.items.find((i: { key: string }) => i.key === 'annexes')).toMatchObject({ ok: true, count: 2, total: 2 })
    const dup = await callWorkbench(`${base}/annexes`, 'POST', { path: 'Iratok/szamla.pdf', title: 'x' })
    expect(dup.status).toBe(400)
    expect(dup.body.error).toBe('outline_duplicate')
    const missing = await callWorkbench(`${base}/annexes`, 'POST', { path: 'Iratok/nincs.pdf', title: 'x' })
    expect(missing.body.error).toBe('outline_file_missing')
    const second = a2.body.outline.annexes[1].id
    const mv = await callWorkbench(`${base}/annexes/${second}`, 'PATCH', { position: 0 })
    expect(mv.body.outline.sections[0].blocks[0].text).toBe('Lásd K2 és K1.')
    const st = await callWorkbench(`${base}/settings`, 'PATCH', { annex_scheme: 'exhibit' })
    expect(st.body.outline.sections[0].blocks[0].text).toBe('Lásd Exhibit B és Exhibit A.')
    const del = await callWorkbench(`${base}/annexes/${second}`, 'DELETE')
    expect(del.body.outline.annexes).toHaveLength(1)
    expect(del.body.outline.sections[0].blocks[0].text).toContain('⚠ Hiányzó adat')
  })

  it('az agent a doc.* eszkozokkel ugyanigy kezeli', () => {
    const ctx = { projectId: pid, workItemId: itemId, lang: 'hu' as const }
    const add = executeTool('doc.addAnnex', { path: 'Iratok/szerzodes.pdf', title: 'Szerződés' }, ctx)
    expect(add.ok).toBe(true)
    const list = executeTool('doc.annexes', {}, ctx)
    expect(list.ok && (list.data as { annexes: { label: string }[] }).annexes.map((a) => a.label)).toEqual(['K1'])
    const set = executeTool('doc.annexSettings', { scheme: 'anlage', prefix: 'B' }, ctx)
    expect(set.ok).toBe(true)
    const again = executeTool('doc.annexes', {}, ctx)
    expect(again.ok && (again.data as { annexes: { label: string }[] }).annexes[0]!.label).toBe('Anlage B1')
    const bad = executeTool('doc.addAnnex', { path: 'nincs.pdf' }, ctx)
    expect(bad.ok).toBe(false)
  })
})

describe('a felulet: mellekletek', () => {
  const ITEM = { id: 'w1', title: 'Beadvány', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Beadvany', source_path: null }
  const ASSETS = [
    { id: 'as1', name: 'szerzodes.pdf', project_path: 'Beadvany/szerzodes.pdf', path: 'P/Beadvany/szerzodes.pdf', support: 'readable', present: true },
    { id: 'as2', name: 'szamla.pdf', project_path: 'Beadvany/szamla.pdf', path: 'P/Beadvany/szamla.pdf', support: 'readable', present: true },
  ]
  const OUTLINE = {
    sections: [{ id: 's1', title: '1. Tényállás', status: 'done', problems: 0, blocks: [{ id: 'b1', kind: 'paragraph', text: 'Lásd K1.', owner_edited_at: null, missing: [], claims: [] }] }],
    check: { ready: false, items: [{ key: 'annexes', ok: false, count: 0, total: 1 }] },
    annexes: [{ id: 'ax1', label: 'K1', title: 'Szerződés', path: 'Beadvany/szerzodes.pdf', exists: false, refs: 0, number: 1 }],
    settings: { annex_scheme: 'k', annex_prefix: 'K', annex_mode: 'separate', schemes: ['k', 'anlage', 'exhibit'], modes: ['separate', 'combined'] },
    content_hash: 'h', reviewed: false, final: null,
  }

  it('lista figyelmeztetesekkel; felvetel az anyagokbol; semavaltas', async () => {
    const h = workbenchHarness({ confirm: true })
    h.respond((url) => {
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/outline')) return { status: 200, body: { ok: true, outline: OUTLINE } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: ASSETS, outline: OUTLINE } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-annexes'))
    const html = h.html()
    expect(html).toContain('<strong>K1</strong> – Szerződés')
    expect(html).toContain('workbench.annex.missing_file')
    expect(html).toContain('workbench.annex.unreferenced')
    // A mar mellekletkent felvett fajl nincs a valasztoban, a masik igen.
    expect(html).toContain('<option value="Beadvany/szamla.pdf">szamla.pdf</option>')
    expect(html).not.toContain('<option value="Beadvany/szerzodes.pdf">')
    expect(html).toContain('<option value="k" selected>')
    expect(html).toContain('id="wbAnnexPrefix"')
    // Felvetel: a valasztott fajl es a leiras megy a szerverre.
    h.inputs['wbAnnexPick'] = { value: 'Beadvany/szamla.pdf', focus() {} }
    h.inputs['wbAnnexTitle'] = { value: ' Számla ', focus() {} }
    h.click({ 'data-wb-act': 'outline-annex-add' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/annexes') && c.init?.method === 'POST')).toBe(true))
    const add = h.fetchCalls.find((c) => c.url.includes('/outline/annexes') && c.init?.method === 'POST')
    expect(JSON.parse(String(add?.init?.body))).toEqual({ path: 'Beadvany/szamla.pdf', title: 'Számla' })
    // Semavaltas.
    h.fire('change', { target: { id: 'wbAnnexScheme', value: 'anlage' } })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/settings'))).toBe(true))
    const set = h.fetchCalls.find((c) => c.url.includes('/outline/settings'))
    expect(JSON.parse(String(set?.init?.body))).toEqual({ annex_scheme: 'anlage' })
    // Rossz betujel: nem megy ki, emberi uzenet jon.
    h.fire('change', { target: { id: 'wbAnnexPrefix', value: 'K1' } })
    expect(h.toasts).toContain('⟦workbench.annex.prefix_bad⟧')
  })
})
