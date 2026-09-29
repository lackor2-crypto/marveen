/**
 * HATARIDOK ES IDOPONTOK AZ IRATOKBOL (kanban #441, v4 spec 1/A, K-1.17).
 *
 * A munkadarab anyagai kozott allo, mar elolvasott iratokbol (1/A, K-1.1:
 * oldalankenti szoveg a gyorsitotarban) a Marveen GEPI UTON, szabalyokkal
 * kigyujti a targyalasokat es a hataridoket -- magyar, nemet es angol
 * iratban. Mindegyik mellett ott a forras: fajl, oldal, a mondat szo szerint.
 *
 * Ket fajta hatarido van:
 *   - naptari napra szolo ("2025. október 15-ig", "bis zum 15. Oktober"):
 *     egy kattintassal teendo lesz belole, a hatarido napjaval;
 *   - kezdonaptol szamitott ("a kézbesítéstől számított 15 napon belül"): ezt
 *     a Marveen NEM szamolja ki magatol, mert a kezdonapot (a kezbesites
 *     napjat) csak a tulajdonos tudja, es a szamitas jogi szabalyokon mulik.
 *     A tulajdonos megadja a kezbesites napjat, a Marveen JAVASLATOT tesz (a
 *     kezdonap nem szamit bele; a hetvegere eso utolso nap a kovetkezo
 *     hetfore tolodik; a munkaszuneti napokat nem ismeri, ezt ki is mondja),
 *     es a tulajdonos a -- szukseg eseten atirt -- napot hagyja jova. A
 *     munkanapban szamolt hataridot nem javasolja: ott a tulajdonos adja meg.
 *
 * A teendo a meglevo Munkapad-teendo (#406): onnan megy a naptarba (.ics,
 * Google Naptar). A kigyujtes a gyorsitotarbol ujraszamolhato, igy csak a
 * tulajdonos dontesei (teendo lett, nem vonatkozik ra) kerulnek tablaba.
 */
import { createHash } from 'node:crypto'
import { getDb } from './db.js'
import { findDates } from './workbench-doccheck.js'
import { getDocRead, getDocPages, docKind, DOCREAD_VERSION } from './workbench-docread.js'
import { addTodo, getTodo, cleanDueDate, type TodoRow } from './workbench-todos.js'

export type DeadlineKind = 'hearing' | 'deadline'
export type DeadlineTopic = 'hearing' | 'appeal' | 'response' | 'cure' | 'payment' | 'other'
export type RelUnit = 'day' | 'week' | 'month' | 'workday'
export type RelTrigger = 'delivery' | 'other'

export interface FoundDeadline {
  kind: DeadlineKind
  topic: DeadlineTopic
  /** Naptari nap (YYYY-MM-DD), ha az irat megnevezi. */
  date: string | null
  /** Idopont (HH:MM), ha az irat megnevezi (jellemzoen targyalasnal). */
  time: string | null
  /** Kezdonaptol szamitott hatarido: mennyi, milyen egysegben, mitol. */
  relative: { amount: number; unit: RelUnit; trigger: RelTrigger } | null
  /** A mondat szo szerint (a forras). */
  quote: string
}

// ---------------------------------------------------------------------------
// Kigyujtes egy oldal szovegebol
// ---------------------------------------------------------------------------

const HEARING_RE = /tárgyalás|tárgyalási|határnap|meghallgatás|mündliche[nr]? Verhandlung|Verhandlungstermin|Gerichtstermin|Termin zur|Anhörung|\bhearing\b|\btrial\b|status conference|pretrial conference/i
const DEADLINE_RE = /határid|belül|[-‑]ig\b|napjáig|legkésőbb|\bFrist|binnen|innerhalb|spätestens|bis zum|\bwithin\b|no later than|\bdeadline\b|on or before|\bdue (?:on|by)\b/i
const TRIGGER_RE = /kézbesít|kézhezvét|közlésé|közléstől|Zustellung|zugestellt|Zugang|\bservice\b|\bserved\b|\breceipt\b/i

