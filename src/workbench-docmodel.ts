/**
 * DOKUMENTUMMODELL ES FORRASRENDSZER (kanban #441, v4 spec 1/A, K-1.7 ... K-1.16, K-1.22).
 *
 * Egy hivatalos dokumentum (beadvany, level) EGY szerkezetben all (K-1.15):
 * fejezetek (cim + allapot) es bennuk blokkok (bekezdes, felsorolas,
 * tablazat, labjegyzet, alairasblokk). Ezt szerkeszti az agent ES a
 * tulajdonos is (K-1.16) -- ugyanazokkal a muveletekkel.
 *
 * A TENYALLITASOK (claim) egy blokk szovegenek szo szerinti reszei, es
 * mindegyikhez egy vagy tobb FORRAS tartozik (K-1.7), negy fajtaban:
 *
 *   1. document -- feltoltott irat: fajl + oldal + szo szerinti idezet. A
 *                  program ellenorzi (K-1.12), nem az agent onbevallasa.
 *   2. owner    -- a tulajdonos kozlese: a chatuzenet szovege es ideje. NEM
 *                  igazolt teny (K-1.9): csak a tulajdonos allitasonkenti,
 *                  kifejezett megerositesevel kerulhet a vegleges iratba, es
 *                  ezt csak a tulajdonos kattintasa adhatja meg, agent nem.
 *   3. official -- kulso hivatalos forras (jogszabaly, itelet): pontos
 *                  hivatkozas + cim + idezet. Amig nincs a hivatalos
 *                  forrasban ellenorizve, "Ellenorizetlen hivatkozas" (K-1.11).
 *   4. inference-- a Marvin kovetkeztetese: melyik allitasokra epul. TENYT NEM
 *                  IGAZOL (K-1.8), csak erveles lehet.
 *
 * Az allitas ereje a legerosebb IGAZOLT forrase (K-1.7). A veglegesites
 * elotti ellenorzes (`documentCheck`, K-1.22) ebbol szamol.
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolveLifePath } from './life-explorer.js'
import { getDb } from './db.js'
import { verifyQuote, normalizeForMatch, bestFuzzyMatch } from './workbench-docread.js'
import { annexCheck, type FileResolver } from './workbench-docannex.js'
import { consistencyIssues } from './workbench-doccheck.js'
import { variantCheckItems } from './workbench-doclang.js'

export const SECTION_STATUSES = ['todo', 'in_progress', 'done'] as const
export type SectionStatus = typeof SECTION_STATUSES[number]
export const BLOCK_KINDS = ['paragraph', 'list', 'table', 'footnote', 'signature', 'image'] as const
export type BlockKind = typeof BLOCK_KINDS[number]

/** Picture formats an `image` block can hold (the ones LibreOffice embeds in the PDF / Word copy). */
export const DOC_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif'])

/**
 * An `image` block's text is the picture's path under the Marveen folder (the same
 * `rel` the Uploads panel shows, Boss TG 2901). It must be a plain relative path to a
 * picture file: no `..`, no absolute path, a picture extension.
 */
export function imageBlockPathOk(text: string): boolean {
  const t = String(text || '').replace(/\\/g, '/')
  if (!t || t.startsWith('/') || /^[a-z]:/i.test(t) || t.split('/').some((x) => x === '..' || x === '.')) return false
  const ext = (t.split('.').pop() || '').toLowerCase()
  return DOC_IMAGE_EXT.has(ext)
}
export const SOURCE_KINDS = ['document', 'owner', 'official', 'inference'] as const
export type SourceKind = typeof SOURCE_KINDS[number]

/** Egy blokk szovegenek felso hatara (egy bekezdes, nem egy konyv). */
export const BLOCK_TEXT_MAX = 20_000
export const SECTION_TITLE_MAX = 200
export const SECTIONS_MAX = 200
export const BLOCKS_MAX = 2000

/**
 * A hiany-jelolesek (K-1.10). Az agent es a tulajdonos is ezt irja a
 * szovegbe, ahol adat vagy forras hianyzik; a piszkozatban latszik, a
 * vegleges irat nem keszulhet, amig van.
 */
export const MISSING_MARK_RE = /⚠\s*(Hiányzó adat|Forrás nem található|Missing data|Source not found)[^\n⚠]*/g

// ---------------------------------------------------------------------------
// Tablak
// ---------------------------------------------------------------------------

let tablesDb: unknown = null

