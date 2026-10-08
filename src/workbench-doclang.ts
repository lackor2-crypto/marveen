/**
 * NYELVI VALTOZATOK (kanban #441, v4 spec 1/B, K-1.27 ... K-1.31).
 *
 * - "+ Nyelvi valtozat" (K-1.27): KULON munkadarab (sajat vazlat, sajat
 *   PDF/DOCX, sajat veglegesites), de FEJEZETENKENT OSSZEKOTVE az eredetivel:
 *   minden valtozat-fejezet tudja, melyik eredeti fejezetbol keszult, es az
 *   eredeti fejezet akkori tartalmanak ujjlenyomatat.
 * - ELAVULAS (K-1.28): ha az eredeti fejezet tartalma azota mas, a
 *   valtozat fejezete "⚠ Elavult -- az eredeti megvaltozott"; a frissitest az
 *   agent vegzi (ujraforditas), a gombot a tulajdonos nyomja.
 * - SZOSZEDET (K-1.29): ugyenkent (projektenkent) rogzitett forditasok
 *   ("Klage -> keresetlevel"). A forditas mentesekor GEPI ellenorzes: ha egy
 *   szoszedet-kifejezes az eredetiben szerepel, a forditasban a rogzitett
 *   forditasa kell alljon -- kulonben figyelmeztetes.
 * - VISSZAFORDITAS (K-1.30, opcionalis): az agent a valtozat fejezetet
 *   visszaforditja az eredeti nyelvere; a felulet az eredeti melle teszi, igy
 *   a tulajdonos a celnyelv ismerete nelkul is ellenorizhet.
 * - FORRASOK (K-1.31): a forditott allitas UGYANARRA a forrasra mutat: a
 *   forrasrekordok (irat + oldal + idezet, tulajdonosi kozles a
 *   megerositesevel, hivatalos forras, kovetkeztetes) atmasolodnak, az
 *   allitas szovege a forditas szo szerinti resze.
 */
import { createHash, randomUUID } from 'node:crypto'
import { getDb } from './db.js'
import {
  addBlock, addSection, ensureDocModelTables, listBlocks, listSections, removeBlock, updateSection,
  BLOCK_KINDS, BLOCK_TEXT_MAX, SECTION_TITLE_MAX,
  type BlockKind, type CheckItem, type ModelResult, type SectionRow, type SourceRow,
} from './workbench-docmodel.js'
import { normalizeForMatch } from './workbench-docread.js'
import { createWorkItem, getWorkItem, type WorkItemRow } from './workbench.js'
import { assignWorkItemFolder } from './workbench-assets.js'
import { projectFileTarget } from './project-files.js'
import { getProject } from './projects.js'

/** A felkinalt nyelvek; mas nyelv is lehet (ISO 639-1 kod). */
export const VARIANT_LANGS = ['hu', 'de', 'en'] as const
const LANG_RE = /^[a-z]{2}$/
export const LANG_NAMES: Record<string, { hu: string; en: string; self: string }> = {
  hu: { hu: 'magyar', en: 'Hungarian', self: 'magyar' },
  de: { hu: 'német', en: 'German', self: 'Deutsch' },
  en: { hu: 'angol', en: 'English', self: 'English' },
  fr: { hu: 'francia', en: 'French', self: 'français' },
  it: { hu: 'olasz', en: 'Italian', self: 'italiano' },
  es: { hu: 'spanyol', en: 'Spanish', self: 'español' },
  sk: { hu: 'szlovák', en: 'Slovak', self: 'slovenčina' },
  ro: { hu: 'román', en: 'Romanian', self: 'română' },
  pl: { hu: 'lengyel', en: 'Polish', self: 'polski' },
}
export const GLOSSARY_MAX = 500
const TERM_MAX = 200

let tablesDb: unknown = null

export function ensureDocLangTables(): void {
  ensureDocModelTables()
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_variants (
      work_item_id TEXT PRIMARY KEY,
      source_item_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_doc_variants_source ON wb_doc_variants(source_item_id)')
  // A valtozat egy fejezete -> az eredeti fejezet, es annak tartalma a forditaskor ('' = meg nincs leforditva).
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_section_links (
      section_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      source_section_id TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      translated_at INTEGER,
      translated_by TEXT
    )
  `)
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_glossary (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lang TEXT NOT NULL,
      term TEXT NOT NULL,
      translation TEXT NOT NULL,
      note TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_wb_doc_glossary_project ON wb_doc_glossary(project_id, lang)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_backchecks (
      section_id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      text TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      created_by TEXT
    )
  `)
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)
const newId = (): string => randomUUID().slice(0, 12)