const TOPICS: [DeadlineTopic, RegExp][] = [
  ['appeal', /fellebbez|felülvizsgálat|Berufung|Beschwerde|Revision|\bappeal/i],
  ['cure', /hiánypótl|hiányok pótlás|Mängel|nachzureichen|nachreichen|\bcure\b|deficien/i],
  ['payment', /megfizet|befizet|fizesse|illeték|Zahlung|zahlen|Kostenvorschuss|\bpay\b|\bpayment\b|\bfee\b/i],
  ['response', /ellenkérelem|ellenkérelm|válasz|nyilatkoz|észrevétel|Stellungnahme|Stellung (?:zu )?nehmen|Klageerwiderung|erwidern|äußern|\banswer\b|\brespond|\bresponse\b|\breply\b|opposition/i],
]

const NUMBER_WORDS: Record<string, number> = {
  egy: 1, két: 2, kettő: 2, három: 3, négy: 4, öt: 5, hat: 6, hét: 7, nyolc: 8, kilenc: 9, tíz: 10, tizenöt: 15, húsz: 20, harminc: 30, negyvenöt: 45, hatvan: 60, kilencven: 90,
  einer: 1, eines: 1, einem: 1, zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, acht: 8, zehn: 10, vierzehn: 14, einundzwanzig: 21, dreißig: 30,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10, fourteen: 14, fifteen: 15, 'twenty-one': 21, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
}
const NUMW = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|')

/** Kezdonaptol szamitott hatarido a mondatban ("15 napon belül", "binnen zwei Wochen", "within 21 days"). */
function findRelative(s: string): { amount: number; unit: RelUnit; at: number } | null {
  const num = (v: string): number => (/^\d+$/.test(v) ? Number(v) : NUMBER_WORDS[v.toLowerCase()] ?? 0)
  const hu = new RegExp(`(?<![\\p{L}\\d])(\\d{1,3}|${NUMW})\\s*(?:\\((?:\\d{1,3}|[\\p{L}]+)\\)\\s*)?(munkanap|nap|hét|hónap)(?:on|en|ja|jon|ig)?\\s+(?:belül|alatt)`, 'iu')
  const de = new RegExp(`(?:binnen|innerhalb(?:\\s+von)?|Frist\\s+von)\\s+(\\d{1,3}|${NUMW})\\s+(Werktag|Arbeitstag|Tag|Woche|Monat)`, 'iu')
  const en = new RegExp(`(?:within|in)\\s+(\\d{1,3}|${NUMW})\\s*(?:\\(\\d{1,3}\\)\\s*)?(business day|court day|working day|day|week|month)`, 'iu')
  const unitOf = (u: string): RelUnit => {
    const x = u.toLowerCase()
    if (/munkanap|werktag|arbeitstag|business|court|working/.test(x)) return 'workday'
    if (/hét|woche|week/.test(x)) return 'week'
    if (/hónap|monat|month/.test(x)) return 'month'
    return 'day'
  }
  for (const re of [hu, de, en]) {
    const m = s.match(re)
    if (m) {
      const amount = num(m[1] as string)
      if (amount > 0 && amount <= 366) return { amount, unit: unitOf(m[2] as string), at: m.index ?? 0 }
    }
  }
  return null
}

