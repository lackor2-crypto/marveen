/**
 * Munkapad 1/B, K-1.35 -- KITAKARAS: egy PDF-rol olyan masolat, amelyben a
 * szemelyes adatok (nev, szuletesi datum, cim, szamlaszam, azonosito, e-mail,
 * telefon) ki vannak takarva. Harmadik felnek kuldott irathoz kell.
 *
 * A kitakaras VALODI torles, nem fekete teglalap a szoveg folott (a
 * leggyakoribb, bírósági iratokban is elofordult hiba: a teglalap alatt a
 * szoveg kijelolheto, kimasolhato). Ezert a masolat minden oldala KEPKENT
 * keszul ujra (pdftoppm), a kitakarando szavak kepponjai feketek lesznek, es a
 * PDF ezekbol a kepekbol all ossze. Az eredeti szovegretegbol, objektumaibol,
 * metaadataibol, csatolmanyaibol semmi nem kerul at. Ha van tesseract, a
 * masolat ujra kereshető (a szovegreteg a MAR kitakart kepbol keszul, tehat a
 * kitakart adat abban sincs); ha nincs, a masolat csak kep.
 *
 * Mit hol keresunk: a szoveges oldalon a PDF szovegretegenek szavai (helyukkel
 * egyutt, `pdftotext -bbox-layout`), ES ha van tesseract, minden oldal
 * kepenek szovegfelismerese is (a szkennelt oldal, illetve a szoveges oldalba
 * agyazott kep szovege miatt). A talalatokat a tulajdonos latja es kivalaszthatja,
 * mielott a masolat elkeszul; a nevek listajat o (vagy az Agent) bovitheti.
 *
 * Elkeszulte utan a masolatot GEPPEL ellenorizzuk: a kitakart szovegek egyike
 * sem olvashato ki belole. Ha megis, a masolat nem marad meg.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { which, ocrLanguages } from './life-inbox-systools.js'
import { sha256OfFile, TEXT_LAYER_MIN_CHARS, meaningfulChars } from './workbench-docread.js'

/** Ekkora felbontasban keszul a masolat (pont/hüvelyk). 200: olvashato, nem tul nagy fajl. */
export const REDACT_DPI = 200
/** Ennyi oldalnal hosszabb iratot nem takarunk ki: a feldolgozas percekig tartana, es felig kitakart masolat nem lehet. */
export const REDACT_MAX_PAGES = 300
const TOOL_TIMEOUT_MS = 5 * 60_000
/** A fekete terulet ennyi keppontttal nagyobb a szonal (az ekezet, a descender se loghasson ki). */
const PAD_PX = 3

export type RedactCategory = 'name' | 'birth_date' | 'address' | 'account' | 'id_number' | 'email' | 'phone' | 'custom'

export interface RedactWord { text: string; x0: number; y0: number; x1: number; y1: number; line: number }
export interface PageWords { page: number; width: number; height: number; text_layer: boolean; ocr: boolean; words: RedactWord[] }

export interface RedactFinding {
  /** `oldal:elso-utolso` szoindex; a kivalasztas ezzel hivatkozik ra. */
  id: string
  page: number
  category: RedactCategory
  text: string
}

export interface RedactScan {
  pages: number
  findings: RedactFinding[]
  /** Oldalak, amelyeken egy szot sem tudtunk kiolvasni (pl. nincs szovegfelismero es az oldal szkennelt). */
  unreadable_pages: number[]
  ocr: boolean
}

export type RedactOutcome =
  | { ok: true; abs: string; name: string; redacted: number; pages: number; searchable: boolean; unreadable_pages: number[] }
  | { ok: false; code: 'not_pdf' | 'not_installed' | 'too_many_pages' | 'nothing_selected' | 'verify_failed' | 'failed'; detail: string }

// ---------------------------------------------------------------------------
// Kulso programok
// ---------------------------------------------------------------------------

function runAsync(bin: string, args: string[], timeout = TOOL_TIMEOUT_MS): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const exe = which(bin)
  if (!exe) return Promise.resolve({ ok: false, error: `${bin} is not installed` })
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: `${bin}: ${(stderr || err.message || '').toString().trim().slice(0, 300)}` })
      else resolve({ ok: true, out: stdout })
    })
  })
}

