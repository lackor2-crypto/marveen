// #441 (v4 spec 1/A, K-1.12 es K-1.4): gepi idezet-ellenorzes es kereshető masolat.
// Nem az agent onbevallasa: program nezi meg, hogy az idezet tenyleg ott all-e.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDb } from '../db.js'
import { createProject, updateProject } from '../projects.js'
import { createWorkItem } from '../workbench.js'
import { attachAsset } from '../workbench-assets.js'
import {
  normalizeForMatch, bestFuzzyMatch, verifyQuoteInRead, verifyQuote, ensureDocReadTables, sha256OfFile,
  DOCREAD_VERSION, searchableName, makeSearchableCopy, searchableCopyAvailable,
} from '../workbench-docread.js'
import { which } from '../life-inbox-systools.js'
import { executeTool } from '../workbench-agent/execute.js'
import { getTool } from '../workbench-agent/tools.js'
import { callWorkbench } from './helpers/workbench-route-call.js'
import { workbenchHarness, itemsBody } from './helpers/workbench-harness.js'

function seedRead(abs: string, name: string, pages: { text: string; method?: string; low?: boolean }[]): string {
  ensureDocReadTables()
  const sha = sha256OfFile(abs)
  const db = getDb()
  db.prepare(`INSERT OR REPLACE INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
    VALUES (?, ?, 'pdf', 'done', ?, ?, NULL, ?, 0)`).run(sha, name, pages.length, pages.length, DOCREAD_VERSION)
  pages.forEach((p, i) => db.prepare('INSERT OR REPLACE INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha, i + 1, p.text, p.method || 'text', p.method === 'ocr' ? 88 : null, p.low ? 1 : 0))
  return sha
}

const P1 = 'Landgericht Berlin\nUrteil vom 3. Februar 2026\nDie Klage wird abge-\nwiesen. Die Kosten des Rechtsstreits trägt der Kläger.'
const P2 = 'Der Termin zur mündlichen Verhandlung ist am 17. März 2027 um 10:30 Uhr im Saal 12.'
const P3 = 'Az alperes a keresetlevél kézhezvételétől számított 15 napon belül írásban nyilatkozhat.'

describe('osszevetes', () => {
  it('normalizalas: kisbetu, ekezet nelkul, elvalasztott szo osszeillesztve, egyseges idezojel es szokoz', () => {
    expect(normalizeForMatch('Die Klage wird abge-\nwiesen.')).toBe('die klage wird abgewiesen.')
    expect(normalizeForMatch('„Árvíztűrő”   tükör–fúrógép')).toBe('"arvizturo" tukor-furogep')
    expect(normalizeForMatch('Straße')).toBe('strasse')
  })
  it('kozelito egyezes: a hay barmely reszehez igazit', () => {
    expect(bestFuzzyMatch('termin', 'der termin ist')).toEqual({ distance: 0, similarity: 1 })
    expect(bestFuzzyMatch('termin', 'der tennin ist').distance).toBe(2)
    expect(bestFuzzyMatch('abc', '').similarity).toBe(0)
  })
})

describe('K-1.12: gepi idezet-ellenorzes', () => {
  let dir = ''
  let sha = ''
  beforeEach(() => {
    initDatabase(':memory:')
    dir = mkdtempSync(join(tmpdir(), 'marveen-verify-'))
    writeFileSync(join(dir, 'itelet.pdf'), 'PDF')
    sha = seedRead(join(dir, 'itelet.pdf'), 'itelet.pdf', [{ text: P1 }, { text: P2, method: 'ocr' }, { text: P3, method: 'ocr', low: true }])
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('szo szerinti idezet a helyes oldalon: igazolt (a sortoresnel elvalasztott szo is)', () => {
    expect(verifyQuoteInRead(sha, 1, 'Die Klage wird abgewiesen.')).toMatchObject({ verdict: 'verified', exact: true, found_on: [1] })
  })

  it('kis felismeresi elteres egy szovegfelismeressel olvasott oldalon: igazolt, de a hasonlosag latszik', () => {
    const r = verifyQuoteInRead(sha, 2, 'Der Termin zur mündlichen Verhandlnng ist am 17. März 2027')
    expect(r).toMatchObject({ verdict: 'verified', exact: false })
    expect('similarity' in r && r.similarity).toBeLessThan(1)
  })

  it('ELFOGADAS: hamis oldalszam -- jelzi, es megmondja a helyes oldalt', () => {
    expect(verifyQuoteInRead(sha, 1, 'am 17. März 2027 um 10:30 Uhr')).toMatchObject({ verdict: 'other_page', found_on: [2] })
  })

  it('ELFOGADAS: kitalalt teny -- nem igazolhato; egy atirt szam (datum) sem "majdnem jo"', () => {
    expect(verifyQuoteInRead(sha, 2, 'Die Verhandlung fand im März 2026 statt')).toMatchObject({ verdict: 'not_found', found_on: [] })
    expect(verifyQuoteInRead(sha, 2, 'ist am 18. März 2027 um 10:30 Uhr')).toMatchObject({ verdict: 'not_found' })
    expect(verifyQuoteInRead(sha, 2, 'ist am 17. März 2027 um 11:30 Uhr')).toMatchObject({ verdict: 'not_found' })
  })

  it('K-1.3: a rosszul olvashato oldalon talalt idezet nem igazolt tenyforras (low_page)', () => {
    expect(verifyQuoteInRead(sha, 3, '15 napon belül írásban nyilatkozhat')).toMatchObject({ verdict: 'low_page' })
  })

  it('ertelmetlen bemenet: megnevezett hiba', () => {
    expect(verifyQuoteInRead(sha, 9, 'Die Klage')).toEqual({ error: 'bad_page' })
    expect(verifyQuoteInRead(sha, 1, 'ab')).toEqual({ error: 'bad_quote' })
    const v = verifyQuote(join(dir, 'itelet.pdf'), 'itelet.pdf', 9, 'Die Klage')
    expect(v).toMatchObject({ ok: false, code: 'bad_input' })
  })
})

describe('az agent es a teljes erteku ugynok', () => {
  let depot = ''
  let pid = ''
  const projDir = () => join(depot, 'Projektek', 'Iroda')
  beforeEach(() => {
    initDatabase(':memory:')
    depot = mkdtempSync(join(tmpdir(), 'marveen-wb-verify-'))
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

  it('source.verifyQuote: olvaso eszkoz, emberi mondattal; a vegpont ugyanazt mondja', async () => {
    expect(getTool('source.verifyQuote')?.autonomyCategory).toBe(null)
    expect(getTool('document.makeSearchable')?.autonomyCategory).toBe('workbench_file_write')
    const w = createWorkItem({ project_id: pid, title: 'Level', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    attachAsset(w.item, 'itelet.pdf', Buffer.from('PDF-v'))
    seedRead(join(projDir(), 'Munkadarabok', 'Level', 'itelet.pdf'), 'itelet.pdf', [{ text: P1 }, { text: P2 }])
    const ctx = { projectId: pid, workItemId: w.item.id, lang: 'hu' as const }
    const ok = executeTool('source.verifyQuote', { path: 'Munkadarabok/Level/itelet.pdf', page: 2, quote: 'am 17. März 2027' }, ctx)
    expect(ok.ok && ok.data).toMatchObject({ verdict: 'verified', ref: '[itelet.pdf:2]' })
    const wrong = executeTool('source.verifyQuote', { path: 'Munkadarabok/Level/itelet.pdf', page: 1, quote: 'am 17. März 2027' }, ctx)
    expect(wrong.ok && String(wrong.data.result)).toContain('it is on page 2')
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/document/verify`, 'POST', { path: 'Munkadarabok/Level/itelet.pdf', page: 1, quote: 'Die Verhandlung fand gestern statt' })
    expect(r.status).toBe(200)
    expect(r.body.verdict).toBe('not_found')
    const out = await callWorkbench(`/api/workbench/items/${w.item.id}/document/verify`, 'POST', { path: '../../x.pdf', page: 1, quote: 'abcd' })
    expect(out.status).toBeGreaterThanOrEqual(400)
  })

  it('kereshető masolat: nev a felulet nyelven; nem PDF-re megnevezett hiba', async () => {
    expect(searchableName('Level.PDF', 'hu')).toBe('Level (kereshető).pdf')
    expect(searchableName('a.pdf', 'en')).toBe('a (searchable).pdf')
    const w = createWorkItem({ project_id: pid, title: 'Level', type: 'note' })
    if (!w.ok) throw new Error('munkadarab')
    attachAsset(w.item, 'jegyzet.md', Buffer.from('# j'))
    const r = await callWorkbench(`/api/workbench/items/${w.item.id}/document/searchable`, 'POST', { path: 'Munkadarabok/Level/jegyzet.md' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('searchable_not_pdf')
  })

  it.skipIf(!(which('ocrmypdf') && searchableCopyAvailable()))('K-1.4: a szkennelt PDF-bol kereshető masolat lesz, az eredeti marad', async () => {
    const src = join(projDir(), 'scan.pdf')
    copyFileSync(join(__dirname, 'fixtures', 'docread-mixed.pdf'), src)
    const r = await makeSearchableCopy(src, join(projDir(), 'scan (kereshető).pdf'))
    expect(r.ok).toBe(true)
    expect(existsSync(src)).toBe(true)
    expect(existsSync(join(projDir(), 'scan (kereshető).pdf'))).toBe(true)
  }, 180_000)
})

describe('a felulet: kereshető masolat gomb', () => {
  it('csak kesz, szkennelt oldalt tartalmazo PDF-nel latszik; a gomb a vegpontot hivja', async () => {
    const h = workbenchHarness()
    const ITEM = { id: 'w1', title: 'Level', type: 'note', status: 'draft', current_version_id: 'v1', folder: 'Level', source_path: null }
    const doc = (ocr: number) => ({ status: 'done', pages_total: 2, pages_done: 2, low_pages: [], ocr_pages: ocr, error: null })
    const base = { present: true, shared: false, support: 'readable' }
    const ASSETS = [
      { ...base, id: 'a1', name: 'scan.pdf', path: 'P/Level/scan.pdf', project_path: 'Level/scan.pdf', doc: doc(1) },
      { ...base, id: 'a2', name: 'szoveg.pdf', path: 'P/Level/szoveg.pdf', project_path: 'Level/szoveg.pdf', doc: doc(0) },
    ]
    h.respond((url, init) => {
      if (url.includes('/document/searchable') && init && init.method === 'POST') return { status: 201, body: { ok: true, name: 'scan (kereshető).pdf', assets: ASSETS } }
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
    expect(html).toContain('data-wb-act="doc-searchable" data-wb-path="Level/scan.pdf"')
    expect(html).not.toContain('data-wb-path="Level/szoveg.pdf"')
    h.click({ 'data-wb-act': 'doc-searchable', 'data-wb-path': 'Level/scan.pdf' })
    await vi.waitFor(() => expect(h.toasts.join(' ')).toContain('workbench.doc.searchable_done'))
    const call = h.fetchCalls.find((c) => c.url.includes('/items/w1/document/searchable'))
    expect(JSON.parse(String(call?.init?.body))).toEqual({ path: 'Level/scan.pdf' })
  })
})