export function langName(code: string, ui: 'hu' | 'en'): string {
  return LANG_NAMES[code]?.[ui] ?? code.toUpperCase()
}

/** Egy fejezet tartalmanak ujjlenyomata: cim + blokkok (fajta, szoveg). Az allapot (kesz/folyamatban) nem szamit. */
export function sectionHash(sectionId: string): string {
  ensureDocModelTables()
  const s = getDb().prepare('SELECT title FROM wb_doc_sections WHERE id = ?').get(sectionId) as { title: string } | undefined
  if (!s) return 'missing'
  const blocks = getDb().prepare('SELECT kind, text FROM wb_doc_blocks WHERE section_id = ? ORDER BY position, created_at').all(sectionId) as { kind: string; text: string }[]
  return createHash('sha256').update(JSON.stringify({ t: s.title, b: blocks.map((b) => [b.kind, b.text]) })).digest('hex')
}

interface VariantRow { work_item_id: string; source_item_id: string; lang: string; created_at: number; created_by: string | null }
interface LinkRow { section_id: string; work_item_id: string; source_section_id: string; source_hash: string; translated_at: number | null; translated_by: string | null }

export function variantOf(itemId: string): VariantRow | null {
  ensureDocLangTables()
  return (getDb().prepare('SELECT * FROM wb_doc_variants WHERE work_item_id = ?').get(itemId) as VariantRow | undefined) ?? null
}

/** Egy valtozat fejezeteinek osszekotese az eredetivel: az eredeti uj fejezetei helyorzot kapnak. */
function syncSections(variantId: string, sourceId: string): void {
  // A valtozatbol torolt fejezet osszekotese is megy: az eredeti fejezete ujra "leforditando" lesz.
  getDb().prepare('DELETE FROM wb_doc_section_links WHERE work_item_id = ? AND section_id NOT IN (SELECT id FROM wb_doc_sections WHERE work_item_id = ?)').run(variantId, variantId)
  const links = new Map((getDb().prepare('SELECT * FROM wb_doc_section_links WHERE work_item_id = ?').all(variantId) as LinkRow[]).map((l) => [l.source_section_id, l]))
  const src = listSections(sourceId)
  src.forEach((s, i) => {
    if (links.has(s.id)) return
    const r = addSection(variantId, s.title, { position: i, status: 'todo' })
    if (r.ok) {
      getDb().prepare('INSERT INTO wb_doc_section_links (section_id, work_item_id, source_section_id, source_hash, translated_at, translated_by) VALUES (?, ?, ?, \'\', NULL, NULL)')
        .run(r.section.id, variantId, s.id)
    }
  })
}

/** Az ugyanabbol a munkadarabbol keszult valtozatok. */
export function listVariants(sourceItemId: string): VariantRow[] {
  ensureDocLangTables()
  return getDb().prepare('SELECT * FROM wb_doc_variants WHERE source_item_id = ? ORDER BY created_at').all(sourceItemId) as VariantRow[]
}

export type CreateVariantResult =
  | { ok: true; item: WorkItemRow; existing: boolean }
  | { ok: false; code: 'bad_input' | 'outline_empty' | 'variant_of_variant'; detail: string }

/**
 * Uj nyelvi valtozat (K-1.27): kulon munkadarab ugyanabban a projektben, az
 * eredeti fejezeteinek helyorzoivel (leforditatlan). Ugyanarra a nyelvre
 * masodszor nem keszul uj: a meglevot adjuk vissza. Valtozatbol nem keszul
 * valtozat -- mindig az eredetibol forditunk.
 */
