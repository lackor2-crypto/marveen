// #441 (v4 spec 1/B, K-1.27 ... K-1.31): nyelvi valtozatok. A valtozat KULON
// munkadarab, fejezetenkent osszekotve az eredetivel; ha az eredeti fejezete
// valtozik, a valtozat fejezete elavult. A forditott allitas UGYANARRA a
// forrasra mutat. Ugyenkenti szoszedet gepi ellenorzessel, visszaforditas-
// ellenorzes az eredeti mellett. A forditast az agent vegzi (doc.* eszkozok).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem, purgeWorkItem, setWorkItemDeleted, type WorkItemRow } from '../workbench.js'
import { addSection, addBlock, addClaim, documentOutline, documentCheck, updateBlock, removeSection, type SourceWorld } from '../workbench-docmodel.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import {
  createVariant, variantInfo, variantsSummary, translateSection, addGlossaryTerm, removeGlossaryTerm, listGlossary,
  glossaryIssues, setBackTranslation, backchecks, variantCheckItems,
} from '../workbench-doclang.js'
import { docLangFor } from '../workbench-docfinal.js'
import { buildFodt } from '../workbench-docrender.js'
import { executeTool } from '../workbench-agent/execute.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const PAGE = 'Landgericht Berlin. Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.'
const CLAIM = 'A tárgyalás 2027. március 17-én 10:30-kor lesz.'
const CLAIM_DE = 'Die Verhandlung findet am 17. März 2027 um 10:30 Uhr statt.'

