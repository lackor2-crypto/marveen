/**
 * IRATOK OLVASASA OLDALANKENT (kanban #441, v4 spec 1/A, K-1.1 ... K-1.6).
 *
 * Eddig a Munkapad agentje csak sima szoveget tudott olvasni (`file.read`), a
 * szovegfelismeres pedig csak a Beerkezo iratrendezoben futott, ott is csak a
 * PDF elso 2 oldalan. Itt egy iratot EGYSZER dolgozunk fel, MINDEN oldalat:
 *
 *   - PDF: oldalankent a szovegreteg (pdftotext); ha egy oldalon nincs
 *     ertelmes szoveg (szkennelt oldal), azt az oldalt szovegfelismeressel
 *     (tesseract, magyar + nemet + angol) olvassuk, MEGBIZHATOSAGGAL;
 *   - irodai fajl (DOCX, ODT, ...): a meglevo LibreOffice-atalakitassal PDF,
 *     abbol oldalankent;
 *   - fotozott irat (JPG, PNG, TIFF, ...): szovegfelismeres, 1 oldal;
 *   - e-mail (EML): fejlec + szoveg, 1 oldal.
 *
 * Az eredmeny oldalankent az adatbazisba kerul, a fajl TARTALMANAK
 * ujjlenyomata (sha256) szerint -- egy atnevezett vagy athelyezett fajlt nem
 * olvasunk ujra, egy megvaltozottat igen. Minden oldal mellett: a kinyeres
 * modja (`text` / `ocr` / `plain`), a szovegfelismeres megbizhatosaga, es hogy
 * gyenge-e (K-1.3: gyenge oldal nem tenyforras, amig ember meg nem erositi).
 *
 * MINDEN A SAJAT GEPEN FUT (K-1.5): kulso szolgaltatas nincs. Ami hianyzik
 * (pl. nincs tesseract), azt a hibaszoveg megnevezi -- nem talalgatunk.
 *
 * Egyszerre EGY irat feldolgozasa fut (egy terhelt gepen sem inditunk tiz
 * tesseractot), ugyanazt a tartalmat ketszer nem dolgozzuk fel.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { getDb } from './db.js'
import { which, ocrLanguages, toolEnv } from './life-inbox-systools.js'
import { convertOfficeToPdf, isOfficeConvertible } from './office-convert.js'

/** A feldolgozo verzioja: ha a modszer valtozik, a regi eredmenyt ujraolvassuk. */
export const DOCREAD_VERSION = 1
/** Ennel kevesebb betu/szam egy PDF-oldal szovegretegeben = szkennelt oldal, OCR kell. */
export const TEXT_LAYER_MIN_CHARS = 25
/** Ez alatti atlagos szovegfelismeresi megbizhatosag (0-100) = gyenge oldal (K-1.3). */
export const OCR_LOW_CONFIDENCE = 70
/** Egy iratbol legfeljebb ennyi oldalt dolgozunk fel (a tobbi hibakent jelzodik). */
export const DOCREAD_MAX_PAGES = 1000
/** Ennel hosszabb iratnal az agent tartalomjegyzeket kap, nem teljes szoveget (K-1.6). */
export const LONG_DOCUMENT_PAGES = 50

const TOOL_TIMEOUT_MS = 60_000
const OCR_TIMEOUT_MS = 180_000

export type DocKind = 'pdf' | 'office' | 'image' | 'email'
export type PageMethod = 'text' | 'ocr' | 'plain'
export type DocStatus = 'pending' | 'running' | 'done' | 'failed'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff', 'bmp', 'webp', 'gif'])

/** Milyen fajtakent olvassuk az iratot; null = nem ez a modul olvassa (szoveg, video, hang...). */
export function docKind(name: string): DocKind | null {
  const ext = extname(String(name || '')).slice(1).toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (ext === 'eml') return 'email'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (isOfficeConvertible(name)) return 'office'
  return null
}

// ---------------------------------------------------------------------------
// Tablak
// ---------------------------------------------------------------------------

let tablesDb: unknown = null

