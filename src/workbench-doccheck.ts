/**
 * KOVETKEZETESSEG-ELLENORZES (kanban #441, v4 spec 1/A, K-1.19).
 *
 * Veglegesites elott a Marveen GEPI UTON (nem AI-val, hanem szabalyokkal)
 * atnezi a dokumentumot:
 *   - nevek: ugyanaz a nev eltero irasmoddal ("Korpás László" / "Korpas
 *     Laszlo", "Kovács Anna" / "Kovács Ana"); a magyar ragozas ("Annát",
 *     "Lászlóval") nem elteres;
 *   - ugyszam: ket nagyon hasonlo, de nem azonos ugyszam (elgepeles);
 *   - osszegek: egy tablazat "Osszesen" sora egyezik-e a folotte allo sorok
 *     osszegevel;
 *   - datumok: nem letezo datum (februar 30.), es a datum-oszlopos tablazat
 *     sorrendje;
 *   - cimek: ugyanaz az utca + hazszam mas iranyitoszammal vagy varossal;
 *   - forrasok: egy allitas datuma / osszege egyezik-e az idezett forras
 *     datumaval / osszegevel (magyar, nemet, angol irasmodban is).
 *
 * Minden talalat JELZES, nem itelet: a tulajdonos egyenkent "szandekos"-nak
 * jelolheti (a profi korrektura-eszkozok "ignore"-ja), es akkor nem allitja
 * meg a veglegesitest. Az agent nem jelolheti el -- javitani tudja a szoveget.
 */
import { createHash } from 'node:crypto'
import { getDb } from './db.js'
import { ensureDocModelTables } from './workbench-docmodel.js'

// ---------------------------------------------------------------------------
// Datumok
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  január: 1, február: 2, március: 3, április: 4, május: 5, június: 6, július: 7, augusztus: 8, szeptember: 9, október: 10, november: 11, december: 12,
  januar: 1, jänner: 1, februar: 2, märz: 3, april: 4, mai: 5, juni: 6, juli: 7, oktober: 10, dezember: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, august: 8, october: 10,
}
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')

export interface FoundDate { iso: string; raw: string; valid: boolean; at: number }

function daysIn(y: number, m: number): number {
  return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0
}

function mk(y: number, m: number, d: number, raw: string, at: number): FoundDate | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  return { iso: `${y}-${p(m)}-${p(d)}`, raw, valid: d <= daysIn(y, m), at }
}

/** Datumok a szovegben: magyar, nemet, angol es ISO irasmod. A kettos ertelmu (03/04/2027) kimarad. */
export function findDates(text: string): FoundDate[] {
  const t = String(text || '')
  const out: FoundDate[] = []
  const taken: [number, number][] = []
  const add = (re: RegExp, f: (m: RegExpMatchArray) => FoundDate | null): void => {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0
      const end = at + m[0].length
      if (taken.some(([a, b]) => at < b && end > a)) continue
      const d = f(m)
      if (d) { out.push(d); taken.push([at, end]) }
    }
  }
  const mon = (s: string): number => MONTHS[s.toLowerCase()] ?? 0
  add(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => mk(+m[1]!, +m[2]!, +m[3]!, m[0], m.index ?? 0))
  add(new RegExp(`\\b(\\d{4})\\.\\s?(${MONTH_RE})\\s?(\\d{1,2})\\b`, 'giu'), (m) => mk(+m[1]!, mon(m[2]!), +m[3]!, m[0], m.index ?? 0))
  add(/\b(\d{4})\.\s?(\d{1,2})\.\s?(\d{1,2})\b/g, (m) => mk(+m[1]!, +m[2]!, +m[3]!, m[0], m.index ?? 0))
  add(new RegExp(`\\b(\\d{1,2})\\.?\\s(${MONTH_RE})\\s(\\d{4})\\b`, 'giu'), (m) => mk(+m[3]!, mon(m[2]!), +m[1]!, m[0], m.index ?? 0))
  add(new RegExp(`\\b(${MONTH_RE})\\s(\\d{1,2}),?\\s(\\d{4})\\b`, 'giu'), (m) => mk(+m[3]!, mon(m[1]!), +m[2]!, m[0], m.index ?? 0))
  add(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (m) => mk(+m[3]!, +m[2]!, +m[1]!, m[0], m.index ?? 0))
  return out.sort((a, b) => a.at - b.at)
}

// ---------------------------------------------------------------------------
// Osszegek
// ---------------------------------------------------------------------------