export function ensureDocModelTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_sections (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_blocks (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      section_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      author TEXT NOT NULL,
      owner_edited_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_claims (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      block_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_sources (
      id TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      path TEXT,
      page INTEGER,
      quote TEXT,
      citation TEXT,
      url TEXT,
      retrieved_at TEXT,
      said TEXT,
      said_at INTEGER,
      message_id TEXT,
      based_on TEXT,
      verdict TEXT NOT NULL,
      detail TEXT,
      checked_at INTEGER,
      confirmed_at INTEGER,
      confirmed_by TEXT,
      confirmed_text TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  // ATIRASI JAVASLAT (K-1.20): blokkonkent legfeljebb egy; a tulajdonos fogadja el vagy veti el.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_rewrites (
      block_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      style TEXT NOT NULL,
      text TEXT NOT NULL,
      base_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_doc_sections_item ON wb_doc_sections(work_item_id, position)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_doc_blocks_section ON wb_doc_blocks(section_id, position)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_doc_claims_block ON wb_doc_claims(block_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_doc_sources_claim ON wb_doc_sources(claim_id)')
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)
const newId = (): string => randomUUID().slice(0, 12)

export interface SectionRow { id: string; work_item_id: string; position: number; title: string; status: SectionStatus; created_at: number; updated_at: number }
export interface BlockRow { id: string; work_item_id: string; section_id: string; position: number; kind: BlockKind; text: string; author: 'agent' | 'owner'; owner_edited_at: number | null; created_at: number; updated_at: number }
export interface ClaimRow { id: string; work_item_id: string; block_id: string; text: string; created_at: number; created_by: string | null }
export interface SourceRow {
  id: string; claim_id: string; kind: SourceKind
  path: string | null; page: number | null; quote: string | null
  citation: string | null; url: string | null; retrieved_at: string | null
  said: string | null; said_at: number | null; message_id: string | null
  based_on: string | null
  /** document: verified / low_page / other_page / not_found / pending; owner: recorded / not_in_chat;
   *  official: unverified / verified; inference: inference */
  verdict: string
  detail: string | null
  checked_at: number | null
  confirmed_at: number | null; confirmed_by: string | null; confirmed_text: string | null
  created_at: number
}

// ---------------------------------------------------------------------------
// Fejezetek es blokkok
// ---------------------------------------------------------------------------

export type ModelError = 'not_found' | 'bad_input' | 'too_many' | 'claim_not_in_text' | 'rewrite_stale'
export type ModelResult<T> = { ok: true } & T | { ok: false; code: ModelError; detail: string }

export function listSections(itemId: string): SectionRow[] {
  ensureDocModelTables()
  return getDb().prepare('SELECT * FROM wb_doc_sections WHERE work_item_id = ? ORDER BY position, created_at').all(itemId) as SectionRow[]
}

export function listBlocks(itemId: string): BlockRow[] {
  ensureDocModelTables()
  return getDb().prepare(`SELECT b.* FROM wb_doc_blocks b JOIN wb_doc_sections s ON s.id = b.section_id
    WHERE b.work_item_id = ? ORDER BY s.position, s.created_at, b.position, b.created_at`).all(itemId) as BlockRow[]
}

export function hasDocModel(itemId: string): boolean {
  ensureDocModelTables()
  return !!getDb().prepare('SELECT 1 FROM wb_doc_sections WHERE work_item_id = ? LIMIT 1').get(itemId)
}

function reorder(table: 'wb_doc_sections' | 'wb_doc_blocks', where: string, arg: string): void {
  const rows = getDb().prepare(`SELECT id FROM ${table} WHERE ${where} = ? ORDER BY position, created_at`).all(arg) as { id: string }[]
  const upd = getDb().prepare(`UPDATE ${table} SET position = ? WHERE id = ?`)
  rows.forEach((r, i) => upd.run(i, r.id))
}

export function addSection(itemId: string, rawTitle: unknown, opts: { position?: number; status?: unknown } = {}): ModelResult<{ section: SectionRow }> {
  ensureDocModelTables()
  const title = String(rawTitle ?? '').trim()
  if (!title || title.length > SECTION_TITLE_MAX) return { ok: false, code: 'bad_input', detail: `the title must be 1 to ${SECTION_TITLE_MAX} characters` }
  const existing = listSections(itemId)
  if (existing.length >= SECTIONS_MAX) return { ok: false, code: 'too_many', detail: `a document has at most ${SECTIONS_MAX} sections` }
  const status = SECTION_STATUSES.includes(opts.status as SectionStatus) ? opts.status as SectionStatus : 'todo'
  const pos = opts.position !== undefined && Number.isFinite(opts.position) ? Math.max(0, Math.min(existing.length, Math.floor(opts.position))) : existing.length
  const db = getDb()
  db.prepare('UPDATE wb_doc_sections SET position = position + 1 WHERE work_item_id = ? AND position >= ?').run(itemId, pos)
  const id = newId()
  db.prepare('INSERT INTO wb_doc_sections (id, work_item_id, position, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, itemId, pos, title, status, now(), now())
  reorder('wb_doc_sections', 'work_item_id', itemId)
  return { ok: true, section: getDb().prepare('SELECT * FROM wb_doc_sections WHERE id = ?').get(id) as SectionRow }
}

function getSection(itemId: string, id: string): SectionRow | undefined {
  return getDb().prepare('SELECT * FROM wb_doc_sections WHERE id = ? AND work_item_id = ?').get(id, itemId) as SectionRow | undefined
}

export function getBlock(itemId: string, id: string): BlockRow | undefined {
  ensureDocModelTables()
  return getDb().prepare('SELECT * FROM wb_doc_blocks WHERE id = ? AND work_item_id = ?').get(id, itemId) as BlockRow | undefined
}

export function updateSection(itemId: string, id: string, patch: { title?: unknown; status?: unknown; position?: unknown }): ModelResult<{ section: SectionRow }> {
  ensureDocModelTables()
  const s = getSection(itemId, String(id || ''))
  if (!s) return { ok: false, code: 'not_found', detail: 'no section with this id in this work item' }
  let title = s.title
  if (patch.title !== undefined && patch.title !== null) {
    title = String(patch.title).trim()
    if (!title || title.length > SECTION_TITLE_MAX) return { ok: false, code: 'bad_input', detail: `the title must be 1 to ${SECTION_TITLE_MAX} characters` }
  }
  let status = s.status
  if (patch.status !== undefined && patch.status !== null) {
    if (!SECTION_STATUSES.includes(patch.status as SectionStatus)) return { ok: false, code: 'bad_input', detail: `status must be one of ${SECTION_STATUSES.join(', ')}` }
    status = patch.status as SectionStatus
  }
  const db = getDb()
  db.prepare('UPDATE wb_doc_sections SET title = ?, status = ?, updated_at = ? WHERE id = ?').run(title, status, now(), s.id)
  if (patch.position !== undefined && patch.position !== null && Number.isFinite(Number(patch.position))) {
    const list = listSections(itemId).filter((x) => x.id !== s.id)
    const pos = Math.max(0, Math.min(list.length, Math.floor(Number(patch.position))))
    list.splice(pos, 0, s)
    const upd = db.prepare('UPDATE wb_doc_sections SET position = ? WHERE id = ?')
    list.forEach((x, i) => upd.run(i, x.id))
  }
  return { ok: true, section: getSection(itemId, s.id) as SectionRow }
}

/** Egy fejezet torlese a blokkjaival, allitasaival es forrasaival egyutt. */
export function removeSection(itemId: string, id: string): ModelResult<{ removed: string }> {
  ensureDocModelTables()
  const s = getSection(itemId, String(id || ''))
  if (!s) return { ok: false, code: 'not_found', detail: 'no section with this id in this work item' }
  const db = getDb()
  db.transaction(() => {
    for (const b of db.prepare('SELECT id FROM wb_doc_blocks WHERE section_id = ?').all(s.id) as { id: string }[]) dropBlockRows(b.id)
    db.prepare('DELETE FROM wb_doc_sections WHERE id = ?').run(s.id)
  })()
  reorder('wb_doc_sections', 'work_item_id', itemId)
  return { ok: true, removed: s.id }
}

function dropBlockRows(blockId: string): void {
  const db = getDb()
  for (const c of db.prepare('SELECT id FROM wb_doc_claims WHERE block_id = ?').all(blockId) as { id: string }[]) {
    db.prepare('DELETE FROM wb_doc_sources WHERE claim_id = ?').run(c.id)
  }
  db.prepare('DELETE FROM wb_doc_claims WHERE block_id = ?').run(blockId)
  db.prepare('DELETE FROM wb_doc_rewrites WHERE block_id = ?').run(blockId)
  db.prepare('DELETE FROM wb_doc_blocks WHERE id = ?').run(blockId)
}

export function addBlock(itemId: string, sectionId: string, input: { kind?: unknown; text?: unknown; position?: unknown; author: 'agent' | 'owner' }): ModelResult<{ block: BlockRow }> {
  ensureDocModelTables()
  const s = getSection(itemId, String(sectionId || ''))
  if (!s) return { ok: false, code: 'not_found', detail: 'no section with this id in this work item' }
  const kind = (input.kind === undefined || input.kind === null || input.kind === '') ? 'paragraph' : input.kind
  if (!BLOCK_KINDS.includes(kind as BlockKind)) return { ok: false, code: 'bad_input', detail: `kind must be one of ${BLOCK_KINDS.join(', ')}` }
  const text = String(input.text ?? '').replace(/\r\n/g, '\n').trim()
  if (!text || text.length > BLOCK_TEXT_MAX) return { ok: false, code: 'bad_input', detail: `the text must be 1 to ${BLOCK_TEXT_MAX} characters` }
  if (kind === 'image' && !imageBlockPathOk(text)) return { ok: false, code: 'bad_input', detail: `an image block's text is the picture's path under the Marveen folder (${[...DOC_IMAGE_EXT].join(', ')})` }
  const db = getDb()
  const count = (db.prepare('SELECT COUNT(*) AS n FROM wb_doc_blocks WHERE work_item_id = ?').get(itemId) as { n: number }).n
  if (count >= BLOCKS_MAX) return { ok: false, code: 'too_many', detail: `a document has at most ${BLOCKS_MAX} blocks` }
  const inSection = (db.prepare('SELECT COUNT(*) AS n FROM wb_doc_blocks WHERE section_id = ?').get(s.id) as { n: number }).n
  const want = Number(input.position)
  const pos = input.position !== undefined && input.position !== null && Number.isFinite(want) ? Math.max(0, Math.min(inSection, Math.floor(want))) : inSection
  db.prepare('UPDATE wb_doc_blocks SET position = position + 1 WHERE section_id = ? AND position >= ?').run(s.id, pos)
  const id = newId()
  db.prepare(`INSERT INTO wb_doc_blocks (id, work_item_id, section_id, position, kind, text, author, owner_edited_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, itemId, s.id, pos, kind, text, input.author, input.author === 'owner' ? now() : null, now(), now())
  reorder('wb_doc_blocks', 'section_id', s.id)
  return { ok: true, block: getBlock(itemId, id) as BlockRow }
}

/**
 * Blokk szovegenek atirasa. Azok az allitasok, amelyek szovege mar nem
 * szerepel a blokkban, torlodnek (a forrasaikkal): egy atirt mondathoz nem
 * maradhat ott a regi forras. Kezi atirasnal (K-1.16) a blokk "tulajdonos
 * irta" jelolest kap.
 */
export function updateBlock(itemId: string, id: string, input: { text?: unknown; kind?: unknown; section?: unknown; position?: unknown; author: 'agent' | 'owner' }): ModelResult<{ block: BlockRow; dropped_claims: number }> {
  ensureDocModelTables()
  const b = getBlock(itemId, String(id || ''))
  if (!b) return { ok: false, code: 'not_found', detail: 'no block with this id in this work item' }
  let text = b.text
  if (input.text !== undefined && input.text !== null) {
    text = String(input.text).replace(/\r\n/g, '\n').trim()
    if (!text || text.length > BLOCK_TEXT_MAX) return { ok: false, code: 'bad_input', detail: `the text must be 1 to ${BLOCK_TEXT_MAX} characters` }
  }
  let kind = b.kind
  if (input.kind !== undefined && input.kind !== null && input.kind !== '') {
    if (!BLOCK_KINDS.includes(input.kind as BlockKind)) return { ok: false, code: 'bad_input', detail: `kind must be one of ${BLOCK_KINDS.join(', ')}` }
    kind = input.kind as BlockKind
  }
  if (kind === 'image' && !imageBlockPathOk(text)) return { ok: false, code: 'bad_input', detail: `an image block's text is the picture's path under the Marveen folder (${[...DOC_IMAGE_EXT].join(', ')})` }
  // Moving (drag handle on the page): a new section and/or a new position inside it.
  const wantsMove = (input.section !== undefined && input.section !== null && input.section !== '') || (input.position !== undefined && input.position !== null && input.position !== '')
  let target: SectionRow | undefined
  if (wantsMove) {
    target = getSection(itemId, input.section !== undefined && input.section !== null && input.section !== '' ? String(input.section) : b.section_id)
    if (!target) return { ok: false, code: 'not_found', detail: 'no section with this id in this work item' }
  }
  const db = getDb()
  let dropped = 0
  db.transaction(() => {
    db.prepare('UPDATE wb_doc_blocks SET text = ?, kind = ?, updated_at = ?, owner_edited_at = CASE WHEN ? = \'owner\' AND ? = 1 THEN ? ELSE owner_edited_at END WHERE id = ?')
      .run(text, kind, now(), input.author, text !== b.text ? 1 : 0, now(), b.id)
    const norm = normalizeForMatch(text)
    for (const c of db.prepare('SELECT id, text FROM wb_doc_claims WHERE block_id = ?').all(b.id) as { id: string; text: string }[]) {
      if (!norm.includes(normalizeForMatch(c.text))) {
        db.prepare('DELETE FROM wb_doc_sources WHERE claim_id = ?').run(c.id)
        db.prepare('DELETE FROM wb_doc_claims WHERE id = ?').run(c.id)
        dropped++
      }
    }
    if (target) {
      const siblings = (db.prepare('SELECT * FROM wb_doc_blocks WHERE section_id = ? AND id != ? ORDER BY position').all(target.id, b.id) as BlockRow[])
      const want = Number(input.position)
      const pos = input.position !== undefined && input.position !== null && input.position !== '' && Number.isFinite(want)
        ? Math.max(0, Math.min(siblings.length, Math.floor(want))) : siblings.length
      siblings.splice(pos, 0, b)
      db.prepare('UPDATE wb_doc_blocks SET section_id = ? WHERE id = ?').run(target.id, b.id)
      const upd = db.prepare('UPDATE wb_doc_blocks SET position = ? WHERE id = ?')
      siblings.forEach((x, i) => upd.run(i, x.id))
      if (target.id !== b.section_id) reorder('wb_doc_blocks', 'section_id', b.section_id)
    }
  })()
  return { ok: true, block: getBlock(itemId, b.id) as BlockRow, dropped_claims: dropped }
}

export function removeBlock(itemId: string, id: string): ModelResult<{ removed: string }> {
  ensureDocModelTables()
  const b = getBlock(itemId, String(id || ''))
  if (!b) return { ok: false, code: 'not_found', detail: 'no block with this id in this work item' }
  getDb().transaction(() => dropBlockRows(b.id))()
  reorder('wb_doc_blocks', 'section_id', b.section_id)
  return { ok: true, removed: b.id }
}

// ---------------------------------------------------------------------------
// Allitasok es forrasok
// ---------------------------------------------------------------------------

export interface SourceInput {
  kind?: unknown
  /** document */
  path?: unknown; page?: unknown; quote?: unknown
  /** official */
  citation?: unknown; url?: unknown; retrieved_at?: unknown
  /** owner */
  said?: unknown
  /** inference: claim id-k */
  based_on?: unknown
}

/**
 * A kulvilag, amit a modell nem ismer: a projekt fajljai (egy projekt-
 * relativ utbol abszolut ut) es a tulajdonos chatuzenetei ennel a
 * munkadarabnal. A hivo adja (a Munkapad utvonala), hogy a modell tesztelheto
 * maradjon.
 */
export interface SourceWorld {
  resolveFile(path: string): { abs: string; name: string } | null
  ownerMessages(): { id: string; content: string; created_at: number }[]
}

/** Egy irat-forras gepi ellenorzese (K-1.12). */
function checkDocumentSource(world: SourceWorld, path: string, page: number, quote: string): { verdict: string; detail: string } {
  const f = world.resolveFile(path)
  if (!f) return { verdict: 'not_found', detail: 'the file is not in the project folder' }
  const r = verifyQuote(f.abs, f.name, page, quote)
  if (!r.ok) {
    if (r.code === 'processing') return { verdict: 'pending', detail: r.detail }
    return { verdict: r.code === 'bad_input' ? 'not_found' : 'pending', detail: r.detail }
  }
  return { verdict: String(r.data['verdict']), detail: String(r.data['result'] ?? '') }
}

/** A tulajdonos tenyleg mondta-e (a chatben, ennel a munkadarabnal): a legjobban egyezo uzenet. */
function findOwnerMessage(world: SourceWorld, said: string): { id: string; created_at: number; content: string } | null {
  const q = normalizeForMatch(said)
  if (q.length < 3) return null
  let best: { id: string; created_at: number; content: string; sim: number } | null = null
  for (const m of world.ownerMessages()) {
    const hay = normalizeForMatch(m.content)
    const sim = hay.includes(q) ? 1 : (q.length <= 600 && hay.length <= 20_000 ? bestFuzzyMatch(q, hay).similarity : 0)
    if (sim >= 0.9 && (!best || sim > best.sim || (sim === best.sim && m.created_at > best.created_at))) best = { ...m, sim }
  }
  return best
}

function insertSource(claimId: string, kind: SourceKind, f: Partial<SourceRow>): void {
  getDb().prepare(`INSERT INTO wb_doc_sources (id, claim_id, kind, path, page, quote, citation, url, retrieved_at, said, said_at, message_id,
      based_on, verdict, detail, checked_at, confirmed_at, confirmed_by, confirmed_text, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`)
    .run(newId(), claimId, kind, f.path ?? null, f.page ?? null, f.quote ?? null, f.citation ?? null, f.url ?? null, f.retrieved_at ?? null,
      f.said ?? null, f.said_at ?? null, f.message_id ?? null, f.based_on ?? null, f.verdict ?? 'pending', f.detail ?? null, f.checked_at ?? null, now())
}

/**
 * Egy tenyallitas a forrasaival. Az allitas szovegenek szo szerint szerepelnie
 * kell a blokkban (igy a felulet meg tudja jelolni). Forras nelkuli allitas
 * nincs (K-1.10: ilyenkor a szovegbe hiany-jeloles kerul, nem allitas).
 */
export function addClaim(itemId: string, blockId: string, rawText: unknown, sources: unknown, world: SourceWorld, createdBy: string | null): ModelResult<{ claim: ClaimView }> {
  ensureDocModelTables()
  const b = getBlock(itemId, String(blockId || ''))
  if (!b) return { ok: false, code: 'not_found', detail: 'no block with this id in this work item' }
  const text = String(rawText ?? '').trim()
  if (text.length < 3) return { ok: false, code: 'bad_input', detail: 'the claim text is required' }
  if (!normalizeForMatch(b.text).includes(normalizeForMatch(text))) {
    return { ok: false, code: 'claim_not_in_text', detail: 'the claim must be a verbatim part of the block text' }
  }
  const list = Array.isArray(sources) ? sources as SourceInput[] : []
  if (!list.length) return { ok: false, code: 'bad_input', detail: 'a claim needs at least one source; if there is none, write "⚠ Hiányzó adat: ..." into the text instead' }
  // Elobb minden forrast ellenorzunk, es csak ha mind ertelmes, irunk.
  const prepared: { kind: SourceKind; f: Partial<SourceRow> }[] = []
  for (const s of list) {
    const kind = String(s.kind ?? '') as SourceKind
    if (!SOURCE_KINDS.includes(kind)) return { ok: false, code: 'bad_input', detail: `source kind must be one of ${SOURCE_KINDS.join(', ')}` }
    if (kind === 'document') {
      const path = String(s.path ?? '').trim()
      const page = Math.floor(Number(s.page))
      const quote = String(s.quote ?? '').trim()
      if (!path || !(page >= 1) || quote.length < 4) return { ok: false, code: 'bad_input', detail: 'a document source needs path, page and a verbatim quote' }
      const c = checkDocumentSource(world, path, page, quote)
      prepared.push({ kind, f: { path, page, quote, verdict: c.verdict, detail: c.detail, checked_at: now() } })
    } else if (kind === 'owner') {
      const said = String(s.said ?? '').trim()
      if (said.length < 3) return { ok: false, code: 'bad_input', detail: 'an owner source needs the words the owner said (said)' }
      const m = findOwnerMessage(world, said)
      prepared.push({
        kind,
        f: m
          ? { said: m.content.slice(0, 4000), said_at: m.created_at, message_id: m.id, verdict: 'recorded', detail: 'the owner said this in the chat; not proven by any document' }
          : { said, verdict: 'not_in_chat', detail: 'no chat message of the owner contains this: ask the owner before you use it' },
      })
    } else if (kind === 'official') {
      const citation = String(s.citation ?? '').trim()
      const url = String(s.url ?? '').trim()
      if (!citation || !/^https?:\/\//i.test(url)) return { ok: false, code: 'bad_input', detail: 'an official source needs the exact citation and the URL of the official source' }
      prepared.push({
        kind,
        f: {
          citation, url, quote: String(s.quote ?? '').trim() || null, retrieved_at: String(s.retrieved_at ?? '').trim() || null,
          verdict: 'unverified', detail: 'not yet checked in the official source: shown as "⚠ Ellenőrizetlen hivatkozás"',
        },
      })
    } else {
      const ids = Array.isArray(s.based_on) ? (s.based_on as unknown[]).map((x) => String(x)) : []
      const known = ids.filter((cid) => getDb().prepare('SELECT 1 FROM wb_doc_claims WHERE id = ? AND work_item_id = ?').get(cid, itemId))
      if (!known.length) return { ok: false, code: 'bad_input', detail: 'an inference must name the claims (based_on: claim ids) it is built on' }
      prepared.push({ kind, f: { based_on: JSON.stringify(known), verdict: 'inference', detail: 'Marvin\'s own conclusion: reasoning, not a fact' } })
    }
  }
  const id = newId()
  const db = getDb()
  db.transaction(() => {
    db.prepare('INSERT INTO wb_doc_claims (id, work_item_id, block_id, text, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, itemId, b.id, text, now(), createdBy)
    for (const p of prepared) insertSource(id, p.kind, p.f)
  })()
  return { ok: true, claim: claimView(id) as ClaimView }
}

export type ClaimStrength = 'verified' | 'owner_confirmed' | 'owner_unconfirmed' | 'inference' | 'unverified'

export interface ClaimView extends ClaimRow {
  sources: SourceRow[]
  strength: ClaimStrength
}

/**
 * Az allitas ereje: a legerosebb IGAZOLT forrase (K-1.7). Sorrend: gepileg
 * igazolt irat vagy hivatalos forras > megerositett tulajdonosi kozles >
 * megerositetlen kozles; a kovetkeztetes tenyt nem igazol.
 */
export function claimStrength(sources: SourceRow[]): ClaimStrength {
  if (sources.some((s) => (s.kind === 'document' || s.kind === 'official') && s.verdict === 'verified')) return 'verified'
  if (sources.some((s) => s.kind === 'owner' && s.confirmed_at)) return 'owner_confirmed'
  if (sources.some((s) => s.kind === 'owner' && s.verdict === 'recorded')) return 'owner_unconfirmed'
  if (sources.length && sources.every((s) => s.kind === 'inference')) return 'inference'
  return 'unverified'
}

export function claimView(id: string): ClaimView | undefined {
  ensureDocModelTables()
  const c = getDb().prepare('SELECT * FROM wb_doc_claims WHERE id = ?').get(id) as ClaimRow | undefined
  if (!c) return undefined
  const sources = getDb().prepare('SELECT * FROM wb_doc_sources WHERE claim_id = ? ORDER BY created_at').all(id) as SourceRow[]
  return { ...c, sources, strength: claimStrength(sources) }
}

export function listClaims(itemId: string): ClaimView[] {
  ensureDocModelTables()
  const rows = getDb().prepare('SELECT id FROM wb_doc_claims WHERE work_item_id = ? ORDER BY created_at').all(itemId) as { id: string }[]
  return rows.map((r) => claimView(r.id) as ClaimView)
}

export function removeClaim(itemId: string, id: string): ModelResult<{ removed: string }> {
  ensureDocModelTables()
  const c = getDb().prepare('SELECT id FROM wb_doc_claims WHERE id = ? AND work_item_id = ?').get(String(id || ''), itemId) as { id: string } | undefined
  if (!c) return { ok: false, code: 'not_found', detail: 'no claim with this id in this work item' }
  getDb().transaction(() => {
    getDb().prepare('DELETE FROM wb_doc_sources WHERE claim_id = ?').run(c.id)
    getDb().prepare('DELETE FROM wb_doc_claims WHERE id = ?').run(c.id)
  })()
  return { ok: true, removed: c.id }
}

/** A kifejezett megerosites szovege (K-1.9); az altalanos "atneztem" nem ez. */
export const CONFIRM_TEXT = { hu: 'Igen, ezt vállalom, így kerüljön be.', en: 'Yes, I stand by this; include it as it is.' } as const

/**
 * A tulajdonos allitasonkenti megerositese (K-1.9). CSAK a tulajdonos
 * kattintasa hivhatja (a hivo utvonal ellenorzi), agent eszkoz nincs ra.
 */
export function confirmOwnerClaim(itemId: string, claimId: string, by: string | null, lang: 'hu' | 'en'): ModelResult<{ claim: ClaimView }> {
  ensureDocModelTables()
  const c = claimView(String(claimId || ''))
  if (!c || c.work_item_id !== itemId) return { ok: false, code: 'not_found', detail: 'no claim with this id in this work item' }
  const owner = c.sources.filter((s) => s.kind === 'owner')
  if (!owner.length) return { ok: false, code: 'bad_input', detail: 'this claim has no statement of the owner to confirm' }
  getDb().prepare('UPDATE wb_doc_sources SET confirmed_at = ?, confirmed_by = ?, confirmed_text = ? WHERE claim_id = ? AND kind = \'owner\'')
    .run(now(), by, CONFIRM_TEXT[lang], c.id)
  return { ok: true, claim: claimView(c.id) as ClaimView }
}

/** A meg fuggo (a feldolgozas alatt allo irat miatt meg nem ellenorzott) irat-forrasok ujraellenorzese. */
export function recheckPendingSources(itemId: string, world: SourceWorld): number {
  ensureDocModelTables()
  const rows = getDb().prepare(`SELECT s.* FROM wb_doc_sources s JOIN wb_doc_claims c ON c.id = s.claim_id
    WHERE c.work_item_id = ? AND s.kind = 'document' AND s.verdict = 'pending'`).all(itemId) as SourceRow[]
  let changed = 0
  for (const s of rows) {
    const r = checkDocumentSource(world, s.path || '', s.page || 0, s.quote || '')
    if (r.verdict !== 'pending') {
      getDb().prepare('UPDATE wb_doc_sources SET verdict = ?, detail = ?, checked_at = ? WHERE id = ?').run(r.verdict, r.detail, now(), s.id)
      changed++
    }
  }
  return changed
}

// ---------------------------------------------------------------------------
// Atirasi javaslat: "egyszerubben" / "hivatalosabban" (K-1.20)
// ---------------------------------------------------------------------------
//
// Az agent NEM irja at helyben a bekezdest: javaslatot tesz, amit a
// tulajdonos a vazlatban lat az eredeti mellett, es egy kattintassal elfogad
// vagy elvet (mint a Word / Google Docs "javaslat" modja). Igy semmi nem
// valtozik a hata mogott, es latja, ha egy forrasolt allitas kiesne.

export const REWRITE_STYLES = ['simpler', 'formal', 'other'] as const
export type RewriteStyle = typeof REWRITE_STYLES[number]
/** Csak szoveges blokkokat irunk at; a tablazat es az alairas szerkezet, nem stilus kerdese. */
export const REWRITABLE_KINDS: readonly BlockKind[] = ['paragraph', 'list', 'footnote']

export interface RewriteView {
  style: RewriteStyle
  text: string
  /** A bekezdes azota megvaltozott: a javaslat a regi szovegre szolt, nem fogadhato el. */
  stale: boolean
  /** Ezek a forrasolt allitasok esnenek ki (a szoveguk nincs benne a javaslatban). */
  would_drop: string[]
  created_at: number
  created_by: string | null
}

interface RewriteRow { block_id: string; work_item_id: string; style: RewriteStyle; text: string; base_text: string; created_at: number; created_by: string | null }

function droppedClaims(blockId: string, text: string): string[] {
  const norm = normalizeForMatch(text)
  return (getDb().prepare('SELECT text FROM wb_doc_claims WHERE block_id = ? ORDER BY created_at').all(blockId) as { text: string }[])
    .filter((c) => !norm.includes(normalizeForMatch(c.text))).map((c) => c.text)
}

function rewriteView(r: RewriteRow, blockText: string): RewriteView {
  return { style: r.style, text: r.text, stale: r.base_text !== blockText, would_drop: droppedClaims(r.block_id, r.text), created_at: r.created_at, created_by: r.created_by }
}

export function proposeRewrite(itemId: string, blockId: string, input: { text?: unknown; style?: unknown }, by: string | null): ModelResult<{ rewrite: RewriteView }> {
  ensureDocModelTables()
  const b = getBlock(itemId, String(blockId || ''))
  if (!b) return { ok: false, code: 'not_found', detail: 'no block with this id in this work item' }
  if (!REWRITABLE_KINDS.includes(b.kind)) return { ok: false, code: 'bad_input', detail: `only ${REWRITABLE_KINDS.join(', ')} blocks can be rewritten this way; edit a ${b.kind} with doc.updateBlock` }
  const text = String(input.text ?? '').replace(/\r\n/g, '\n').trim()
  if (!text || text.length > BLOCK_TEXT_MAX) return { ok: false, code: 'bad_input', detail: `the text must be 1 to ${BLOCK_TEXT_MAX} characters` }
  if (text === b.text) return { ok: false, code: 'bad_input', detail: 'the proposal is the same as the current text' }
  const style = REWRITE_STYLES.includes(input.style as RewriteStyle) ? input.style as RewriteStyle : 'other'
  getDb().prepare(`INSERT INTO wb_doc_rewrites (block_id, work_item_id, style, text, base_text, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(block_id) DO UPDATE SET style = excluded.style, text = excluded.text, base_text = excluded.base_text, created_at = excluded.created_at, created_by = excluded.created_by`)
    .run(b.id, itemId, style, text, b.text, now(), by)
  return { ok: true, rewrite: rewriteView(getDb().prepare('SELECT * FROM wb_doc_rewrites WHERE block_id = ?').get(b.id) as RewriteRow, b.text) }
}

/**
 * A javaslat elfogadasa: CSAK a tulajdonos kattintasa (a hivo utvonal
 * ellenorzi). A szoveget az agent irta, ezert a blokk szerzoje nem valtozik
 * "tulajdonos irta"-ra; a kieso allitasok a forrasaikkal egyutt kiesnek (ezt
 * a felulet elore mutatta).
 */
export function acceptRewrite(itemId: string, blockId: string): ModelResult<{ block: BlockRow; dropped_claims: number }> {
  ensureDocModelTables()
  const b = getBlock(itemId, String(blockId || ''))
  const r = b ? getDb().prepare('SELECT * FROM wb_doc_rewrites WHERE block_id = ?').get(b.id) as RewriteRow | undefined : undefined
  if (!b || !r) return { ok: false, code: 'not_found', detail: 'no rewrite proposal for this block' }
  if (r.base_text !== b.text) return { ok: false, code: 'rewrite_stale', detail: 'the block changed since the proposal was made' }
  const out = updateBlock(itemId, b.id, { text: r.text, author: 'agent' })
  if (out.ok) getDb().prepare('DELETE FROM wb_doc_rewrites WHERE block_id = ?').run(b.id)
  return out
}

export function dismissRewrite(itemId: string, blockId: string): ModelResult<{ removed: string }> {
  ensureDocModelTables()
  const r = getDb().prepare('DELETE FROM wb_doc_rewrites WHERE block_id = ? AND work_item_id = ?').run(String(blockId || ''), itemId)
  return r.changes ? { ok: true, removed: String(blockId) } : { ok: false, code: 'not_found', detail: 'no rewrite proposal for this block' }
}

// ---------------------------------------------------------------------------
// A teljes nezet es a veglegesites elotti ellenorzes (K-1.14, K-1.22)
// ---------------------------------------------------------------------------

export interface SectionView extends SectionRow {
  blocks: (BlockRow & { claims: ClaimView[]; missing: string[]; rewrite: RewriteView | null })[]
  /** Hiany-jelolesek + nem igazolt allitasok szama a fejezetben. */
  problems: number
}

export function missingMarks(text: string): string[] {
  return (text.match(MISSING_MARK_RE) || []).map((m) => m.trim())
}

export function documentOutline(itemId: string): { sections: SectionView[] } {
  ensureDocModelTables()
  const claims = listClaims(itemId)
  const blocks = listBlocks(itemId)
  const rewrites = new Map((getDb().prepare('SELECT * FROM wb_doc_rewrites WHERE work_item_id = ?').all(itemId) as RewriteRow[]).map((r) => [r.block_id, r]))
  const sections = listSections(itemId).map((s) => {
    const bs = blocks.filter((b) => b.section_id === s.id).map((b) => {
      const rw = rewrites.get(b.id)
      return { ...b, claims: claims.filter((c) => c.block_id === b.id), missing: missingMarks(b.text), rewrite: rw ? rewriteView(rw, b.text) : null }
    })
    const problems = bs.reduce((n, b) => n + b.missing.length + b.claims.filter((c) => c.strength === 'unverified').length, 0)
    return { ...s, blocks: bs, problems }
  })
  return { sections }
}

export interface CheckItem { key: string; ok: boolean; count: number; total?: number; detail?: string[] }

/**
 * A VEGLEGESITES elotti ellenorzes (K-1.22). Minden sor egy feltetel; a
 * dokumentum csak akkor veglegesitheto, ha mindegyik `ok`. A tulajdonos
 * sajat kezzel irt blokkjai tajekoztatasul szerepelnek (a sajat szavaiert
 * felel), nem akadalyoznak.
 */
export function documentCheck(itemId: string, resolve?: FileResolver): { ready: boolean; items: CheckItem[] } {
  const { sections } = documentOutline(itemId)
  const claims = sections.flatMap((s) => s.blocks.flatMap((b) => b.claims))
  const blocks = sections.flatMap((s) => s.blocks)
  const sources = claims.flatMap((c) => c.sources)
  const docSources = sources.filter((s) => s.kind === 'document')
  const docBad = docSources.filter((s) => s.verdict !== 'verified')
  const official = sources.filter((s) => s.kind === 'official')
  const officialBad = official.filter((s) => s.verdict !== 'verified')
  const ownerClaims = claims.filter((c) => c.sources.some((s) => s.kind === 'owner'))
  const ownerUnconfirmed = ownerClaims.filter((c) => !c.sources.some((s) => s.kind === 'owner' && s.confirmed_at) && c.strength !== 'verified')
  const inferenceOnly = claims.filter((c) => c.strength === 'inference')
  const unsupported = claims.filter((c) => c.strength === 'unverified')
  const missing = blocks.flatMap((b) => b.missing)
  const notDone = sections.filter((s) => s.status !== 'done')
  const items: CheckItem[] = [
    { key: 'sections_done', ok: sections.length > 0 && notDone.length === 0, count: sections.length - notDone.length, total: sections.length, detail: notDone.map((s) => s.title) },
    { key: 'missing_data', ok: missing.length === 0, count: missing.length, detail: missing },
    { key: 'unverified_references', ok: officialBad.length === 0, count: officialBad.length, total: official.length, detail: officialBad.map((s) => s.citation || '') },
    {
      key: 'quotes_verified', ok: docBad.length === 0, count: docSources.length - docBad.length, total: docSources.length,
      detail: docBad.map((s) => `${s.path}:${s.page} -- ${s.verdict}`),
    },
    { key: 'owner_statements', ok: ownerUnconfirmed.length === 0, count: ownerClaims.length - ownerUnconfirmed.length, total: ownerClaims.length, detail: ownerUnconfirmed.map((c) => c.text) },
    { key: 'unsupported_claims', ok: unsupported.length === 0, count: unsupported.length, detail: unsupported.map((c) => c.text) },
    { key: 'inference_as_fact', ok: true, count: inferenceOnly.length, detail: inferenceOnly.map((c) => c.text) },
    { key: 'owner_written', ok: true, count: blocks.filter((b) => b.owner_edited_at).length },
  ]
  // MELLEKLETEK (K-1.18): csak ha van melleklet, vagy a szoveg hivatkozik egyre.
  const ax = annexCheck(itemId, resolve)
  if (ax.total || ax.dangling.length) {
    items.push({ key: 'annexes', ok: ax.ok === ax.total && !ax.dangling.length, count: ax.ok, total: ax.total })
    if (ax.unreferenced.length) items.push({ key: 'annex_unreferenced', ok: false, count: ax.unreferenced.length, detail: ax.unreferenced })
    if (ax.dangling.length) items.push({ key: 'annex_dangling', ok: false, count: ax.dangling.length, detail: ax.dangling })
    if (ax.missing_files.length) items.push({ key: 'annex_missing_file', ok: false, count: ax.missing_files.length, detail: ax.missing_files })
    if (ax.unsupported.length) items.push({ key: 'annex_unsupported', ok: false, count: ax.unsupported.length, detail: ax.unsupported })
  }
  // PICTURES (Boss TG 2901): a picture block whose file is gone would end up as a warning line in the final PDF.
  const pics = blocks.filter((b) => b.kind === 'image')
  if (pics.length) {
    const gone = pics.filter((b) => { const abs = resolveLifePath(b.text); return !abs || !existsSync(abs) }).map((b) => b.text.split('/').pop() || b.text)
    items.push({ key: 'image_missing_file', ok: gone.length === 0, count: gone.length, total: pics.length, detail: gone })
  }
  // KOVETKEZETESSEG (K-1.19): nevek, ugyszam, datumok, osszegek, cimek. A tulajdonos
  // altal szandekosnak jelolt elteres nem allitja meg a veglegesitest.
  const cons = consistencyIssues(itemId)
  const open = cons.filter((i) => !i.acked)
  items.push({ key: 'consistency', ok: open.length === 0, count: open.length, total: cons.length, detail: open.map((i) => `${i.kind}: ${i.values.join(' / ')}`) })
  // NYELVI VALTOZAT (K-1.28): leforditatlan vagy elavult fejezettel nem veglegesitheto.
  items.push(...variantCheckItems(itemId))
  return { ready: items.every((i) => i.ok), items }
}