export function ensureDocReadTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_reads (
      sha256 TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      pages_total INTEGER NOT NULL DEFAULT 0,
      pages_done INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_pages (
      sha256 TEXT NOT NULL,
      page INTEGER NOT NULL,
      text TEXT NOT NULL,
      method TEXT NOT NULL,
      confidence REAL,
      low INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (sha256, page)
    )
  `)
  tablesDb = db
}

export interface DocReadRow {
  sha256: string
  name: string
  kind: DocKind
  status: DocStatus
  pages_total: number
  pages_done: number
  error: string | null
  version: number
  updated_at: number
}

export interface DocPageRow {
  sha256: string
  page: number
  text: string
  method: PageMethod
  confidence: number | null
  low: number
}

export function getDocRead(sha: string): DocReadRow | undefined {
  ensureDocReadTables()
  return getDb().prepare('SELECT * FROM doc_reads WHERE sha256 = ?').get(sha) as DocReadRow | undefined
}

export function getDocPages(sha: string, from = 1, to = DOCREAD_MAX_PAGES): DocPageRow[] {
  ensureDocReadTables()
  return getDb().prepare('SELECT * FROM doc_pages WHERE sha256 = ? AND page >= ? AND page <= ? ORDER BY page')
    .all(sha, from, to) as DocPageRow[]
}

/** A gyenge (K-1.3) oldalak szama, emelkedo sorrendben. */
export function lowPages(sha: string): number[] {
  ensureDocReadTables()
  return (getDb().prepare('SELECT page FROM doc_pages WHERE sha256 = ? AND low = 1 ORDER BY page').all(sha) as { page: number }[]).map((r) => r.page)
}

function setState(sha: string, name: string, kind: DocKind, patch: Partial<Pick<DocReadRow, 'status' | 'pages_total' | 'pages_done' | 'error'>>): void {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const cur = getDocRead(sha)
  if (!cur) {
    db.prepare(`INSERT INTO doc_reads (sha256, name, kind, status, pages_total, pages_done, error, version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha, name, kind, patch.status ?? 'pending', patch.pages_total ?? 0, patch.pages_done ?? 0, patch.error ?? null, DOCREAD_VERSION, now)
    return
  }
  db.prepare(`UPDATE doc_reads SET name = ?, kind = ?, status = ?, pages_total = ?, pages_done = ?, error = ?, version = ?, updated_at = ? WHERE sha256 = ?`)
    .run(name, kind, patch.status ?? cur.status, patch.pages_total ?? cur.pages_total, patch.pages_done ?? cur.pages_done,
      patch.error === undefined ? cur.error : patch.error, DOCREAD_VERSION, now, sha)
}

function savePage(sha: string, p: { page: number; text: string; method: PageMethod; confidence: number | null }): void {
  const low = p.method === 'ocr' && p.confidence !== null && p.confidence < OCR_LOW_CONFIDENCE && p.text.trim().length > 0
  getDb().prepare(`INSERT INTO doc_pages (sha256, page, text, method, confidence, low) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sha256, page) DO UPDATE SET text = excluded.text, method = excluded.method, confidence = excluded.confidence, low = excluded.low`)
    .run(sha, p.page, p.text, p.method, p.confidence, low ? 1 : 0)
}

// ---------------------------------------------------------------------------
// Kulso programok (aszinkron: a dashboard nem allhat meg egy OCR alatt)
// ---------------------------------------------------------------------------

function runAsync(bin: string, args: string[], timeout = TOOL_TIMEOUT_MS): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const exe = which(bin)
  if (!exe) return Promise.resolve({ ok: false, error: `${bin} is not installed` })
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: toolEnv(bin) }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: `${bin}: ${(stderr || err.message || '').toString().trim().slice(0, 300)}` })
      else resolve({ ok: true, out: stdout })
    })
  })
}

/** Ennyi betu/szam van a szovegben (a szokoz, vonal, pont nem szamit). */
export function meaningfulChars(s: string): number {
  const m = String(s || '').match(/[\p{L}\p{N}]/gu)
  return m ? m.length : 0
}

/**
 * A tesseract TSV-kimenetebol az atlagos szo-megbizhatosag (0-100), a
 * szavak hosszaval sulyozva; null, ha nincs egy felismert szo sem.
 */