describe('nyelvi valtozatok a dokumentummodellben', () => {
  let depot = ''
  let pid = ''
  let src: WorkItemRow
  let secId = ''
  let blockId = ''
  let claimId = ''
  const saved: Record<string, string | undefined> = {}
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const world = (): SourceWorld => ({
    resolveFile: (p) => (p === 'Level/idezes.pdf' ? { abs: join(projDir(), 'Level', 'idezes.pdf'), name: 'idezes.pdf' } : null),
    ownerMessages: () => [],
  })

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-doclang-'))
    mkdirSync(join(projDir(), 'Level'), { recursive: true })
    saved['MARVEEN_DEPOT'] = process.env['MARVEEN_DEPOT']
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Válaszbeadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    src = w.item
    const abs = join(projDir(), 'Level', 'idezes.pdf')
    writeFileSync(abs, 'PDF')
    ensureDocReadTables()
    const sha = sha256OfFile(abs)
    getDb().prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, 'idezes.pdf', 'pdf', 'done', 1, 1, NULL, ?, 0)`).run(sha, DOCREAD_VERSION)
    getDb().prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 1, ?, \'text\', NULL, 0)').run(sha, PAGE)
    const s = addSection(src.id, '1. Tényállás')
    if (!s.ok) throw new Error('fejezet')
    secId = s.section.id
    const b = addBlock(src.id, secId, { text: `A keresetlevél szerint ${CLAIM}`, author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    blockId = b.block.id
    const c = addClaim(src.id, blockId, CLAIM, [{ kind: 'document', path: 'Level/idezes.pdf', page: 1, quote: 'am 17. März 2027 um 10:30 Uhr' }], world(), 'workbench-agent')
    if (!c.ok) throw new Error('allitas')
    claimId = c.claim.id
    addSection(src.id, '2. Kérelem')
  })
  afterEach(() => {
    if (saved['MARVEEN_DEPOT'] === undefined) delete process.env['MARVEEN_DEPOT']
    else process.env['MARVEEN_DEPOT'] = saved['MARVEEN_DEPOT']
    rmSync(depot, { recursive: true, force: true })
  })

  const makeDe = (): WorkItemRow => {
    const r = createVariant(src, 'de', 'teszt')
    if (!r.ok) throw new Error(r.detail)
    return r.item
  }
  const translateFirst = (vid: string, text = `Laut der Klageschrift: ${CLAIM_DE}`) => translateSection(vid, {
    source_section: secId, title: '1. Sachverhalt',
    blocks: [{ text, claims: [{ source_claim: claimId, text: CLAIM_DE }] }],
  }, 'workbench-agent')

  it('kulon munkadarab ugyanabban a projektben, az eredeti fejezeteinek helyorzoivel; ugyanarra a nyelvre nem kesz masodikat', () => {
    const v = makeDe()
    expect(v.id).not.toBe(src.id)
    expect(v.project_id).toBe(pid)
    expect(v.title).toBe('Válaszbeadvány (DE)')
    expect(documentOutline(v.id).sections.map((s) => s.title)).toEqual(['1. Tényállás', '2. Kérelem'])
    const info = variantInfo(v.id)!
    expect(info.lang).toBe('de')
    expect(info.sections.map((s) => s.state)).toEqual(['untranslated', 'untranslated'])
    const again = createVariant(src, 'DE', 'teszt')
    expect(again.ok && again.existing && again.item.id).toBe(v.id)
    expect(variantsSummary(src.id)).toEqual([{ item_id: v.id, title: v.title, lang: 'de', stale: 0, untranslated: 2 }])
  })

  it('rossz nyelvkod, ures vazlat es valtozatbol valtozat: nem keszul', () => {
    expect(createVariant(src, 'deutsch', null)).toMatchObject({ ok: false, code: 'bad_input' })
    const empty = createWorkItem({ project_id: pid, title: 'Üres', type: 'document' })
    if (!empty.ok) throw new Error('ures')
    expect(createVariant(empty.item, 'de', null)).toMatchObject({ ok: false, code: 'outline_empty' })
    const v = makeDe()
    expect(createVariant(v, 'en', null)).toMatchObject({ ok: false, code: 'variant_of_variant' })
  })

  it('a forditas atviszi az allitast UGYANAZZAL a forrassal (K-1.31), es a fejezet friss lesz', () => {
    const v = makeDe()
    const r = translateFirst(v.id)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result).toMatchObject({ blocks: 1, claims_carried: 1, claims_not_carried: [] })
    const sec = documentOutline(v.id).sections[0]!
    expect(sec.title).toBe('1. Sachverhalt')
    const claim = sec.blocks[0]!.claims[0]!
    expect(claim.text).toBe(CLAIM_DE)
    expect(claim.sources).toHaveLength(1)
    expect(claim.sources[0]).toMatchObject({ kind: 'document', path: 'Level/idezes.pdf', page: 1, quote: 'am 17. März 2027 um 10:30 Uhr', verdict: 'verified' })
    expect(claim.strength).toBe('verified')
    expect(variantInfo(v.id)!.sections[0]!.state).toBe('current')
    // Az eredeti erintetlen.
    expect(documentOutline(src.id).sections[0]!.blocks[0]!.claims[0]!.text).toBe(CLAIM)
  })

  it('a nem szo szerinti vagy ki nem adott allitast megnevezi', () => {
    const v = makeDe()
    const r = translateSection(v.id, {
      source_section: secId, title: '1. Sachverhalt',
      blocks: [{ text: 'Die Verhandlung ist im März.', claims: [{ source_claim: claimId, text: CLAIM_DE }] }],
    }, null)
    expect(r.ok && r.result.claims_carried).toBe(0)
    expect(r.ok && r.result.claims_not_carried).toEqual([{ id: claimId, text: CLAIM, reason: 'the translated claim text is not a verbatim part of the translated block' }])
    const r2 = translateSection(v.id, { source_section: secId, title: '1. Sachverhalt', blocks: [{ text: CLAIM_DE }] }, null)
    expect(r2.ok && r2.result.claims_not_carried[0]).toMatchObject({ id: claimId, reason: 'not given in claims' })
  })

  it('csak az eredeti fejezetebol, csak nyelvi valtozatba fordit', () => {
    const v = makeDe()
    expect(translateSection(v.id, { source_section: 'nincs', title: 'x', blocks: [{ text: 'y' }] }, null)).toMatchObject({ ok: false, code: 'not_found' })
    expect(translateSection(src.id, { source_section: secId, title: 'x', blocks: [{ text: 'y' }] }, null)).toMatchObject({ ok: false, code: 'bad_input' })
    expect(translateSection(v.id, { source_section: secId, title: 'x', blocks: [] }, null)).toMatchObject({ ok: false, code: 'bad_input' })
  })

  it('ha az eredeti fejezete valtozik, a valtozate elavult (K-1.28); ujraforditassal ujra friss', () => {
    const v = makeDe()
    translateFirst(v.id)
    updateBlock(src.id, blockId, { text: `A keresetlevél szerint ${CLAIM} Kérem a tárgyalás elhalasztását.`, author: 'owner' })
    expect(variantInfo(v.id)!.sections[0]!.state).toBe('stale')
    expect(variantsSummary(src.id)[0]).toMatchObject({ stale: 1 })
    const chk = variantCheckItems(v.id)[0]!
    expect(chk).toMatchObject({ key: 'variant_current', ok: false })
    expect(chk.detail).toContain('1. Tényállás')
    translateFirst(v.id, `Laut der Klageschrift: ${CLAIM_DE} Ich beantrage die Vertagung.`)
    expect(variantInfo(v.id)!.sections[0]!.state).toBe('current')
  })

  it('a valtozat nem veglegesitheto, amig van leforditatlan fejezet; az eredetinel nincs ilyen sor', () => {
    const v = makeDe()
    translateFirst(v.id)
    const item = documentCheck(v.id).items.find((i) => i.key === 'variant_current')!
    expect(item).toMatchObject({ ok: false, count: 1, total: 2, detail: ['2. Kérelem'] })
    expect(documentCheck(src.id).items.some((i) => i.key === 'variant_current')).toBe(false)
  })

  it('a csak cimbol allo eredeti fejezet forditasa maga a cim, blokk nelkul (#505)', () => {
    const v = makeDe()
    translateFirst(v.id)
    const empty = documentOutline(src.id).sections[1]!
    expect(empty.blocks).toHaveLength(0)
    const r = translateSection(v.id, { source_section: empty.id, title: '2. Antrag', blocks: [] }, 'workbench-agent')
    expect(r.ok && r.result).toMatchObject({ blocks: 0, claims_carried: 0, claims_not_carried: [] })
    expect(documentOutline(v.id).sections[1]).toMatchObject({ title: '2. Antrag', blocks: [] })
    expect(variantInfo(v.id)!.sections.map((s) => s.state)).toEqual(['current', 'current'])
    expect(documentCheck(v.id).items.find((i) => i.key === 'variant_current')).toMatchObject({ ok: true })
    // Ha az eredeti fejezet szoveget kap, mar csak blokkokkal fordithato ujra.
    addBlock(src.id, empty.id, { text: 'Kérem a keresetet elutasítani.', author: 'owner' })
    expect(variantInfo(v.id)!.sections[1]!.state).toBe('stale')
    expect(translateSection(v.id, { source_section: empty.id, title: '2. Antrag', blocks: [] }, null)).toMatchObject({ ok: false, code: 'bad_input' })
  })

  it('az eredeti uj fejezete megjelenik; a valtozatbol kezzel torolt fejezet parja nem tunik el', () => {
    const v = makeDe()
    translateFirst(v.id)
    const n = addSection(src.id, '3. Bizonyítékok')
    if (!n.ok) throw new Error('uj')
    expect(variantInfo(v.id)!.new_in_source).toEqual([{ id: n.section.id, title: '3. Bizonyítékok' }])
    expect(variantCheckItems(v.id)[0]!.ok).toBe(false)
    // A tulajdonos kitorli a valtozatbol a leforditott fejezetet: az eredeti parja ujra "meg nincs itt".
    const vsec = variantInfo(v.id)!.sections[0]!.section_id
    removeSection(v.id, vsec)
    expect(variantInfo(v.id)!.new_in_source.map((s) => s.id)).toContain(secId)
    // Forditasnal a hianyzo fejezetek helyorzot kapnak, a torolt ujra letrejon.
    translateFirst(v.id)
    const info = variantInfo(v.id)!
    expect(info.new_in_source).toEqual([])
    expect(info.sections.map((s) => s.source_title).sort()).toEqual(['1. Tényállás', '2. Kérelem', '3. Bizonyítékok'])
  })

  it('az eredeti torlese utan: a fejezetek "az eredetibol torolve", a valtozat nem frissitheto', () => {
    const v = makeDe()
    translateFirst(v.id)
    removeSection(src.id, secId)
    const info = variantInfo(v.id)!
    expect(info.sections.find((s) => s.source_section_id === secId)?.state).toBe('source_removed')
    getDb().prepare('UPDATE work_items SET deleted_at = 1 WHERE id = ?').run(src.id)
    expect(variantInfo(v.id)!.source_title).toBe(null)
    expect(variantsSummary(src.id)).toHaveLength(1)
  })

  it('a valtozat vegleges torlesevel az osszekotesei es visszaforditasai is mennek; az eredeti listajabol eltunik', () => {
    const v = makeDe()
    translateFirst(v.id)
    setBackTranslation(v.id, variantInfo(v.id)!.sections[0]!.section_id, 'vissza', null)
    setWorkItemDeleted(v.id, true)
    expect(variantsSummary(src.id)).toEqual([])
    expect(purgeWorkItem(v.id).ok).toBe(true)
    for (const t of ['wb_doc_variants', 'wb_doc_section_links', 'wb_doc_backchecks']) {
      expect(getDb().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE work_item_id = ?`).get(v.id), t).toEqual({ n: 0 })
    }
    // Ujra keszitheto ugyanarra a nyelvre.
    const again = createVariant(src, 'de', null)
    expect(again.ok && !again.existing).toBe(true)
  })

  it('szoszedet (K-1.29): ugyenkent, azonos kifejezes felulirja; a forditas jelzi, ha hianyzik a rogzitett forditas', () => {
    const a = addGlossaryTerm(pid, { term: 'keresetlevél', translation: 'Klageschrift', lang: 'de' }, 'teszt')
    expect(a.ok).toBe(true)
    const again = addGlossaryTerm(pid, { term: 'Keresetlevél', translation: 'Klage', lang: 'DE', note: 'a bíróság így hívja' }, 'teszt')
    expect(again.ok && again.term.id).toBe(a.ok ? a.term.id : '')
    expect(listGlossary(pid, 'de')).toHaveLength(1)
    expect(listGlossary(pid, 'de')[0]).toMatchObject({ translation: 'Klage', note: 'a bíróság így hívja' })
    expect(addGlossaryTerm(pid, { term: 'x', translation: '', lang: 'de' }, null).ok).toBe(false)
    expect(addGlossaryTerm(pid, { term: 'x', translation: 'y', lang: 'deutsch' }, null).ok).toBe(false)
    // Toldalekolt alak is talalat; a hianyzo rogzitett forditas figyelmeztetes.
    expect(glossaryIssues(pid, 'de', 'A keresetlevelet beadtuk.', 'Wir haben die Klage eingereicht.')).toEqual([])
    expect(glossaryIssues(pid, 'de', 'A keresetlevelet beadtuk.', 'Wir haben den Antrag eingereicht.')).toEqual([{ term: 'Keresetlevél', translation: 'Klage' }])
    const v = makeDe()
    const r = translateSection(v.id, { source_section: secId, title: '1. Sachverhalt', blocks: [{ text: `Laut dem Antrag: ${CLAIM_DE}`, claims: [{ source_claim: claimId, text: CLAIM_DE }] }] }, null)
    expect(r.ok && r.result.glossary_issues).toEqual([{ term: 'Keresetlevél', translation: 'Klage' }])
    expect(removeGlossaryTerm(pid, a.ok ? a.term.id : '').ok).toBe(true)
    expect(removeGlossaryTerm(pid, 'nincs').ok).toBe(false)
  })

  it('visszaforditas (K-1.30): az eredeti melle; a forditas modositasa utan elavult, az ujraforditas torli', () => {
    const v = makeDe()
    translateFirst(v.id)
    const vsec = variantInfo(v.id)!.sections[0]!.section_id
    expect(setBackTranslation(src.id, secId, 'x', null).ok).toBe(false)
    const r = setBackTranslation(v.id, vsec, `A keresetlevél szerint ${CLAIM}`, 'workbench-agent')
    expect(r.ok).toBe(true)
    const b = backchecks(v.id)[0]!
    expect(b).toMatchObject({ section_id: vsec, stale: false, source_title: '1. Tényállás' })
    expect(b.source_text).toContain(CLAIM)
    const vb = documentOutline(v.id).sections[0]!.blocks[0]!
    updateBlock(v.id, vb.id, { text: `${vb.text} Danke.`, author: 'owner' })
    expect(backchecks(v.id)[0]!.stale).toBe(true)
    translateFirst(v.id)
    expect(backchecks(v.id)).toEqual([])
  })

  it('a nyelvi valtozat PDF/Word-feliratai a valtozat nyelven', () => {
    const v = makeDe()
    expect(docLangFor(getWorkItem(v.id)!, 'hu')).toBe('de')
    expect(docLangFor(src, 'hu')).toBe('hu')
    const fodt = buildFodt({ sections: [{ title: 'A', blocks: [{ kind: 'paragraph', text: 'x' }] }] } as never, { title: 'T', author: null, draft: true, lang: 'de' })
    expect(fodt).toContain('ENTWURF')
    expect(fodt).toContain('de-DE')
  })

  it('utvonalak: letrehozas, ujra ugyanaz, a vazlat mindket oldalon, szoszedet es visszaforditas torlese', async () => {
    const base = `/api/workbench/items/${src.id}/outline`
    const bad = await callWorkbench(`${base}/variants`, 'POST', { lang: 'xyz' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('variant_bad_input')
    const r = await callWorkbench(`${base}/variants`, 'POST', { lang: 'de' })
    expect(r.status).toBe(201)
    const vid = r.body.item.id as string
    expect(r.body.outline.variants).toEqual([expect.objectContaining({ item_id: vid, lang: 'de', untranslated: 2 })])
    expect((await callWorkbench(`${base}/variants`, 'POST', { lang: 'de' })).status).toBe(200)
    const vo = await callWorkbench(`/api/workbench/items/${vid}/outline`, 'GET')
    expect(vo.body.outline.variant).toMatchObject({ source_item_id: src.id, lang: 'de', source_title: 'Válaszbeadvány' })
    expect(vo.body.outline.check.items.some((i: { key: string }) => i.key === 'variant_current')).toBe(true)
    const vv = await callWorkbench(`/api/workbench/items/${vid}/outline/variants`, 'POST', { lang: 'en' })
    expect(vv.status).toBe(400)
    expect(vv.body.message).toContain('nyelvi változat')
    const g = await callWorkbench(`${base}/glossary`, 'POST', { term: 'keresetlevél', translation: 'Klage', lang: 'de' })
    expect(g.status).toBe(201)
    const term = g.body.outline.glossary[0]
    expect(term).toMatchObject({ term: 'keresetlevél', translation: 'Klage', lang: 'de' })
    // A szoszedet ugyenkenti: a valtozatnal is latszik.
    expect((await callWorkbench(`/api/workbench/items/${vid}/outline`, 'GET')).body.outline.glossary).toHaveLength(1)
    expect((await callWorkbench(`${base}/glossary/${term.id}`, 'DELETE')).status).toBe(200)
    translateFirst(vid)
    const vsec = variantInfo(vid)!.sections[0]!.section_id
    setBackTranslation(vid, vsec, 'vissza', null)
    const d = await callWorkbench(`/api/workbench/items/${vid}/outline/backchecks/${vsec}`, 'DELETE')
    expect(d.status).toBe(200)
    expect(d.body.outline.backchecks).toEqual([])
  })

  it('az agent eszkozei: letrehozza a valtozatot az eredetibol, es a valtozatot forditja az eredeti vazlatabol', () => {
    const ctx = { projectId: pid, workItemId: src.id, lang: 'hu' as const }
    const c = executeTool('doc.createVariant', { lang: 'de' }, ctx)
    expect(c.ok).toBe(true)
    const vid = c.ok ? (c.data as { item_id: string }).item_id : ''
    expect(c.ok && (c.data as { note: string }).note).toContain('doc.translateSection')
    const info = executeTool('doc.variants', { id: vid }, ctx)
    expect(info.ok).toBe(true)
    const d = info.ok ? info.data as { is_language_version: boolean; original_outline: { id: string; blocks: { claims: { id: string }[] }[] }[] } : null
    expect(d?.is_language_version).toBe(true)
    expect(d?.original_outline[0]!.id).toBe(secId)
    expect(d?.original_outline[0]!.blocks[0]!.claims[0]!.id).toBe(claimId)
    const t = executeTool('doc.translateSection', {
      id: vid, source_section: secId, title: '1. Sachverhalt',
      blocks: [{ kind: 'paragraph', text: `Laut der Klageschrift: ${CLAIM_DE}`, claims: [{ source_claim: claimId, text: CLAIM_DE }] }],
    }, ctx)
    expect(t.ok && (t.data as { claims_carried: number }).claims_carried).toBe(1)
    const orig = executeTool('doc.variants', {}, ctx)
    expect(orig.ok && (orig.data as { language_versions: unknown[] }).language_versions).toHaveLength(1)
    expect(executeTool('doc.addTerm', { term: 'keresetlevél', translation: 'Klage', lang: 'de' }, ctx).ok).toBe(true)
    const gl = executeTool('doc.glossary', { lang: 'de' }, ctx)
    expect(gl.ok && (gl.data as { glossary: unknown[] }).glossary).toHaveLength(1)
    const vsec = variantInfo(vid)!.sections[0]!.section_id
    expect(executeTool('doc.backTranslate', { id: vid, section: vsec, text: 'vissza' }, ctx).ok).toBe(true)
  })
})