export function createVariant(source: WorkItemRow, rawLang: unknown, by: string | null): CreateVariantResult {
  ensureDocLangTables()
  const lang = String(rawLang ?? '').trim().toLowerCase()
  if (!LANG_RE.test(lang)) return { ok: false, code: 'bad_input', detail: 'lang must be a two-letter language code (hu, de, en, ...)' }
  if (variantOf(source.id)) return { ok: false, code: 'variant_of_variant', detail: 'this is already a language version; make the new one from the original' }
  if (!listSections(source.id).length) return { ok: false, code: 'outline_empty', detail: 'the original has no outline yet' }
  const had = listVariants(source.id).find((v) => v.lang === lang)
  if (had) {
    const it = getWorkItem(had.work_item_id)
    if (it && !it.deleted_at) { syncSections(it.id, source.id); return { ok: true, item: it, existing: true } }
  }
  const title = `${source.title} (${lang.toUpperCase()})`.slice(0, 200)
  // Boss TG 3049/3060: the language version lives in the SAME folder as the original (no new folder, not a
  // sub-folder): it takes over the original's folder; only an original without a usable folder falls back to
  // the container it was made in.
  const w = createWorkItem({ project_id: source.project_id, title, type: 'document', created_by: by, container_folder: source.container_folder ?? null })
  if (!w.ok) return { ok: false, code: 'bad_input', detail: w.code }
  const project = source.folder ? getProject(source.project_id) : null
  if (project && source.folder && projectFileTarget(project, source.folder).ok) {
    assignWorkItemFolder(w.item.id, source.folder)
    w.item.folder = source.folder
  }
  getDb().prepare('INSERT OR REPLACE INTO wb_doc_variants (work_item_id, source_item_id, lang, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
    .run(w.item.id, source.id, lang, now(), by)
  syncSections(w.item.id, source.id)
  return { ok: true, item: w.item, existing: false }
}

export interface VariantSectionState {
  section_id: string
  source_section_id: string
  source_title: string | null
  state: 'untranslated' | 'current' | 'stale' | 'source_removed'
  translated_at: number | null
}

export interface VariantInfo {
  source_item_id: string
  source_title: string | null
  lang: string
  sections: VariantSectionState[]
  /** Az eredeti fejezetei, amelyek meg nincsenek a valtozatban (azota kerultek bele). */
  new_in_source: { id: string; title: string }[]
}

/** Egy valtozat allapota fejezetenkent (K-1.28). */
export function variantInfo(itemId: string): VariantInfo | null {
  const v = variantOf(itemId)
  if (!v) return null
  const src = getWorkItem(v.source_item_id)
  const srcSections = new Map(listSections(v.source_item_id).map((s) => [s.id, s]))
  const mine = new Set(listSections(itemId).map((s) => s.id))
  // Csak az ELO osszekotes szamit: ha a valtozatbol kezzel toroltek egy fejezetet,
  // az eredeti parja ujra "meg nincs itt" lesz, nem tunik el a nyilvantartasbol.
  const links = (getDb().prepare('SELECT * FROM wb_doc_section_links WHERE work_item_id = ?').all(itemId) as LinkRow[]).filter((l) => mine.has(l.section_id))
  const linked = new Set(links.map((l) => l.source_section_id))
  const sections = links.map((l): VariantSectionState => {
    const s = srcSections.get(l.source_section_id)
    const state = !s ? 'source_removed' : !l.source_hash ? 'untranslated' : l.source_hash === sectionHash(s.id) ? 'current' : 'stale'
    return { section_id: l.section_id, source_section_id: l.source_section_id, source_title: s ? s.title : null, state, translated_at: l.translated_at }
  })
  const newIn = [...srcSections.values()].filter((s) => !linked.has(s.id)).map((s) => ({ id: s.id, title: s.title }))
  return { source_item_id: v.source_item_id, source_title: src && !src.deleted_at ? src.title : null, lang: v.lang, sections, new_in_source: newIn }
}

/** Az eredeti vazlat melle: a valtozatai, es hany fejezetuk elavult vagy leforditatlan. */
export function variantsSummary(sourceItemId: string): { item_id: string; title: string; lang: string; stale: number; untranslated: number }[] {
  return listVariants(sourceItemId).map((v) => {
    const it = getWorkItem(v.work_item_id)
    if (!it || it.deleted_at) return null
    const info = variantInfo(v.work_item_id)
    const secs = info ? info.sections : []
    return {
      item_id: v.work_item_id, title: it.title, lang: v.lang,
      stale: secs.filter((s) => s.state === 'stale' || s.state === 'source_removed').length,
      untranslated: secs.filter((s) => s.state === 'untranslated').length + (info ? info.new_in_source.length : 0),
    }
  }).filter((x): x is NonNullable<typeof x> => !!x)
}

// ---------------------------------------------------------------------------
// Szoszedet (K-1.29)
// ---------------------------------------------------------------------------

export interface GlossaryRow { id: string; project_id: string; lang: string; term: string; translation: string; note: string | null; created_at: number; created_by: string | null }

export function listGlossary(projectId: string, lang?: string): GlossaryRow[] {
  ensureDocLangTables()
  return lang
    ? getDb().prepare('SELECT * FROM wb_doc_glossary WHERE project_id = ? AND lang = ? ORDER BY term COLLATE NOCASE').all(projectId, lang) as GlossaryRow[]
    : getDb().prepare('SELECT * FROM wb_doc_glossary WHERE project_id = ? ORDER BY lang, term COLLATE NOCASE').all(projectId) as GlossaryRow[]
}

/** Egy kifejezes rogzitese; ugyanaz a kifejezes ugyanarra a nyelvre felulirja a regit. */
export function addGlossaryTerm(projectId: string, input: { term?: unknown; translation?: unknown; lang?: unknown; note?: unknown }, by: string | null): ModelResult<{ term: GlossaryRow }> {
  ensureDocLangTables()
  const term = String(input.term ?? '').trim()
  const translation = String(input.translation ?? '').trim()
  const lang = String(input.lang ?? '').trim().toLowerCase()
  if (!term || !translation || term.length > TERM_MAX || translation.length > TERM_MAX) return { ok: false, code: 'bad_input', detail: `term and translation are required, at most ${TERM_MAX} characters each` }
  if (!LANG_RE.test(lang)) return { ok: false, code: 'bad_input', detail: 'lang must be the two-letter code of the language of the translation' }
  const note = String(input.note ?? '').trim().slice(0, 500) || null
  const db = getDb()
  const same = (db.prepare('SELECT id, term FROM wb_doc_glossary WHERE project_id = ? AND lang = ?').all(projectId, lang) as { id: string; term: string }[])
    .find((r) => normalizeForMatch(r.term) === normalizeForMatch(term))
  if (!same && (db.prepare('SELECT COUNT(*) AS n FROM wb_doc_glossary WHERE project_id = ?').get(projectId) as { n: number }).n >= GLOSSARY_MAX) {
    return { ok: false, code: 'too_many', detail: `a case has at most ${GLOSSARY_MAX} glossary terms` }
  }
  const id = same ? same.id : newId()
  if (same) db.prepare('UPDATE wb_doc_glossary SET term = ?, translation = ?, note = ?, created_at = ?, created_by = ? WHERE id = ?').run(term, translation, note, now(), by, id)
  else db.prepare('INSERT INTO wb_doc_glossary (id, project_id, lang, term, translation, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, lang, term, translation, note, now(), by)
  return { ok: true, term: db.prepare('SELECT * FROM wb_doc_glossary WHERE id = ?').get(id) as GlossaryRow }
}

export function removeGlossaryTerm(projectId: string, id: string): ModelResult<{ removed: string }> {
  ensureDocLangTables()
  const r = getDb().prepare('DELETE FROM wb_doc_glossary WHERE id = ? AND project_id = ?').run(String(id || ''), projectId)
  return r.changes ? { ok: true, removed: String(id) } : { ok: false, code: 'not_found', detail: 'no glossary term with this id in this case' }
}

/** Egy szo(szerkezet) szerepel-e a szovegben -- szohatarral, kis/nagybetu es ekezet-normalizalassal. */
function containsTerm(text: string, term: string): boolean {
  const t = normalizeForMatch(term)
  if (!t) return false
  const hay = ` ${normalizeForMatch(text)} `
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Toldalekolt alak (keresetlevelet, Klagen) is talalat: a kifejezes ELEJE szohatarra essen.
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}`, 'u').test(hay)
}

/** A szoszedet gepi ellenorzese egy forditasra: ahol az eredetiben a kifejezes all, a forditasban a rogzitett forditasa kell. */
export function glossaryIssues(projectId: string, lang: string, sourceText: string, translated: string): { term: string; translation: string }[] {
  return listGlossary(projectId, lang)
    .filter((g) => containsTerm(sourceText, g.term) && !containsTerm(translated, g.translation))
    .map((g) => ({ term: g.term, translation: g.translation }))
}

// ---------------------------------------------------------------------------
// Forditas mentese fejezetenkent (K-1.27, K-1.28, K-1.31)
// ---------------------------------------------------------------------------

export interface TranslatedBlockInput {
  kind?: unknown
  text?: unknown
  /** Az eredeti allitasai a forditasban: melyik eredeti allitas (id) melyik szo szerinti resz lett. */
  claims?: unknown
}

export interface TranslateOutcome {
  section_id: string
  blocks: number
  claims_carried: number
  /** Az eredeti fejezet allitasai, amelyek NEM kerultek at (nem adtad meg, vagy a szoveguk nincs a forditasban). */
  claims_not_carried: { id: string; text: string; reason: string }[]
  glossary_issues: { term: string; translation: string }[]
}

function sectionText(sectionId: string): string {
  const s = getDb().prepare('SELECT title FROM wb_doc_sections WHERE id = ?').get(sectionId) as { title: string } | undefined
  const b = getDb().prepare('SELECT text FROM wb_doc_blocks WHERE section_id = ? ORDER BY position, created_at').all(sectionId) as { text: string }[]
  return [s?.title ?? '', ...b.map((x) => x.text)].join('\n\n')
}

/**
 * Egy eredeti fejezet forditasanak mentese a valtozatba: a valtozat fejezete
 * (ha nincs meg, letrejon) cimet es blokkjait CSERELJUK a forditasra, az
 * allitasok a forrasaikkal atmasolodnak, es az osszekotes az eredeti MOSTANI
 * tartalmat rogziti (igy all vissza "friss"-re egy elavult fejezet).
 */
export function translateSection(variantId: string, input: { source_section?: unknown; title?: unknown; blocks?: unknown }, by: string | null): ModelResult<{ result: TranslateOutcome }> {
  ensureDocLangTables()
  const v = variantOf(variantId)
  if (!v) return { ok: false, code: 'bad_input', detail: 'this work item is not a language version; create one with doc.createVariant from the original' }
  const src = getDb().prepare('SELECT * FROM wb_doc_sections WHERE id = ? AND work_item_id = ?').get(String(input.source_section ?? ''), v.source_item_id) as SectionRow | undefined
  if (!src) return { ok: false, code: 'not_found', detail: 'source_section must be a section id of the ORIGINAL document (see doc.outline with id = the original)' }
  const title = String(input.title ?? '').trim()
  if (!title || title.length > SECTION_TITLE_MAX) return { ok: false, code: 'bad_input', detail: `the translated title must be 1 to ${SECTION_TITLE_MAX} characters` }
  const raw = Array.isArray(input.blocks) ? input.blocks as TranslatedBlockInput[] : []
  // Egy csak cimbol allo eredeti fejezet forditasa maga a cim: blokk nelkul is mentheto.
  const srcBlocks = (getDb().prepare('SELECT COUNT(*) AS n FROM wb_doc_blocks WHERE section_id = ?').get(src.id) as { n: number }).n
  if (!raw.length && srcBlocks > 0) return { ok: false, code: 'bad_input', detail: 'blocks: the translated blocks of the section, in order ({kind, text, claims: [{source_claim, text}]}); blocks: [] only when the original section has no blocks' }
  const blocks: { kind: BlockKind; text: string; claims: { source_claim: string; text: string }[] }[] = []
  for (const b of raw) {
    const kind = (b.kind === undefined || b.kind === null || b.kind === '') ? 'paragraph' : String(b.kind)
    if (!BLOCK_KINDS.includes(kind as BlockKind)) return { ok: false, code: 'bad_input', detail: `kind must be one of ${BLOCK_KINDS.join(', ')}` }
    const text = String(b.text ?? '').replace(/\r\n/g, '\n').trim()
    if (!text || text.length > BLOCK_TEXT_MAX) return { ok: false, code: 'bad_input', detail: `each block text must be 1 to ${BLOCK_TEXT_MAX} characters` }
    const cl = (Array.isArray(b.claims) ? b.claims as { source_claim?: unknown; text?: unknown }[] : [])
      .map((c) => ({ source_claim: String(c.source_claim ?? ''), text: String(c.text ?? '').trim() }))
    blocks.push({ kind: kind as BlockKind, text, claims: cl })
  }
  const db = getDb()
  const srcClaims = db.prepare(`SELECT c.id, c.text, c.created_by FROM wb_doc_claims c JOIN wb_doc_blocks b ON b.id = c.block_id
    WHERE b.section_id = ? ORDER BY c.created_at`).all(src.id) as { id: string; text: string; created_by: string | null }[]
  const srcClaimIds = new Set(srcClaims.map((c) => c.id))

  const box: { out: TranslateOutcome | null; failed: { code: 'not_found' | 'bad_input' | 'too_many'; detail: string } | null } = { out: null, failed: null }
  const run = db.transaction(() => {
    syncSections(variantId, v.source_item_id)
    const link = db.prepare('SELECT * FROM wb_doc_section_links WHERE work_item_id = ? AND source_section_id = ?').get(variantId, src.id) as LinkRow | undefined
    if (!link) { box.failed = { code: 'not_found', detail: 'the section could not be linked' }; throw new Error('rollback') }
    const secId = link.section_id
    updateSection(variantId, secId, { title, status: src.status })
    for (const b of listBlocks(variantId).filter((x) => x.section_id === secId)) removeBlock(variantId, b.id)
    const carried = new Map<string, string>()
    const notCarried: TranslateOutcome['claims_not_carried'] = []
    const pendingInference: { newClaim: string; basedOn: string[] }[] = []
    for (const b of blocks) {
      const nb = addBlock(variantId, secId, { kind: b.kind, text: b.text, author: 'agent' })
      if (!nb.ok) { box.failed = { code: nb.code === 'too_many' ? 'too_many' : 'bad_input', detail: nb.detail }; throw new Error('rollback') }
      const norm = normalizeForMatch(b.text)
      for (const c of b.claims) {
        const orig = srcClaims.find((x) => x.id === c.source_claim)
        if (!orig) { notCarried.push({ id: c.source_claim, text: '', reason: 'not a claim of this section of the original' }); continue }
        if (carried.has(orig.id)) continue
        if (c.text.length < 3 || !norm.includes(normalizeForMatch(c.text))) { notCarried.push({ id: orig.id, text: orig.text, reason: 'the translated claim text is not a verbatim part of the translated block' }); continue }
        const cid = newId()
        db.prepare('INSERT INTO wb_doc_claims (id, work_item_id, block_id, text, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
          .run(cid, variantId, nb.block.id, c.text, now(), by)
        for (const s of db.prepare('SELECT * FROM wb_doc_sources WHERE claim_id = ? ORDER BY created_at').all(orig.id) as SourceRow[]) {
          // UGYANAZ a forras (K-1.31): irat + oldal + idezet, a gepi ellenorzes eredmenye, a tulajdonos megerositese.
          db.prepare(`INSERT INTO wb_doc_sources (id, claim_id, kind, path, page, quote, citation, url, retrieved_at, said, said_at, message_id,
              based_on, verdict, detail, checked_at, confirmed_at, confirmed_by, confirmed_text, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(newId(), cid, s.kind, s.path, s.page, s.quote, s.citation, s.url, s.retrieved_at, s.said, s.said_at, s.message_id,
              s.based_on, s.verdict, s.detail, s.checked_at, s.confirmed_at, s.confirmed_by, s.confirmed_text, now())
          if (s.kind === 'inference' && s.based_on) {
            try { pendingInference.push({ newClaim: cid, basedOn: JSON.parse(s.based_on) as string[] }) } catch { /* rossz JSON: marad, ahogy volt */ }
          }
        }
        carried.set(orig.id, cid)
      }
    }
    // A kovetkeztetes az eredeti allitasaira epult: a valtozatban a forditott parjukra mutasson.
    for (const p of pendingInference) {
      const mapped = p.basedOn.map((id) => carried.get(id) ?? (db.prepare('SELECT 1 FROM wb_doc_claims WHERE id = ? AND work_item_id = ?').get(id, variantId) ? id : null)).filter((x): x is string => !!x)
      db.prepare('UPDATE wb_doc_sources SET based_on = ? WHERE claim_id = ? AND kind = \'inference\'').run(JSON.stringify(mapped), p.newClaim)
    }
    for (const c of srcClaims) {
      if (!carried.has(c.id) && !notCarried.some((n) => n.id === c.id)) notCarried.push({ id: c.id, text: c.text, reason: 'not given in claims' })
    }
    db.prepare('UPDATE wb_doc_section_links SET source_hash = ?, translated_at = ?, translated_by = ? WHERE section_id = ?').run(sectionHash(src.id), now(), by, secId)
    // A regi visszaforditas a regi forditasra szolt.
    db.prepare('DELETE FROM wb_doc_backchecks WHERE section_id = ?').run(secId)
    const variantItem = getWorkItem(variantId)
    box.out = {
      section_id: secId,
      blocks: blocks.length,
      claims_carried: carried.size,
      claims_not_carried: notCarried.filter((n) => srcClaimIds.has(n.id) || n.text === ''),
      glossary_issues: variantItem ? glossaryIssues(variantItem.project_id, v.lang, sectionText(src.id), sectionText(secId)) : [],
    }
  })
  try { run() } catch (e) {
    if (!box.failed) throw e
  }
  if (box.failed) return { ok: false, ...box.failed }
  if (!box.out) return { ok: false, code: 'bad_input', detail: 'the translation could not be saved' }
  return { ok: true, result: box.out }
}