/** Kitakarni csak Popplerrel lehet (oldalkep + szovegreteg); a szovegfelismero opcionalis. */
export function redactAvailable(): boolean {
  return !!which('pdftoppm') && !!which('pdftotext') && !!which('pdfinfo')
}

function ocrReady(): boolean {
  return !!which('tesseract') && !!ocrLanguages()
}

/** A masolat neve: `level.pdf` -> `level (kitakart).pdf` (a felulet nyelve szerint). */
export function redactedName(name: string, lang: 'hu' | 'en'): string {
  const base = name.replace(/\.pdf$/i, '')
  return `${base} (${lang === 'en' ? 'redacted' : 'kitakart'}).pdf`
}

// ---------------------------------------------------------------------------
// Szavak es helyuk
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
}

/** `pdftotext -bbox-layout` kimenetebol a szavak, keppontban (REDACT_DPI), sorszammal. */
export function parseBboxLayout(xhtml: string, dpi = REDACT_DPI): { width: number; height: number; words: RedactWord[] } {
  const k = dpi / 72
  const pm = /<page width="([\d.]+)" height="([\d.]+)"/.exec(xhtml)
  const words: RedactWord[] = []
  let line = 0
  for (const lm of xhtml.matchAll(/<line\b[^>]*>([\s\S]*?)<\/line>/g)) {
    for (const wm of lm[1].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/word>/g)) {
      const text = decodeEntities(wm[5]).trim()
      if (!text) continue
      words.push({ text, x0: Number(wm[1]) * k, y0: Number(wm[2]) * k, x1: Number(wm[3]) * k, y1: Number(wm[4]) * k, line })
    }
    line++
  }
  return { width: pm ? Number(pm[1]) * k : 0, height: pm ? Number(pm[2]) * k : 0, words }
}

/** A tesseract TSV szavai (5. szint), keppontban; a sorkulcs blokk+bekezdes+sor. */
export function parseTesseractTsv(tsv: string, lineOffset: number): RedactWord[] {
  const out: RedactWord[] = []
  const lines = new Map<string, number>()
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const c = row.split('\t')
    if (c.length < 12 || c[0] !== '5') continue
    const text = c.slice(11).join('\t').trim()
    if (!text) continue
    const key = `${c[2]}.${c[3]}.${c[4]}`
    if (!lines.has(key)) lines.set(key, lineOffset + lines.size)
    const left = Number(c[6]), top = Number(c[7]), w = Number(c[8]), h = Number(c[9])
    out.push({ text, x0: left, y0: top, x1: left + w, y1: top + h, line: lines.get(key)! })
  }
  return out
}

function overlapRatio(a: RedactWord, b: RedactWord): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0))
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))
  const area = Math.max(1, (a.x1 - a.x0) * (a.y1 - a.y0))
  return (ix * iy) / area
}

/**
 * A szovegreteg szavaihoz a felismeres azon szavai jonnek hozza, amelyek nem
 * fedik a szovegreteg egy szavat sem (azaz kepben allo szoveg). Szkennelt
 * oldalon ez az osszes felismert szo.
 */
export function mergeWords(layer: RedactWord[], ocr: RedactWord[]): RedactWord[] {
  const extra = ocr.filter((o) => !layer.some((l) => overlapRatio(o, l) > 0.3 || overlapRatio(l, o) > 0.3))
  return [...layer, ...extra]
}

