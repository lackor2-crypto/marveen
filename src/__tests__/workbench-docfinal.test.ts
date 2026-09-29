// #441 (v4 spec 1/A, K-1.13, K-1.21 ... K-1.24): piszkozat es vegleges PDF a
// dokumentummodellbol. A piszkozat barmikor keszul (vizjellel); a vegleges
// csak ellenorzes + atnezes + a tulajdonos sajat felelossegvallalasa utan, es
// a forras (fajlnev, idezet, belso azonosito, ikon) SOHA nem kerul a PDF-be.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, setProjectArchived, updateProject } from '../projects.js'
import { createWorkItem, getWorkItem, listWorkItemVersions } from '../workbench.js'
import { addSection, addBlock, addClaim, documentOutline, type SourceWorld } from '../workbench-docmodel.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { buildFodt, renderOutlineDocx, renderOutlinePdf, toRenderOutline, DOCX_FILTER, PDF_FILTER_FINAL } from '../workbench-docrender.js'
import { contentHash, docxFileName, fileStem } from '../workbench-docfinal.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import { executeTool } from '../workbench-agent/execute.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const QUOTE_PAGE = 'Landgericht Berlin. Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr.'

function seedRead(abs: string, name: string, pages: string[]): void {
  ensureDocReadTables()
  const sha = sha256OfFile(abs)
  const db = getDb()
  db.prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
    VALUES (?, ?, 'pdf', 'done', ?, ?, NULL, ?, 0)`).run(sha, name, pages.length, pages.length, DOCREAD_VERSION)
  pages.forEach((t, i) => db.prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, ?, ?, \'text\', NULL, 0)').run(sha, i + 1, t))
}

/** Hamis LibreOffice: a PDF-be beleirja, milyen beallitassal kertek (piszkozat vagy PDF/A). */
const FAKE_SOFFICE = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""; prev=""; filter=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  if [ "$prev" = "--convert-to" ]; then filter="$a"; fi
  prev="$a"
done
case "$filter" in
  docx*) printf 'PK-docx %s' "$filter" > "$out/doc.docx" ;;
  *) printf '%%PDF-1.4 %s' "$filter" > "$out/doc.pdf" ;;
esac
exit 0
`

describe('a dokumentummodellbol keszulo PDF', () => {
  let depot = ''
  let pid = ''
  let itemId = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  const world = (): SourceWorld => ({
    resolveFile: (p) => (p === 'Level/idezes.pdf' ? { abs: join(projDir(), 'Level', 'idezes.pdf'), name: 'idezes.pdf' } : null),
    ownerMessages: () => [{ id: 'msg-owner-1', content: 'A bérleti szerződést 2024. május 2-án írtuk alá.', created_at: 1_790_000_000 }],
  })
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-docfinal-'))
    mkdirSync(join(projDir(), 'Level'), { recursive: true })
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = depot
    process.env['MARVEEN_RENDER_CACHE'] = join(depot, 'render-cache')
    const fake = join(depot, 'fake-soffice.sh')
    writeFileSync(fake, FAKE_SOFFICE, 'utf-8')
    chmodSync(fake, 0o755)
    process.env['MARVEEN_SOFFICE'] = fake
    resetLibreOfficeProbe()
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Válaszbeadvány', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    writeFileSync(join(projDir(), 'Level', 'idezes.pdf'), 'PDF')
    seedRead(join(projDir(), 'Level', 'idezes.pdf'), 'idezes.pdf', ['Seite eins', QUOTE_PAGE])
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmSync(depot, { recursive: true, force: true })
  })

  /** Egy kesz (veglegesitheto) dokumentum: forrasolt allitasokkal. */
  function readyDocument(): void {
    const s = addSection(itemId, '1. Tényállás', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text: 'Tisztelt Bíróság!\nA tárgyalás 2027. március 17-én 10:30-kor lesz.', author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    const c = addClaim(itemId, b.block.id, 'A tárgyalás 2027. március 17-én 10:30-kor lesz.', [
      { kind: 'document', path: 'Level/idezes.pdf', page: 2, quote: 'am 17. März 2027 um 10:30 Uhr' },
    ], world(), 'workbench-agent')
    if (!c.ok || c.claim.strength !== 'verified') throw new Error('allitas')
    const sig = addBlock(itemId, s.section.id, { kind: 'signature', text: 'Budapest, 2026. szeptember 29.\n\nalperes', author: 'agent' })
    if (!sig.ok) throw new Error('alairas')
  }

  it('K-1.13: a PDF forrasa csak a cimekbol es a szovegbol all -- fajlnev, idezet, azonosito, ikon nem kerul bele', () => {
    readyDocument()
    const o = documentOutline(itemId)
    const claim = o.sections[0]!.blocks[0]!.claims[0]!
    for (const draft of [true, false]) {
      const xml = buildFodt(toRenderOutline(o), { title: 'Válaszbeadvány', author: 'Teszt Elek', draft, lang: 'hu' })
      expect(xml).toContain('A tárgyalás 2027. március 17-én 10:30-kor lesz.')
      for (const leak of ['idezes.pdf', 'Level/', 'am 17. März 2027', 'Source', 'source', claim.id, itemId, o.sections[0]!.id, '📄', '🗣', '⚖', '💭', 'msg-owner-1', 'verified']) {
        expect(xml, `${draft ? 'piszkozat' : 'vegleges'}: ${leak}`).not.toContain(leak)
      }
    }
  })

  it('K-1.21: a piszkozaton vizjel van es a hiany kiemelve; a vegleges tiszta', () => {
    const outline = { sections: [{ title: 'Kérelem', status: 'todo' as const, blocks: [{ kind: 'paragraph' as const, text: 'A kézbesítés napja: ⚠ Hiányzó adat: a kézbesítés dátuma' }] }] }
    const draft = buildFodt(outline, { title: 'Beadvány', author: null, draft: true, lang: 'hu' })
    expect(draft).toContain('>PISZKOZAT<')
    expect(draft).toContain('<text:span text:style-name="Missing">⚠ Hiányzó adat: a kézbesítés dátuma</text:span>')
    const final = buildFodt(outline, { title: 'Beadvány', author: null, draft: false, lang: 'hu' })
    expect(final).not.toContain('PISZKOZAT')
    expect(final).not.toContain('draw:name="Watermark"')
    expect(draft).toContain('draw:name="Watermark"')
    const en = buildFodt(outline, { title: 'Filing', author: null, draft: true, lang: 'en' })
    expect(en).toContain('>DRAFT<')
    expect(en).toContain('Page <text:page-number')
  })

  it('K-1.24: sortores nem huzza szet a sort, valodi labjegyzet, ismetlodo tablazatfejlec, szamozott lista, metaadat, escape', () => {
    const outline = {
      sections: [{
        title: '1. <Bevezetés> & más', status: 'done' as const,
        blocks: [
          { kind: 'paragraph' as const, text: 'Tisztelt Bíróság!\nMásodik sor.\n\nÚj bekezdés.' },
          { kind: 'footnote' as const, text: '¹ Lábjegyzet: a Pp. 170. §.' },
          { kind: 'list' as const, text: '1. első\n2. második' },
          { kind: 'table' as const, text: '| Tétel | Összeg |\n|---|---|\n| Díj | 1 200 000 Ft |' },
        ],
      }],
    }
    const xml = buildFodt(outline, { title: 'Beadvány', author: 'Teszt Elek', draft: false, lang: 'hu' })
    expect(xml).not.toContain('<text:line-break/>')
    expect(xml).toContain('<text:p text:style-name="BodyLine">Tisztelt Bíróság!</text:p>')
    expect(xml).toContain('<text:p text:style-name="Body">Második sor.</text:p>')
    expect(xml).toContain('<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p text:style-name="Footnote">Lábjegyzet: a Pp. 170. §.</text:p>')
    expect(xml).toContain('Új bekezdés.<text:note')
    expect(xml).toContain('text:style-name="LNum"')
    expect(xml).toContain('<table:table-header-rows>')
    expect(xml).not.toContain('---')
    expect(xml).toContain('<dc:title>Beadvány</dc:title>')
    expect(xml).toContain('<dc:creator>Teszt Elek</dc:creator>')
    expect(xml).toContain('1. &lt;Bevezetés&gt; &amp; más')
    expect(xml).toContain('text:outline-level="1"')
  })

  it('K-1.22/K-1.23: vegleges PDF csak ellenorzes + atnezes + felelossegvallalas utan; verzio keszul, a PDF a mappaba kerul; modositas utan elavul', async () => {
    readyDocument()
    const base = `/api/workbench/items/${itemId}/outline`
    const o0 = await callWorkbench(base, 'GET')
    expect(o0.body.outline.check.ready).toBe(true)
    expect(o0.body.outline.reviewed).toBe(false)
    expect(o0.body.outline.final).toBe(null)
    const hash = o0.body.outline.content_hash as string
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    // Agent nem veglegesithet.
    const agent = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash }, undefined, { kind: 'token' })
    expect(agent.status).toBe(403)
    expect(agent.body.error).toBe('outline_finalize_owner_only')
    // Atnezes nelkul nem.
    const notReviewed = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    expect(notReviewed.status).toBe(409)
    expect(notReviewed.body.error).toBe('outline_not_reviewed')

    // Az agent (token) megnyithatja a piszkozatot, de az NEM a tulajdonos atnezese.
    const agentDraft = await callWorkbench(`${base}/pdf?review=${hash}`, 'GET', undefined, undefined, { kind: 'token' })
    expect(agentDraft.status).toBe(200)
    expect((await callWorkbench(base, 'GET')).body.outline.reviewed).toBe(false)
    // Mas ujjlenyomattal (regi kepernyo) sem rogzul.
    await callWorkbench(`${base}/pdf?review=${'0'.repeat(64)}`, 'GET')
    expect((await callWorkbench(base, 'GET')).body.outline.reviewed).toBe(false)

    // A tulajdonos megnyitja: piszkozat (nem PDF/A), az atnezes rogzul.
    const draft = await callWorkbench(`${base}/pdf?review=${hash}`, 'GET')
    expect(draft.status).toBe(200)
    expect(draft.headers['Content-Type']).toBe('application/pdf')
    expect(draft.headers['Content-Disposition']).toContain(encodeURIComponent('Válaszbeadvány (piszkozat).pdf'))
    expect(draft.raw.toString('utf-8')).toContain('writer_pdf_Export')
    expect(draft.raw.toString('utf-8')).not.toContain('SelectPdfVersion')
    expect((await callWorkbench(base, 'GET')).body.outline.reviewed).toBe(true)

    // Pipa nelkul nem; regi kepernyorol nem.
    const noAccept = await callWorkbench(`${base}/finalize`, 'POST', { accept: false, hash })
    expect(noAccept.status).toBe(400)
    expect(noAccept.body.error).toBe('outline_accept_required')
    const oldScreen = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash: 'f'.repeat(64) })
    expect(oldScreen.status).toBe(409)
    expect(oldScreen.body.error).toBe('outline_changed')

    const versionsBefore = listWorkItemVersions(itemId).length
    const fin = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    expect(fin.status).toBe(200)
    expect(fin.body.final.label).toMatch(/^Végleges – \d{4}-\d{2}-\d{2}$/)
    expect(fin.body.final.stale).toBe(false)
    expect(fin.body.final.accepted_text).toBe('Átnéztem a dokumentumot, és a tartalmáért felelősséget vállalok.')
    expect(fin.body.final.accepted_by).toBe('teszt')
    expect(fin.body.outline.final.version_no).toBe(fin.body.final.version_no)
    // A PDF a munkadarab mappajaba kerult, PDF/A beallitassal, es az anyagok kozott van.
    const abs = join(depot, fin.body.file)
    expect(existsSync(abs)).toBe(true)
    expect(fin.body.file).toContain('Válaszbeadvány – Végleges – ')
    expect(readFileSync(abs, 'utf-8')).toContain('"SelectPdfVersion":{"type":"long","value":"2"}')
    expect(PDF_FILTER_FINAL).toContain('SelectPdfVersion')
    expect(fin.body.assets.some((a: { path: string }) => a.path === fin.body.file)).toBe(true)
    // Verzio "Vegleges -- datum" nevvel.
    const versions = listWorkItemVersions(itemId)
    expect(versions.length).toBe(versionsBefore + 1)
    expect(versions[0]!.prompt).toBe(fin.body.final.label)

    // Modositas utan a vegleges allapot megszunik, es ujra at kell nezni.
    const blockId = (await callWorkbench(base, 'GET')).body.outline.sections[0].blocks[0].id
    const edited = await callWorkbench(`${base}/blocks/${blockId}`, 'PATCH', { text: 'Tisztelt Bíróság!\nA tárgyalás 2027. március 17-én 10:30-kor lesz. Kiegészítés.' })
    expect(edited.body.outline.final.stale).toBe(true)
    expect(edited.body.outline.reviewed).toBe(false)
    expect(edited.body.outline.content_hash).not.toBe(hash)

    // Technikai nyom (K-1.23/b): ki irta, ki ellenorizte, ki vallalta.
    const trail = await callWorkbench(`${base}/trail`, 'GET')
    expect(trail.status).toBe(200)
    expect(trail.headers['Content-Disposition']).toContain('attachment')
    const t = JSON.parse(trail.raw.toString('utf-8'))
    expect(t.kind).toBe('marveen-document-trail')
    expect(t.note).toContain('does not assess')
    expect(t.finals).toHaveLength(1)
    expect(t.finals[0]).toMatchObject({ accepted_by: 'teszt', still_current: false, reviewed_by: 'teszt' })
    expect(t.sections[0].blocks[0].written_by).toBe('agent')
    expect(t.sections[0].blocks[0].edited_by_owner_at).not.toBe(null)
    expect(t.summary.blocks_written_or_edited_by_owner).toBe(1)
    expect(t.reviews.length).toBeGreaterThanOrEqual(1)
  })

  it('K-1.22: hianyzo adattal nem veglegesitheto, a piszkozat viszont elkeszul', async () => {
    const s = addSection(itemId, '1. Kérelem', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    addBlock(itemId, s.section.id, { text: 'A kézbesítés napja: ⚠ Hiányzó adat: a kézbesítés dátuma', author: 'agent' })
    const base = `/api/workbench/items/${itemId}/outline`
    const hash = (await callWorkbench(base, 'GET')).body.outline.content_hash
    const draft = await callWorkbench(`${base}/pdf?review=${hash}`, 'GET')
    expect(draft.status).toBe(200)
    const fin = await callWorkbench(`${base}/finalize`, 'POST', { accept: true, hash })
    expect(fin.status).toBe(409)
    expect(fin.body.error).toBe('outline_not_ready')
    expect(fin.body.message).toContain('ellenőrzés')
  })

  it('vazlat nelkul nincs PDF; LibreOffice nelkul emberi mondat a teendovel', async () => {
    const base = `/api/workbench/items/${itemId}/outline`
    const empty = await callWorkbench(`${base}/pdf`, 'GET')
    expect(empty.status).toBe(404)
    expect(empty.body.error).toBe('outline_empty')
    readyDocument()
    process.env['MARVEEN_SOFFICE'] = join(depot, 'nincs-ilyen-soffice')
    resetLibreOfficeProbe()
    const r = await callWorkbench(`${base}/pdf`, 'GET')
    expect(r.status).toBe(501)
    expect(['docpdf_not_installed', 'docpdf_check_failed']).toContain(r.body.error)
    expect(r.body.message).toContain('LibreOffice')
  })

  it('K-1.26: a Word-valtozat ugyanabbol a modellbol, vizjel es futo fejlec nelkul, a hiany kiemelve, forras nelkul', () => {
    readyDocument()
    const o = documentOutline(itemId)
    const xml = buildFodt(toRenderOutline(o), { title: 'Válaszbeadvány', author: 'Teszt Elek', draft: false, lang: 'hu', target: 'docx' })
    expect(xml).toContain('A tárgyalás 2027. március 17-én 10:30-kor lesz.')
    expect(xml).toContain('<text:p text:style-name="Title">Válaszbeadvány</text:p>')
    expect(xml).toContain('text:style-name="Heading_20_1" text:outline-level="1">1. Tényállás<')
    expect(xml).not.toContain('draw:name="Watermark"')
    expect(xml).not.toContain('PISZKOZAT')
    expect(xml).not.toContain('<text:p text:style-name="Header">')
    expect(xml).toContain('<text:page-number')
    for (const leak of ['idezes.pdf', 'Level/', 'am 17. März 2027', 'Source', o.sections[0]!.blocks[0]!.claims[0]!.id, itemId, '📄', '🗣']) expect(xml, leak).not.toContain(leak)
    const gap = buildFodt({ sections: [{ title: 'K', status: 'todo', blocks: [{ kind: 'paragraph', text: 'Nap: ⚠ Hiányzó adat: a kézbesítés dátuma' }] }] }, { title: 'B', author: null, draft: false, lang: 'hu', target: 'docx' })
    expect(gap).toContain('<text:span text:style-name="Missing">⚠ Hiányzó adat: a kézbesítés dátuma</text:span>')
    expect(gap).not.toContain('PISZKOZAT')
  })

  it('K-1.26: a DOCX letoltes a Word-szurovel keszul; vazlat nelkul 404, LibreOffice nelkul emberi mondat', async () => {
    const base = `/api/workbench/items/${itemId}/outline`
    expect((await callWorkbench(`${base}/docx`, 'GET')).body.error).toBe('outline_empty')
    readyDocument()
    const r = await callWorkbench(`${base}/docx?lang=hu`, 'GET')
    expect(r.status).toBe(200)
    expect(r.raw.toString('utf-8')).toBe(`PK-docx ${DOCX_FILTER}`)
    expect(r.headers['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(r.headers['Content-Disposition']).toMatch(/^attachment; filename\*=UTF-8''V%C3%A1laszbeadv%C3%A1ny%20\(\d{4}-\d{2}-\d{2}\)\.docx$/)
    // Archivalt projektben is letoltheto (olvasas).
    setProjectArchived(pid, true)
    process.env['MARVEEN_SOFFICE'] = join(depot, 'nincs-ilyen-soffice')
    resetLibreOfficeProbe()
    const miss = await callWorkbench(`${base}/docx`, 'GET')
    expect(miss.status).toBe(501)
    expect(['docx_not_installed', 'docx_check_failed']).toContain(miss.body.error)
    expect(miss.body.message).toContain('LibreOffice')
  })

  it('a Word-fajl neve a cimbol es a datumbol', () => {
    const item = getWorkItem(itemId)
    if (!item) throw new Error('munkadarab')
    expect(docxFileName(item, new Date(2026, 8, 29))).toBe('Válaszbeadvány (2026-09-29).docx')
  })

  it('a fajlnev a cimbol: a perjel es a tiltott jelek nem vesznek el reszt, a .pdf sose esik le', () => {
    expect(fileStem('Kereset 2026/12: "fellebbezés"?')).toBe('Kereset 2026-12- -fellebbezés-')
    expect(fileStem('...')).toBe('dokumentum')
    expect(fileStem('x'.repeat(400)).length).toBe(120)
  })

  it('az agent doc.check-je megmondja a vegleges allapotot, es hogy veglegesiteni nem tud', async () => {
    readyDocument()
    const item = getWorkItem(itemId)
    if (!item) throw new Error('munkadarab')
    const r = executeTool('doc.check', {}, { projectId: pid, workItemId: itemId, lang: 'hu' })
    expect(r.ok).toBe(true)
    const d = r.ok ? r.data as { ready: boolean; reviewed_by_owner: boolean; final: unknown; pdf: string } : null
    expect(d?.ready).toBe(true)
    expect(d?.reviewed_by_owner).toBe(false)
    expect(d?.final).toBe(null)
    expect(d?.pdf).toContain('can not finalize')
    expect(contentHash(item)).toMatch(/^[0-9a-f]{64}$/)
  })
})

// A VALODI LibreOffice-szal (a CI telepiti): a kesz PDF-ben keresve nincs
// fajlnev, "Source", belso azonosito vagy ikon (K-1.13 elfogadas); a vegleges
// PDF/A, a piszkozaton ott a vizjel.
const HAS_SOFFICE = spawnSync('soffice', ['--version'], { encoding: 'utf-8' }).status === 0
  && spawnSync('pdftotext', ['-v'], { encoding: 'utf-8' }).status === 0

describe.skipIf(!HAS_SOFFICE)('valodi LibreOffice-szal', () => {
  const saved: Record<string, string | undefined> = {}
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'marveen-docrender-'))
    for (const k of ['MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
    delete process.env['MARVEEN_SOFFICE']
    process.env['MARVEEN_RENDER_CACHE'] = join(dir, 'cache')
    resetLibreOfficeProbe()
  })
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetLibreOfficeProbe()
    rmSync(dir, { recursive: true, force: true })
  })

  it('K-1.13 + K-1.21 + K-1.24 a kesz PDF-en merve', async () => {
    const outline = {
      sections: [
        { title: '1. Tényállás', status: 'done' as const, blocks: [
          { kind: 'paragraph' as const, text: 'Tisztelt Bíróság!\nA tárgyalás 2027. március 17-én 10:30-kor lesz.' },
          { kind: 'footnote' as const, text: 'Lásd a K1. mellékletet.' },
        ] },
        { title: '2. Kérelem', status: 'done' as const, blocks: [{ kind: 'signature' as const, text: 'Budapest, 2026. szeptember 29.\n\nalperes' }] },
      ],
    }
    const text = (buf: Buffer, name: string): string => {
      const p = join(dir, name)
      writeFileSync(p, buf)
      return spawnSync('pdftotext', ['-layout', p, '-'], { encoding: 'utf-8' }).stdout
    }
    const final = await renderOutlinePdf(outline, { title: 'Válaszbeadvány', author: 'Teszt Elek', draft: false, lang: 'hu' })
    expect(final.ok).toBe(true)
    if (!final.ok) return
    const ft = text(final.pdf, 'final.pdf')
    expect(ft).toContain('A tárgyalás 2027. március 17-én 10:30-kor lesz.')
    expect(ft).toContain('Lásd a K1. mellékletet.')
    expect(ft).toMatch(/1 \/ 1 oldal/)
    for (const leak of ['PISZKOZAT', 'Source', '.pdf', '📄', '🗣', '⚖', '💭']) expect(ft, leak).not.toContain(leak)
    const raw = final.pdf.toString('latin1')
    expect(raw).toContain('pdfaid:part>2<')
    expect(raw).toContain('/Outlines')
    const info = spawnSync('pdfinfo', [join(dir, 'final.pdf')], { encoding: 'utf-8' }).stdout
    expect(info).toMatch(/Title:\s+Válaszbeadvány/)
    expect(info).toMatch(/Author:\s+Teszt Elek/)
    expect(info).toMatch(/Tagged:\s+yes/)
    const fonts = spawnSync('pdffonts', [join(dir, 'final.pdf')], { encoding: 'utf-8' }).stdout.split('\n').slice(2).filter(Boolean)
    expect(fonts.length).toBeGreaterThan(0)
    for (const f of fonts) expect(f, f).toMatch(/\syes\s+yes\s+yes\s/)

    const draft = await renderOutlinePdf(outline, { title: 'Válaszbeadvány', author: null, draft: true, lang: 'hu' })
    expect(draft.ok).toBe(true)
    if (!draft.ok) return
    expect(text(draft.pdf, 'draft.pdf')).toContain('PISZKOZAT')
  }, 180_000)

  it('K-1.26 a kesz DOCX-en merve: Word-cimstilus, valodi labjegyzet es szamozas, vizjel es forras nelkul', async () => {
    const outline = {
      sections: [
        { title: '1. Tényállás', status: 'done' as const, blocks: [
          { kind: 'paragraph' as const, text: 'A tárgyalás 2027. március 17-én lesz. ⚠ Hiányzó adat: ügyszám' },
          { kind: 'footnote' as const, text: 'Lásd a K1. mellékletet.' },
          { kind: 'list' as const, text: '1. első\n2. második' },
        ] },
      ],
    }
    const r = await renderOutlineDocx(outline, { title: 'Válaszbeadvány', author: 'Teszt Elek', lang: 'hu' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    if (spawnSync('unzip', ['-v'], { encoding: 'utf-8' }).status !== 0) return
    const p = join(dir, 'out.docx')
    writeFileSync(p, r.docx)
    const part = (name: string): string => spawnSync('unzip', ['-p', p, name], { encoding: 'utf-8' }).stdout
    const doc = part('word/document.xml')
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>')
    expect(doc).toContain('<w:pStyle w:val="Title"/>')
    expect(doc).toContain('w:footnoteReference')
    expect(doc).toContain('<w:numId w:val="')
    expect(part('word/footnotes.xml')).toContain('Lásd a K1. mellékletet.')
    expect(doc).toContain('⚠ Hiányzó adat: ügyszám')
    const all = doc + part('word/header1.xml')
    for (const leak of ['PISZKOZAT', 'Source', '.pdf']) expect(all, leak).not.toContain(leak)
    expect(part('docProps/core.xml')).toContain('Teszt Elek')
  }, 180_000)
})