// ---------------------------------------------------------------------------
// Visszaforditas-ellenorzes (K-1.30)
// ---------------------------------------------------------------------------

export interface BackcheckView { section_id: string; text: string; stale: boolean; created_at: number; source_title: string | null; source_text: string | null }

export function setBackTranslation(variantId: string, sectionId: string, rawText: unknown, by: string | null): ModelResult<{ backcheck: BackcheckView }> {
  ensureDocLangTables()
  if (!variantOf(variantId)) return { ok: false, code: 'bad_input', detail: 'only a language version has a back-translation check' }
  const own = getDb().prepare('SELECT 1 FROM wb_doc_section_links WHERE section_id = ? AND work_item_id = ?').get(String(sectionId || ''), variantId)
  if (!own) return { ok: false, code: 'not_found', detail: 'section must be a section id of this language version' }
  const text = String(rawText ?? '').replace(/\r\n/g, '\n').trim()
  if (!text || text.length > BLOCK_TEXT_MAX * 5) return { ok: false, code: 'bad_input', detail: 'the back-translation text is required' }
  getDb().prepare(`INSERT INTO wb_doc_backchecks (section_id, work_item_id, text, base_hash, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(section_id) DO UPDATE SET text = excluded.text, base_hash = excluded.base_hash, created_at = excluded.created_at, created_by = excluded.created_by`)
    .run(sectionId, variantId, text, sectionHash(sectionId), now(), by)
  return { ok: true, backcheck: backchecks(variantId).find((b) => b.section_id === sectionId) as BackcheckView }
}