/** P6 PPM fejlec: szelesseg, magassag, az adatok kezdete. */
export function ppmHeader(buf: Buffer): { width: number; height: number; offset: number } | null {
  const m = /^P6\s+(?:#[^\n]*\n\s*)*(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 64).toString('latin1'))
  if (!m || Number(m[3]) !== 255) return null
  return { width: Number(m[1]), height: Number(m[2]), offset: m[0].length }
}

/**
 * Egy talalat szavai soronkent EGY savva: a szavak kozotti res ne arulja el,
 * hany szobol es milyen hosszu szavakbol allt a kitakart szoveg.
 */
export function lineBars(words: RedactWord[]): { x0: number; y0: number; x1: number; y1: number }[] {
  const byLine = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
  for (const w of words) {
    const cur = byLine.get(w.line)
    if (!cur) byLine.set(w.line, { x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 })
    else Object.assign(cur, { x0: Math.min(cur.x0, w.x0), y0: Math.min(cur.y0, w.y0), x1: Math.max(cur.x1, w.x1), y1: Math.max(cur.y1, w.y1) })
  }
  return [...byLine.values()]
}

/** A dobozok kepponjai feketek lesznek (a kep adataiban, nem ratett retegkent). */
export function blackOut(buf: Buffer, boxes: { x0: number; y0: number; x1: number; y1: number }[]): void {
  const h = ppmHeader(buf)
  if (!h) throw new Error('not a P6 PPM image')
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x0) - PAD_PX), x1 = Math.min(h.width, Math.ceil(b.x1) + PAD_PX)
    const y0 = Math.max(0, Math.floor(b.y0) - PAD_PX), y1 = Math.min(h.height, Math.ceil(b.y1) + PAD_PX)
    if (x1 <= x0 || y1 <= y0) continue
    for (let y = y0; y < y1; y++) {
      const start = h.offset + (y * h.width + x0) * 3
      buf.fill(0, start, start + (x1 - x0) * 3)
    }
  }
}

// ---------------------------------------------------------------------------
// Mit takarunk ki
// ---------------------------------------------------------------------------