export function tsvConfidence(tsv: string): number | null {
  let sum = 0
  let weight = 0
  for (const line of tsv.split(/\r?\n/).slice(1)) {
    const cols = line.split('\t')
    if (cols.length < 12) continue
    const conf = Number(cols[10])
    const word = (cols[11] || '').trim()
    if (!word || !Number.isFinite(conf) || conf < 0) continue
    const w = Math.max(1, meaningfulChars(word))
    sum += conf * w
    weight += w
  }
  return weight ? Math.round((sum / weight) * 10) / 10 : null
}

/** Egy kep szovegfelismerese: szoveg + megbizhatosag. */
async function ocrImage(imagePath: string, workDir: string): Promise<{ ok: true; text: string; confidence: number | null } | { ok: false; error: string }> {
  const langs = ocrLanguages()
  if (!which('tesseract') || !langs) return { ok: false, error: 'tesseract (text recognition) is not installed' }
  const base = join(workDir, 'ocr-' + basename(imagePath).replace(/\W+/g, '_'))
  const r = await runAsync('tesseract', [imagePath, base, '-l', langs, 'txt', 'tsv'], OCR_TIMEOUT_MS)
  if (!r.ok) return r
  let text = ''
  let tsv = ''
  try { text = readFileSync(base + '.txt', 'utf-8') } catch { /* nincs szoveg */ }
  try { tsv = readFileSync(base + '.tsv', 'utf-8') } catch { /* nincs tsv */ }
  return { ok: true, text: text.replace(/\f/g, '').trimEnd(), confidence: tsvConfidence(tsv) }
}

async function pdfPageCount(pdf: string): Promise<{ ok: true; pages: number } | { ok: false; error: string }> {
  const r = await runAsync('pdfinfo', [pdf])
  if (!r.ok) return r
  const m = /^Pages:\s*(\d+)/m.exec(r.out)
  const n = m ? Number(m[1]) : 0
  return n > 0 ? { ok: true, pages: n } : { ok: false, error: 'pdfinfo: the PDF has no pages' }
}

// ---------------------------------------------------------------------------
// Feldolgozas
// ---------------------------------------------------------------------------

async function readPdfPages(sha: string, name: string, kind: DocKind, pdf: string): Promise<void> {
  const count = await pdfPageCount(pdf)
  if (!count.ok) throw new Error(count.error)
  const total = Math.min(count.pages, DOCREAD_MAX_PAGES)
  setState(sha, name, kind, { status: 'running', pages_total: total, pages_done: 0 })
  const work = mkdtempSync(join(tmpdir(), 'marveen-docread-'))
  try {
    for (let p = 1; p <= total; p++) {
      const t = await runAsync('pdftotext', ['-q', '-enc', 'UTF-8', '-f', String(p), '-l', String(p), pdf, '-'])
      if (!t.ok) throw new Error(t.error)
      const layer = t.out.replace(/\f/g, '').trimEnd()
      if (meaningfulChars(layer) >= TEXT_LAYER_MIN_CHARS) {
        savePage(sha, { page: p, text: layer, method: 'text', confidence: null })
      } else {
        // Szkennelt (vagy ures) oldal: kep, szovegfelismeres.
        const prefix = join(work, `p${p}`)
        const img = await runAsync('pdftoppm', ['-r', '300', '-f', String(p), '-l', String(p), '-png', '-singlefile', pdf, prefix], OCR_TIMEOUT_MS)
        if (!img.ok) throw new Error(img.error)
        const o = await ocrImage(prefix + '.png', work)
        if (!o.ok) throw new Error(o.error)
        // Ha a szovegreteg tobbet adott, mint a felismeres, az marad.
        if (meaningfulChars(layer) >= meaningfulChars(o.text)) savePage(sha, { page: p, text: layer, method: 'text', confidence: null })
        else savePage(sha, { page: p, text: o.text, method: 'ocr', confidence: o.confidence })
        try { rmSync(prefix + '.png', { force: true }) } catch { /* a munkamappa ugyis torlodik */ }
      }
      setState(sha, name, kind, { pages_done: p })
    }
    const note = count.pages > total ? `only the first ${total} of ${count.pages} pages were read` : null
    setState(sha, name, kind, { status: 'done', error: note })
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* mar nincs meg */ }
  }
}