const CUR: Record<string, string> = { ft: 'HUF', huf: 'HUF', forint: 'HUF', eur: 'EUR', '€': 'EUR', 'euró': 'EUR', euro: 'EUR', usd: 'USD', '$': 'USD', chf: 'CHF' }

/** Egy szam szovegbol (1 200 000 / 1.200.000,50 / 1,200,000.50 / 1200,5) szazadokban. */
export function parseAmount(raw: string): number | null {
  const s = String(raw || '').replace(/[\s\u00a0\u202f]/g, '').replace(/,-$/, '')
  if (!/^\d[\d.,]*$/.test(s)) return null
  let intPart = s
  let dec = ''
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) { [intPart, dec = ''] = s.split(','); intPart = (intPart as string).replace(/\./g, '') }
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) { [intPart, dec = ''] = s.split('.'); intPart = (intPart as string).replace(/,/g, '') }
  else if (/^\d+,\d{1,2}$/.test(s)) [intPart, dec = ''] = s.split(',')
  else if (/^\d+\.\d{1,2}$/.test(s)) [intPart, dec = ''] = s.split('.')
  else if (/^\d+$/.test(s)) intPart = s
  else return null
  const v = Number(intPart) * 100 + Number((dec + '00').slice(0, 2))
  return Number.isFinite(v) ? v : null
}

export interface FoundAmount { cents: number; currency: string | null; raw: string }

// A szam nem kezdodhet egy masik szam kozepen: a "3. Januar 2026 900 Euro"
// nem "026 900 Euro", hanem 900 euro (a 2026 ezres tagolasnak nem ervenyes).
const NUM = '(?<!\\d)(?:\\d{1,3}(?:[ .,\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)'
// A magyar ragos alak is osszeg: "900 eurót", "100 000 forintot", "forinttal".
const HU_CASE = '(?:o?t|ért|ból|ba|ban|ra|ról|tól|nál|hoz|t?al|val|nak|ig|o?s|ként)'

/** Penzosszegek (penznemmel elol vagy hatul). Penznem nelkuli szam nem osszeg. */
export function findAmounts(text: string): FoundAmount[] {
  const out: FoundAmount[] = []
  const re = new RegExp(`(?:(€|\\$|EUR|USD|HUF|CHF)\\s?(${NUM}))|(?:(${NUM})(?:,-)?\\s?(?:(Ft|HUF|EUR|€|USD|CHF)|(forint|euró|euro)${HU_CASE}?)(?![\\p{L}]))`, 'giu')
  for (const m of String(text || '').matchAll(re)) {
    const num = m[2] ?? m[3] ?? ''
    const cur = (m[1] ?? m[4] ?? m[5] ?? '').toLowerCase()
    const cents = parseAmount(num)
    if (cents !== null) out.push({ cents, currency: CUR[cur] ?? null, raw: m[0].trim() })
  }
  return out
}

function fmtCents(c: number): string {
  const whole = Math.floor(c / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return c % 100 ? `${whole},${String(c % 100).padStart(2, '0')}` : whole
}

// ---------------------------------------------------------------------------
// Nevek, ugyszamok, cimek
// ---------------------------------------------------------------------------

export function fold(s: string): string {
  return foldKeep(s).replace(/ß/g, 'ss')
}

/** Ekezet nelkul, kisbetuvel, a hossz megtartasaval (NFC bemenetre betu-betu megfeleltetes). */
function foldKeep(s: string): string {
  return s.normalize('NFC').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] as number
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number
      prev[j] = Math.min(up + 1, (prev[j - 1] as number) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = up
    }
  }
  return prev[b.length] as number
}

const UP = 'A-ZÁÉÍÓÖŐÚÜŰÄ'
const LOW = 'a-záéíóöőúüűäß'
/** Nem nev-resz, ha ezzel kezdodik (nevelo, megszolitas, intezmeny-szo): a szo lemarad a jelolt elejerol. */
const NOT_NAME = new Set(['a', 'az', 'egy', 'the', 'der', 'die', 'das', 'ein', 'eine', 'tisztelt', 'sehr', 'dear', 'mellekletek', 'anlage', 'exhibit', 'kerem', 'bitte',
  'herr', 'herrn', 'frau', 'mr', 'mrs', 'ms', 'miss', 'sir'])
const WORD_RE = `[${UP}][${LOW}]+(?:-[${UP}][${LOW}]+)?`
const NAME_RE = new RegExp(`(?<![${UP}${LOW}])${WORD_RE}(?: ${WORD_RE}){1,2}(?![${UP}${LOW}])`, 'gu')