/** Kisbetu, ekezet nelkul -- a kereseshez es az ellenorzeshez. */
export function foldText(s: string): string {
  return String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

const L = '\\p{L}'
const UP = '\\p{Lu}'
const LOW = "[\\p{Ll}'’-]"
const NAME = `(?:(?:dr|Dr|DR|Prof|prof|ifj|id|özv)\\.\\s+)?${UP}${LOW}+\\.?(?:[ \\t-]+${UP}${LOW}+\\.?){1,3}`
const DATE = [
  `\\d{4}\\.\\s*(?:\\d{1,2}\\.|${L}{3,}\\.?)\\s*\\d{1,2}\\.?`, // 1978. március 4. / 1978.03.04.
  `\\d{1,2}\\.\\s*(?:\\d{1,2}\\.|${L}{3,}\\.?)\\s*\\d{4}`, // 04.03.1978 / 4. März 1978
  `\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}`,
  `\\d{4}-\\d{2}-\\d{2}`,
  `${L}{3,}\\.?\\s+\\d{1,2},?\\s+\\d{4}`, // March 4, 1978
].join('|')

interface Detector { category: RedactCategory; re: RegExp; group?: number }

const DETECTORS: Detector[] = [
  { category: 'email', re: /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu },
  { category: 'account', re: /\b[A-Z]{2}\d{2}(?:[ \n]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?(?![\p{L}\p{N}-])/gu },
  { category: 'account', re: /\b\d{8}[- ]\d{8}(?:[- ]\d{8})?\b/g },
  { category: 'phone', re: /(?:\+\d{1,3}[ /-]?(?:\(0\))?|\b0036[ /-]?|\b06[ /-]?)\(?\d{1,3}\)?[ /-]?\d{3}[ /-]?\d{3,4}\b/g },
  // Szuletesi datum: csak a kulcsszo utan allo datum (a tobbi datum ugyiratban kell).
  {
    category: 'birth_date',
    re: new RegExp(`(?:szül(?:\\.|etett|etési\\s+(?:idő|ideje|dátum|dátuma))|geb(?:\\.|oren)|geburtsdatum|date\\s+of\\s+birth|d\\.?o\\.?b\\.?|born)[^\\d\\n]{0,25}?(${DATE})`, 'giu'),
    group: 1,
  },
  // Azonositok kulcsszo utan: adoazonosito, TAJ, szemelyi, utlevel, Steuer-ID, SSN...
  {
    category: 'id_number',
    re: /(?:adóazonosító(?:\s+jele?)?|adószám|taj(?:\s*-?\s*szám)?|személyi\s+igazolvány(?:\s*száma?)?|szig\.?\s*sz(?:ám)?\.?|útlevél(?:\s*száma?)?|személyi\s+szám|steuer-?id(?:entifikationsnummer)?|steuernummer|sozialversicherungsnummer|personalausweis(?:nummer)?|reisepass(?:nummer)?|ssn|social\s+security\s+(?:number|no\.?)|passport\s+(?:number|no\.?))\s*:?\s*([A-Z]{0,3}[ -]?\d[\dA-Z /-]{2,22}\d[A-Z]{0,2})/giu,
    group: 1,
  },
  // Magyar cim: iranyitoszam, telepules, kozterulet, hazszam (emelet, ajto).
  {
    category: 'address',
    re: new RegExp(`\\b\\d{4}[ \\t]+${UP}${L}+(?:[ -]${UP}${L}+)?,?[ \\t\\n]+(?:[${L}.-]+[ \\t\\n]+){1,4}?(?:utca|u\\.|út|útja|tér|tere|körút|krt\\.|köz|sor|fasor|sétány|dűlő|lakótelep|ltp\\.|rakpart|liget|udvar|park)[ \\t]*\\d+[\\p{L}\\d/.-]*(?:[ \\t]*\\d+\\.?[ \\t]*(?:em\\.|emelet)(?:[ \\t]*\\d+\\.?(?:[ \\t]*ajtó)?)?)?`, 'gu'),
  },
  // Nemet cim: utca hazszammal, utana esetleg iranyitoszam + varos.
  {
    category: 'address',
    re: new RegExp(`\\b(?:${UP}${L}*(?:straße|strasse|str\\.|weg|platz|allee|gasse|ring|damm|ufer|chaussee)|${UP}${L}+[ \\t]+(?:Straße|Strasse|Str\\.|Weg|Platz|Allee|Gasse|Ring|Damm))[ \\t]+\\d+[a-z]?(?:,?[ \\t\\n]+\\d{5}[ \\t]+${UP}${L}+)?`, 'gu'),
  },
  // Angol/amerikai cim.
  {
    category: 'address',
    re: new RegExp(`\\b\\d{1,5}[ \\t]+(?:${UP}${L}+[ \\t]+){1,3}(?:Street|St\\.|Avenue|Ave\\.|Road|Rd\\.|Boulevard|Blvd\\.|Lane|Ln\\.|Drive|Dr\\.|Court|Ct\\.|Place|Pl\\.)(?:,?[ \\t]+(?:Apt\\.?|Suite|Unit)[ \\t]*[\\w-]+)?`, 'gu'),
  },
  // Cim kulcsszo utan: a sor vegeig (legfeljebb 80 betu, zarojelig/pontosvesszoig).
  {
    category: 'address',
    re: /(?:lakcím|lakóhely|tartózkodási\s+hely|székhely|címe|cím|anschrift|wohnort|wohnhaft\s+in|address|residing\s+at)\s*:[ \t]*([^\n;)]{0,60}?\d[^\n;)]{0,60}?)(?=[;)\n]|$|,\s*(?:szül|tel|e-?mail|adó|taj|geb|phone))/giu,
    group: 1,
  },
  // Nev kulcsszo utan (kettosponttal): ebbol a talalatbol az irat tobbi
  // elofordulasa is kitakarodik (ragozva is), lasd collectTerms.
  {
    category: 'name',
    re: new RegExp(`(?:név|neve|születési\\s+név|anyja\\s+neve|felperes|alperes|kérelmező|kérelmezett|terhelt|vádlott|sértett|tanú|name|vorname|nachname|geburtsname|kläger(?:in)?|beklagte[rn]?|antragsteller(?:in)?|antragsgegner(?:in)?|zeuge|zeugin|plaintiff|defendant|claimant|respondent|witness)\\s*:[ \\t]*(${NAME})`, 'giu'),
    group: 1,
  },
]

interface Span { start: number; end: number; category: RedactCategory }

/** Egy oldal szovege a szavakbol: soronkent szokozzel, a sorok kozott ujsor; es minden betu melyik szohoz tartozik. */
export function pageText(words: RedactWord[]): { text: string; owner: number[] } {
  let text = ''
  const owner: number[] = []
  words.forEach((w, i) => {
    if (i > 0) {
      text += words[i - 1].line === w.line ? ' ' : '\n'
      owner.push(-1)
    }
    text += w.text
    for (let k = 0; k < w.text.length; k++) owner.push(i)
  })
  return { text, owner }
}

