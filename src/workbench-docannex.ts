/**
 * MELLEKLETJEGYZEK (kanban #441, v4 spec 1/A, K-1.18).
 *
 * A bizonyitekkent csatolt fajlok SZAMOZOTT listaja egy dokumentumhoz. A szam
 * a lista sorrendjebol jon (K1, K2 ... / Anlage K1 ... / Exhibit A ...), es a
 * szovegben allo hivatkozasok MINDIG a listahoz igazodnak: atrendezesnel,
 * torlesnel es semavaltasnal a Marveen a szovegben is atirja oket (mint a
 * Word kereszthivatkozasa). A torolt mellekletre mutato hivatkozasbol
 * hiany-jeloles lesz ("⚠ Hiányzó adat: ..."), ami a veglegesitest megallitja --
 * csendben nem tunik el, es nem mutat rossz mellekletre.
 *
 * Az ellenorzes (K-1.22 "Mellekletek: 4 / 4"): minden hivatkozott melleklet
 * letezik, minden mellekletre van hivatkozas, minden melleklet fajlja megvan.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import { ensureDocModelTables } from './workbench-docmodel.js'
import { officeExt } from './office-convert.js'

export const ANNEX_SCHEMES = ['k', 'anlage', 'exhibit'] as const
export type AnnexScheme = typeof ANNEX_SCHEMES[number]
/** separate: minden melleklet kulon PDF (e-beadasnal ez a szokasos); combined: egy PDF-ben a beadvannyal. */
export const ANNEX_MODES = ['separate', 'combined'] as const
export type AnnexMode = typeof ANNEX_MODES[number]

export const ANNEXES_MAX = 200
export const ANNEX_TITLE_MAX = 300

export interface DocSettings { annex_scheme: AnnexScheme; annex_prefix: string; annex_mode: AnnexMode }
export const DEFAULT_SETTINGS: DocSettings = { annex_scheme: 'k', annex_prefix: 'K', annex_mode: 'separate' }

let tablesDb: unknown = null