/** Mondat (vagy tablazat-cella, felsorolas-elem, idezet) eleje: ott a nagybetu nem jelent nevet. */
function atSentenceStart(text: string, at: number): boolean {
  const line = text.slice(text.lastIndexOf('\n', at - 1) + 1, at)
  if (/^\s*(?:[-*•–]|\d+[.)])?\s*$/.test(line)) return true
  return /(?:[.!?:;|„“"(]\s*)$/.test(line)
}

export interface NameCandidate {
  name: string
  /** Biztosan nev: nem mondat eleji, vagy a mondat eleji szava a szovegben mondat belsejeben is nev-resz. */
  sure: boolean
}

/**
 * Tobbszavas, nagybetus kifejezesek (nevek jeloltjei). A mondat eleji szo
 * nagybetus, mert a mondat eleje: ha a szovegben mondat belsejeben nem
 * nev-resz, a harom szavas jeloltrol lemarad ("Ezért Kovács Anna" -> "Kovács
 * Anna"), a ket szavas pedig csak "bizonytalan" jelolt ("Korpás László" a
 * mondat elejen): az irasmod-elteresben szamit, az egy betus elteresben nem
 * ("Ezért Kovács" / "Azért Kovács" nem ket nev).
 */
export function findNameCandidates(text: string): NameCandidate[] {
  const t = String(text || '')
  const found = [...t.matchAll(NAME_RE)].map((m) => ({ words: m[0].split(' '), initial: atSentenceStart(t, m.index ?? 0) }))
  const inner = new Set(found.filter((f) => !f.initial).flatMap((f) => f.words.map(fold)))
  const out: NameCandidate[] = []
  for (const f of found) {
    let w = f.words
    while (w.length && NOT_NAME.has(fold(w[0] as string))) w = w.slice(1)
    let sure = true
    if (f.initial && w === f.words && !inner.has(fold(w[0] as string))) {
      if (w.length >= 3) w = w.slice(1)
      else sure = false
    }
    if (w.length >= 2) out.push({ name: w.join(' '), sure })
  }
  return out
}

export function findNames(text: string): string[] {
  return findNameCandidates(text).map((c) => c.name)
}

/** Magyar esetragok (ekezet nelkul, a leghosszabb elol). A "Kovács Annát" es a "Kovács Annával" ugyanaz a nev. */
const HU_SUFFIXES = ['kent', 'nak', 'nek', 'val', 'vel', 'ban', 'ben', 'bol', 'rol', 'tol', 'hoz', 'hez', 'nal', 'nel', 'ert', 'kor',
  'ig', 'ba', 'be', 'ra', 're', 'on', 'en', 'ot', 'et', 'at', 'ul', 'e', 't', 'n']

/** A nev ragozatlan alakja (ekezet nelkul): az utolso szorol az esetrag lemarad, ha legalabb 3 betu marad. */
export function nameStem(name: string): string {
  const words = foldKeep(name).split(' ')
  const last = words[words.length - 1] as string
  for (const suf of HU_SUFFIXES) {
    if (last.length - suf.length >= 3 && last.endsWith(suf)) { words[words.length - 1] = last.slice(0, -suf.length); break }
  }
  return words.join(' ')
}

/** Az irasmod a ragozatlan resz szerint (a szovegben allo betukkel, de a to utolso betuje
 *  nelkul -- a magyar ragozas "Anna" -> "Anná-t" azt megnyujtja). */
function spelling(raw: string, stem: string): string {
  return raw.normalize('NFC').toLowerCase().slice(0, Math.max(0, stem.length - 1))
}

/** Ugyszamok: magyar (12.P.20.123/2025/4, Pf.20.456/2025), nemet (2 O 123/25), amerikai (1:23-cv-01234). */
export function findCaseNumbers(text: string): string[] {
  const out: string[] = []
  const res = [
    /(?<![\p{L}\d.])(?:\d{1,3}\.\s?)?[A-ZÁÉÍÓÖŐÚÜŰ][a-záéíóöőúüű]{0,3}\.(?:\s?[IVX]{1,4}\.)?\s?\d{1,5}(?:\.\d{1,5})?\/\d{4}(?:\/\d{1,3})?/gu,
    /\b\d{1,3}\s[A-Z][a-z]{0,2}\s\d{1,5}\/\d{2,4}\b/g,
    /\b\d:\d{2}-[a-z]{2}-\d{3,6}\b/g,
  ]
  for (const re of res) for (const m of String(text || '').matchAll(re)) out.push(m[0].replace(/\s+/g, ' ').trim())
  return out
}

export interface FoundAddress { key: string; place: string; raw: string }

/** Cimek (iranyitoszam + varos + utca + hazszam); a kulcs az utca + hazszam, a hely az iranyitoszam + varos. */
export function findAddresses(text: string): FoundAddress[] {
  const street = `(?:(?:[${UP}${LOW}.-]+\\s){1,3}?(?:utca|út|útja|tér|tere|körút|köz|sor|sétány|u\\.|krt\\.|Straße|Strasse|Str\\.|Weg|Platz|Allee|Gasse|Street|St\\.|Avenue|Ave\\.|Road|Rd\\.)|[${UP}][${LOW}]+(?:straße|strasse|str\\.|weg|platz|allee|gasse|ring|damm))`
  const re = new RegExp(`\\b(\\d{4,5})\\s+([${UP}][${LOW}-]+),?\\s+(${street})\\s*(\\d+[a-zA-Z/]*)`, 'gu')
  return [...String(text || '').matchAll(re)].map((m) => ({
    key: fold(`${(m[3] as string).replace(/\s+/g, ' ')} ${m[4]}`),
    place: fold(`${m[1]} ${m[2]}`),
    raw: m[0],
  }))
}

// ---------------------------------------------------------------------------
// Az ellenorzes
// ---------------------------------------------------------------------------

export type IssueKind =
  | 'name_variant' | 'case_number_variant' | 'amount_sum' | 'date_invalid' | 'date_order'
  | 'address_variant' | 'claim_date_mismatch' | 'claim_amount_mismatch'

export interface ConsistencyIssue {
  key: string
  kind: IssueKind
  /** A jelzett ertekek, nyelvfuggetlenul ("Korpás László", "Korpas Laszlo"). */
  values: string[]
  /** Hol (fejezetcim), ha egy helyhez kotheto. */
  where: string | null
  /** A tulajdonos szandekosnak jelolte (akkor nem allitja meg a veglegesitest). */
  acked: boolean
  acked_at: number | null
  acked_by: string | null
}

interface DocText { section: string; kind: string; text: string }

function issue(kind: IssueKind, values: string[], where: string | null): Omit<ConsistencyIssue, 'acked' | 'acked_at' | 'acked_by'> {
  const key = createHash('sha1').update(kind + '\u0000' + [...values].sort().join('\u0000')).digest('hex').slice(0, 16)
  return { key, kind, values, where }
}

function tableRows(text: string): string[][] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !/^\|?[\s:|-]+\|?$/.test(l))
    .map((l) => l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()))
}