async function readEmail(sha: string, name: string, abs: string): Promise<void> {
  const { simpleParser } = await import('mailparser')
  const mail = await simpleParser(readFileSync(abs))
  const addr = (a: unknown): string => {
    if (!a) return ''
    const list = Array.isArray(a) ? a : [a]
    return list.map((x) => (x && typeof x === 'object' && 'text' in x ? String((x as { text: string }).text) : '')).filter(Boolean).join(', ')
  }
  const head = [
    `From: ${addr(mail.from)}`,
    `To: ${addr(mail.to)}`,
    mail.cc ? `Cc: ${addr(mail.cc)}` : '',
    `Date: ${mail.date ? mail.date.toISOString() : ''}`,
    `Subject: ${mail.subject || ''}`,
    mail.attachments && mail.attachments.length ? `Attachments: ${mail.attachments.map((x) => x.filename || '(no name)').join(', ')}` : '',
  ].filter(Boolean).join('\n')
  const body = (mail.text || '').trimEnd()
  savePage(sha, { page: 1, text: `${head}\n\n${body}`, method: 'plain', confidence: null })
  setState(sha, name, 'email', { status: 'done', pages_total: 1, pages_done: 1, error: null })
}

async function processDocument(abs: string, name: string, sha: string, kind: DocKind): Promise<void> {
  getDb().prepare('DELETE FROM doc_pages WHERE sha256 = ?').run(sha)
  setState(sha, name, kind, { status: 'running', pages_total: 0, pages_done: 0, error: null })
  try {
    if (kind === 'pdf') await readPdfPages(sha, name, kind, abs)
    else if (kind === 'office') {
      const c = await convertOfficeToPdf(abs)
      if (!c.ok) throw new Error(`office conversion failed (${c.code})${c.detail ? ': ' + c.detail : ''}`)
      await readPdfPages(sha, name, kind, c.pdf)
    } else if (kind === 'image') {
      setState(sha, name, kind, { status: 'running', pages_total: 1 })
      const work = mkdtempSync(join(tmpdir(), 'marveen-docread-'))
      try {
        const o = await ocrImage(abs, work)
        if (!o.ok) throw new Error(o.error)
        savePage(sha, { page: 1, text: o.text, method: 'ocr', confidence: o.confidence })
        setState(sha, name, kind, { status: 'done', pages_done: 1, error: null })
      } finally {
        try { rmSync(work, { recursive: true, force: true }) } catch { /* mar nincs meg */ }
      }
    } else await readEmail(sha, name, abs)
  } catch (e) {
    setState(sha, name, kind, { status: 'failed', error: e instanceof Error ? e.message : String(e) })
  }
}

// Egyszerre egy irat; ugyanaz a tartalom egyszer.
let queue: Promise<unknown> = Promise.resolve()
const inFlight = new Map<string, Promise<void>>()

export function sha256OfFile(abs: string): string {
  return createHash('sha256').update(readFileSync(abs)).digest('hex')
}

export type StartOutcome =
  | { ok: true; sha: string; state: DocReadRow; started: boolean; done: Promise<void> }
  | { ok: false; code: 'not_a_document' | 'missing' }

/**
 * Az irat feldolgozasanak inditasa (ha meg nincs kesz / folyamatban). Nem var
 * a vegere: a `done` igeret akkor teljesul, amikor az irat elkeszult.
 * `sha` megadhato, ha a hivo mar kiszamolta (az anyag-sorban megvan).
 */
export function startDocRead(abs: string, name: string, opts: { sha?: string; force?: boolean } = {}): StartOutcome {
  ensureDocReadTables()
  const kind = docKind(name)
  if (!kind) return { ok: false, code: 'not_a_document' }
  if (!existsSync(abs)) return { ok: false, code: 'missing' }
  const sha = opts.sha || sha256OfFile(abs)
  const running = inFlight.get(sha)
  if (running) return { ok: true, sha, state: getDocRead(sha) as DocReadRow, started: false, done: running }
  const cur = getDocRead(sha)
  const fresh = cur && cur.version === DOCREAD_VERSION && cur.status === 'done'
  if (fresh && !opts.force) return { ok: true, sha, state: cur, started: false, done: Promise.resolve() }
  // Egy korabbi (pl. ujrainditas miatt felbeszakadt) futas: ujrakezdjuk.
  if (cur && cur.status === 'failed' && cur.version === DOCREAD_VERSION && !opts.force) {
    return { ok: true, sha, state: cur, started: false, done: Promise.resolve() }
  }
  setState(sha, name, kind, { status: 'pending', pages_total: 0, pages_done: 0, error: null })
  const job = queue.then(() => processDocument(abs, name, sha, kind))
  const done = job.finally(() => { inFlight.delete(sha) })
  queue = done.catch(() => undefined)
  inFlight.set(sha, done)
  return { ok: true, sha, state: getDocRead(sha) as DocReadRow, started: true, done }
}