export function removeBackTranslation(variantId: string, sectionId: string): ModelResult<{ removed: string }> {
  ensureDocLangTables()
  const r = getDb().prepare('DELETE FROM wb_doc_backchecks WHERE section_id = ? AND work_item_id = ?').run(String(sectionId || ''), variantId)
  return r.changes ? { ok: true, removed: String(sectionId) } : { ok: false, code: 'not_found', detail: 'no back-translation for this section' }
}

/** A visszaforditasok az eredeti fejezet szovege mellett (a felulet egymas melle teszi). */
export function backchecks(variantId: string): BackcheckView[] {
  ensureDocLangTables()
  const rows = getDb().prepare(`SELECT k.*, l.source_section_id FROM wb_doc_backchecks k JOIN wb_doc_section_links l ON l.section_id = k.section_id
    WHERE k.work_item_id = ?`).all(variantId) as { section_id: string; text: string; base_hash: string; created_at: number; source_section_id: string }[]
  return rows.map((r) => {
    const src = getDb().prepare('SELECT title FROM wb_doc_sections WHERE id = ?').get(r.source_section_id) as { title: string } | undefined
    return {
      section_id: r.section_id, text: r.text, stale: r.base_hash !== sectionHash(r.section_id), created_at: r.created_at,
      source_title: src ? src.title : null, source_text: src ? sectionText(r.source_section_id) : null,
    }
  })
}

// ---------------------------------------------------------------------------
// A veglegesites elotti ellenorzes sorai egy valtozatnal
// ---------------------------------------------------------------------------

/** Leforditatlan, elavult vagy az eredetibol hianyzo fejezet mellett nem veglegesitheto a valtozat. */
export function variantCheckItems(itemId: string): CheckItem[] {
  const info = variantInfo(itemId)
  if (!info) return []
  const stale = info.sections.filter((s) => s.state === 'stale' || s.state === 'source_removed')
  const untranslated = info.sections.filter((s) => s.state === 'untranslated')
  return [{
    key: 'variant_current',
    ok: !stale.length && !untranslated.length && !info.new_in_source.length,
    count: info.sections.filter((s) => s.state === 'current').length,
    total: info.sections.length + info.new_in_source.length,
    detail: [...stale.map((s) => s.source_title || '?'), ...untranslated.map((s) => s.source_title || '?'), ...info.new_in_source.map((s) => s.title)],
  }]
}