const TOTAL_RE = /^(összesen|mindösszesen|összes|együtt|total|sum|gesamt|summe|insgesamt|gesamtbetrag)\b/i
const SUBTOTAL_RE = /(részösszeg|részösszesen|subtotal|sub-total|zwischensumme|teilsumme)/i

/** Osszesito vagy reszosszeg sor (az elso cella szerint): a sorok osszegeben nem szamit. */
function isTotalRow(r: string[]): boolean {
  const c = (r[0] || '').trim().toLowerCase()
  return TOTAL_RE.test(c) || SUBTOTAL_RE.test(c)
}

/** Egy tablazat-cella osszege; az ures vagy gondolatjeles cella nulla. */
function cellAmount(c: string): number | null {
  const v = stripCur(c)
  return /^[-–—]?$/.test(v) ? 0 : parseAmount(v)
}

function checkTable(t: DocText, found: Omit<ConsistencyIssue, 'acked' | 'acked_at' | 'acked_by'>[]): void {
  const rows = tableRows(t.text)
  if (rows.length < 3) return
  // Osszesen-sor: az elotte allo tetel-sorok (a fejlec es a reszosszegek nelkul) osszege oszloponkent.
  rows.forEach((r, ri) => {
    if (ri < 2 || !TOTAL_RE.test((r[0] || '').trim().toLowerCase())) return
    for (let ci = 1; ci < r.length; ci++) {
      const total = parseAmount(stripCur(r[ci] ?? ''))
      if (total === null) continue
      const parts = rows.slice(1, ri).filter((x) => !isTotalRow(x)).map((x) => cellAmount(x[ci] ?? ''))
      if (!parts.length || parts.some((p) => p === null)) continue
      const sum = (parts as number[]).reduce((a, b) => a + b, 0)
      if (sum !== total) found.push(issue('amount_sum', [`${r[0]}: ${fmtCents(total)}`, `${fmtCents(sum)}`], t.section))
    }
  })
  // Datum-oszlop: ha minden adatsorban van datum ugyanabban az oszlopban, novekvo legyen.
  const cols = Math.max(...rows.map((r) => r.length))
  for (let ci = 0; ci < cols; ci++) {
    const ds = rows.slice(1).filter((r) => !isTotalRow(r)).map((r) => findDates(r[ci] ?? '')[0])
    if (ds.length < 3 || ds.some((d) => !d || !d.valid)) continue
    const isos = (ds as FoundDate[]).map((d) => d.iso)
    const asc = isos.every((d, i) => i === 0 || d >= (isos[i - 1] as string))
    const desc = isos.every((d, i) => i === 0 || d <= (isos[i - 1] as string))
    if (!asc && !desc) {
      const bad = isos.findIndex((d, i) => i > 0 && d < (isos[i - 1] as string))
      found.push(issue('date_order', [(ds[bad - 1] as FoundDate).raw, (ds[bad] as FoundDate).raw], t.section))
    }
  }
}