/** Idopont a mondatban: "10:30", "10.30 órakor", "10 óra 30 perckor", "um 10 Uhr", "9:00 a.m.". */
export function findTime(s: string): string | null {
  const p = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  let m = s.match(/(?<![\d.:])([01]?\d|2[0-3]):([0-5]\d)(?!\d)\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/i)
  if (m) {
    let h = Number(m[1])
    if (m[3] && /p/i.test(m[3]) && h < 12) h += 12
    if (m[3] && /a/i.test(m[3]) && h === 12) h = 0
    return p(h, Number(m[2]))
  }
  m = s.match(/(?<![\d.])([01]?\d|2[0-3])\.([0-5]\d)\s*(?:órakor|óra\b|Uhr)/i)
  if (m) return p(Number(m[1]), Number(m[2]))
  m = s.match(/(?<![\d.])([01]?\d|2[0-3])\s*(?:órakor|óra\b)(?:\s*([0-5]?\d)\s*perc)?/i)
  if (m) return p(Number(m[1]), Number(m[2] ?? 0))
  m = s.match(/\bum\s+([01]?\d|2[0-3])(?:[.:]([0-5]\d))?\s*Uhr/i)
  if (m) return p(Number(m[1]), Number(m[2] ?? 0))
  m = s.match(/(?<![\d.:])(1[0-2]|0?[1-9])\s*(a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])/i)
  if (m) {
    let h = Number(m[1])
    if (/p/i.test(m[2] as string) && h < 12) h += 12
    if (/a/i.test(m[2] as string) && h === 12) h = 0
    return p(h, 0)
  }
  return null
}