describe('a felulet: nyelvi valtozatok', () => {
  const SRC = { id: 'w1', title: 'Beadvány', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Beadvany', source_path: null }
  const VAR = { id: 'w2', title: 'Beadvány (DE)', type: 'document', status: 'draft', current_version_id: 'v2', folder: 'Beadvany (DE)', source_path: null }
  const base = (extra: Record<string, unknown>) => ({
    sections: [{ id: 's1', title: '1. Kérelem', status: 'done', problems: 0, blocks: [{ id: 'b1', kind: 'paragraph', text: 'Szöveg.', owner_edited_at: null, missing: [], claims: [], rewrite: null }] }],
    check: { ready: false, items: [] }, content_hash: 'a'.repeat(64), reviewed: false, final: null,
    variant: null, variants: [], glossary: [], backchecks: [], ...extra,
  })

  async function open(outline: Record<string, unknown>, item = SRC) {
    const h = workbenchHarness({ confirm: true })
    h.respond((url) => {
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/outline/variants')) return { status: 201, body: { ok: true, existing: false, item: { id: 'w2', title: 'Beadvány (DE)' }, outline } }
      if (url.includes('/outline/')) return { status: 200, body: { ok: true, outline } }
      if (url.includes('/agent/message')) return { status: 200, body: {}, stream: { chunks: ['event: done\ndata: {}\n\n'] } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item, versions: [], parts: [], assets: [], outline } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([SRC, VAR], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': item.id })
    await vi.waitFor(() => expect(h.html()).toContain('wb-outline-pdf'))
    return h
  }

  it('az eredetinel: a valtozatai es a "+ Nyelvi valtozat"; letrehozas utan a valtozat nyilik, es az agent kap forditasi kerest', async () => {
    const h = await open(base({ variants: [{ item_id: 'w2', title: 'Beadvány (DE)', lang: 'de', stale: 1, untranslated: 0 }] }))
    const html = h.html()
    expect(html).toContain('workbench.doclang.title')
    expect(html).toContain('workbench.doclang.stale_n')
    expect(html).toContain('data-wb-act="outline-lang-open" data-wb-item="w2"')
    expect(html).toContain('id="wbVariantLang"')
    // A mar meglevo nyelv nem kinalhato ujra.
    expect(html).not.toContain('<option value="de">')
    expect(html).toContain('<option value="en">')
    h.inputs['wbVariantLang'] = { value: 'en', focus() {} }
    h.click({ 'data-wb-act': 'outline-lang-create' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/variants') && c.init?.method === 'POST')).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/outline/variants'))
    expect(JSON.parse(String(call?.init?.body))).toEqual({ lang: 'en' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(true))
    const msg = h.fetchCalls.find((c) => c.url.includes('/api/workbench/agent/message'))
    expect(String(msg?.init?.body)).toContain('workbench.doclang.ask_all')
    expect(String(msg?.init?.body)).toContain('"work_item_id":"w2"')
  })

  it('a valtozatnal: elavult fejezet frissites-gombbal az agentnek, visszaforditas az eredeti mellett, szoszedet felvetele', async () => {
    const h = await open(base({
      variant: {
        source_item_id: 'w1', source_title: 'Beadvány', lang: 'de', new_in_source: [],
        sections: [{ section_id: 's1', source_section_id: 'o1', source_title: '1. Kérelem', state: 'stale', translated_at: 1 }],
      },
      backchecks: [{ section_id: 's1', text: 'Visszafordított szöveg.', stale: true, created_at: 1, source_title: '1. Kérelem', source_text: 'Eredeti szöveg.' }],
    }), VAR)
    const html = h.html()
    expect(html).toContain('workbench.doclang.variant_title')
    expect(html).toContain('workbench.doclang.state.stale')
    expect(html).toContain('data-wb-act="outline-lang-translate" data-wb-sec="s1"')
    expect(html).toContain('data-wb-act="outline-lang-translate-all"')
    expect(html).toContain('Visszafordított szöveg.')
    expect(html).toContain('Eredeti szöveg.')
    expect(html).toContain('workbench.doclang.back_stale')
    h.click({ 'data-wb-act': 'outline-lang-translate', 'data-wb-sec': 's1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/api/workbench/agent/message'))).toBe(true))
    const msg = h.fetchCalls.find((c) => c.url.includes('/api/workbench/agent/message'))
    expect(String(msg?.init?.body)).toContain('workbench.doclang.ask_refresh')
    h.click({ 'data-wb-act': 'outline-lang-back-del', 'data-wb-sec': 's1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/backchecks/s1') && c.init?.method === 'DELETE')).toBe(true))
    h.inputs['wbGlossTerm'] = { value: ' keresetlevél ', focus() {} }
    h.inputs['wbGlossTr'] = { value: 'Klage', focus() {} }
    h.inputs['wbGlossLang'] = { value: 'de', focus() {} }
    h.click({ 'data-wb-act': 'outline-lang-term-add' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/glossary') && c.init?.method === 'POST')).toBe(true))
    const g = h.fetchCalls.find((c) => c.url.includes('/outline/glossary'))
    expect(JSON.parse(String(g?.init?.body))).toEqual({ term: 'keresetlevél', translation: 'Klage', lang: 'de' })
  })

  it('ures vazlatnal (es meg valtozat nelkul) nincs nyelvi doboz es szoszedet', async () => {
    const h = await open(base({ sections: [] }))
    const html = h.html()
    expect(html).not.toContain('wb-doclang-gloss')
    expect(html).not.toContain('workbench.doclang.title')
    expect(html).not.toContain('outline-lang-create')
  })
})