/** A rogzitett mintak talalatai egy oldal szovegeben. */
export function detectSpans(text: string): Span[] {
  const out: Span[] = []
  for (const d of DETECTORS) {
    d.re.lastIndex = 0
    for (const m of text.matchAll(d.re)) {
      const g = d.group ? m[d.group] : m[0]
      if (!g) continue
      const start = (m.index ?? 0) + (d.group ? m[0].indexOf(g) : 0)
      const val = g.replace(/[\s,.;:]+$/u, '')
      if (d.category === 'id_number' && (val.match(/\d/g) || []).length < 4) continue
      out.push({ start, end: start + val.length, category: d.category })
    }
  }
  return out
}

/** Egy szo osszevetheto alakja: kisbetu, ekezet nelkul, a szelen allo irasjel nelkul. */
function wordKey(s: string): string {
  return foldText(s).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * Ekezet nelkuli rag egy nev utan: -ne (Kovácsné), utana esetragok, birtokos,
 * tobbes szam (-ek, Kovácsék), a nemet/angol birtokos -s. Barmely mas folytatas
 * (Kovácsházai, Nagyvárad) mar masik szo, az nem takarodik ki.
 */
const NAME_SUFFIX = /^(?:ne)?(?:[aeiou]?(?:nak|nek|nal|nel|hoz|hez|tol|rol|ra|re|ba|be|ban|ben|bol|ig|ert|kent|val|vel|ul|ek|ei|ok|ak|t|k|n|s|i|e))?$/u

/**
 * Egy nev (vagy barmely megadott kifejezes) minden elofordulasa a szavak kozott.
 * A magyar ragozas miatt a kifejezes szava a szo eleje is lehet, ha utana rag
 * all (Kovács -> Kovácsnak, Kovácsnéval, Jánosnak; lasd NAME_SUFFIX); rovid
 * (3 betunel rovidebb) szonal csak a pontos egyezes szamit.
 */
export function findTermWords(words: RedactWord[], term: string): Array<[number, number]> {
  const parts = term.split(/\s+/).map(wordKey).filter(Boolean)
  if (!parts.length) return []
  const keys = words.map((w) => wordKey(w.text))
  const same = (k: string, p: string): boolean => k === p || (p.length >= 3 && k.startsWith(p) && NAME_SUFFIX.test(k.slice(p.length)))
  const out: Array<[number, number]> = []
  for (let i = 0; i + parts.length <= keys.length; i++) {
    let ok = true
    for (let j = 0; j < parts.length && ok; j++) ok = same(keys[i + j], parts[j])
    if (ok) out.push([i, i + parts.length - 1])
  }
  return out
}

/**
 * Egy oldal talalatai szo-tartomanyokkent. `terms`: a tulajdonos vagy az Agent
 * altal megadott nevek/kifejezesek; `names`: a mintakbol (pl. „Felperes: X Y”)
 * az egesz iratban talalt nevek, ezeket minden oldalon keressuk.
 */
export function pageFindings(p: PageWords, terms: string[], names: string[]): RedactFinding[] {
  const { text, owner } = pageText(p.words)
  const ranges: Array<{ a: number; b: number; category: RedactCategory }> = []
  for (const s of detectSpans(text)) {
    const idx = owner.slice(s.start, s.end).filter((x) => x >= 0)
    if (idx.length) ranges.push({ a: Math.min(...idx), b: Math.max(...idx), category: s.category })
  }
  for (const n of names) for (const [a, b] of findTermWords(p.words, n)) ranges.push({ a, b, category: 'name' })
  for (const t of terms) for (const [a, b] of findTermWords(p.words, t)) ranges.push({ a, b, category: 'custom' })
  // Atfedo tartomanyok egybe; a kategoria az elsoe (a minta pontosabb, mint a megadott kifejezes).
  ranges.sort((x, y) => x.a - y.a || y.b - x.b)
  const merged: typeof ranges = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.a <= last.b) { last.b = Math.max(last.b, r.b); continue }
    merged.push({ ...r })
  }
  return merged.map((r) => ({
    id: `${p.page}:${r.a}-${r.b}`,
    page: p.page,
    category: r.category,
    text: p.words.slice(r.a, r.b + 1).map((w) => w.text).join(' ').slice(0, 200),
  }))
}