describe('a felulet: piszkozat, atnezes, veglegesites', () => {
  const ITEM = { id: 'w1', title: 'Beadvány', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Beadvany', source_path: null }
  const HASH = 'a'.repeat(64)
  const outline = (extra: Record<string, unknown>) => ({
    sections: [{ id: 's1', title: '1. Kérelem', status: 'done', problems: 0, blocks: [{ id: 'b1', kind: 'paragraph', text: 'Szöveg.', owner_edited_at: null, missing: [], claims: [] }] }],
    check: { ready: true, items: [{ key: 'sections_done', ok: true, count: 1, total: 1 }] },
    content_hash: HASH, reviewed: false, final: null,
    ...extra,
  })

  async function open(o: Record<string, unknown>) {
    const h = workbenchHarness({ confirm: true })
    let current = o
    h.respond((url, init) => {
      if (url.includes('/outline/finalize') && init && init.method === 'POST') {
        current = outline({ reviewed: true, final: { label: 'Végleges – 2026-09-29', version_no: 3, pdf_path: 'Projektek/Iroda/Beadvany/Beadvány – Végleges – 2026-09-29.pdf', stale: false } })
        return { status: 200, body: { ok: true, final: current['final'], outline: current, assets: [] } }
      }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/w1/outline')) return { status: 200, body: { outline: current } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [], outline: current } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-outline-pdf'))
    return h
  }

  it('piszkozat gomb es technikai nyom mindig; atnezes elott a pipa es a keszites tiltva', async () => {
    const h = await open(outline({}))
    const html = h.html()
    expect(html).toContain('href="/api/workbench/items/w1/outline/pdf?lang=hu"')
    expect(html).toContain('workbench.outline.draft_pdf')
    expect(html).toContain('href="/api/workbench/items/w1/outline/trail?lang=hu"')
    expect(html).toContain('href="/api/workbench/items/w1/outline/docx?lang=hu" download')
    expect(html).toContain('workbench.outline.docx')
    expect(html).toContain(`data-wb-act="outline-review" href="/api/workbench/items/w1/outline/pdf?lang=hu&review=${HASH}"`)
    expect(html).toContain('<input type="checkbox" data-wb-act="outline-accept" disabled>')
    expect(html).toContain('data-wb-act="outline-finalize" disabled')
  })

  it('nem kesz dokumentumnal az atnezes gomb sem aktiv', async () => {
    const h = await open(outline({ check: { ready: false, items: [{ key: 'missing_data', ok: false, count: 1 }] } }))
    const html = h.html()
    expect(html).not.toContain('data-wb-act="outline-review"')
    expect(html).toContain('workbench.outline.finalize_blocked')
  })

  it('atnezes utan pipa -> a gomb elesedik, es a veglegesites a latott ujjlenyomattal megy', async () => {
    const h = await open(outline({ reviewed: true }))
    expect(h.html()).toContain('workbench.outline.reviewed')
    expect(h.html()).toContain('data-wb-act="outline-finalize" disabled')
    // A pipa (a valodi checkbox "checked" allapotaval).
    h.fire('click', {
      target: { closest: (sel: string) => (sel === '[data-wb-act]' ? { getAttribute: (a: string) => (a === 'data-wb-act' ? 'outline-accept' : null), checked: true } : null) },
      preventDefault() {}, stopPropagation() {},
    })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-act="outline-accept" checked'))
    expect(h.html()).not.toContain('data-wb-act="outline-finalize" disabled')
    h.click({ 'data-wb-act': 'outline-finalize' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/outline/finalize'))).toBe(true))
    const call = h.fetchCalls.find((c) => c.url.includes('/outline/finalize'))
    expect(JSON.parse(String(call?.init?.body))).toEqual({ accept: true, hash: HASH })
    await vi.waitFor(() => expect(h.html()).toContain('workbench.outline.final_current'))
    expect(h.toasts.some((m) => m.includes('workbench.outline.finalized'))).toBe(true)
  })

  it('elavult vegleges: figyelmeztetes es a regi PDF megnyithato', async () => {
    const h = await open(outline({ final: { label: 'Végleges – 2026-09-28', version_no: 2, pdf_path: 'P/B/x.pdf', stale: true } }))
    const html = h.html()
    expect(html).toContain('workbench.outline.final_stale')
    expect(html).toContain('href="/api/life/file?rel=P%2FB%2Fx.pdf"')
  })
})
