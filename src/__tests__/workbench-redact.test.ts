// #441 (v4 spec 1/B, K-1.35): kitakart masolat -- a szemelyes adat VALOBAN
// eltunik (szovegkereses, kijeloles-masolas, gepi szovegkinyeres, a PDF belso
// objektumai es metaadatai, a kepreteg), nem csak fekete teglalap kerul ra.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { attachAsset } from '../workbench-assets.js'
import {
  detectSpans, findTermWords, pageFindings, collectNames, lineBars, blackOut, ppmHeader, imagePdf, cleanTerms,
  countFolded, parseBboxLayout, parseTesseractTsv, mergeWords, redactedName, scanForRedaction, makeRedactedCopy,
  resetRedactCache, type RedactWord, type PageWords,
} from '../workbench-redact.js'
import { which } from '../life-inbox-systools.js'
import { runTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

const FIXTURE = join(__dirname, 'fixtures', 'redact-mixed.pdf')
const havePoppler = !!(which('pdftotext') && which('pdfinfo') && which('pdftoppm'))
const haveAll = havePoppler && !!which('tesseract')

/** Szavak egy sorbol, egyszeru helyekkel (1 betu = 10 keppont). */
function words(lines: string[]): RedactWord[] {
  const out: RedactWord[] = []
  lines.forEach((l, line) => {
    let x = 0
    for (const w of l.split(' ')) {
      out.push({ text: w, x0: x, y0: line * 30, x1: x + w.length * 10, y1: line * 30 + 20, line })
      x += w.length * 10 + 10
    }
  })
  return out
}
const page = (lines: string[], n = 1): PageWords => ({ page: n, width: 1000, height: 1000, text_layer: true, ocr: false, words: words(lines) })
const texts = (p: PageWords, terms: string[] = [], names: string[] = []) => pageFindings(p, terms, names).map((f) => `${f.category}:${f.text}`)

describe('mit takarunk ki', () => {
  it('rogzitett mintak: e-mail, IBAN, magyar szamlaszam, telefon, szuletesi datum (csak kulcsszo utan), azonosito, cim', () => {
    const p = page([
      'Felperes: Kovács János (szül.: 1978. március 4., lakcím: 1051 Budapest, Kossuth Lajos',
      'utca 12.) adóazonosító jel: 8412345678',
      'IBAN: HU42 1177 3016 1111 1018 0000 0000 E-mail: kovacs.janos@example.hu',
      'Számlaszám: 11773016-01234567 telefon: +36 30 123 4567',
      'Anschrift: Musterstraße 12, 10115 Berlin, geb. 04.03.1978',
      'A tárgyalás 2027. január 5-én lesz.',
    ])
    const got = texts(p)
    expect(got).toContain('name:Kovács János')
    expect(got).toContain('birth_date:1978. március 4.,')
    expect(got.some((g) => g.startsWith('address:1051 Budapest') && g.includes('utca 12.)'))).toBe(true)
    expect(got).toContain('id_number:8412345678')
    // Az IBAN nem nyul at a kovetkezo szora (E-mail:).
    expect(got).toContain('account:HU42 1177 3016 1111 1018 0000 0000')
    expect(got).toContain('email:kovacs.janos@example.hu')
    expect(got).toContain('account:11773016-01234567')
    expect(got).toContain('phone:+36 30 123 4567')
    expect(got.some((g) => g.startsWith('address:Musterstraße 12, 10115 Berlin'))).toBe(true)
    expect(got).toContain('birth_date:04.03.1978')
    // Az ugyirat tobbi datuma NEM szemelyes adat: marad.
    expect(got.join(' ')).not.toContain('2027')
  })

  it('a megadott nev ragozva is (Kovács Jánosnak), rovid szonal csak pontosan; ekezet nelkul is egyezik', () => {
    const ws = words(['Kovács Jánosnak a bíróság kézbesített, Kovacs Janos is. Kovácsék nem, Kő Ede sem.'])
    const hits = findTermWords(ws, 'Kovács János').map(([a, b]) => ws.slice(a, b + 1).map((w) => w.text).join(' '))
    expect(hits).toEqual(['Kovács Jánosnak', 'Kovacs Janos'])
    expect(findTermWords(words(['Kőbánya Kő Ede']), 'Kő').length).toBe(1)
    expect(findTermWords(words(['Kovácsnéval tárgyalt']), 'Kovács').length).toBe(1)
    expect(findTermWords(words(['Kovácsházai úton']), 'Kovács').length).toBe(0)
  })

  it('a „Tanú: Szabó Éva” nevet az irat minden oldalan keressuk; a talalatok nem fednek at', () => {
    const p1 = page(['Tanú: Szabó Éva'], 1)
    const p2 = page(['Szabó Évának írt levél, Szabó Éva aláírta.'], 2)
    const names = collectNames([p1, p2])
    expect(names).toEqual(['Szabó Éva'])
    expect(texts(p2, [], names)).toEqual(['name:Szabó Évának', 'name:Szabó Éva'])
    // A minta es a megadott kifejezes ugyanazon a helyen: egy talalat.
    expect(texts(p1, ['Szabó Éva'], names)).toEqual(['name:Szabó Éva'])
  })

  it('a megadott kifejezesek tisztitasa: soronkent vagy listaban, ismetles es ures nelkul', () => {
    expect(cleanTerms('Kovács János\n\n  kovacs  janos \nX\nNagy Péter')).toEqual(['Kovács János', 'Nagy Péter'])
    expect(cleanTerms(['A B', 5, null])).toEqual(['A B'])
    expect(cleanTerms(undefined)).toEqual([])
  })

  it('a talalat soronkent egy fekete sav (a szavak kozotti res nem arulja el a szavak szamat)', () => {
    const ws = words(['Kovács János', 'Nagy'])
    expect(lineBars(ws)).toEqual([{ x0: 0, y0: 0, x1: 120, y1: 20 }, { x0: 0, y0: 30, x1: 40, y1: 50 }])
  })

  it('a masolat neve a felulet nyelven', () => {
    expect(redactedName('Kereset.PDF', 'hu')).toBe('Kereset (kitakart).pdf')
    expect(redactedName('a.pdf', 'en')).toBe('a (redacted).pdf')
  })

  it('ellenorzes szamolasa: ekezet, kisbetu, szokoz nem szamit; a nagyon rovid szoveg nem', () => {
    expect(countFolded('KOVACS  janos, Kovács János', 'Kovács János')).toBe(2)
    expect(countFolded('abc', 'ab')).toBe(0)
  })
})

describe('szavak helye', () => {
  it('pdftotext -bbox-layout: pontbol keppont (200 dpi), soronkent', () => {
    const x = '<page width="595.3" height="841.9"><flow><block><line><word xMin="72" yMin="72" xMax="144" yMax="90">Kov&amp;ács</word>'
      + '<word xMin="150" yMin="72" xMax="200" yMax="90">János</word></line><line><word xMin="72" yMin="100" xMax="90" yMax="110">x</word></line></block></flow></page>'
    const r = parseBboxLayout(x, 200)
    expect(Math.round(r.width)).toBe(1654)
    expect(r.words.map((w) => [w.text, w.line])).toEqual([['Kov&ács', 0], ['János', 0], ['x', 1]])
    expect(Math.round(r.words[0].x0)).toBe(200)
  })

  it('tesseract TSV: csak a szavak (5. szint), sorkulccsal; a szovegreteget fedo felismeres nem duplazodik', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '4\t1\t1\t1\t1\t0\t10\t10\t100\t20\t-1\t',
      '5\t1\t1\t1\t1\t1\t10\t10\t40\t20\t90\tKovács',
      '5\t1\t1\t1\t2\t1\t10\t40\t40\t20\t90\tBerlin',
    ].join('\n')
    const o = parseTesseractTsv(tsv, 5)
    expect(o.map((w) => [w.text, w.line])).toEqual([['Kovács', 5], ['Berlin', 6]])
    const layer: RedactWord[] = [{ text: 'Kovács', x0: 11, y0: 11, x1: 49, y1: 29, line: 0 }]
    expect(mergeWords(layer, o).map((w) => w.text)).toEqual(['Kovács', 'Berlin'])
  })

  it('a fekete terulet a kep adataiban van (nem ratett reteg), a kep szelen tul nem ir', () => {
    const w = 20, h = 10
    const buf = Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`, 'latin1'), Buffer.alloc(w * h * 3, 255)])
    blackOut(buf, [{ x0: 5, y0: 4, x1: 6, y1: 5 }, { x0: -50, y0: -50, x1: 1, y1: 1 }])
    const hd = ppmHeader(buf)!
    const px = (x: number, y: number) => buf[hd.offset + (y * w + x) * 3]
    expect(px(5, 4)).toBe(0)
    expect(px(2, 1)).toBe(0) // 3 keppont raadas
    expect(px(15, 9)).toBe(255)
    expect(buf.length).toBe(hd.offset + w * h * 3)
  })

  it.skipIf(!havePoppler)('kepekbol allo PDF (ha nincs szovegfelismero): ervenyes, nincs benne szoveg es metaadat', () => {
    const dir = mkdtempSync(join(tmpdir(), 'marveen-redact-img-'))
    try {
      const ppm = Buffer.concat([Buffer.from('P6\n200 100\n255\n', 'latin1'), Buffer.alloc(200 * 100 * 3, 128)])
      writeFileSync(join(dir, 'a.pdf'), imagePdf([{ ppm, dpi: 200 }, { ppm, dpi: 100 }]))
      const info = execFileSync('pdfinfo', [join(dir, 'a.pdf')], { encoding: 'utf8' })
      expect(info).toMatch(/Pages:\s+2/)
      expect(info).toMatch(/Page size:\s+72 x 36 pts/)
      expect(info).not.toMatch(/Title|Author|Producer|Creator/)
      expect(execFileSync('pdftotext', [join(dir, 'a.pdf'), '-'], { encoding: 'utf8' }).trim()).toBe('')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

/** A kitakart adat sehol: a PDF nyers bajtjaiban sem (UTF-8, UTF-16, ekezet nelkul). */
function rawContains(buf: Buffer, s: string): boolean {
  const utf16 = Buffer.from('﻿' + s, 'utf16le').swap16().subarray(2)
  const plain = s.normalize('NFD').replace(/\p{M}/gu, '')
  return buf.includes(Buffer.from(s, 'utf8')) || buf.includes(utf16) || buf.includes(Buffer.from(plain, 'latin1'))
}

const SECRETS = ['Kovács', 'János', '1978', '11773016', 'HU42', 'example.hu', '123 4567', 'Kossuth', 'Szabó', '1985', '8412345678', 'Musterstraße', '10115']

describe('K-1.35 kitakaras-proba (szoveges + szkennelt oldal)', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'marveen-redact-')); resetRedactCache() })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it.skipIf(!haveAll)('a kitakart adat sehol nem talalhato; ami nem szemelyes adat, olvashato marad; az eredeti nem valtozik', async () => {
    const src = join(dir, 'kereset.pdf')
    copyFileSync(FIXTURE, src)
    const before = readFileSync(src)
    const scan = await scanForRedaction(src, ['Nagy Péter'])
    expect(scan.ok).toBe(true)
    if (!scan.ok) return
    expect(scan.data.pages).toBe(2)
    expect(scan.data.unreadable_pages).toEqual([])
    const cats = (p: number) => new Set(scan.data.findings.filter((f) => f.page === p).map((f) => f.category))
    expect([...cats(1)].sort()).toEqual(['account', 'address', 'birth_date', 'email', 'name', 'phone'])
    // A szkennelt oldalon is (szovegfelismeressel): nev, szuletesi datum, azonosito, cim.
    expect([...cats(2)].sort()).toEqual(['address', 'birth_date', 'id_number', 'name'])
    // Az eredetiben meg benne van minden (kulonben a proba semmit nem bizonyit).
    const origText = execFileSync('pdftotext', [src, '-'], { encoding: 'utf8' })
    expect(origText).toContain('Kovács János')

    const out = join(dir, 'kereset (kitakart).pdf')
    const r = await makeRedactedCopy(src, out, {})
    expect(r).toMatchObject({ ok: true, pages: 2, searchable: true })
    expect(readFileSync(src).equals(before)).toBe(true)

    // 1. Gepi szovegkinyeres / szovegkereses / kijeloles-masolas (ugyanaz a szovegreteg).
    const text = execFileSync('pdftotext', [out, '-'], { encoding: 'utf8' })
    for (const s of SECRETS) expect(text, s).not.toContain(s)
    expect(text).toContain('Die Klage wird abgewiesen')
    expect(text).toMatch(/17\. M.rz 2027/)
    // 2. A PDF belso objektumai es 3. metaadatai: a nyers fajlban sincs.
    const raw = readFileSync(out)
    for (const s of SECRETS) expect(rawContains(raw, s), s).toBe(false)
    const info = execFileSync('pdfinfo', [out], { encoding: 'utf8' })
    expect(info).not.toMatch(/Kov/)
    expect(info).toMatch(/Pages:\s+2/)
    // 4. A kepreteg: a masolat oldalkepeit ujra felismertetve sincs meg (a keppontok torolve).
    for (const pg of [1, 2]) {
      execFileSync('pdftoppm', ['-r', '200', '-f', String(pg), '-l', String(pg), '-singlefile', '-png', out, join(dir, `v${pg}`)])
      const ocr = execFileSync('tesseract', [join(dir, `v${pg}.png`), 'stdout', '-l', 'hun+deu+eng'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      for (const s of SECRETS) expect(ocr, `${pg}. oldal: ${s}`).not.toContain(s)
    }
  }, 240_000)

  it.skipIf(!haveAll)('amibol a tulajdonos kivette a pipat, az olvashato marad; semmi kijelolve: megnevezett hiba', async () => {
    const src = join(dir, 'kereset.pdf')
    copyFileSync(FIXTURE, src)
    const scan = await scanForRedaction(src, [])
    if (!scan.ok) throw new Error(scan.detail)
    const mail = scan.data.findings.find((f) => f.category === 'email')!
    const out = join(dir, 'k.pdf')
    const r = await makeRedactedCopy(src, out, { skip: [mail.id] })
    expect(r.ok).toBe(true)
    const text = execFileSync('pdftotext', [out, '-'], { encoding: 'utf8' })
    expect(text).toContain('example.hu')
    expect(text).not.toContain('Kovács')
    const none = await makeRedactedCopy(src, join(dir, 'x.pdf'), { skip: scan.data.findings.map((f) => f.id) })
    expect(none).toMatchObject({ ok: false, code: 'nothing_selected' })
    expect(existsSync(join(dir, 'x.pdf'))).toBe(false)
  }, 240_000)
})

describe('vegpont es Agent-eszkoz', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  beforeEach(() => {
    initDatabase(':memory:')
    resetRedactCache()
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-redact-'))
    mkdirSync(projDir(), { recursive: true })
    process.env['MARVEEN_DEPOT'] = depot
    const p = createProject({ name: 'Iroda' })
    if (!p.ok) throw new Error('projekt')
    pid = p.project.id
    updateProject(pid, { folder_path: 'Projektek/Iroda' })
  })
  afterEach(() => {
    rmSync(depot, { recursive: true, force: true })
    delete process.env['MARVEEN_DEPOT']
  })

  it('nem PDF-re megnevezett hiba; az eszkoz fajlt ir (engedelykoteles)', async () => {
    expect(getTool('document.redact')?.autonomyCategory).toBe('workbench_file_write')
    const w = createWorkItem({ project_id: pid, title: 'Level', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    attachAsset(w.item, 'jegyzet.md', Buffer.from('# j'))
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/document/redact/scan`, 'POST', { path: 'Munkadarabok/Level/jegyzet.md' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('redact_not_pdf')
    expect(String(r.body.message)).toContain('PDF')
  })

  it.skipIf(!haveAll)('a vegpont: vizsgalat, majd a masolat a mappaba kerul; az Agent ugyanazt kapja', async () => {
    const w = createWorkItem({ project_id: pid, title: 'Level', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    attachAsset(w.item, 'kereset.pdf', readFileSync(FIXTURE))
    const path = 'Munkadarabok/Level/kereset.pdf'
    const s = await callWorkbench(`/api/workbench/items/${w.item.id}/document/redact/scan`, 'POST', { path, terms: ['Die Klage'] })
    expect(s.status).toBe(200)
    expect(s.body.findings.some((f: { category: string; text: string }) => f.category === 'custom' && f.text === 'Die Klage')).toBe(true)
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/document/redact`, 'POST', { path, terms: [], skip: [] })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ name: 'kereset (kitakart).pdf', path: 'Munkadarabok/Level/kereset (kitakart).pdf', pages: 2 })
    expect(existsSync(join(projDir(), 'Munkadarabok', 'Level', 'kereset (kitakart).pdf'))).toBe(true)

    const ctx = { projectId: pid, workItemId: w.item.id, lang: 'hu' as const }
    const dry = await runTool('document.redact', { path, dry_run: true }, ctx)
    expect(dry.ok && (dry.data as { findings: unknown[] }).findings.length).toBeGreaterThan(5)
    expect(existsSync(join(projDir(), 'Munkadarabok', 'Level', 'kereset (kitakart) (2).pdf'))).toBe(false)
    const made = await runTool('document.redact', { path, terms: ['Nagy Péter'] }, ctx)
    expect(made.ok && (made.data as { created: string; verified: boolean })).toMatchObject({ verified: true })
    expect(made.ok && String((made.data as { created: string }).created)).toMatch(/^Munkadarabok\/Level\/kereset \(kitakart\).*\.pdf$/)
  }, 240_000)
})

describe('a felulet: kitakart masolat', () => {
  it('PDF mellett gomb; a talalatok pipaval; a kivett pipa a skip-be, a beirt nev a terms-be kerul', async () => {
    const h = workbenchHarness()
    const ITEM = { id: 'w1', title: 'Level', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Level', source_path: null }
    const doc = { status: 'done', pages_total: 2, pages_done: 2, low_pages: [], ocr_pages: 0, error: null }
    const base = { present: true, shared: false, support: 'readable', doc }
    const ASSETS = [
      { ...base, id: 'a1', name: 'kereset.pdf', path: 'P/Level/kereset.pdf', project_path: 'Level/kereset.pdf' },
      { ...base, id: 'a2', name: 'kereset (kitakart).pdf', path: 'P/Level/kereset (kitakart).pdf', project_path: 'Level/kereset (kitakart).pdf' },
    ]
    const FINDINGS = [
      { id: '1:2-3', page: 1, category: 'name', text: 'Kovács János' },
      { id: '1:9-9', page: 1, category: 'email', text: 'kj@example.hu' },
    ]
    h.respond((url, init) => {
      if (url.includes('/document/redact/scan')) return { status: 200, body: { ok: true, pages: 2, findings: FINDINGS, unreadable_pages: [2], ocr: true } }
      if (url.includes('/document/redact') && init && init.method === 'POST') return { status: 201, body: { ok: true, name: 'kereset (kitakart) (2).pdf', redacted: 1, searchable: true, assets: ASSETS } }
      if (url.includes('/preview')) return { status: 200, body: { available: false, reason: 'no_source' } }
      if (url.includes('/api/workbench/items/')) return { status: 200, body: { item: ITEM, versions: [], parts: [], assets: ASSETS } }
      if (url.includes('/overview')) return { status: 200, body: { overview: null } }
      return { status: 200, body: itemsBody([ITEM], { id: 'p1', name: 'Iroda', archived: false }) }
    })
    h.win.MarvinWorkbench.open('p1', 'Iroda')
    await vi.waitFor(() => expect(h.html()).toContain('wb-items'))
    h.click({ 'data-wb-item': 'w1' })
    await vi.waitFor(() => expect(h.html()).toContain('wb-assets-block'))
    const html = h.html()
    expect(html).toContain('data-wb-act="redact-open" data-wb-path="Level/kereset.pdf"')
    // A mar kitakart masolatnal nincs ujabb kitakaras-gomb.
    expect(html).not.toContain('data-wb-act="redact-open" data-wb-path="Level/kereset (kitakart).pdf"')
    h.click({ 'data-wb-act': 'redact-open', 'data-wb-path': 'Level/kereset.pdf' })
    await vi.waitFor(() => expect(h.html()).toContain('data-wb-redact-id="1:9-9"'))
    expect(h.html()).toContain('workbench.redact.unreadable')
    // A pipa kivetele es a nev beirasa: a delegalt figyelok kapjak.
    h.fire('change', { target: { checked: false, closest: () => null, getAttribute: (a: string) => (a === 'data-wb-redact-id' ? '1:9-9' : null) } })
    h.fire('input', { target: { id: 'wbRedactTerms', value: 'Nagy Péter\n' } })
    h.click({ 'data-wb-act': 'redact-apply' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.redact.done'))
    const call = h.fetchCalls.find((c) => /\/items\/w1\/document\/redact(?:\?|$)/.test(c.url))
    expect(JSON.parse(String(call?.init?.body))).toEqual({ path: 'Level/kereset.pdf', terms: ['Nagy Péter'], skip: ['1:9-9'] })
    expect(h.html()).not.toContain('wb-redact-box')
  })
})