/** A „Felperes: Kovács János” jellegu talalatokbol a nevek (egyszer), hogy mashol is kitakarodjanak. */
export function collectNames(pages: PageWords[]): string[] {
  const seen = new Map<string, string>()
  for (const p of pages) {
    const { text } = pageText(p.words)
    for (const s of detectSpans(text)) {
      if (s.category !== 'name') continue
      const n = text.slice(s.start, s.end).replace(/\s+/g, ' ').replace(/^(?:dr|prof|ifj|id|özv)\.\s+/i, '').trim()
      if (n.split(' ').length >= 2 && !seen.has(foldText(n))) seen.set(foldText(n), n)
    }
  }
  return [...seen.values()]
}

export function cleanTerms(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n|;/) : []
  const out: string[] = []
  for (const x of list) {
    const t = String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
    if (t.length >= 2 && !out.some((o) => foldText(o) === foldText(t))) out.push(t)
    if (out.length >= 100) break
  }
  return out
}

// ---------------------------------------------------------------------------
// Beolvasas (gyorsitotarral: a vizsgalat es a masolat ugyanazt hasznalja)
// ---------------------------------------------------------------------------

interface ReadDoc { pages: PageWords[]; ocr: boolean }
const readCache = new Map<string, ReadDoc>()
const readJobs = new Map<string, Promise<ReadDoc>>()
const CACHE_DOCS = 4

async function pageCount(pdf: string): Promise<number> {
  const r = await runAsync('pdfinfo', [pdf])
  if (!r.ok) throw new Error(r.error)
  const m = /^Pages:\s*(\d+)/m.exec(r.out)
  const n = m ? Number(m[1]) : 0
  if (n <= 0) throw new Error('pdfinfo: the PDF has no pages')
  return n
}

async function renderPage(pdf: string, page: number, prefix: string): Promise<string> {
  const r = await runAsync('pdftoppm', ['-r', String(REDACT_DPI), '-f', String(page), '-l', String(page), '-singlefile', pdf, prefix])
  if (!r.ok) throw new Error(r.error)
  const file = prefix + '.ppm'
  if (!existsSync(file)) throw new Error('pdftoppm produced no page image')
  return file
}

async function readPdfWords(pdf: string, work: string): Promise<ReadDoc> {
  const total = await pageCount(pdf)
  if (total > REDACT_MAX_PAGES) throw Object.assign(new Error(`the PDF has ${total} pages; at most ${REDACT_MAX_PAGES} can be redacted at once`), { code: 'too_many_pages' })
  const ocr = ocrReady()
  const langs = ocr ? ocrLanguages() : ''
  const pages: PageWords[] = []
  for (let p = 1; p <= total; p++) {
    const t = await runAsync('pdftotext', ['-q', '-bbox-layout', '-enc', 'UTF-8', '-f', String(p), '-l', String(p), pdf, '-'])
    if (!t.ok) throw new Error(t.error)
    const layer = parseBboxLayout(t.out)
    const hasLayer = meaningfulChars(layer.words.map((w) => w.text).join(' ')) >= TEXT_LAYER_MIN_CHARS
    let words = layer.words
    let width = layer.width, height = layer.height
    let didOcr = false
    if (ocr) {
      const img = await renderPage(pdf, p, join(work, `scan-${p}`))
      const h = ppmHeader(readFileSync(img))
      if (h) { width = h.width; height = h.height }
      const o = await runAsync('tesseract', [img, 'stdout', '--dpi', String(REDACT_DPI), '-l', langs, 'tsv'])
      rmSync(img, { force: true })
      if (!o.ok) throw new Error(o.error)
      const lastLine = words.length ? words[words.length - 1].line + 1 : 0
      words = mergeWords(words, parseTesseractTsv(o.out, lastLine))
      didOcr = true
    }
    pages.push({ page: p, width, height, text_layer: hasLayer, ocr: didOcr, words })
  }
  return { pages, ocr }
}

