// #441 (v4 spec 7.4, K-1.36, K-1.37): celbirosag-profilok. A profil ADAT
// (szabalyverzio, ervenyesseg, hivatalos forras, utolso ellenorzes), a fajlbol
// frissitheto; veglegesiteskor a fajlnevek a profil szerint keszulnek, es a
// kesz fajlokat a Marveen gepi uton ellenorzi -- megmondja, melyik
// szabalyverzio szerint, es nem allitja, hogy a beadvany megfelel.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { addSection, addBlock, addClaim } from '../workbench-docmodel.js'
import { ensureDocReadTables, sha256OfFile, DOCREAD_VERSION } from '../workbench-docread.js'
import { addAnnex, listAnnexes, setAnnexPath, setDocSettings } from '../workbench-docannex.js'
import { resolveProjectFile } from '../workbench-docmodel-world.js'
import { getProject } from '../projects.js'
import { resetLibreOfficeProbe } from '../office-convert.js'
import {
  SEED_PROFILES, acceptProposal, checkFiles, currentVersion, daysSince, getProfile, listProfileSummaries, listProposals, loadProfiles,
  markProfileChecked, pdfNames, profileFileName, proposeRule, rejectProposal, setItemProfile, setMaxAgeDays, itemProfileId, type CourtProfile,
} from '../workbench-courtprofile.js'
import { which } from '../life-inbox-systools.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const havePoppler = !!(which('pdfinfo') && which('pdffonts') && which('pdftotext') && which('pdfdetach'))
const MIXED = join(__dirname, 'fixtures', 'docread-mixed.pdf')

/** Egy kis, szabalyos PDF (helyes xref): egy oldal szoveggel, nem beagyazott Helvetica; kerre JavaScript es urlapmezo. */
function makePdf(opts: { text?: string; js?: boolean; form?: boolean } = {}): Buffer {
  const text = opts.text ?? 'Klageschrift'
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`
  const objs: string[] = []
  const catalogExtra = (opts.js ? ' /OpenAction 6 0 R' : '') + (opts.form ? ' /AcroForm << /Fields [7 0 R] >>' : '')
  objs.push(`<< /Type /Catalog /Pages 2 0 R${catalogExtra} >>`)
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R${opts.form ? ' /Annots [7 0 R]' : ''} >>`)
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  // A 6. es 7. objektum csak kerre letezik (kulonben ures szotar), hogy a szamozas ne valtozzon.
  objs.push(opts.js ? '<< /S /JavaScript /JS (app.alert\\(1\\)) >>' : '<< >>')
  objs.push(opts.form ? '<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /Rect [72 600 300 620] /P 3 0 R >>' : '<< >>')
  let out = '%PDF-1.4\n'
  const offs: number[] = []
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
  const x = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

const saved: Record<string, string | undefined> = {}
let dir = ''

beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'marveen-court-'))
  saved['MARVEEN_COURT_PROFILES_FILE'] = process.env['MARVEEN_COURT_PROFILES_FILE']
  process.env['MARVEEN_COURT_PROFILES_FILE'] = join(dir, 'profiles.json')
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('K-1.36: a profil adat, datummal es hivatalos forrassal', () => {
  it('a kiindulo profilok: DE / USA / HU / altalanos, mindegyiknek van szabalyverzioja; a birosagiaknak hivatalos webcime', () => {
    expect(SEED_PROFILES.map((p) => p.id)).toEqual(['de-ervv', 'us-cmecf', 'hu-eper', 'general'])
    for (const p of SEED_PROFILES) {
      expect(p.last_checked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      const v = currentVersion(p)
      expect(v.valid_from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      if (p.id !== 'general') {
        expect(v.sources.length).toBeGreaterThan(0)
        for (const s of v.sources) expect(s.url).toMatch(/^https:\/\/[a-z0-9.-]+\.(de|gov|hu)\//)
      }
    }
    // ERVB 2025: 90 karakteres fajlnev, 1000 fajl, 200 MB egyutt.
    const de = currentVersion(getProfile('de-ervv')!).requirements
    expect(de.filename?.max_length).toBe(90)
    expect(de.max_files).toBe(1000)
    expect(de.max_total_mb).toBe(200)
  })

  it('a fajl verziokat AD a profilokhoz a program frissitese nelkul (azonos neven a fajlbeli nyer); a hibas bejegyzest kihagyja, es megmondja, miert', () => {
    const newer: CourtProfile = {
      id: 'de-ervv', name: { hu: 'Németország', en: 'Germany' }, last_checked: '2027-03-01',
      versions: [{ version: 'ERVB 2099', valid_from: '2099-01-01', sources: [], requirements: { searchable: 'error' } }],
    }
    writeFileSync(process.env['MARVEEN_COURT_PROFILES_FILE']!, JSON.stringify({
      max_age_days: 30,
      profiles: [
        newer,
        { id: 'at-erv', name: { hu: 'Ausztria', en: 'Austria' }, last_checked: '2027-01-01', versions: [{ version: 'ERV 2027', valid_from: '2027-01-01', sources: [], requirements: {} }] },
        { id: 'Rossz Id!', versions: [] },
        { id: 'us-local', name: { hu: 'Helyi', en: 'Local' }, last_checked: '2027-01-01', versions: [{ version: 'v1', valid_from: '2027-01-01', sources: [], requirements: { filename: { pattern: '(a+)+$', rule: { hu: 'x', en: 'x' } } } }] },
        { id: 'us-typo', name: { hu: 'Elírás', en: 'Typo' }, last_checked: '2027-01-01', versions: [{ version: 'v1', valid_from: '2027-01-01', sources: [], requirements: { searchabel: 'error' } }] },
      ],
    }))
    const { profiles, max_age_days, skipped, file_error } = loadProfiles()
    expect(file_error).toBe(null)
    expect(max_age_days).toBe(30)
    expect(profiles.map((p) => p.id)).toEqual(['de-ervv', 'us-cmecf', 'hu-eper', 'general', 'at-erv'])
    // A beepitett ERVB 2025 megmaradt a fajlbeli uj verzio mellett (nem cserelte le a profilt).
    const de = getProfile('de-ervv')!
    expect(de.versions.map((v) => v.version)).toEqual(['ERVB 2025', 'ERVB 2099'])
    expect(de.last_checked).toBe('2027-03-01')
    expect(currentVersion(de, '2027-06-01').requirements.filename?.max_length).toBe(90)
    expect(currentVersion(de, '2099-06-01').version).toBe('ERVB 2099')
    // Hibas id, lassu regex, elirt kulcs: kimarad, a felulet kiirja.
    expect(skipped.map((x) => x.id)).toEqual(['Rossz Id!', 'us-local', 'us-typo'])
    expect(skipped[1]!.problem).toMatch(/filename\.pattern/)
    expect(skipped[2]!.problem).toMatch(/unknown requirement: searchabel/)
  })

  it('a hibas profilfajl NEM nema es NEM irodik felul: a beepitett profilok mennek, a jelzes es a beallitas megtagadja az irast', () => {
    const f = process.env['MARVEEN_COURT_PROFILES_FILE']!
    writeFileSync(f, '{ "profiles": [ { "id": "de-ervv", ')
    const l = loadProfiles()
    expect(l.file_error).toBeTruthy()
    expect(l.profiles.map((p) => p.id)).toEqual(['de-ervv', 'us-cmecf', 'hu-eper', 'general'])
    expect(markProfileChecked('hu-eper')).toMatchObject({ ok: false, code: 'file_broken' })
    expect(setMaxAgeDays(365)).toMatchObject({ ok: false, code: 'file_broken' })
    expect(readFileSync(f, 'utf8')).toBe('{ "profiles": [ { "id": "de-ervv", ')
    // A hianyzo fajl viszont a friss telepites rendes allapota: nincs hiba.
    rmSync(f)
    expect(loadProfiles().file_error).toBe(null)
  })

  it('a figyelmeztetes ideje a feluletrol allithato (30 ... 3650 nap), a fajlba kerul', () => {
    expect(loadProfiles().max_age_days).toBe(183)
    expect(setMaxAgeDays(10)).toMatchObject({ ok: false, code: 'bad_input' })
    expect(setMaxAgeDays('abc')).toMatchObject({ ok: false, code: 'bad_input' })
    expect(setMaxAgeDays(365)).toEqual({ ok: true, max_age_days: 365 })
    expect(loadProfiles().max_age_days).toBe(365)
    expect(JSON.parse(readFileSync(process.env['MARVEEN_COURT_PROFILES_FILE']!, 'utf8')).max_age_days).toBe(365)
  })

  it('a regen ellenorzott profil "elavult"; a tulajdonos jelzese utan a datum frissul (a fajlba kerul)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // Fel ev mulva a beepitett profilok datuma (2026-09-30) mar regi.
      vi.setSystemTime(new Date('2027-06-01T12:00:00'))
      const old = listProfileSummaries().find((p) => p.id === 'hu-eper')!
      expect(daysSince(old.last_checked)).toBeGreaterThan(183)
      expect(old.stale).toBe(true)
      expect(old.age_days).toBe(daysSince(old.last_checked))
      const r = markProfileChecked('hu-eper')
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.profile).toMatchObject({ stale: false, last_checked: '2027-06-01' })
      const file = JSON.parse(readFileSync(process.env['MARVEEN_COURT_PROFILES_FILE']!, 'utf8'))
      expect(file.checked['hu-eper']).toBe('2027-06-01')
      expect(markProfileChecked('nincs-ilyen')).toMatchObject({ ok: false, code: 'not_found' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fajlnev a profil szerint: ERVB -- ekezet atirva, szokoz alahuzas, sorszam, 90 karakter; a tobbi profilnal valtozatlan', () => {
    const de = getProfile('de-ervv')
    expect(profileFileName('Válaszbeadvány – Végleges – 2026-09-30.pdf', de, 0, 3)).toBe('01_Valaszbeadvany_Vegleges_2026-09-30.pdf')
    expect(profileFileName('K1 – Mietvertrag Größe.pdf', de, 1, 3)).toBe('02_K1_Mietvertrag_Größe.pdf')
    expect(profileFileName('Klage.pdf', de, 0, 1)).toBe('Klage.pdf')
    const long = profileFileName('x'.repeat(200) + '.pdf', de, 0, 1)
    expect(long.length).toBe(90)
    expect(long.endsWith('.pdf')).toBe(true)
    expect(new RegExp(currentVersion(de!).requirements.filename!.pattern!, 'u').test(long)).toBe(true)
    expect(profileFileName('Válasz – Végleges.pdf', getProfile('hu-eper'), 0, 2)).toBe('Válasz – Végleges.pdf')
    expect(profileFileName('Válasz.pdf', null, 0, 2)).toBe('Válasz.pdf')
    // Mas nyelv ekezetes betuje az alapbetuje lesz, nem alahuzas.
    expect(profileFileName('Čestné prohlášení.pdf', de, 0, 1)).toBe('Cestne_prohlaseni.pdf')
    // Ha a minta a nemet betuket sem engedi, csak angol betu marad.
    const ascii: CourtProfile = { id: 'x-ascii', name: { hu: 'x', en: 'x' }, last_checked: '2026-09-30', versions: [{ version: 'v', valid_from: '2026-01-01', sources: [], requirements: { filename: { pattern: '^[A-Za-z0-9_-]+\\.pdf$', rule: { hu: 'x', en: 'x' } } } }] }
    expect(profileFileName('Größe Übersicht – Kőszeg.pdf', ascii, 0, 1)).toBe('Groesse_Uebersicht_Koeszeg.pdf')
  })

  it('a munkadarab profilja: valaszthato, torolheto, ismeretlen profilt nem fogad el', () => {
    expect(setItemProfile('item-1', 'us-cmecf')).toEqual({ ok: true, profile_id: 'us-cmecf' })
    expect(itemProfileId('item-1')).toBe('us-cmecf')
    expect(setItemProfile('item-1', 'mars').ok).toBe(false)
    expect(setItemProfile('item-1', null)).toEqual({ ok: true, profile_id: null })
    expect(itemProfileId('item-1')).toBe(null)
  })
})

describe('K-1.37: a kesz fajlok gepi ellenorzese', () => {
  it('a tiltott elemeket a tomoritett objektumfolyamban is megtalalja', () => {
    expect([...pdfNames(makePdf({ js: true, form: true }))].sort()).toEqual(['AcroForm', 'JS', 'JavaScript'])
    const hidden = deflateSync(Buffer.from('<< /S /Launch /F (cmd.exe) >> << /Type /EmbeddedFile >>', 'latin1'))
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.5\n9 0 obj\n<< /Type /ObjStm /N 2 /First 10 /Filter /FlateDecode /Length ${hidden.length} >>\nstream\n`, 'latin1'), hidden, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    expect([...pdfNames(pdf)].sort()).toEqual(['EmbeddedFile', 'Launch'])
    expect(pdfNames(makePdf()).size).toBe(0)
  })

  it.skipIf(!havePoppler)('USA CM/ECF: a JavaScript hiba (a CM/ECF visszautasitja); az urlapmezo es a szkennelt oldal csak jelzes (helyi szabaly); a melleklethez kereshető-javaslat', async () => {
    const r = await checkFiles(getProfile('us-cmecf')!, [
      { name: 'Motion.pdf', pdf: makePdf({ js: true, form: true }), role: 'main' },
      { name: 'Exhibit A.pdf', pdf: readFileSync(MIXED), role: 'annex', label: 'Exhibit A', annex_id: 'ax1' },
    ])
    expect(r.version).toBe('CM/ECF 1.6 PDF validation')
    expect(r.profile_id).toBe('us-cmecf')
    expect(r.valid_from_unknown).toBe(false)
    const keys = r.issues.map((i) => `${i.level}:${i.key}:${i.label || i.file}`)
    expect(keys).toContain('error:javascript:Motion.pdf')
    expect(keys).toContain('warn:form_fields:Motion.pdf')
    expect(keys).toContain('warn:fonts_not_embedded:Motion.pdf')
    const scan = r.issues.find((i) => i.key === 'not_searchable')!
    expect(scan).toMatchObject({ level: 'warn', label: 'Exhibit A', annex_id: 'ax1', fix: 'searchable', detail: { pages: [2] } })
    expect(r.errors).toBe(1)
    expect(r.files.map((f) => f.pages)).toEqual([1, 2])
    expect(r.sources.length).toBeGreaterThan(0)
  })

  it.skipIf(!havePoppler)('Nemetorszag: ugyanez csak figyelmeztetes (ERVB: "soll", urlapmezo megengedett); a rossz fajlnev hiba; az altalanos profil mindent csak jelez', async () => {
    const de = await checkFiles(getProfile('de-ervv')!, [{ name: 'Klage Entwurf.pdf', pdf: makePdf({ js: true, form: true }), role: 'main' }])
    expect(de.issues.map((i) => `${i.level}:${i.key}`).sort()).toEqual(['error:filename', 'warn:fonts_not_embedded', 'warn:javascript'])
    const gen = await checkFiles(getProfile('general')!, [{ name: 'a.pdf', pdf: makePdf({ js: true }), role: 'main' }])
    expect(gen.errors).toBe(0)
    expect(gen.warnings).toBe(2)
  })

  it.skipIf(!havePoppler)('meretkorlat (HU e-per 150 MB / fajl) es a nem PDF fajl: nem csendes kudarc', async () => {
    const hu: CourtProfile = structuredClone(getProfile('hu-eper')!)
    hu.versions[0]!.requirements.max_file_mb = 0.0001
    const r = await checkFiles(hu, [{ name: 'a.pdf', pdf: makePdf(), role: 'main' }, { name: 'b.pdf', pdf: Buffer.from('nem pdf'), role: 'annex', label: 'K1' }])
    expect(r.issues.find((i) => i.key === 'file_too_large')).toMatchObject({ level: 'error', file: 'a.pdf', detail: { max: 0.0001 } })
    expect(r.issues.find((i) => i.key === 'unreadable')).toMatchObject({ level: 'error', label: 'K1' })
  })
})

// ---------------------------------------------------------------------------
// Veglegesites a profillal (utvonalon at), a melleklet csereje, az Agent
// ---------------------------------------------------------------------------

/** Hamis LibreOffice: a vegleges PDF helyett egy igazi kis PDF-et ir. */
const fakeSoffice = (pdfPath: string): string => `#!/bin/sh
if [ "$1" = "--version" ]; then echo "LibreOffice 7.4.7.2 tesztpeldany"; exit 0; fi
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"
done
cp "${pdfPath}" "$out/doc.pdf"
exit 0
`

describe('veglegesites celbirosag-profillal', () => {
  let pid = ''
  let itemId = ''
  const projDir = () => join(dir, 'Projektek', 'Iroda')

  beforeEach(() => {
    for (const k of ['MARVEEN_DEPOT', 'MARVEEN_SOFFICE', 'MARVEEN_RENDER_CACHE']) saved[k] = process.env[k]
    process.env['MARVEEN_DEPOT'] = dir
    process.env['MARVEEN_RENDER_CACHE'] = join(dir, 'render-cache')
    mkdirSync(join(projDir(), 'Level'), { recursive: true })
    writeFileSync(join(dir, 'main.pdf'), makePdf())
    const fake = join(dir, 'fake-soffice.sh')
    writeFileSync(fake, fakeSoffice(join(dir, 'main.pdf')), 'utf-8')
    chmodSync(fake, 0o755)
    process.env['MARVEEN_SOFFICE'] = fake
    resetLibreOfficeProbe()
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
    const w = createWorkItem({ project_id: pid, title: 'Klage gegen Muster', type: 'document' })
    if (!w.ok) throw new Error('munkadarab')
    itemId = w.item.id
    // Forras-irat a forrasolt allitashoz, es a szkennelt melleklet.
    const src = join(projDir(), 'Level', 'brief.pdf')
    writeFileSync(src, 'PDF')
    ensureDocReadTables()
    getDb().prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, 'brief.pdf', 'pdf', 'done', 1, 1, NULL, ?, 0)`).run(sha256OfFile(src), DOCREAD_VERSION)
    getDb().prepare("INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, 1, 'Die Miete beträgt 900 Euro.', 'text', NULL, 0)").run(sha256OfFile(src))
    writeFileSync(join(projDir(), 'Level', 'Mietvertrag.pdf'), readFileSync(MIXED))
  })
  afterEach(() => { resetLibreOfficeProbe() })

  function readyDocument(): void {
    const s = addSection(itemId, '1. Sachverhalt', { status: 'done' })
    if (!s.ok) throw new Error('fejezet')
    const b = addBlock(itemId, s.section.id, { text: 'Die Miete beträgt 900 Euro. Beweis: Anlage K1.', author: 'agent' })
    if (!b.ok) throw new Error('blokk')
    const world = { resolveFile: (p: string) => resolveProjectFile(getProject(pid)!, p), ownerMessages: () => [] }
    const c = addClaim(itemId, b.block.id, 'Die Miete beträgt 900 Euro.', [{ kind: 'document', path: 'Level/brief.pdf', page: 1, quote: 'Die Miete beträgt 900 Euro.' }], world, 'workbench-agent')
    if (!c.ok || c.claim.strength !== 'verified') throw new Error('allitas ' + JSON.stringify(c))
    const sig = addBlock(itemId, s.section.id, { kind: 'signature', text: 'Berlin, 30.09.2026\n\nRechtsanwalt', author: 'agent' })
    if (!sig.ok) throw new Error('alairas')
    const ax = addAnnex(itemId, { path: 'Level/Mietvertrag.pdf', title: 'Mietvertrag' }, (p) => resolveProjectFile(getProject(pid)!, p), 'owner')
    if (!ax.ok) throw new Error('melleklet')
    if (!setDocSettings(itemId, { annex_scheme: 'anlage' }).ok) throw new Error('beallitas')
  }

  it.skipIf(!havePoppler)('a fajlnevek az ERVB szerint keszulnek, a kesz fajlokat ellenorzi (melyik verzio szerint), a szkennelt mellekletre kereshető-javaslat jon', async () => {
    readyDocument()
    const base = `/api/workbench/items/${itemId}`
    const put = await callWorkbench(`${base}/court`, 'PUT', { profile_id: 'de-ervv' })
    expect(put.status).toBe(200)
    expect(put.body.court.profile.version).toBe('ERVB 2025')
    expect(put.body.court.check_current).toBe(false)
    const o = await callWorkbench(`${base}/outline`, 'GET')
    const hash = o.body.outline.content_hash
    await callWorkbench(`${base}/outline/pdf?review=${hash}`, 'GET')
    const fin = await callWorkbench(`${base}/outline/finalize`, 'POST', { accept: true, hash })
    expect(fin.status, JSON.stringify(fin.body)).toBe(200)
    const names = fin.body.final.files.map((f: { name: string }) => f.name)
    expect(names[0]).toMatch(/^01_Klage_gegen_Muster_Endgueltig|^01_Klage_gegen_Muster_Vegleges/)
    for (const n of names) expect(n).toMatch(/^[A-Za-zÄÖÜäöüß0-9_-]+\.pdf$/)
    expect(names[1]).toMatch(/^02_Anlage_K1_Mietvertrag\.pdf$/)
    const court = fin.body.court
    expect(court.check_current).toBe(true)
    expect(court.check.result.version).toBe('ERVB 2025')
    const scan = court.check.result.issues.find((i: { key: string }) => i.key === 'not_searchable')
    // A melleklet-PDF 1. oldala a boritolap, igy a szkennelt 2. oldal a fajlban a 3.
    expect(scan).toMatchObject({ level: 'warn', label: 'Anlage K1', fix: 'searchable', detail: { pages: [3] } })
    // Ujraellenorzes mas profillal: a CM/ECF szabalyverzioja szerint, fajlnev-szabaly nelkul.
    await callWorkbench(`${base}/court`, 'PUT', { profile_id: 'us-cmecf' })
    const g = await callWorkbench(base, 'GET')
    expect(g.body.court.check_current).toBe(false)
    const re = await callWorkbench(`${base}/court/check`, 'POST', {})
    expect(re.status).toBe(200)
    expect(re.body.court).toMatchObject({ check_current: true, rules_current: true })
    expect(re.body.court.check.result.version).toBe('CM/ECF 1.6 PDF validation')
    expect(re.body.court.check.result.issues.find((i: { key: string }) => i.key === 'not_searchable').level).toBe('warn')
    expect(re.body.court.check.result.issues.some((i: { key: string }) => i.key === 'filename')).toBe(false)
    // Uj szabalyverzio elfogadasa utan az ellenorzes mar nem a mai szabaly szerinti: ujra kell futtatni.
    const pr = proposeRule({
      profile_id: 'us-cmecf', reason: 'teszt', checked_sources: ['https://pacer.uscourts.gov/'],
      version: { version: 'CM/ECF 1.7', valid_from: '2025-01-01', sources: [{ title: 'PACER', url: 'https://pacer.uscourts.gov/' }], requirements: { searchable: 'error' } },
    })
    if (!pr.ok) throw new Error(pr.detail)
    const acc = await callWorkbench(`${base}/court/proposals/${pr.proposal.id}/accept`, 'POST', {})
    expect(acc.status, JSON.stringify(acc.body)).toBe(200)
    expect(acc.body.court).toMatchObject({ check_current: true, rules_current: false, profile: { version: 'CM/ECF 1.7' } })
    const re2 = await callWorkbench(`${base}/court/check`, 'POST', {})
    expect(re2.body.court.rules_current).toBe(true)
    expect(re2.body.court.check.result.issues.find((i: { key: string }) => i.key === 'not_searchable').level).toBe('error')
  })

  it('profil nelkul nincs ujraellenorzes; ismeretlen profil 400; a "megneztem" csak a tulajdonos kattintasa', async () => {
    const base = `/api/workbench/items/${itemId}`
    expect((await callWorkbench(`${base}/court`, 'PUT', { profile_id: 'mars' })).status).toBe(400)
    const noProf = await callWorkbench(`${base}/court/check`, 'POST', {})
    expect([409, 424]).toContain(noProf.status)
    await callWorkbench(`${base}/court`, 'PUT', { profile_id: 'general' })
    if (havePoppler) expect((await callWorkbench(`${base}/court/check`, 'POST', {})).body.error).toBe('court_no_final')
    // Ugynok-hivas (token): se "megneztem", se beallitas, se javaslat-dontes.
    const agent = { kind: 'token' }
    const pr = proposeRule({ profile_id: 'hu-eper', unchanged: true, reason: 'teszt', checked_sources: ['https://birosag.hu/'] })
    if (!pr.ok) throw new Error(pr.detail)
    expect((await callWorkbench(`${base}/court/checked`, 'POST', { profile_id: 'hu-eper' }, undefined, agent)).status).toBe(403)
    expect((await callWorkbench(`${base}/court/settings`, 'PUT', { max_age_days: 365 }, undefined, agent)).status).toBe(403)
    expect((await callWorkbench(`${base}/court/proposals/${pr.proposal.id}/accept`, 'POST', {}, undefined, agent)).status).toBe(403)
    expect(listProposals().map((x) => x.id)).toEqual([pr.proposal.id])
    // A tulajdonos kattintasa: beallitas, rossz ertek 400, a hibas fajl 409 (nem irjuk felul).
    const ok = await callWorkbench(`${base}/court/settings`, 'PUT', { max_age_days: 365 })
    expect(ok.status).toBe(200)
    expect(ok.body.court.max_age_days).toBe(365)
    expect((await callWorkbench(`${base}/court/settings`, 'PUT', { max_age_days: 5 })).body.error).toBe('court_settings_bad')
    writeFileSync(process.env['MARVEEN_COURT_PROFILES_FILE']!, 'nem json')
    const broken = await callWorkbench(`${base}/court/proposals/${pr.proposal.id}/accept`, 'POST', {})
    expect(broken.status).toBe(409)
    expect(broken.body.error).toBe('court_file_broken')
    const g = await callWorkbench(`${base}/court`, 'GET')
    expect(g.body.court.file_error).toBeTruthy()
    expect(g.body.court.proposals).toHaveLength(1)
    rmSync(process.env['MARVEEN_COURT_PROFILES_FILE']!)
    expect((await callWorkbench(`${base}/court/proposals/${pr.proposal.id}/reject`, 'POST', {})).status).toBe(200)
    expect((await callWorkbench(`${base}/court/proposals/${pr.proposal.id}/accept`, 'POST', {})).body.error).toBe('court_proposal_not_open')
    expect((await callWorkbench(`${base}/court/proposals/nincs/accept`, 'POST', {})).status).toBe(404)
  })

  it('a melleklet fajlja cserelheto (a sorszam, a cim marad); mas fajlra nem mutathat, ami mar melleklet', () => {
    const resolve = (p: string) => resolveProjectFile(getProject(pid)!, p)
    writeFileSync(join(projDir(), 'Level', 'Mietvertrag (kereshető).pdf'), makePdf())
    const a = addAnnex(itemId, { path: 'Level/Mietvertrag.pdf', title: 'Mietvertrag' }, resolve, 'owner')
    if (!a.ok) throw new Error('melleklet')
    expect(setAnnexPath(itemId, a.annex.id, 'Level/nincs.pdf', resolve).ok).toBe(false)
    const r = setAnnexPath(itemId, a.annex.id, 'Level/Mietvertrag (kereshető).pdf', resolve)
    expect(r.ok).toBe(true)
    const list = listAnnexes(itemId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ path: 'Level/Mietvertrag (kereshető).pdf', title: 'Mietvertrag', label: 'K1' })
    expect(existsSync(join(projDir(), 'Level', 'Mietvertrag.pdf'))).toBe(true)
  })

  it('az Agent latja a profilt es valaszthat; ellenorzott-nek nem jelolheti, veglegesiteni nem tud', () => {
    expect(getTool('doc.court')?.autonomyCategory).toBe(null)
    expect(getTool('doc.setCourt')?.autonomyCategory).toBe('marveen_selfdev')
    const set = executeTool('doc.setCourt', { profile: 'de-ervv' }, { projectId: pid, workItemId: itemId, lang: 'hu' })
    expect(set).toMatchObject({ ok: true, data: { profile_id: 'de-ervv' } })
    const got = executeTool('doc.court', {}, { projectId: pid, workItemId: itemId, lang: 'hu' })
    expect(got.ok).toBe(true)
    if (got.ok) {
      const d = got.data as { profile: { id: string; version: string }; last_check: unknown; choices: unknown[] }
      expect(d.profile).toMatchObject({ id: 'de-ervv', version: 'ERVB 2025' })
      expect(d.last_check).toBe(null)
      expect(d.choices).toHaveLength(4)
    }
    expect(executeTool('doc.setCourt', { profile: 'mars' }, { projectId: pid, workItemId: itemId, lang: 'hu' }).ok).toBe(false)
    expect(getTool('doc.markCourtChecked')).toBeFalsy()
  })

  it('az Agent szabalyfrissitest JAVASOL (nem ir a profilba); a doc.court latja a nyitott javaslatot', () => {
    expect(getTool('doc.proposeCourtRule')?.autonomyCategory).toBe('marveen_selfdev')
    const ctx = { projectId: pid, workItemId: itemId, lang: 'hu' as const }
    const r = executeTool('doc.proposeCourtRule', {
      profile_id: 'de-ervv', reason: 'Az ERVB új változata 250 MB-ot enged.', checked_sources: ['https://justiz.de/'],
      version: { version: 'ERVB 2026', valid_from: '2026-01-01', sources: [{ title: 'ERVB 2026', url: 'https://justiz.de/ervb2026.pdf' }], requirements: { max_total_mb: 250 } },
    }, ctx)
    expect(r.ok, JSON.stringify(r)).toBe(true)
    // A profil nem valtozott: csak a tulajdonos elfogadasa irja be.
    expect(currentVersion(getProfile('de-ervv')!).version).toBe('ERVB 2025')
    const got = executeTool('doc.court', {}, ctx)
    if (!got.ok) throw new Error('doc.court')
    const d = got.data as { open_rule_proposals: { profile_id: string; diff: { key: string }[] }[]; profile_file_problem: unknown; stale_after_days: number }
    expect(d.open_rule_proposals).toHaveLength(1)
    expect(d.open_rule_proposals[0]!.diff.map((x) => x.key)).toContain('max_total_mb')
    expect(d.profile_file_problem).toBe(null)
    expect(d.stale_after_days).toBe(183)
    expect(executeTool('doc.proposeCourtRule', { profile_id: 'de-ervv', reason: 'x', checked_sources: [] }, ctx).ok).toBe(false)
  })
})

describe('K-1.36: szabalyfrissites javaslattal, a tulajdonos elfogadasaval', () => {
  const src = ['https://justiz.de/laender-bund-europa/elektronische_kommunikation/']
  const ervb26 = { version: 'ERVB 2026', valid_from: '2025-08-01', sources: [{ title: 'ERVB 2026', url: 'https://justiz.de/ervb2026.pdf' }], requirements: { max_total_mb: 250 } }

  it('rossz javaslat: forras nelkul, ismeretlen kulcs, lassu regex, a mostanival azonos, korabbi kezdet mas neven -- mind visszautasitva, emberi okkal', () => {
    expect(proposeRule({ profile_id: 'de-ervv', reason: 'x', checked_sources: ['http://nem-https.de/'], version: ervb26 })).toMatchObject({ ok: false, detail: expect.stringMatching(/checked_sources/) })
    expect(proposeRule({ profile_id: 'de-ervv', reason: '', checked_sources: src, version: ervb26 })).toMatchObject({ ok: false, detail: expect.stringMatching(/reason/) })
    expect(proposeRule({ profile_id: 'de-ervv', reason: 'x', checked_sources: src, version: { ...ervb26, sources: [] } })).toMatchObject({ ok: false, detail: expect.stringMatching(/official source/) })
    expect(proposeRule({ profile_id: 'de-ervv', reason: 'x', checked_sources: src, version: { ...ervb26, requirements: { max_size: 1 } } })).toMatchObject({ ok: false, detail: expect.stringMatching(/unknown requirement: max_size/) })
    expect(proposeRule({ profile_id: 'de-ervv', reason: 'x', checked_sources: src, version: { ...ervb26, requirements: { filename: { pattern: '(x+)+y', rule: { hu: 'a', en: 'a' } } } } })).toMatchObject({ ok: false, detail: expect.stringMatching(/filename\.pattern/) })
    const cur = currentVersion(getProfile('de-ervv')!)
    expect(proposeRule({ profile_id: 'de-ervv', reason: 'x', checked_sources: src, version: { ...cur, requirements: {} } })).toMatchObject({ ok: false, detail: expect.stringMatching(/unchanged: true/) })
    expect(proposeRule({ profile_id: 'de-ervv', reason: 'x', checked_sources: src, version: { ...ervb26, valid_from: '2020-01-01' } })).toMatchObject({ ok: false, detail: expect.stringMatching(/earlier than the current version/) })
    expect(proposeRule({ profile_id: 'mars', reason: 'x', checked_sources: src, unchanged: true })).toMatchObject({ ok: false })
    expect(proposeRule({ profile_id: 'at-erv', reason: 'x', checked_sources: src, version: ervb26 })).toMatchObject({ ok: false, detail: expect.stringMatching(/name/) })
    expect(listProposals()).toHaveLength(0)
  })

  it('uj verzio: csak a valtozo kulcsot kell kuldeni, a tobbi a mostanibol jon; elfogadas utan a fajlba kerul, a beepitett verzio megmarad', () => {
    const r = proposeRule({ profile_id: 'de-ervv', reason: 'Az új ERVB 250 MB-ot enged.', checked_sources: src, version: ervb26 })
    if (!r.ok) throw new Error(r.detail)
    expect(r.proposal).toMatchObject({ kind: 'new_version', base_version: 'ERVB 2025', status: 'open' })
    const diff = Object.fromEntries(r.proposal.diff.map((d) => [d.key, [d.from, d.to]]))
    expect(diff['max_total_mb']).toEqual([200, 250])
    expect(diff['version']).toEqual(['ERVB 2025', 'ERVB 2026'])
    expect(diff['filename']).toBeUndefined()
    expect(r.proposal.version!.requirements.filename?.max_length).toBe(90)
    // Az ujabb javaslat ugyanarra a profilra felvaltja a regit.
    const r2 = proposeRule({ profile_id: 'de-ervv', reason: 'Pontosítva.', checked_sources: src, version: { ...ervb26, requirements: { max_total_mb: 250, max_files: 2000 } } })
    if (!r2.ok) throw new Error(r2.detail)
    expect(listProposals().map((x) => x.id)).toEqual([r2.proposal.id])
    expect(acceptProposal(r.proposal.id)).toMatchObject({ ok: false, code: 'not_open' })
    const a = acceptProposal(r2.proposal.id)
    if (!a.ok) throw new Error(a.code)
    expect(a.profile).toMatchObject({ version: 'ERVB 2026', stale: false })
    const de = getProfile('de-ervv')!
    expect(de.versions.map((v) => v.version)).toEqual(['ERVB 2025', 'ERVB 2026'])
    expect(currentVersion(de).requirements).toMatchObject({ max_total_mb: 250, max_files: 2000 })
    const file = JSON.parse(readFileSync(process.env['MARVEEN_COURT_PROFILES_FILE']!, 'utf8'))
    expect(file.profiles).toHaveLength(1)
    expect(file.profiles[0].versions.map((v: { version: string }) => v.version)).toEqual(['ERVB 2026'])
    expect(listProposals()).toHaveLength(0)
    expect(listProposals('accepted').map((x) => x.id)).toEqual([r2.proposal.id])
    expect(listProposals('superseded').map((x) => x.id)).toEqual([r.proposal.id])
  })

  it('"nincs valtozas" javaslat: elfogadva a datum mai lesz; elvetve semmi nem valtozik; uj birosag profilja nevvel', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2027-06-01T12:00:00'))
      expect(listProfileSummaries().find((p) => p.id === 'hu-eper')!.stale).toBe(true)
      const u = proposeRule({ profile_id: 'hu-eper', unchanged: true, reason: 'A segédlet ugyanaz.', checked_sources: ['https://birosag.hu/'] })
      if (!u.ok) throw new Error(u.detail)
      expect(u.proposal.diff).toEqual([])
      const a = acceptProposal(u.proposal.id)
      if (!a.ok) throw new Error(a.code)
      expect(a.profile).toMatchObject({ last_checked: '2027-06-01', stale: false })
      const n = proposeRule({
        profile_id: 'at-erv', name: { hu: 'Ausztria (ERV)', en: 'Austria (ERV)' }, reason: 'Új bíróság.', checked_sources: ['https://www.justiz.gv.at/'],
        version: { version: 'ERV 2021', valid_from: '2021-01-01', sources: [{ title: 'ERV', url: 'https://www.justiz.gv.at/' }], requirements: { searchable: 'error', max_file_mb: 50 } },
      })
      if (!n.ok) throw new Error(n.detail)
      expect(n.proposal).toMatchObject({ kind: 'new_profile', base_version: null, name: { hu: 'Ausztria (ERV)' } })
      const x = proposeRule({ profile_id: 'us-cmecf', unchanged: true, reason: 'x', checked_sources: ['https://pacer.uscourts.gov/'] })
      if (!x.ok) throw new Error(x.detail)
      expect(rejectProposal(x.proposal.id)).toMatchObject({ ok: true, proposal: { status: 'rejected' } })
      expect(getProfile('us-cmecf')!.last_checked).toBe('2026-09-30')
      expect(acceptProposal(n.proposal.id).ok).toBe(true)
      expect(getProfile('at-erv')).toMatchObject({ name: { hu: 'Ausztria (ERV)' }, last_checked: '2027-06-01' })
      expect(listProfileSummaries().map((p) => p.id)).toContain('at-erv')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fajl hibas bejegyzesehez nem fuz (az ugy is kimaradna, csendben): a javaslat nyitva marad', () => {
    writeFileSync(process.env['MARVEEN_COURT_PROFILES_FILE']!, JSON.stringify({ profiles: [{ id: 'de-ervv', name: { hu: 'N', en: 'G' }, last_checked: 'tegnap', versions: [] }] }))
    const r = proposeRule({ profile_id: 'de-ervv', reason: 'x', checked_sources: src, version: ervb26 })
    if (!r.ok) throw new Error(r.detail)
    expect(acceptProposal(r.proposal.id)).toMatchObject({ ok: false, code: 'file_broken', detail: expect.stringMatching(/de-ervv: last_checked/) })
    expect(listProposals().map((x) => x.id)).toEqual([r.proposal.id])
  })
})