function stripCur(s: string): string {
  return s.replace(/(Ft|HUF|forint|EUR|€|euró|euro|USD|\$|CHF)\.?/gi, '').replace(/,-/, '').trim()
}

/** A dokumentum szovegei es allitasai (a modell tablaibol). */
function docTexts(itemId: string): { texts: DocText[]; claims: { text: string; section: string; quotes: string[] }[] } {
  ensureDocModelTables()
  const db = getDb()
  const texts = db.prepare(`SELECT s.title AS section, b.kind AS kind, b.text AS text FROM wb_doc_blocks b JOIN wb_doc_sections s ON s.id = b.section_id
    WHERE b.work_item_id = ? AND b.kind != 'image' ORDER BY s.position, b.position`).all(itemId) as DocText[]
  const claims = (db.prepare(`SELECT c.id AS id, c.text AS text, s.title AS section FROM wb_doc_claims c
    JOIN wb_doc_blocks b ON b.id = c.block_id JOIN wb_doc_sections s ON s.id = b.section_id
    WHERE c.work_item_id = ? ORDER BY s.position, b.position, c.created_at`).all(itemId) as { id: string; text: string; section: string }[]).map((c) => ({
    text: c.text,
    section: c.section,
    quotes: (db.prepare("SELECT quote FROM wb_doc_sources WHERE claim_id = ? AND kind IN ('document', 'official') AND quote IS NOT NULL AND verdict = 'verified'").all(c.id) as { quote: string }[]).map((q) => q.quote),
  }))
  return { texts, claims }
}

let ackDb: unknown = null
function ensureAckTable(): void {
  const db = getDb()
  if (ackDb === db) return
  db.exec(`CREATE TABLE IF NOT EXISTS wb_doc_consistency_acks (
    work_item_id TEXT NOT NULL, issue_key TEXT NOT NULL, acked_at INTEGER NOT NULL, acked_by TEXT,
    PRIMARY KEY (work_item_id, issue_key))`)
  ackDb = db
}