async function readDoc(abs: string): Promise<{ sha: string; doc: ReadDoc }> {
  const sha = sha256OfFile(abs)
  const hit = readCache.get(sha)
  if (hit) return { sha, doc: hit }
  let job = readJobs.get(sha)
  if (!job) {
    const work = mkdtempSync(join(tmpdir(), 'marveen-redact-'))
    job = readPdfWords(abs, work).finally(() => {
      readJobs.delete(sha)
      try { rmSync(work, { recursive: true, force: true }) } catch { /* mar nincs meg */ }
    })
    readJobs.set(sha, job)
  }
  const doc = await job
  readCache.set(sha, doc)
  while (readCache.size > CACHE_DOCS) readCache.delete(readCache.keys().next().value as string)
  return { sha, doc }
}

/** Csak teszthez: a gyorsitotar urites. */
export function resetRedactCache(): void { readCache.clear() }

function failOf(e: unknown): RedactOutcome {
  const err = e as { code?: string; message?: string }
  if (err && err.code === 'too_many_pages') return { ok: false, code: 'too_many_pages', detail: String(err.message || '') }
  return { ok: false, code: 'failed', detail: String((err && err.message) || e).slice(0, 300) }
}

/** Mi takarodna ki: a talalatok oldalankent, a tulajdonos ebbol valaszt. */
export async function scanForRedaction(abs: string, rawTerms: unknown): Promise<{ ok: true; data: RedactScan } | Exclude<RedactOutcome, { ok: true }>> {
  if (!/\.pdf$/i.test(abs)) return { ok: false, code: 'not_pdf', detail: 'only a PDF can be redacted' }
  if (!redactAvailable()) return { ok: false, code: 'not_installed', detail: 'Poppler (pdftoppm, pdftotext) is not installed on this machine' }
  try {
    const { doc } = await readDoc(abs)
    const terms = cleanTerms(rawTerms)
    const names = collectNames(doc.pages)
    const findings = doc.pages.flatMap((p) => pageFindings(p, terms, names))
    const unreadable = doc.pages.filter((p) => meaningfulChars(p.words.map((w) => w.text).join(' ')) === 0).map((p) => p.page)
    return { ok: true, data: { pages: doc.pages.length, findings, unreadable_pages: unreadable, ocr: doc.ocr } }
  } catch (e) {
    return failOf(e) as Exclude<RedactOutcome, { ok: true }>
  }
}

// ---------------------------------------------------------------------------
// A masolat
// ---------------------------------------------------------------------------