/** Fut-e most feldolgozas ehhez a tartalomhoz ebben a folyamatban. */
export function isDocReadRunning(sha: string): boolean {
  return inFlight.has(sha)
}

/**
 * A felulet es az agent szamara: az irat allapota egy mondatnyi adatban.
 * Egy `running`/`pending` sor, amihez ebben a folyamatban NINCS futas (a
 * Marveen kozben ujraindult), `stale` -- a kovetkezo keres ujrainditja.
 */
export interface DocReadSummary {
  status: DocStatus | 'none' | 'stale'
  pages_total: number
  pages_done: number
  low_pages: number[]
  ocr_pages: number
  error: string | null
}

export function docReadSummary(sha: string): DocReadSummary {
  const r = getDocRead(sha)
  if (!r) return { status: 'none', pages_total: 0, pages_done: 0, low_pages: [], ocr_pages: 0, error: null }
  const ocr = (getDb().prepare("SELECT COUNT(*) AS n FROM doc_pages WHERE sha256 = ? AND method = 'ocr'").get(sha) as { n: number }).n
  const stale = (r.status === 'running' || r.status === 'pending') && !inFlight.has(sha)
  return {
    status: stale ? 'stale' : (r.version !== DOCREAD_VERSION && r.status === 'done' ? 'stale' : r.status),
    pages_total: r.pages_total, pages_done: r.pages_done, low_pages: lowPages(sha), ocr_pages: ocr, error: r.error,
  }
}

/** Ez a gep mit tud olvasni (a hibauzenetekhez es a kepesseg-lapra). */
export function docReaderTools(): { pdftotext: boolean; pdfinfo: boolean; pdftoppm: boolean; tesseract: boolean; ocr_languages: string } {
  return {
    pdftotext: !!which('pdftotext'), pdfinfo: !!which('pdfinfo'), pdftoppm: !!which('pdftoppm'),
    tesseract: !!which('tesseract'), ocr_languages: which('tesseract') ? ocrLanguages() : '',
  }
}


// ---------------------------------------------------------------------------
// Az agent es a teljes erteku ugynok nezete (ugyanaz a ket uton)
// ---------------------------------------------------------------------------

/** Egy `document.read` valaszban legfeljebb ennyi karakternyi oldalszoveg. */
export const DOCUMENT_READ_MAX_CHARS = 9000

export type DocViewOutcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: 'not_a_document' | 'missing' | 'processing' | 'failed' | 'bad_input'; detail: string }

const LOW_WARNING = 'LOW OCR CONFIDENCE: this page is hard to read. Do NOT use it as a source of facts until the owner has checked it; tell the owner which page to check.'

function stateOrStart(abs: string, name: string, retry: boolean): { ok: true; sha: string; sum: DocReadSummary } | { ok: false; code: 'not_a_document' | 'missing' | 'processing' | 'failed'; detail: string } {
  const s = startDocRead(abs, name, { force: retry })
  if (!s.ok) {
    return s.code === 'missing'
      ? { ok: false, code: 'missing', detail: 'the file is not there' }
      : { ok: false, code: 'not_a_document', detail: 'not a PDF, office document, image or e-mail; read plain text files with file.read' }
  }
  s.done.catch(() => undefined)
  let sum = docReadSummary(s.sha)
  if (sum.status === 'stale') {
    const again = startDocRead(abs, name, { sha: s.sha, force: true })
    if (again.ok) again.done.catch(() => undefined)
    sum = docReadSummary(s.sha)
  }
  if (sum.status === 'failed') {
    return { ok: false, code: 'failed', detail: `reading this document failed: ${sum.error || 'unknown error'}. Tell the owner exactly this; call again with retry=true after the cause is fixed.` }
  }
  if (sum.status !== 'done') {
    return {
      ok: false, code: 'processing',
      detail: `the document is being read now (${sum.pages_done}/${sum.pages_total || '?'} pages done). Tell the owner it is in progress and ask again a little later; do not guess its content.`,
    }
  }
  return { ok: true, sha: s.sha, sum }
}