/** A dokumentum osszes kovetkezetesseg-jelzese (a szandekosnak jeloltek is, `acked`-del). */
export function consistencyIssues(itemId: string): ConsistencyIssue[] {
  const { texts, claims } = docTexts(itemId)
  const found: Omit<ConsistencyIssue, 'acked' | 'acked_at' | 'acked_by'>[] = []
  const all = texts.map((t) => t.text).join('\n')

  // Nevek. A ragozott alak ("Kovács Annát", "Kovács Annával") nem elteres; a
  // ragozatlan resz eltero irasa ("Korpás László" / "Korpas Laszlo") igen, es
  // az egy betunyi elteres is ("Kovács Anna" / "Kovács Ana").
  const stems = new Map<string, Map<string, string>>()
  const sure = new Set<string>()
  for (const c of findNameCandidates(all)) {
    const st = nameStem(c.name)
    if (!stems.has(st)) stems.set(st, new Map())
    if (c.sure) sure.add(st)
    const sp = stems.get(st) as Map<string, string>
    const k = spelling(c.name, st)
    if (!sp.has(k)) sp.set(k, c.name)
  }
  for (const [, sp] of stems) if (sp.size > 1) found.push(issue('name_variant', [...sp.values()], null))
  const keys = [...sure]
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i] as string
      const b = keys[j] as string
      if (a.length < 8 || b.length < 8 || a.startsWith(b) || b.startsWith(a)) continue
      if (a.split(' ').length !== b.split(' ').length) continue
      if (editDistance(a, b) === 1) {
        const first = (st: string): string => [...(stems.get(st) as Map<string, string>).values()].sort((x, y) => x.length - y.length)[0] as string
        found.push(issue('name_variant', [first(a), first(b)], null))
      }
    }
  }

  // Ugyszam: ket nagyon hasonlo, de nem azonos. A magyar ugyszam vegi irat-sorszam
  // ("/4", "/7") ugyanannak az ugynek mas irata, az nem elteres.
  const cases = [...new Set(findCaseNumbers(all).map((c) => c.replace(/\s+/g, '').replace(/(\/\d{4})\/\d{1,3}$/, '$1')))]
  for (let i = 0; i < cases.length; i++) {
    for (let j = i + 1; j < cases.length; j++) {
      if (editDistance(cases[i] as string, cases[j] as string) <= 2) found.push(issue('case_number_variant', [cases[i] as string, cases[j] as string], null))
    }
  }

  // Datumok: nem letezo nap.
  for (const t of texts) for (const d of findDates(t.text)) if (!d.valid) found.push(issue('date_invalid', [d.raw], t.section))

  // Tablazatok: osszesen-sor, datum-sorrend.
  for (const t of texts) if (t.kind === 'table') checkTable(t, found)

  // Cimek: ugyanaz az utca + hazszam mas iranyitoszammal / varossal.
  const addr = new Map<string, Map<string, string>>()
  for (const a of findAddresses(all)) {
    if (!addr.has(a.key)) addr.set(a.key, new Map())
    const places = addr.get(a.key) as Map<string, string>
    if (!places.has(a.place)) places.set(a.place, a.raw)
  }
  for (const [, places] of addr) if (places.size > 1) found.push(issue('address_variant', [...places.values()], null))

  // Allitas es forrasa: a datum es az osszeg egyezzen az idezettel.
  for (const c of claims) {
    if (!c.quotes.length) continue
    const q = c.quotes.join('\n')
    const qd = new Set(findDates(q).map((d) => d.iso))
    if (qd.size) for (const d of findDates(c.text)) if (d.valid && !qd.has(d.iso)) found.push(issue('claim_date_mismatch', [d.raw, [...findDates(q)].map((x) => x.raw).join(', ')], c.section))
    const qa = findAmounts(q)
    if (qa.length) {
      for (const a of findAmounts(c.text)) {
        const same = qa.some((x) => x.cents === a.cents && (!x.currency || !a.currency || x.currency === a.currency))
        if (!same) found.push(issue('claim_amount_mismatch', [a.raw, qa.map((x) => x.raw).join(', ')], c.section))
      }
    }
  }

  ensureAckTable()
  const acks = new Map((getDb().prepare('SELECT issue_key, acked_at, acked_by FROM wb_doc_consistency_acks WHERE work_item_id = ?')
    .all(itemId) as { issue_key: string; acked_at: number; acked_by: string | null }[]).map((r) => [r.issue_key, r]))
  const seen = new Set<string>()
  return found.filter((f) => (seen.has(f.key) ? false : (seen.add(f.key), true))).map((f) => {
    const a = acks.get(f.key)
    return { ...f, acked: !!a, acked_at: a ? a.acked_at : null, acked_by: a ? a.acked_by : null }
  })
}

/** A tulajdonos jelolese: ez az elteres szandekos (csak a tulajdonos kattintasa hivhatja). */
export function ackConsistencyIssue(itemId: string, key: string, by: string | null): boolean {
  const k = String(key || '')
  if (!consistencyIssues(itemId).some((i) => i.key === k)) return false
  ensureAckTable()
  getDb().prepare(`INSERT INTO wb_doc_consistency_acks (work_item_id, issue_key, acked_at, acked_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(work_item_id, issue_key) DO UPDATE SET acked_at = excluded.acked_at, acked_by = excluded.acked_by`).run(itemId, k, Math.floor(Date.now() / 1000), by)
  return true
}

/** A jeloles visszavonasa. */
export function unackConsistencyIssue(itemId: string, key: string): void {
  ensureAckTable()
  getDb().prepare('DELETE FROM wb_doc_consistency_acks WHERE work_item_id = ? AND issue_key = ?').run(itemId, String(key || ''))
}