export function ensureAnnexTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  ensureDocModelTables()
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_annexes (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_settings (
      work_item_id TEXT PRIMARY KEY,
      annex_scheme TEXT NOT NULL,
      annex_prefix TEXT NOT NULL,
      annex_mode TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_doc_annexes_item ON wb_doc_annexes(work_item_id, position)')
  // #530: a LINKED annex is a document of the Life tree, not a copy in the project folder. Its
  // `path` is `doc:<document id>`; `life_rel` is where the file was when it was last seen (shown
  // to the owner, and the only thing left to show when the file cannot be found).
  const cols = new Set((db.prepare('PRAGMA table_info(wb_doc_annexes)').all() as { name: string }[]).map((c) => c.name))
  if (!cols.has('life_rel')) db.exec('ALTER TABLE wb_doc_annexes ADD COLUMN life_rel TEXT')
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Semak: cimke es hivatkozas-felismeres
// ---------------------------------------------------------------------------

export function letters(n: number): string {
  let s = ''
  let x = n
  while (x > 0) { x--; s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) }
  return s
}

export function fromLetters(s: string): number {
  let n = 0
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

export function annexLabel(s: Pick<DocSettings, 'annex_scheme' | 'annex_prefix'>, n: number): string {
  if (s.annex_scheme === 'exhibit') return `Exhibit ${letters(n)}`
  if (s.annex_scheme === 'anlage') return `Anlage ${s.annex_prefix}${n}`
  return `${s.annex_prefix}${n}`
}

/** A mellekletjegyzek cime a dokumentum vegen (a sema nyelven, mert a dokumentum is az). */
export function annexListTitle(s: Pick<DocSettings, 'annex_scheme'>): string {
  return s.annex_scheme === 'exhibit' ? 'Exhibits' : s.annex_scheme === 'anlage' ? 'Anlagen' : 'Mellékletek'
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const NB = '(?<![\\p{L}\\p{N}])'
const NA = '(?![\\p{L}\\p{N}])'

/** A hivatkozas mintaja (egy csoport: a sorszam; exhibitnel a betu). */
function refPattern(s: Pick<DocSettings, 'annex_scheme' | 'annex_prefix'>): string {
  if (s.annex_scheme === 'exhibit') return `${NB}Exhibit ([A-Z]{1,2})${NA}`
  const p = esc(s.annex_prefix)
  if (s.annex_scheme === 'anlage') return `${NB}(?:Anlage|Anl\\.) ?${p} ?(\\d{1,3})${NA}`
  // Az "Anlage K1" mar a nemet sema cimkeje, nem K1-hivatkozas: kulonben a
  // nemetre forditott szovegben semavaltaskor "Anlage Anlage K1" lenne belole.
  return `${NB}(?<!(?:Anlage|Anl\\.)[ \\u00a0]?)${p} ?(\\d{1,3})${NA}`
}

function numberOf(s: Pick<DocSettings, 'annex_scheme'>, raw: string): number {
  return s.annex_scheme === 'exhibit' ? fromLetters(raw) : Number(raw)
}

/** A mar hianyzonak jelolt hivatkozas: benne a regi cimke nem szamit hivatkozasnak, es nem irjuk at ujra. */
const DEAD_PREFIX = '⚠ Hiányzó adat: a hivatkozott melléklet nincs a jegyzékben'
const DEAD_REF_RE = /⚠ Hiányzó adat: a hivatkozott melléklet nincs a jegyzékben \([^)\n]*\)/gu

/** A szoveg a halott hivatkozasok nelkul (azonos hosszban, hogy a tartomany-figyeles ne csusszon el). */
function withoutDeadRefs(text: string): string {
  return String(text || '').replace(DEAD_REF_RE, (m) => ' '.repeat(m.length))
}

/**
 * A szovegben hivatkozott mellekletek sorszamai. A tartomany ("K1–K3",
 * "Anlage K1 bis K3") a kozbulsoket is jelenti.
 */
export function annexRefs(raw: string, s: Pick<DocSettings, 'annex_scheme' | 'annex_prefix'>): number[] {
  const text = withoutDeadRefs(raw)
  const out = new Set<number>()
  const re = new RegExp(refPattern(s), 'gu')
  const hits = [...text.matchAll(re)].map((m) => ({ n: numberOf(s, m[1] as string), at: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
  hits.forEach((h) => { if (h.n > 0) out.add(h.n) })
  for (let i = 0; i + 1 < hits.length; i++) {
    const a = hits[i] as typeof hits[number]
    const b = hits[i + 1] as typeof hits[number]
    const between = text.slice(a.end, b.at)
    if (/^\s*(?:[-–—]|bis|to|through)\s*$/i.test(between) && b.n > a.n && b.n - a.n <= ANNEXES_MAX) {
      for (let n = a.n + 1; n < b.n; n++) out.add(n)
    }
  }
  // A "K1–3" alak (a masodik vegpont cimke nelkul).
  if (s.annex_scheme !== 'exhibit') {
    const range = new RegExp(`${refPattern(s)}\\s*[-–—]\\s*(\\d{1,3})${NA}`, 'gu')
    for (const m of text.matchAll(range)) {
      const a = Number(m[1]); const b = Number(m[2])
      if (b > a && b - a <= ANNEXES_MAX) for (let n = a; n <= b; n++) out.add(n)
    }
  }
  return [...out].sort((x, y) => x - y)
}

/**
 * A hivatkozasok atirasa a dokumentum MINDEN blokkjaban es allitasaban.
 * `map(n)`: az uj cimke, vagy null, ha a melleklet mar nincs meg (akkor
 * hiany-jeloles lesz belole). Egy menetben cserel, igy a K1<->K2 csere sem
 * akad ossze.
 */
export function rewriteAnnexRefs(itemId: string, from: Pick<DocSettings, 'annex_scheme' | 'annex_prefix'>, map: (n: number) => string | null): number {
  ensureAnnexTables()
  const re = new RegExp(refPattern(from), 'gu')
  const swap = (part: string): string => part.replace(re, (whole: string, raw: string) => {
    const to = map(numberOf(from, raw))
    return to === null ? `${DEAD_PREFIX} (${whole})` : to
  })
  // A mar halottnak jelolt hivatkozasokhoz nem nyulunk, csak a koztuk allo szoveghez.
  const fix = (text: string): string => {
    let out = ''
    let last = 0
    for (const m of text.matchAll(DEAD_REF_RE)) {
      out += swap(text.slice(last, m.index ?? 0)) + m[0]
      last = (m.index ?? 0) + m[0].length
    }
    return out + swap(text.slice(last))
  }
  const db = getDb()
  let changed = 0
  db.transaction(() => {
    for (const b of db.prepare('SELECT id, text FROM wb_doc_blocks WHERE work_item_id = ?').all(itemId) as { id: string; text: string }[]) {
      const t = fix(b.text)
      if (t !== b.text) { db.prepare('UPDATE wb_doc_blocks SET text = ?, updated_at = ? WHERE id = ?').run(t, now(), b.id); changed++ }
    }
    for (const c of db.prepare('SELECT id, text FROM wb_doc_claims WHERE work_item_id = ?').all(itemId) as { id: string; text: string }[]) {
      const t = fix(c.text)
      if (t !== c.text) db.prepare('UPDATE wb_doc_claims SET text = ? WHERE id = ?').run(t, c.id)
    }
  })()
  return changed
}

// ---------------------------------------------------------------------------
// Beallitasok
// ---------------------------------------------------------------------------

export function docSettings(itemId: string): DocSettings {
  ensureAnnexTables()
  const r = getDb().prepare('SELECT annex_scheme, annex_prefix, annex_mode FROM wb_doc_settings WHERE work_item_id = ?').get(itemId) as DocSettings | undefined
  if (!r) return { ...DEFAULT_SETTINGS }
  return {
    annex_scheme: ANNEX_SCHEMES.includes(r.annex_scheme) ? r.annex_scheme : DEFAULT_SETTINGS.annex_scheme,
    annex_prefix: /^[A-Z]{1,2}$/.test(r.annex_prefix) ? r.annex_prefix : DEFAULT_SETTINGS.annex_prefix,
    annex_mode: ANNEX_MODES.includes(r.annex_mode) ? r.annex_mode : DEFAULT_SETTINGS.annex_mode,
  }
}

export type AnnexError = 'not_found' | 'bad_input' | 'too_many' | 'duplicate' | 'file_missing'
export type AnnexResult<T> = ({ ok: true } & T) | { ok: false; code: AnnexError; detail: string }

/** Sema, betujel vagy modvaltas. Ha a cimke alakja valtozik, a szovegbeli hivatkozasok is atiroddnak. */
export function setDocSettings(itemId: string, patch: { annex_scheme?: unknown; annex_prefix?: unknown; annex_mode?: unknown }): AnnexResult<{ settings: DocSettings; rewritten: number }> {
  const cur = docSettings(itemId)
  const next: DocSettings = { ...cur }
  if (patch.annex_scheme !== undefined && patch.annex_scheme !== null && patch.annex_scheme !== '') {
    if (!ANNEX_SCHEMES.includes(patch.annex_scheme as AnnexScheme)) return { ok: false, code: 'bad_input', detail: `annex_scheme must be one of ${ANNEX_SCHEMES.join(', ')}` }
    next.annex_scheme = patch.annex_scheme as AnnexScheme
  }
  if (patch.annex_prefix !== undefined && patch.annex_prefix !== null && patch.annex_prefix !== '') {
    const p = String(patch.annex_prefix).trim().toUpperCase()
    if (!/^[A-Z]{1,2}$/.test(p)) return { ok: false, code: 'bad_input', detail: 'annex_prefix must be one or two letters (K, B, A, F ...)' }
    next.annex_prefix = p
  }
  if (patch.annex_mode !== undefined && patch.annex_mode !== null && patch.annex_mode !== '') {
    if (!ANNEX_MODES.includes(patch.annex_mode as AnnexMode)) return { ok: false, code: 'bad_input', detail: `annex_mode must be one of ${ANNEX_MODES.join(', ')}` }
    next.annex_mode = patch.annex_mode as AnnexMode
  }
  let rewritten = 0
  if (next.annex_scheme !== cur.annex_scheme || next.annex_prefix !== cur.annex_prefix) {
    // A semavaltas csak a cimke ALAKJAT valtja, a sorszamot nem: a meg fel nem
    // vett mellekletre mutato hivatkozas is atcimkezodik (a "nincs a jegyzekben"
    // ellenorzes ugyanugy megallitja), nem lesz belole torolt-melleklet jeloles.
    // Igy a forditas utan beallitott nemet sema sem rontja el a hivatkozasokat.
    rewritten = rewriteAnnexRefs(itemId, cur, (n) => (n >= 1 ? annexLabel(next, n) : null))
  }
  getDb().prepare(`INSERT INTO wb_doc_settings (work_item_id, annex_scheme, annex_prefix, annex_mode, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(work_item_id) DO UPDATE SET annex_scheme = excluded.annex_scheme, annex_prefix = excluded.annex_prefix,
      annex_mode = excluded.annex_mode, updated_at = excluded.updated_at`)
    .run(itemId, next.annex_scheme, next.annex_prefix, next.annex_mode, now())
  return { ok: true, settings: next, rewritten }
}

// ---------------------------------------------------------------------------
// A lista
// ---------------------------------------------------------------------------

export interface AnnexRow { id: string; work_item_id: string; position: number; path: string; title: string; created_at: number; created_by: string | null; life_rel?: string | null }

/** `doc:<id>`: the annex is a linked document of the Life tree (#530), not a file of the project folder. */
export const LINKED_PREFIX = 'doc:'
export const isLinkedPath = (p: string): boolean => String(p || '').startsWith(LINKED_PREFIX)
const baseName = (p: string): string => String(p || '').slice(String(p || '').lastIndexOf('/') + 1)

function listAnnexRows(itemId: string): AnnexRow[] {
  ensureAnnexTables()
  return getDb().prepare('SELECT * FROM wb_doc_annexes WHERE work_item_id = ? ORDER BY position, created_at').all(itemId) as AnnexRow[]
}

/** A projekt fajljainak feloldasa (a hivo adja, hogy a modul tesztelheto maradjon). */
export type FileResolver = (path: string) => { abs: string; name: string } | null

export interface AnnexView extends AnnexRow {
  number: number
  label: string
  /** null: nem neztuk meg (nincs feloldo). */
  exists: boolean | null
  refs: number
  /** The file's name as it is now (a linked document may have been renamed); the last known one when it cannot be found. */
  name: string
  /** #530: a document of the Life tree, referred to and not copied. */
  linked: boolean
}

/** The file name an annex row stands for when the file itself was not looked at. */
function rowName(a: AnnexRow): string {
  return isLinkedPath(a.path) ? baseName(a.life_rel || '') : baseName(a.path)
}

function allTexts(itemId: string): string[] {
  ensureAnnexTables()
  return (getDb().prepare('SELECT text FROM wb_doc_blocks WHERE work_item_id = ?').all(itemId) as { text: string }[]).map((r) => r.text)
}

export function listAnnexes(itemId: string, resolve?: FileResolver): AnnexView[] {
  const s = docSettings(itemId)
  const counts = new Map<number, number>()
  for (const t of allTexts(itemId)) for (const n of annexRefs(t, s)) counts.set(n, (counts.get(n) || 0) + 1)
  return listAnnexRows(itemId).map((a, i) => {
    const f = resolve ? resolve(a.path) : null
    return {
      ...a, number: i + 1, label: annexLabel(s, i + 1),
      exists: resolve ? !!f : null,
      refs: counts.get(i + 1) || 0,
      name: f ? f.name : rowName(a),
      linked: isLinkedPath(a.path),
    }
  })
}

/** Uj sorrend alkalmazasa; a szovegbeli hivatkozasok a regi sorszambol az ujra irodnak at. */
function applyOrder(itemId: string, oldOrder: AnnexRow[], newOrder: (AnnexRow | null)[]): number {
  const s = docSettings(itemId)
  const kept = newOrder.filter((x): x is AnnexRow => !!x)
  const newNo = new Map(kept.map((a, i) => [a.id, i + 1]))
  const upd = getDb().prepare('UPDATE wb_doc_annexes SET position = ? WHERE id = ?')
  kept.forEach((a, i) => upd.run(i, a.id))
  return rewriteAnnexRefs(itemId, s, (n) => {
    // Nem letezo mellekletre mutato (elore megirt) hivatkozas: atszamozas utan
    // mar nem tudni, melyikre gondolt -- hiany-jeloles, nem csendes rossz cel.
    const a = oldOrder[n - 1]
    if (!a) return null
    const to = newNo.get(a.id)
    return to ? annexLabel(s, to) : null
  })
}

export function addAnnex(itemId: string, input: { path?: unknown; title?: unknown; position?: unknown }, resolve: FileResolver, by: string | null): AnnexResult<{ annex: AnnexView; rewritten: number }> {
  ensureAnnexTables()
  const path = String(input.path ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!path) return { ok: false, code: 'bad_input', detail: 'path (a file of the project folder) is required' }
  // A linked document is added by linkAnnex only: a caller cannot name one by typing its id as a path.
  if (isLinkedPath(path)) return { ok: false, code: 'bad_input', detail: 'path must be a file of the project folder' }
  const f = resolve(path)
  if (!f) return { ok: false, code: 'file_missing', detail: 'there is no such file in the project folder' }
  const title = String(input.title ?? '').trim() || f.name.replace(/\.[^.]+$/, '')
  if (title.length > ANNEX_TITLE_MAX) return { ok: false, code: 'bad_input', detail: `the title is at most ${ANNEX_TITLE_MAX} characters` }
  const rows = listAnnexRows(itemId)
  if (rows.length >= ANNEXES_MAX) return { ok: false, code: 'too_many', detail: `a document has at most ${ANNEXES_MAX} annexes` }
  if (rows.some((r) => r.path === path)) return { ok: false, code: 'duplicate', detail: 'this file is already an annex of this document' }
  const id = randomUUID().slice(0, 12)
  getDb().prepare('INSERT INTO wb_doc_annexes (id, work_item_id, position, path, title, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, itemId, rows.length, path, title, now(), by)
  const row = getDb().prepare('SELECT * FROM wb_doc_annexes WHERE id = ?').get(id) as AnnexRow
  let rewritten = 0
  const want = Number(input.position)
  if (input.position !== undefined && input.position !== null && input.position !== '' && Number.isFinite(want) && Math.floor(want) < rows.length) {
    const next: AnnexRow[] = rows.slice()
    next.splice(Math.max(0, Math.floor(want)), 0, row)
    rewritten = applyOrder(itemId, rows, next)
  }
  const view = listAnnexes(itemId, resolve).find((a) => a.id === id) as AnnexView
  return { ok: true, annex: view, rewritten }
}

export function updateAnnex(itemId: string, id: string, patch: { title?: unknown; position?: unknown }): AnnexResult<{ annex: AnnexRow; rewritten: number }> {
  const rows = listAnnexRows(itemId)
  const a = rows.find((r) => r.id === String(id || ''))
  if (!a) return { ok: false, code: 'not_found', detail: 'no annex with this id in this document' }
  if (patch.title !== undefined && patch.title !== null) {
    const title = String(patch.title).trim()
    if (!title || title.length > ANNEX_TITLE_MAX) return { ok: false, code: 'bad_input', detail: `the title must be 1 to ${ANNEX_TITLE_MAX} characters` }
    getDb().prepare('UPDATE wb_doc_annexes SET title = ? WHERE id = ?').run(title, a.id)
  }
  let rewritten = 0
  const want = Number(patch.position)
  if (patch.position !== undefined && patch.position !== null && patch.position !== '' && Number.isFinite(want)) {
    const pos = Math.max(0, Math.min(rows.length - 1, Math.floor(want)))
    const next = rows.filter((r) => r.id !== a.id)
    next.splice(pos, 0, a)
    if (next.some((r, i) => r.id !== rows[i]?.id)) rewritten = applyOrder(itemId, rows, next)
  }
  return { ok: true, annex: getDb().prepare('SELECT * FROM wb_doc_annexes WHERE id = ?').get(a.id) as AnnexRow, rewritten }
}

/**
 * #530: a document of the Life tree becomes an annex WITHOUT a copy. The caller has already
 * given the file its stable id (`docId`, life-doc-ids.ts) and knows where it is now (`lifeRel`).
 * The same document can be an annex of any number of documents and projects -- each list has
 * its own number for it -- but only once in one list.
 */
export function linkAnnex(itemId: string, input: { docId: string; lifeRel: string; title?: unknown; position?: unknown }, resolve: FileResolver, by: string | null): AnnexResult<{ annex: AnnexView; rewritten: number }> {
  ensureAnnexTables()
  const docId = String(input.docId || '').trim()
  if (!/^DOC-[A-Z0-9]{4,40}$/.test(docId)) return { ok: false, code: 'bad_input', detail: 'docId must be a document id' }
  const path = LINKED_PREFIX + docId
  const f = resolve(path)
  if (!f) return { ok: false, code: 'file_missing', detail: 'the document is not where its record says' }
  const title = String(input.title ?? '').trim() || f.name.replace(/\.[^.]+$/, '')
  if (title.length > ANNEX_TITLE_MAX) return { ok: false, code: 'bad_input', detail: `the title is at most ${ANNEX_TITLE_MAX} characters` }
  const rows = listAnnexRows(itemId)
  if (rows.length >= ANNEXES_MAX) return { ok: false, code: 'too_many', detail: `a document has at most ${ANNEXES_MAX} annexes` }
  if (rows.some((r) => r.path === path)) return { ok: false, code: 'duplicate', detail: 'this file is already an annex of this document' }
  const id = randomUUID().slice(0, 12)
  getDb().prepare('INSERT INTO wb_doc_annexes (id, work_item_id, position, path, title, created_at, created_by, life_rel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, itemId, rows.length, path, title, now(), by, String(input.lifeRel || ''))
  const row = getDb().prepare('SELECT * FROM wb_doc_annexes WHERE id = ?').get(id) as AnnexRow
  let rewritten = 0
  const want = Number(input.position)
  if (input.position !== undefined && input.position !== null && input.position !== '' && Number.isFinite(want) && Math.floor(want) < rows.length) {
    const next: AnnexRow[] = rows.slice()
    next.splice(Math.max(0, Math.floor(want)), 0, row)
    rewritten = applyOrder(itemId, rows, next)
  }
  const view = listAnnexes(itemId, resolve).find((a) => a.id === id) as AnnexView
  return { ok: true, annex: view, rewritten }
}

/** The linked annexes of every document, for "where is this file used?" and for following a moved file. */
export function linkedAnnexRows(): AnnexRow[] {
  ensureAnnexTables()
  return getDb().prepare(`SELECT * FROM wb_doc_annexes WHERE path LIKE 'doc:%'`).all() as AnnexRow[]
}

/** Where the linked file was last seen: kept current, so the list can say it even when the file is gone. */
export function rememberLinkedRel(annexId: string, lifeRel: string): void {
  ensureAnnexTables()
  getDb().prepare('UPDATE wb_doc_annexes SET life_rel = ? WHERE id = ? AND (life_rel IS NULL OR life_rel != ?)').run(lifeRel, annexId, lifeRel)
}

/**
 * A melleklet fajljanak csereje (pl. a kereshető masolatra, K-1.37): a sorszam,
 * a cim es a szovegbeli hivatkozasok maradnak.
 */
export function setAnnexPath(itemId: string, id: string, rawPath: string, resolve: FileResolver): AnnexResult<{ annex: AnnexRow }> {
  const rows = listAnnexRows(itemId)
  const a = rows.find((r) => r.id === String(id || ''))
  if (!a) return { ok: false, code: 'not_found', detail: 'no annex with this id in this document' }
  const path = String(rawPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '').trim()
  if (!path || isLinkedPath(path) || !resolve(path)) return { ok: false, code: 'file_missing', detail: 'there is no such file in the project folder' }
  if (rows.some((r) => r.id !== a.id && r.path === path)) return { ok: false, code: 'duplicate', detail: 'this file is already an annex of this document' }
  getDb().prepare('UPDATE wb_doc_annexes SET path = ?, life_rel = NULL WHERE id = ?').run(path, a.id)
  return { ok: true, annex: getDb().prepare('SELECT * FROM wb_doc_annexes WHERE id = ?').get(a.id) as AnnexRow }
}

/** Levetel a jegyzekrol (a fajl a mappaban marad). A ra mutato hivatkozasbol hiany-jeloles lesz. */
export function removeAnnex(itemId: string, id: string): AnnexResult<{ removed: string; rewritten: number }> {
  const rows = listAnnexRows(itemId)
  const a = rows.find((r) => r.id === String(id || ''))
  if (!a) return { ok: false, code: 'not_found', detail: 'no annex with this id in this document' }
  getDb().prepare('DELETE FROM wb_doc_annexes WHERE id = ?').run(a.id)
  const rewritten = applyOrder(itemId, rows, rows.map((r) => (r.id === a.id ? null : r)))
  return { ok: true, removed: a.id, rewritten }
}

/** Kepek, amiket a LibreOffice Draw-ja PDF-lappa tud tenni. (HEIC nem: azt a LibreOffice nem nyitja meg.) */
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp'])

/** Hogyan lesz a mellekletbol PDF (K-1.25); null: sehogy -- ezt az ellenorzes elore jelzi. */
export function annexPdfKind(name: string): 'pdf' | 'office' | 'image' | 'text' | null {
  const ext = (String(name || '').split('.').pop() || '').toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (officeExt(name)) return 'office'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (ext === 'txt' || ext === 'md') return 'text'
  return null
}

// ---------------------------------------------------------------------------
// Ellenorzes (K-1.18, K-1.22)
// ---------------------------------------------------------------------------

export interface AnnexCheck {
  total: number
  ok: number
  /** hivatkozva, de nincs ilyen melleklet */
  dangling: string[]
  /** melleklet, amire a szoveg nem hivatkozik */
  unreferenced: string[]
  /** melleklet, aminek a fajlja mar nincs meg */
  missing_files: string[]
  /** melleklet, amibol nem lehet PDF-et kesziteni (pl. e-mail, HEIC, hang) */
  unsupported: string[]
}

export function annexCheck(itemId: string, resolve?: FileResolver): AnnexCheck {
  const s = docSettings(itemId)
  const list = listAnnexes(itemId, resolve)
  const referenced = new Set<number>()
  for (const t of allTexts(itemId)) for (const n of annexRefs(t, s)) referenced.add(n)
  const dangling = [...referenced].filter((n) => n > list.length).sort((a, b) => a - b).map((n) => annexLabel(s, n))
  const unreferenced = list.filter((a) => a.refs === 0).map((a) => a.label)
  const missing = list.filter((a) => a.exists === false).map((a) => a.label)
  const unsupported = list.filter((a) => !annexPdfKind(a.name)).map((a) => a.label)
  const ok = list.filter((a) => a.refs > 0 && a.exists !== false && annexPdfKind(a.name)).length
  return { total: list.length, ok, dangling, unreferenced, missing_files: missing, unsupported }
}