describe('a felulet: celbirosag-doboz (a rajzolo kod tenyleg lefut)', () => {
  const ITEM = { id: 'w1', title: 'Klage', type: 'document', status: 'draft', current_version_id: 'v1', folder: 'Klage', source_path: null }
  const HASH = 'c'.repeat(64)
  const FINAL = { label: 'Végleges – 2026-09-30', version_no: 2, version_id: 'v2', pdf_path: 'P/K/01_Klage.pdf', pdf_name: '01_Klage.pdf', stale: false }
  const outline = (final: unknown) => ({
    sections: [{ id: 's1', title: '1. Sachverhalt', status: 'done', problems: 0, blocks: [{ id: 'b1', kind: 'paragraph', text: 'Text.', owner_edited_at: null, missing: [], claims: [] }] }],
    check: { ready: true, items: [] }, content_hash: HASH, reviewed: true, final,
  })
  /** A szerver valodi alakja: a profilok a valodi `listProfileSummaries()`-bol. */
  const court = (extra: Record<string, unknown> = {}) => {
    const profiles = listProfileSummaries()
    return {
      profile_id: null, profile: null, profiles, check: null, available: true, max_age_days: 183,
      file: '/store/workbench-court-profiles.json', file_error: null, skipped: [], proposals: [],
      check_current: false, rules_current: false, ...extra,
    }
  }
  const de = () => listProfileSummaries().find((p) => p.id === 'de-ervv')!
  const RESULT = {
    profile_id: 'de-ervv', profile_name: { hu: 'Németország', en: 'Germany' }, version: 'ERVB 2025', valid_from: '2025-07-30', last_checked: '2026-09-30', stale: false,
    checked_at: '2026-09-30T10:00:00Z', files: [{ name: '01_Klage.pdf', role: 'main', bytes: 1000, pages: 1 }, { name: '02_Anlage_K1.pdf', role: 'annex', label: 'Anlage K1', bytes: 2000, pages: 3 }],
    issues: [
      { key: 'not_searchable', level: 'warn', file: '02_Anlage_K1.pdf', label: 'Anlage K1', annex_id: 'ax1', detail: { pages: [3] }, fix: 'searchable' },
      { key: 'filename', level: 'error', file: 'Klage (neu).pdf', detail: { length: 15, max: 90 } },
    ],
    errors: 1, warnings: 1, notes: [], sources: [],
  }

  /** A felulet minden hivashoz `?lang=` -ot fuz; az utvonalat enelkul nezzuk. */
  const bare = (url: string) => url.split('?')[0]

  async function open(c: Record<string, unknown>, final: unknown = null, project = { id: 'p1', name: 'Iroda', archived: false }) {
    const h = workbenchHarness({ confirm: true })
    let cur = c
    h.respond((url, init) => {
      const m = init?.method || 'GET'
      if (bare(url).endsWith('/court') && m === 'PUT') {
        cur = court({ profile_id: 'de-ervv', profile: de() })
        return { status: 200, body: { ok: true, court: cur } }
      }
      if (bare(url).endsWith('/court/check') && m === 'POST') {
        cur = { ...cur, check: { version_id: 'v2', result: RESULT }, check_current: true, rules_current: true }
        return { status: 200, body: { ok: true, court: cur } }
      }
      if (url.includes('/court/') && m !== 'GET') return { status: 200, body: { ok: true, court: cur } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/w1/outline')) return { status: 200, body: { outline: outline(final) } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: [], outline: outline(final), court: cur } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], project) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-court'))
    return h
  }

  /** Csak a celbirosag-doboz (a veglegesites dobozaig), hogy mas panel szovege ne zavarjon. */
  const box = (html: string): string => {
    const at = html.indexOf('<div class="wb-court">')
    if (at < 0) return ''
    const end = html.indexOf('<div class="wb-outline-final">', at)
    return html.slice(at, end < 0 ? undefined : end)
  }

  it('friss allapot: nincs valasztva -> mind a negy profil valaszthato, nincs eredmeny es ujraellenorzes; a valasztas PUT-tal megy, utana latszik a szabalyverzio a forrassal', async () => {
    const h = await open(court())
    let b = box(h.html())
    expect(b).toContain('<select id="wbCourtProfile">')
    for (const id of ['de-ervv', 'us-cmecf', 'hu-eper', 'general']) expect(b).toContain(`<option value="${id}"`)
    expect(b).not.toContain('data-wb-act="court-check"')
    expect(b).not.toContain('workbench.court.result_')
    // A figyelmeztetes ideje a feluletrol allithato, a jelenlegi (183 nap = 6 honap) kivalasztva.
    expect(b).toContain('<option value="183" selected>')
    expect(b).toContain('workbench.court.new_hint')

    h.change('wbCourtProfile', [], 'de-ervv')
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => bare(c.url).endsWith('/court') && c.init?.method === 'PUT')).toBe(true))
    const put = h.fetchCalls.find((c) => bare(c.url).endsWith('/court') && c.init?.method === 'PUT')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ profile_id: 'de-ervv' })
    await vi.waitFor(() => expect(box(h.html())).toContain('workbench.court.version:'))
    b = box(h.html())
    expect(b).toContain('"version":"ERVB 2025"')
    expect(b).toContain('href="https://www.gesetze-im-internet.de/ervv/__2.html"')
    expect(b).toContain('workbench.court.filename')
    // Vegleges valtozat nelkul: az ellenorzes a veglegesiteskor fut, gomb nincs.
    expect(b).toContain('workbench.court.not_checked')
    expect(b).not.toContain('data-wb-act="court-check"')
    // "Nincs kivalasztva" is valaszthato (a profil torolheto).
    h.change('wbCourtProfile', [], '')
    await vi.waitFor(() => expect(h.fetchCalls.filter((c) => bare(c.url).endsWith('/court') && c.init?.method === 'PUT')).toHaveLength(2))
    expect(JSON.parse(String(h.fetchCalls.filter((c) => bare(c.url).endsWith('/court') && c.init?.method === 'PUT')[1].init?.body))).toEqual({ profile_id: null })
  })

  it('vegleges valtozat utan: ujraellenorzes -> hibak es figyelmeztetesek emberi mondattal, melyik szabalyverzio szerint; a szkennelt mellekletre egy kattintasos javitas', async () => {
    const h = await open(court({ profile_id: 'de-ervv', profile: de() }), FINAL)
    expect(box(h.html())).toContain('workbench.court.not_checked_final')
    h.click({ 'data-wb-act': 'court-check' })
    await vi.waitFor(() => expect(box(h.html())).toContain('workbench.court.result_errors'))
    const b = box(h.html())
    expect(b).toContain('"version":"ERVB 2025","files":2,"e":1,"w":1')
    expect(b).toContain('<li class="wb-court-err">✗ ⟦workbench.court.issue.filename:')
    expect(b).toContain('<li class="wb-court-warn">⚠ ⟦workbench.court.issue.not_searchable:')
    expect(b).toContain('"who":"⟦workbench.court.annex_file:{\\"label\\":\\"Anlage K1\\"}⟧"')
    expect(b).toContain('"pages":"3"')
    // A javitas gombja PONTOSAN a szkennelt mellekletre mutat, a fajlnev-hibanal nincs javitas-gomb.
    expect(b.match(/data-wb-act="court-fix"/g)).toHaveLength(1)
    expect(b).toContain('data-wb-act="court-fix" data-wb-id="ax1"')
    // Sosem allitja, hogy a beadvany megfelel.
    expect(b).toContain('workbench.court.disclaimer')
    h.click({ 'data-wb-act': 'court-fix', 'data-wb-id': 'ax1' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => bare(c.url).endsWith('/court/fix'))).toBe(true))
    expect(JSON.parse(String(h.fetchCalls.find((c) => bare(c.url).endsWith('/court/fix'))?.init?.body))).toEqual({ annex_id: 'ax1' })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.court.fixed⟧'))
  })

  it('elavult profil es regi szabalyverzio szerinti ellenorzes: mindketto hangosan szol, a "megneztem" a profilt kuldi', async () => {
    const stale = { ...de(), stale: true, last_checked: '2025-01-01', version: 'ERVB 2026' }
    const h = await open(court({ profile_id: 'de-ervv', profile: stale, check: { version_id: 'v2', result: RESULT }, check_current: true, rules_current: false }), FINAL)
    const b = box(h.html())
    expect(b).toContain('workbench.court.stale:')
    expect(b).toContain('"date":"2025-01-01"')
    expect(b).toContain('workbench.court.rules_changed:{"version":"ERVB 2026","old":"ERVB 2025"}')
    h.click({ 'data-wb-act': 'court-checked', 'data-wb-id': 'de-ervv' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => bare(c.url).endsWith('/court/checked'))).toBe(true))
    expect(JSON.parse(String(h.fetchCalls.find((c) => bare(c.url).endsWith('/court/checked'))?.init?.body))).toEqual({ profile_id: 'de-ervv' })
  })

  it('az Agent javaslata: mi valtozna (regi -> uj), forrasok; elfogadas es elvetes a tulajdonos kattintasa', async () => {
    const pr = proposeRule({
      profile_id: 'hu-eper', reason: 'A segédlet szerint a méretkorlát 200 MB.', checked_sources: ['https://birosag.hu/'],
      version: { version: 'segédlet 2027', valid_from: '2027-01-01', sources: [{ title: 'birosag.hu', url: 'https://birosag.hu/' }], requirements: { max_file_mb: 200 } },
    })
    if (!pr.ok) throw new Error(pr.detail)
    const h = await open(court({ proposals: listProposals() }))
    const b = box(h.html())
    expect(b).toContain('workbench.court.proposal.new_version')
    expect(b).toContain('A segédlet szerint a méretkorlát 200 MB.')
    expect(b).toContain('href="https://birosag.hu/"')
    // A valtozas sora: a kulcs emberi neve, regi -> uj ertek.
    expect(b).toContain('⟦workbench.court.req.max_file_mb⟧:</b> ⟦workbench.court.val.mb:{"n":150}⟧ → ⟦workbench.court.val.mb:{"n":200}⟧')
    expect(b).toContain('workbench.court.proposal.verify')
    h.click({ 'data-wb-act': 'court-prop-accept', 'data-wb-id': pr.proposal.id })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => bare(c.url).endsWith(`/court/proposals/${pr.proposal.id}/accept`))).toBe(true))
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.court.proposal.accepted⟧'))
  })

  it('a hibas profilfajl nem nema (a hiba kiirva), es a beallitas ilyenkor nem allithato; archivalt projektben nincs gomb', async () => {
    const h = await open(court({ file_error: 'Unexpected token', skipped: [{ id: 'xx', problem: 'id: 2-40 lowercase letters' }] }))
    const b = box(h.html())
    expect(b).toContain('workbench.court.file_error:')
    expect(b).toContain('Unexpected token')
    expect(b).toContain('workbench.court.skipped:')
    expect(b).toContain('<select id="wbCourtMaxAge" disabled>')

    const pr = proposeRule({ profile_id: 'hu-eper', reason: 'Nincs változás.', checked_sources: ['https://birosag.hu/'], unchanged: true })
    if (!pr.ok) throw new Error(pr.detail)
    const ro = await open(court({ profile_id: 'de-ervv', profile: { ...de(), stale: true }, check: { version_id: 'v2', result: RESULT }, check_current: true, rules_current: true, proposals: listProposals() }), FINAL, { id: 'p1', name: 'Iroda', archived: true })
    const rb = box(ro.html())
    expect(rb).toContain('workbench.court.result_errors')
    expect(rb).not.toContain('<select id="wbCourtProfile"')
    for (const act of ['court-check', 'court-fix', 'court-checked', 'court-ask-check', 'court-prop-accept', 'court-prop-reject']) expect(rb).not.toContain(`data-wb-act="${act}"`)
    // A javaslat archivalt projektben is olvashato, csak gomb nincs hozza.
    expect(rb).toContain('workbench.court.proposal.unchanged')
  })

  it('a figyelmeztetes idejenek atallitasa es a javaslat elvetese a szerverhez megy, visszajelzessel', async () => {
    const pr = proposeRule({ profile_id: 'us-cmecf', reason: 'Nincs változás a forrásban.', checked_sources: ['https://www.uscourts.gov/'], unchanged: true })
    if (!pr.ok) throw new Error(pr.detail)
    const h = await open(court({ proposals: listProposals() }))
    h.change('wbCourtMaxAge', [], '365')
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => bare(c.url).endsWith('/court/settings'))).toBe(true))
    const put = h.fetchCalls.find((c) => bare(c.url).endsWith('/court/settings'))
    expect(put?.init?.method).toBe('PUT')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ max_age_days: 365 })
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.court.settings_saved⟧'))
    h.click({ 'data-wb-act': 'court-prop-reject', 'data-wb-id': pr.proposal.id })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => bare(c.url).endsWith(`/court/proposals/${pr.proposal.id}/reject`))).toBe(true))
    await vi.waitFor(() => expect(h.toasts).toContain('⟦workbench.court.proposal.rejected⟧'))
  })

  it('a "Nezd meg a forrast" a chatbe kuldi a kerest a profil hivatalos forrasaival', async () => {
    const h = await open(court({ profile_id: 'de-ervv', profile: de() }))
    h.click({ 'data-wb-act': 'court-ask-check', 'data-wb-id': 'de-ervv' })
    await vi.waitFor(() => expect(h.fetchCalls.some((c) => c.url.includes('/agent/message'))).toBe(true))
    const msg = JSON.parse(String(h.fetchCalls.find((c) => c.url.includes('/agent/message'))?.init?.body))
    expect(JSON.stringify(msg)).toContain('workbench.court.ask_check_text')
    expect(JSON.stringify(msg)).toContain('https://www.gesetze-im-internet.de/ervv/__2.html')
    expect(JSON.stringify(msg)).toContain('de-ervv')
  })
})