/** Kepekbol allo PDF, minden mas nelkul (ha nincs tesseract). A kepek nyers RGB, Flate-tel. */
export function imagePdf(pages: { ppm: Buffer; dpi: number }[]): Buffer {
  const objs: Buffer[] = []
  const add = (b: Buffer | string): number => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')); return objs.length }
  const catalog = add('')
  const pagesObj = add('')
  const kids: number[] = []
  for (const p of pages) {
    const h = ppmHeader(p.ppm)
    if (!h) throw new Error('not a P6 PPM image')
    const data = deflateSync(p.ppm.subarray(h.offset, h.offset + h.width * h.height * 3))
    const img = add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${h.width} /Height ${h.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'),
      data, Buffer.from('\nendstream', 'latin1'),
    ]))
    const w = (h.width * 72 / p.dpi).toFixed(2), hh = (h.height * 72 / p.dpi).toFixed(2)
    const content = `q ${w} 0 0 ${hh} 0 0 cm /Im0 Do Q`
    const cs = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${hh}] /Resources << /XObject << /Im0 ${img} 0 R >> >> /Contents ${cs} 0 R >>`))
  }
  objs[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesObj} 0 R >>`, 'latin1')
  objs[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`, 'latin1')
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')]
  const offsets: number[] = []
  let pos = parts[0].length
  objs.forEach((o, i) => {
    offsets.push(pos)
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')])
    parts.push(chunk)
    pos += chunk.length
  })
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'))
  return Buffer.concat(parts)
}

/** Hanyszor fordul elo a kifejezes (ekezet, kisbetu, szokoz nelkul) a szovegben. */
export function countFolded(hay: string, needle: string): number {
  const h = foldText(hay).replace(/[^\p{L}\p{N}]/gu, '')
  const n = foldText(needle).replace(/[^\p{L}\p{N}]/gu, '')
  if (n.length < 4) return 0
  let c = 0
  for (let i = h.indexOf(n); i >= 0; i = h.indexOf(n, i + 1)) c++
  return c
}

const redactJobs = new Map<string, Promise<RedactOutcome>>()

/**
 * A kitakart masolat. `skip`: a talalatok azonositoi, amelyeket a tulajdonos
 * NEM akar kitakarni (alapbol minden talalat kitakarodik).
 */
export function makeRedactedCopy(abs: string, destAbs: string, opts: { terms?: unknown; skip?: unknown }): Promise<RedactOutcome> {
  const running = redactJobs.get(destAbs)
  if (running) return running
  const job = (async (): Promise<RedactOutcome> => {
    const scan = await scanForRedaction(abs, opts.terms)
    if (!scan.ok) return scan
    const skip = new Set((Array.isArray(opts.skip) ? opts.skip : []).map((x) => String(x)))
    const chosen = scan.data.findings.filter((f) => !skip.has(f.id))
    if (!chosen.length) return { ok: false, code: 'nothing_selected', detail: 'nothing was selected for redaction' }
    let doc: ReadDoc
    try { doc = (await readDoc(abs)).doc } catch (e) { return failOf(e) }
    const work = mkdtempSync(join(tmpdir(), 'marveen-redact-out-'))
    const tmpOut = join(work, 'out.pdf')
    try {
      const images: string[] = []
      for (const p of doc.pages) {
        const img = await renderPage(abs, p.page, join(work, `p-${String(p.page).padStart(4, '0')}`))
        const buf = readFileSync(img)
        const boxes = chosen.filter((f) => f.page === p.page).flatMap((f) => {
          const [a, b] = f.id.split(':')[1].split('-').map(Number)
          return lineBars(p.words.slice(a, b + 1))
        })
        blackOut(buf, boxes)
        writeFileSync(img, buf)
        images.push(img)
      }
      const searchable = ocrReady()
      if (searchable) {
        const list = join(work, 'pages.txt')
        writeFileSync(list, images.join('\n') + '\n')
        const r = await runAsync('tesseract', [list, join(work, 'out'), '--dpi', String(REDACT_DPI), '-l', ocrLanguages(), '-c', 'document_title=', 'pdf'], 30 * 60_000)
        if (!r.ok) throw new Error(r.error)
      } else {
        writeFileSync(tmpOut, imagePdf(images.map((f) => ({ ppm: readFileSync(f), dpi: REDACT_DPI }))))
      }
      if (!existsSync(tmpOut)) throw new Error('the redacted PDF was not written')
      // Gepi ellenorzes: a kitakart szovegek egyike sem olvashato ki a masolatbol
      // tobbszor, mint ahanyszor kitakaratlanul maradt az eredetiben.
      const check = await runAsync('pdftotext', ['-q', '-enc', 'UTF-8', tmpOut, '-'])
      if (!check.ok) throw new Error(check.error)
      const kept = doc.pages.map((p) => {
        const hidden = new Set<number>()
        for (const f of chosen) {
          if (f.page !== p.page) continue
          const [a, b] = f.id.split(':')[1].split('-').map(Number)
          for (let i = a; i <= b; i++) hidden.add(i)
        }
        return p.words.filter((_, i) => !hidden.has(i)).map((w) => w.text).join(' ')
      }).join('\n')
      const leaks = [...new Set(chosen.map((f) => f.text))].filter((t) => countFolded(check.out, t) > countFolded(kept, t))
      if (leaks.length) return { ok: false, code: 'verify_failed', detail: `${leaks.length} redacted text(s) could still be read from the copy; the copy was not kept` }
      // Masik meghajtora is (a projektmappa lehet Windows-meghajton): masolas, nem atnevezes.
      copyFileSync(tmpOut, destAbs)
      return { ok: true, abs: destAbs, name: basename(destAbs), redacted: chosen.length, pages: doc.pages.length, searchable, unreadable_pages: scan.data.unreadable_pages }
    } catch (e) {
      return failOf(e)
    } finally {
      try { rmSync(work, { recursive: true, force: true }) } catch { /* mar nincs meg */ }
    }
  })()
  const done = job.finally(() => { redactJobs.delete(destAbs) })
  redactJobs.set(destAbs, done)
  return done
}