/** Nem mondathatar: rovidites ("Dr.", "Nr.", "Az."), vagy a nemet sorszamos datum ("17. März"). */
const NO_SPLIT_BEFORE = /(?:^|[\s(])(?:Dr|Nr|Az|Abs|Art|vgl|ggf|bzw|ca|St|Str|ifj|id|sz|stb|u|pl|ill|Kft|Bt|Zrt|Nyrt|GmbH|Inc|Ltd|No|Sec|v|vs)\.$/i
const DE_MONTH_AFTER = /^(?:Januar|Jänner|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\b/

/** Mondatokra bontas (a sortores a szkennelt szovegben nem mondathatar). */
function sentences(text: string): string[] {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  const out: string[] = []
  let from = 0
  for (const m of t.matchAll(/[.!?;]\s+(?=[A-ZÁÉÍÓÖŐÚÜŰÄ„"(])/gu)) {
    const end = (m.index ?? 0) + 1
    const head = t.slice(from, end)
    const next = t.slice(end).trimStart()
    if (NO_SPLIT_BEFORE.test(head) || (/\d\.$/.test(head) && DE_MONTH_AFTER.test(next))) continue
    out.push(head.trim())
    from = end
  }
  out.push(t.slice(from).trim())
  return out.filter((x) => x.length >= 8)
}

const QUOTE_MAX = 400

/** A hataridore utalo datum: kozvetlenul utana "-ig"/"napjáig", vagy elotte "legkésőbb", "bis", "by", "until" ... */
function adjacentDeadlineDate(s: string, dates: { iso: string; raw: string; at: number }[]): { iso: string; at: number } | null {
  for (const d of dates) {
    const after = s.slice(d.at + d.raw.length, d.at + d.raw.length + 12)
    const before = s.slice(Math.max(0, d.at - 30), d.at)
    if (/^\.?\s?[-‑]?\s?(?:ig|jéig|jáig|éig|áig|napjáig)\b/i.test(after)) return d
    if (/(?:legkésőbb|határidő(?:re)?:?|bis(?: zum| spätestens)?|spätestens(?: am| bis)?|no later than|on or before|\bby|\buntil|\bdue(?: on| by)?)\s*$/i.test(before)) return d
  }
  return null
}

/** A forras-idezet: a mondat, vagy hosszu mondatnal a talalat korule vagott resz. */
function quoteAround(s: string, at: number): string {
  if (s.length <= QUOTE_MAX) return s
  const from = Math.max(0, Math.min(at - 150, s.length - QUOTE_MAX))
  return (from > 0 ? '…' : '') + s.slice(from, from + QUOTE_MAX - 2).trim() + (from + QUOTE_MAX - 2 < s.length ? '…' : '')
}

/**
 * Egy oldal hataridoi es idopontjai. A hatarido napja: a "-ig" / "legkésőbb"
 * / "bis" melletti datum; ha ilyen nincs, de a mondat kezdonaptol szamitott
 * hataridot mond ("a 2025. szeptember 1-jén kelt végzés kézbesítésétől
 * számított 15 napon belül"), akkor az -- a mondat egyeb datuma nem hatarido.
 */
export function extractDeadlines(text: string): FoundDeadline[] {
  const out: FoundDeadline[] = []
  for (const s of sentences(text)) {
    const dates = findDates(s).filter((d) => d.valid)
    const topic = (TOPICS.find(([, re]) => re.test(s)) || [])[0] || null
    if (HEARING_RE.test(s) && dates.length) {
      for (const d of dates) out.push({ kind: 'hearing', topic: 'hearing', date: d.iso, time: findTime(s), relative: null, quote: quoteAround(s, d.at) })
      continue
    }
    if (!DEADLINE_RE.test(s)) continue
    const adj = adjacentDeadlineDate(s, dates)
    const rel = adj ? null : findRelative(s)
    const date = adj ?? (!rel && dates.length === 1 ? dates[0] as { iso: string; at: number } : null)
    if (date) out.push({ kind: 'deadline', topic: topic ?? 'other', date: date.iso, time: null, relative: null, quote: quoteAround(s, date.at) })
    else if (rel) {
      out.push({
        kind: 'deadline', topic: topic ?? 'other', date: null, time: null,
        relative: { amount: rel.amount, unit: rel.unit, trigger: TRIGGER_RE.test(s) ? 'delivery' : 'other' }, quote: quoteAround(s, rel.at),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// A kezdonaptol szamitott hatarido JAVASLATA (a tulajdonos hagyja jova)
// ---------------------------------------------------------------------------

export interface DueProposal {
  due: string
  /** Az utolso nap hetvegere esett, a kovetkezo hetfore tolodott. */
  shifted: boolean
}

/**
 * A kezdonap (pl. a kezbesites napja) + N nap / het / honap. A kezdonap nem
 * szamit bele; a het es a honap a kezdonappal azonos nevu / szamu napon jar
 * le (ha a honapban nincs ilyen nap, az utolso napjan); a hetvegere eso
 * utolso nap a kovetkezo hetfore tolodik. (Ugyanigy a magyar Pp. 146. §, a
 * nemet BGB 187-188. § + ZPO 222. § es az amerikai FRCP 6(a).) A
 * munkaszuneti napokat NEM ismeri, es munkanapban nem szamol: null.
 */
export function proposeDue(trigger: string, amount: number, unit: RelUnit): DueProposal | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(trigger || ''))
  if (!m || unit === 'workday' || !(amount > 0 && amount <= 366)) return null
  const y = Number(m[1]); const mo = Number(m[2]) - 1; const d = Number(m[3])
  const start = new Date(Date.UTC(y, mo, d))
  if (start.getUTCFullYear() !== y || start.getUTCMonth() !== mo || start.getUTCDate() !== d) return null
  let end: Date
  if (unit === 'month') {
    const target = new Date(Date.UTC(y, mo + amount, 1))
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
    end = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d, last)))
  } else {
    end = new Date(start.getTime() + (unit === 'week' ? amount * 7 : amount) * 86_400_000)
  }
  const wd = end.getUTCDay()
  const shift = wd === 6 ? 2 : wd === 0 ? 1 : 0
  if (shift) end = new Date(end.getTime() + shift * 86_400_000)
  return { due: end.toISOString().slice(0, 10), shifted: shift > 0 }
}

// ---------------------------------------------------------------------------
// A munkadarab hataridoi (az anyagok olvasott iratabol) es a tulajdonos dontesei
// ---------------------------------------------------------------------------

/** Az anyag, amibol olvasunk (a munkadarab anyaglistajanak sora). */
export interface DeadlineAsset { sha256: string; name: string; project_path: string; present: boolean }

export interface DeadlineView extends FoundDeadline {
  key: string
  path: string
  name: string
  page: number
  /** A szovegfelismeres ezen az oldalon bizonytalan (K-1.3): nezd meg az iratban. */
  low: boolean
  todo: { id: string; due_date: string | null; done: boolean } | null
  dismissed: boolean
}

type PageFound = FoundDeadline & { page: number; low: boolean }
const memo = new Map<string, { stamp: string; found: PageFound[] }>()
const MEMO_MAX = 200

/** Egy olvasott irat hataridoi (a gyorsitotar valtozasaig megjegyezve). */
function fileDeadlines(sha: string): PageFound[] {
  const read = getDocRead(sha)
  if (!read || read.status !== 'done' || read.version !== DOCREAD_VERSION) return []
  const stamp = `${read.updated_at}:${read.pages_done}`
  const hit = memo.get(sha)
  if (hit && hit.stamp === stamp) return hit.found
  const found: PageFound[] = []
  for (const p of getDocPages(sha)) for (const f of extractDeadlines(p.text)) found.push({ ...f, page: p.page, low: !!p.low })
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string)
  memo.set(sha, { stamp, found })
  return found
}

let stateDb: unknown = null
export function ensureDeadlineTables(): void {
  const db = getDb()
  if (stateDb === db) return
  db.exec(`CREATE TABLE IF NOT EXISTS wb_deadline_state (
    work_item_id TEXT NOT NULL, deadline_key TEXT NOT NULL, todo_id TEXT, dismissed_at INTEGER, updated_at INTEGER NOT NULL, updated_by TEXT,
    PRIMARY KEY (work_item_id, deadline_key))`)
  stateDb = db
}

function keyOf(sha: string, f: PageFound): string {
  const rel = f.relative ? `${f.relative.amount}${f.relative.unit}${f.relative.trigger}` : ''
  return createHash('sha1').update([sha, f.page, f.kind, f.topic, f.date ?? '', f.time ?? '', rel, f.quote].join('\u0000')).digest('hex').slice(0, 16)
}

/**
 * A munkadarab hataridoi es idopontjai: az anyagok kozotti, mar elolvasott
 * iratokbol, a tulajdonos donteseivel. Egy iraton belul ugyanaz a hatarido
 * (ugyanaz a nap / szabaly) csak egyszer, az elso elofordulasanal.
 */
export function itemDeadlines(itemId: string, assets: DeadlineAsset[]): DeadlineView[] {
  ensureDeadlineTables()
  const state = new Map((getDb().prepare('SELECT deadline_key, todo_id, dismissed_at FROM wb_deadline_state WHERE work_item_id = ?')
    .all(itemId) as { deadline_key: string; todo_id: string | null; dismissed_at: number | null }[]).map((r) => [r.deadline_key, r]))
  const out: DeadlineView[] = []
  const seenFile = new Set<string>()
  for (const a of assets) {
    const k = docKind(a.name)
    if (!a.present || !k || seenFile.has(a.sha256)) continue
    seenFile.add(a.sha256)
    const seen = new Set<string>()
    for (const f of fileDeadlines(a.sha256)) {
      const same = [f.kind, f.topic, f.date, f.time, f.relative ? JSON.stringify(f.relative) : ''].join('|')
      if (seen.has(same)) continue
      seen.add(same)
      const key = keyOf(a.sha256, f)
      const st = state.get(key)
      const td: TodoRow | undefined = st?.todo_id ? getTodo(st.todo_id) : undefined
      out.push({
        ...f, key, path: a.project_path, name: a.name,
        todo: td ? { id: td.id, due_date: td.due_date, done: td.done_at != null } : null,
        dismissed: !!st?.dismissed_at,
      })
    }
  }
  return out
}

export type DeadlineTodoResult =
  | { ok: true; todo: TodoRow }
  | { ok: false; code: 'not_found' | 'needs_due' | 'bad_due' | 'already' | 'todo_failed'; detail?: string }

/** A teendo szovege: mi, mikor (idopont), honnan -- a felulet nyelven. */
export function deadlineTodoText(d: DeadlineView, lang: 'hu' | 'en'): string {
  const topic: Record<DeadlineTopic, { hu: string; en: string }> = {
    hearing: { hu: 'Tárgyalás', en: 'Hearing' },
    appeal: { hu: 'Fellebbezési határidő', en: 'Appeal deadline' },
    response: { hu: 'Válaszadási (nyilatkozattételi) határidő', en: 'Response deadline' },
    cure: { hu: 'Hiánypótlási határidő', en: 'Deadline to cure deficiencies' },
    payment: { hu: 'Fizetési határidő', en: 'Payment deadline' },
    other: { hu: 'Határidő', en: 'Deadline' },
  }
  const src = lang === 'en' ? `(${d.name}, page ${d.page})` : `(${d.name}, ${d.page}. oldal)`
  return `${topic[d.topic][lang]}${d.time ? ' ' + d.time : ''} ${src}`.slice(0, 300)
}

/**
 * Teendo a hataridobol (a tulajdonos kattintasa). A nap: a tulajdonos altal
 * megadott (`due`), vagy -- ha nem adott meg -- az irat naptari napja. A
 * kezdonaptol szamitott hataridonel a nap megadasa kotelezo (a javaslatot a
 * `proposeDue` adja, de azt a tulajdonos hagyja jova).
 */
export function deadlineToTodo(itemId: string, assets: DeadlineAsset[], key: string, input: { due?: unknown; by: string | null; lang: 'hu' | 'en' }): DeadlineTodoResult {
  const d = itemDeadlines(itemId, assets).find((x) => x.key === key)
  if (!d) return { ok: false, code: 'not_found' }
  if (d.todo) return { ok: false, code: 'already' }
  let due: string | null = null
  if (input.due !== undefined && input.due !== null && input.due !== '') {
    const c = cleanDueDate(input.due)
    if (!c.ok || !c.due) return { ok: false, code: 'bad_due' }
    due = c.due
  } else due = d.date
  if (!due) return { ok: false, code: 'needs_due' }
  const r = addTodo({ work_item_id: itemId, text: deadlineTodoText(d, input.lang), due_date: due, by: input.by, source: 'owner' })
  if (!r.ok) return { ok: false, code: 'todo_failed', detail: r.code }
  setState(itemId, key, { todo_id: r.todo.id, dismissed_at: null }, input.by)
  return { ok: true, todo: r.todo }
}

/** "Nem vonatkozik ram": a hatarido lekerul a fo listarol (visszahozhato). */
export function dismissDeadline(itemId: string, assets: DeadlineAsset[], key: string, dismissed: boolean, by: string | null): boolean {
  if (dismissed && !itemDeadlines(itemId, assets).some((x) => x.key === key)) return false
  setState(itemId, key, { dismissed_at: dismissed ? Math.floor(Date.now() / 1000) : null }, by)
  return true
}

function setState(itemId: string, key: string, patch: { todo_id?: string | null; dismissed_at?: number | null }, by: string | null): void {
  ensureDeadlineTables()
  const db = getDb()
  const cur = db.prepare('SELECT todo_id, dismissed_at FROM wb_deadline_state WHERE work_item_id = ? AND deadline_key = ?').get(itemId, key) as { todo_id: string | null; dismissed_at: number | null } | undefined
  const todo = patch.todo_id !== undefined ? patch.todo_id : cur?.todo_id ?? null
  const dis = patch.dismissed_at !== undefined ? patch.dismissed_at : cur?.dismissed_at ?? null
  db.prepare(`INSERT INTO wb_deadline_state (work_item_id, deadline_key, todo_id, dismissed_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id, deadline_key) DO UPDATE SET todo_id = excluded.todo_id, dismissed_at = excluded.dismissed_at, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(itemId, key, todo, dis, Math.floor(Date.now() / 1000), by)
}