/**
 * Az irat attekintese: hany oldal, oldalankent a modszer, a megbizhatosag,
 * es egy rovid kezdosor. Hosszu iratnal (K-1.6) ez a tartalomjegyzek: a
 * teljes szoveget oldalanként a `documentPagesText` adja.
 */
export function documentOverview(abs: string, name: string, opts: { retry?: boolean } = {}): DocViewOutcome {
  const st = stateOrStart(abs, name, !!opts.retry)
  if (!st.ok) return st
  const pages = getDocPages(st.sha)
  const long = pages.length > LONG_DOCUMENT_PAGES
  return {
    ok: true,
    data: {
      name, pages: st.sum.pages_total, ocr_pages: st.sum.ocr_pages, low_confidence_pages: st.sum.low_pages,
      note: [
        st.sum.error || '',
        st.sum.low_pages.length ? `pages ${st.sum.low_pages.join(', ')} are hard to read (low OCR confidence): do not use them as a source of facts until the owner checks them` : '',
        long ? 'long document: use this list as a table of contents and read only the pages you need' : '',
      ].filter(Boolean).join('; '),
      page_list: pages.map((p) => ({
        page: p.page, method: p.method, confidence: p.confidence, low: !!p.low, chars: p.text.length,
        starts_with: p.text.replace(/\s+/g, ' ').trim().slice(0, long ? 80 : 160),
      })),
    },
  }
}

/**
 * Oldalak szovege `[fajl:oldal]` jelolessel, szo szerint (K-1.2). Egy
 * valaszba legfeljebb DOCUMENT_READ_MAX_CHARS fer; a `next_page` mondja meg,
 * honnan kell folytatni.
 */
export function documentPagesText(abs: string, name: string, from: number, to: number, opts: { retry?: boolean } = {}): DocViewOutcome {
  const st = stateOrStart(abs, name, !!opts.retry)
  if (!st.ok) return st
  const total = st.sum.pages_total
  const a = Math.max(1, Math.floor(from || 1))
  const b = Math.min(total, Math.floor(to || a))
  if (a > total) return { ok: false, code: 'bad_input', detail: `the document has only ${total} page(s)` }
  const out: { page: number; ref: string; method: string; confidence: number | null; warning?: string; truncated?: boolean; text: string }[] = []
  let cut = false
  let used = 0
  let next: number | null = null
  for (const p of getDocPages(st.sha, a, Math.max(a, b))) {
    let text = p.text
    if (used + text.length > DOCUMENT_READ_MAX_CHARS) {
      if (out.length) { next = p.page; break }
      text = text.slice(0, DOCUMENT_READ_MAX_CHARS)
      cut = true
      next = p.page < b ? p.page + 1 : null
    }
    used += text.length
    out.push({
      page: p.page, ref: `[${name}:${p.page}]`, method: p.method, confidence: p.confidence,
      ...(p.low ? { warning: LOW_WARNING } : {}),
      ...(cut && out.length === 0 ? { truncated: true } : {}),
      text,
    })
  }
  return {
    ok: true,
    data: {
      name, pages: total, from: a, to: out.length ? out[out.length - 1].page : a, next_page: next,
      how_to_cite: 'quote verbatim and cite as [file:page], e.g. ' + `[${name}:${a}]`,
      page_texts: out,
    },
  }
}

// ---------------------------------------------------------------------------
// GEPI IDEZET-ELLENORZES (K-1.12)
// ---------------------------------------------------------------------------
//
// Nem az agent onbevallasa: program nezi meg, hogy a szo szerinti idezet
// tenyleg ott all-e a megadott fajl megadott oldalan. Kis elteres (a
// szovegfelismeres egy-egy betuje, sortores, kotojel, ekezet, idezojel-fajta)
// megengedett; ha az idezet MASIK oldalon van, azt kulon megmondjuk (hamis
// oldalszam), ha sehol, akkor "nem igazolhato".

/** Egy idezet legfeljebb ilyen hosszu lehet (hosszabbat reszekre kell bontani). */
export const QUOTE_MAX_CHARS = 1500
/** Ennyi hasonlosag kell egy szovegretegbol olvasott oldalon (1 = betu szerint egyezik). */
export const MATCH_MIN_TEXT = 0.97
/** Ennyi egy szovegfelismeressel olvasott oldalon (a felismeres hibazhat egy-egy betut). */
export const MATCH_MIN_OCR = 0.92

/** Osszeveteshez: kisbetu, ekezet nelkul, egyseges idezojel/kotojel, sortoresnel elvalasztott szo osszeillesztve, egy szokoz. */
export function normalizeForMatch(s: string): string {
  return String(s || '')
    .replace(/(\p{L})-\s*\n\s*(\p{L})/gu, '$1$2')
    .normalize('NFKD').replace(/\p{M}/gu, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * A `needle` legjobb kozelito elofordulasa a `hay`-ben (Sellers-algoritmus:
 * szerkesztesi tavolsag, a hay barmely reszehez igazitva).
 */
export function bestFuzzyMatch(needle: string, hay: string): { distance: number; similarity: number } {
  const m = needle.length
  if (!m) return { distance: 0, similarity: 1 }
  let prev = new Array<number>(m + 1)
  let cur = new Array<number>(m + 1)
  for (let i = 0; i <= m; i++) prev[i] = i
  let best = m
  for (let j = 1; j <= hay.length; j++) {
    cur[0] = 0
    const hc = hay.charCodeAt(j - 1)
    for (let i = 1; i <= m; i++) {
      const cost = needle.charCodeAt(i - 1) === hc ? 0 : 1
      cur[i] = Math.min(prev[i - 1] + cost, prev[i] + 1, cur[i - 1] + 1)
    }
    if (cur[m] < best) best = cur[m]
    const t = prev; prev = cur; cur = t
  }
  if (!hay.length) best = m
  return { distance: best, similarity: Math.round((1 - best / m) * 1000) / 1000 }
}

/** Gyors elszures a tobbi oldal atnezesehez: tartalmaz-e az oldal legalabb egy darabot az idezetbol. */
function mightContain(needle: string, hay: string): boolean {
  if (needle.length < 24) return true
  const step = Math.max(1, Math.floor((needle.length - 8) / 6))
  for (let i = 0; i + 8 <= needle.length; i += step) if (hay.includes(needle.slice(i, i + 8))) return true
  return false
}

export interface QuoteCheck {
  /** verified: ott all (betu szerint vagy kis elteressel); other_page: masik oldalon all;
   *  not_found: sehol; low_page: ott all, de az oldal rosszul olvashato (ember nezze meg). */
  verdict: 'verified' | 'low_page' | 'other_page' | 'not_found'
  page: number
  similarity: number
  exact: boolean
  found_on: number[]
  method: PageMethod | null
}

function pageSimilarity(q: string, text: string): { similarity: number; exact: boolean } {
  const hay = normalizeForMatch(text)
  if (hay.includes(q)) return { similarity: 1, exact: true }
  if (!mightContain(q, hay)) return { similarity: 0, exact: false }
  // Egy szam (datum, osszeg, ugyszam, oldalszam) nem lehet "majdnem jo":
  // minden szamnak betu szerint szerepelnie kell az oldalon.
  const hayNums = new Set(hay.match(/\d+/g) || [])
  if ((q.match(/\d+/g) || []).some((n) => !hayNums.has(n))) return { similarity: 0, exact: false }
  return { similarity: bestFuzzyMatch(q, hay).similarity, exact: false }
}

/** Egy mar elolvasott irat egy oldalan az idezet. A hivo biztositja, hogy az irat kesz (`documentOverview`). */
export function verifyQuoteInRead(sha: string, page: number, quote: string): QuoteCheck | { error: 'bad_quote' | 'bad_page' } {
  const q = normalizeForMatch(quote)
  if (q.length < 4 || quote.length > QUOTE_MAX_CHARS) return { error: 'bad_quote' }
  const pages = getDocPages(sha)
  const target = pages.find((p) => p.page === page)
  if (!target) return { error: 'bad_page' }
  const min = (p: DocPageRow): number => (p.method === 'ocr' ? MATCH_MIN_OCR : MATCH_MIN_TEXT)
  const here = pageSimilarity(q, target.text)
  if (here.similarity >= min(target)) {
    return {
      verdict: target.low ? 'low_page' : 'verified', page, similarity: here.similarity, exact: here.exact,
      found_on: [page], method: target.method,
    }
  }
  const elsewhere = pages.filter((p) => p.page !== page && pageSimilarity(q, p.text).similarity >= min(p)).map((p) => p.page)
  return {
    verdict: elsewhere.length ? 'other_page' : 'not_found', page, similarity: here.similarity, exact: false,
    found_on: elsewhere, method: target.method,
  }
}

/** Az agent es a teljes erteku ugynok nezete: az irat (ha kell) elolvasasa utan az ellenorzes. */
export function verifyQuote(abs: string, name: string, page: number, quote: string): DocViewOutcome {
  const st = stateOrStart(abs, name, false)
  if (!st.ok) return st
  const r = verifyQuoteInRead(st.sha, Math.floor(page || 0), String(quote || ''))
  if ('error' in r) {
    return {
      ok: false, code: 'bad_input',
      detail: r.error === 'bad_page' ? `the document has ${st.sum.pages_total} page(s); page ${page} does not exist` : `the quote must be 4 to ${QUOTE_MAX_CHARS} characters of real text`,
    }
  }
  const say = r.verdict === 'verified' ? `verified: the quote is on page ${page}${r.exact ? '' : ` (similarity ${r.similarity}, small reading differences allowed)`}`
    : r.verdict === 'low_page' ? `found on page ${page}, but that page is hard to read: the owner must check it before it counts as a source`
    : r.verdict === 'other_page' ? `NOT on page ${page}; it is on page ${r.found_on.join(', ')} -- correct the page number`
    : `NOT FOUND in this document: the quote cannot be verified (mark it "⚠ Forrás nem igazolható" / "source cannot be verified")`
  return { ok: true, data: { name, ref: `[${name}:${page}]`, ...r, result: say } }
}

// ---------------------------------------------------------------------------
// KERESHETO MASOLAT (K-1.4)
// ---------------------------------------------------------------------------
//
// A szkennelt PDF-bol olyan masolat, amelyben a kep mogott szovegreteg van
// (OCRmyPDF, a sajat gepen). Az eredeti fajlhoz NEM nyulunk; a masolat
// ugyanabba a mappaba kerul, szabad nevvel.

export type SearchableOutcome =
  | { ok: true; abs: string; name: string }
  | { ok: false; code: 'not_installed' | 'not_pdf' | 'failed'; detail: string }

const searchableJobs = new Map<string, Promise<SearchableOutcome>>()

export function searchableCopyAvailable(): boolean {
  return !!which('ocrmypdf') && !!which('tesseract')
}

/** A masolat neve: `level.pdf` -> `level (kereshető).pdf` (a felulet nyelve szerint). */
export function searchableName(name: string, lang: 'hu' | 'en'): string {
  const base = name.replace(/\.pdf$/i, '')
  return `${base} (${lang === 'en' ? 'searchable' : 'kereshető'}).pdf`
}

/**
 * Kereshető másolat keszitese. `destName` a kivant nev (a hivo szabad nevet ad);
 * ugyanarra a forrasra egyszerre egy futas.
 */
export function makeSearchableCopy(abs: string, destAbs: string): Promise<SearchableOutcome> {
  if (!/\.pdf$/i.test(abs)) return Promise.resolve({ ok: false, code: 'not_pdf', detail: 'only a PDF can get a searchable copy' })
  if (!searchableCopyAvailable()) return Promise.resolve({ ok: false, code: 'not_installed', detail: 'OCRmyPDF (ocrmypdf) is not installed on this machine' })
  const running = searchableJobs.get(abs)
  if (running) return running
  const langs = ocrLanguages() || 'eng'
  const job = (async (): Promise<SearchableOutcome> => {
    const r = await runAsync('ocrmypdf', ['--skip-text', '--output-type', 'pdf', '-l', langs, abs, destAbs], 30 * 60_000)
    if (!r.ok || !existsSync(destAbs)) {
      try { rmSync(destAbs, { force: true }) } catch { /* nem jott letre */ }
      return { ok: false, code: 'failed', detail: r.ok ? 'ocrmypdf produced no file' : r.error }
    }
    return { ok: true, abs: destAbs, name: basename(destAbs) }
  })()
  const done = job.finally(() => { searchableJobs.delete(abs) })
  searchableJobs.set(abs, done)
  return done
}
