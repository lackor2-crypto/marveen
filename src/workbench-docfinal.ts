/**
 * PISZKOZAT, VEGLEGESITES, TECHNIKAI NYOM (kanban #441, v4 spec 1/A,
 * K-1.21 ... K-1.23/b).
 *
 * - PISZKOZAT PDF barmikor: vizjellel, a hiany-jelolesekkel (K-1.21).
 * - VEGLEGES PDF csak akkor, ha (K-1.22):
 *     1. a veglegesites elotti ellenorzes minden sora rendben (`documentCheck`);
 *     2. a tulajdonos MEGNYITOTTA es atnezte PONTOSAN ezt a tartalmat (az
 *        atnezest a tartalom ujjlenyomataval rogzitjuk -- ha kozben valtozott,
 *        ujra at kell neznie);
 *     3. a tulajdonos a SAJAT kattintasaval vallalja a felelosseget. Agent ezt
 *        nem teheti meg: nincs ra eszkoz, es az utvonal csak a tulajdonos
 *        munkamenetet fogadja el.
 * - A veglegesites VERZIOT keszit "Vegleges -- <datum>" nevvel, a PDF a
 *   munkadarab mappajaba kerul (K-1.23). Ha a dokumentum ezutan valtozik, a
 *   vegleges allapot megszunik ("elavult"), es ujra ellenorizni kell.
 * - TECHNIKAI NYOM (K-1.23/b): ki, mikor, mit irt, ellenorzott, erositett meg.
 *   A Marveen NEM minositi, hogy ez mire eleg jogilag -- csak rogziti.
 */
import { getDb } from './db.js'
import { OWNER_NAME_PLACEHOLDER, currentOwnerName } from './config.js'
import { documentCheck, documentOutline, hasDocModel, type CheckItem } from './workbench-docmodel.js'
import { consistencyIssues } from './workbench-doccheck.js'
import { outlineHash, renderOutlinePdf, toRenderOutline, type RenderResult } from './workbench-docrender.js'
import { createWorkItemVersion, getWorkItem, listWorkItemVersions, type WorkItemRow } from './workbench.js'
import { attachAsset } from './workbench-assets.js'
import { annexListTitle, docSettings, listAnnexes, type FileResolver } from './workbench-docannex.js'
import { annexPdfs, mergePdfs, type PackageError } from './workbench-docpackage.js'
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { resolveProjectFile } from './workbench-docmodel-world.js'
import { getProject } from './projects.js'
import type { RenderOutline } from './workbench-docrender.js'

let tablesDb: unknown = null

export function ensureDocFinalTables(): void {
  const db = getDb()
  if (tablesDb === db) return
  db.exec(`
    CREATE TABLE IF NOT EXISTS wb_doc_reviews (
      work_item_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      reviewed_at INTEGER NOT NULL,
      reviewed_by TEXT,
      PRIMARY KEY (work_item_id, content_hash)
    )
  `)
  tablesDb = db
}

const now = (): number => Math.floor(Date.now() / 1000)

/** A felelossegvallalas szovege (K-1.22); ez kerul a technikai nyomba is. */
export const ACCEPT_TEXT = {
  hu: 'Átnéztem a dokumentumot, és a tartalmáért felelősséget vállalok.',
  en: 'I have reviewed the document and take responsibility for its content.',
} as const

const FINAL_LABEL = { hu: 'Végleges', en: 'Final' } as const
const DRAFT_LABEL = { hu: 'piszkozat', en: 'draft' } as const

/** A projekt fajljainak feloldoja ennel a munkadarabnal (a mellekletek letezesehez). */
export function resolverFor(item: WorkItemRow): FileResolver | undefined {
  const project = getProject(item.project_id)
  return project ? (p: string) => resolveProjectFile(project, p) : undefined
}

/** Ami a PDF-be kerul: fejezetek, blokkok es a mellekletjegyzek (cimke + leiras). */
export function renderInputFor(item: WorkItemRow): RenderOutline {
  const annexes = listAnnexes(item.id)
  return {
    ...toRenderOutline(documentOutline(item.id)),
    ...(annexes.length ? { annexes: annexes.map((a) => ({ label: a.label, title: a.title })), annexTitle: annexListTitle(docSettings(item.id)) } : {}),
  }
}

/**
 * A dokumentum PDF-be kerulo tartalmanak ujjlenyomata: cim + fejezetek +
 * blokkok + mellekletjegyzek, es mellekletek eseten a mellekletfajlok allapota
 * (meret + modositas ideje) is -- egy kicserelt mellekletet ujra at kell nezni.
 */
export function contentHash(item: WorkItemRow): string {
  const base = outlineHash(renderInputFor(item), item.title)
  const resolve = resolverFor(item)
  const annexes = listAnnexes(item.id)
  if (!annexes.length) return base
  const prints = annexes.map((a) => {
    const f = resolve ? resolve(a.path) : null
    try { const st = f ? statSync(f.abs) : null; return st ? `${a.path}:${st.size}:${Math.floor(st.mtimeMs)}` : `${a.path}:missing` } catch { return `${a.path}:missing` }
  })
  return createHash('sha256').update(base + '\n' + prints.join('\n')).digest('hex')
}

/** A PDF szerzoje a metaadatban: a tulajdonos beallitott neve; ha nincs beallitva, nincs szerzo (nem egy helyorzo). */
export function documentAuthor(): string | null {
  const n = currentOwnerName().trim()
  return n && n !== OWNER_NAME_PLACEHOLDER ? n : null
}

/** Helyi datum EEEE-HH-NN alakban (fajlnevbe es verzionevbe). */
export function localDate(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function recordReview(itemId: string, hash: string, by: string | null): void {
  ensureDocFinalTables()
  getDb().prepare(`INSERT INTO wb_doc_reviews (work_item_id, content_hash, reviewed_at, reviewed_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(work_item_id, content_hash) DO UPDATE SET reviewed_at = excluded.reviewed_at, reviewed_by = excluded.reviewed_by`)
    .run(itemId, hash, now(), by)
}

export function reviewOf(itemId: string, hash: string): { reviewed_at: number; reviewed_by: string | null } | null {
  ensureDocFinalTables()
  return (getDb().prepare('SELECT reviewed_at, reviewed_by FROM wb_doc_reviews WHERE work_item_id = ? AND content_hash = ?')
    .get(itemId, hash) as { reviewed_at: number; reviewed_by: string | null } | undefined) ?? null
}

export interface FinalFile { path: string; name: string; role: 'main' | 'bundle' | 'annex'; label?: string }

export interface FinalMeta {
  final: true
  label: string
  content_hash: string
  pdf_path: string
  pdf_name: string
  /** Minden keszult fajl (a beadvany, a mellekletek, vagy az egyesitett PDF). Regebbi veglegesitesnel hianyzik. */
  files?: FinalFile[]
  annex_mode?: 'separate' | 'combined' | null
  pdfa?: boolean
  accepted_by: string | null
  accepted_at: number
  accepted_text: string
  reviewed_at: number | null
  reviewed_by: string | null
  check: CheckItem[]
}

export interface FinalView extends FinalMeta {
  version_id: string
  version_no: number
  created_at: number
}

/** A veglegesitesek, a legujabb elol. */
export function listFinals(itemId: string): FinalView[] {
  const out: FinalView[] = []
  for (const v of listWorkItemVersions(itemId)) {
    if (!v.metadata_json) continue
    try {
      const m = JSON.parse(v.metadata_json) as Partial<FinalMeta>
      if (m && m.final === true && typeof m.content_hash === 'string') {
        out.push({ ...(m as FinalMeta), version_id: v.id, version_no: v.version_no, created_at: v.created_at })
      }
    } catch { /* rossz JSON: nem veglegesites */ }
  }
  return out
}

/** A legutobbi veglegesites, es hogy a dokumentum azota valtozott-e (K-1.23). */
export function finalState(item: WorkItemRow, hash = contentHash(item)): (FinalView & { stale: boolean }) | null {
  const f = listFinals(item.id)[0]
  return f ? { ...f, stale: f.content_hash !== hash } : null
}

/** A vazlat melle a felulet szamara: ujjlenyomat, atnezes, vegleges allapot. */
export function finalizationState(item: WorkItemRow): { content_hash: string; reviewed: boolean; final: ReturnType<typeof finalState> } {
  const hash = contentHash(item)
  return { content_hash: hash, reviewed: !!reviewOf(item.id, hash), final: finalState(item, hash) }
}

/**
 * A cimbol fajlnev-to: a Windows alatt tiltott jelek (a "/" is -- kulonben a
 * fajliro a perjel elotti reszt eldobna) kotojelre, es rovidre vagva, hogy a
 * ".pdf" vegzodes sose essen le a nevhossz-korlatnal.
 */
export function fileStem(title: string): string {
  const s = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s-]+|[.\s]+$/g, '')
  return (s || 'dokumentum').slice(0, 120).trim()
}

export function draftFileName(item: WorkItemRow, lang: 'hu' | 'en'): string {
  return `${fileStem(item.title)} (${DRAFT_LABEL[lang]}).pdf`
}

export type DraftResult =
  | { ok: true; pdf: Buffer; hash: string }
  | { ok: false; code: string; detail: string | null; label?: string }

/** Egy csomag-hiba (melleklet, egyesites) a hivonak; a LibreOffice-hiany kulon kodot kap. */
function packageFail(e: PackageError & { ok: false }): { ok: false; code: string; detail: string | null; label?: string } {
  const convert = 'convert' in e ? e.convert : undefined
  if (convert === 'not_installed' || convert === 'check_failed') return { ok: false, code: convert, detail: e.detail, label: 'label' in e ? e.label : undefined }
  return { ok: false, code: e.code, detail: e.detail, label: 'label' in e ? e.label : undefined }
}

/** Piszkozat PDF (K-1.21): barmikor, vizjellel; mellekletek eseten boritolappal egyutt, egy PDF-ben (atnezesre). */
export async function renderDraft(item: WorkItemRow, lang: 'hu' | 'en'): Promise<DraftResult> {
  const outline = renderInputFor(item)
  const hash = contentHash(item)
  const r = await renderOutlinePdf(outline, { title: item.title, author: documentAuthor(), draft: true, lang })
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
  if (!outline.annexes || !outline.annexes.length) return { ok: true, pdf: r.pdf, hash }
  const resolve = resolverFor(item)
  if (!resolve) return { ok: false, code: 'annex_missing', detail: null }
  const ax = await annexPdfs(item.id, resolve, { lang })
  if (!ax.ok) return packageFail(ax)
  const all = await mergePdfs([r.pdf, ...ax.annexes.map((a) => a.pdf)])
  if (!all.ok) return packageFail(all)
  return { ok: true, pdf: all.pdf, hash }
}

export type FinalizeCode =
  | 'outline_empty' | 'outline_not_ready' | 'outline_changed' | 'outline_not_reviewed' | 'outline_accept_required'
  | 'docpdf_failed'

export type FinalizeOutcome =
  | { ok: true; final: FinalView & { stale: boolean }; asset_path: string }
  | { ok: false; code: FinalizeCode | string; detail: string | null; check?: ReturnType<typeof documentCheck>; convert?: string; label?: string }

/**
 * VEGLEGESITES (K-1.22, K-1.23, K-1.25). A hivo (utvonal) mar ellenorizte, hogy
 * a tulajdonos sajat kattintasa; itt a tartalmi feltetelek allnak.
 * `hash`: az az ujjlenyomat, amit a tulajdonos a kepernyon latott -- ha a
 * dokumentum kozben valtozott, nem veglegesitunk "vakon".
 * Mellekletekkel: "separate" -- a beadvany (PDF/A) es mellekletenkent egy PDF
 * (boritolap + tartalom); "combined" -- minden egy PDF-ben.
 */
export async function finalizeDocument(item: WorkItemRow, input: { accept: unknown; hash: unknown; by: string | null; lang: 'hu' | 'en' }): Promise<FinalizeOutcome> {
  if (!hasDocModel(item.id)) return { ok: false, code: 'outline_empty', detail: null }
  const hash = contentHash(item)
  if (typeof input.hash === 'string' && input.hash && input.hash !== hash) return { ok: false, code: 'outline_changed', detail: null }
  const resolve = resolverFor(item)
  const check = documentCheck(item.id, resolve)
  if (!check.ready) return { ok: false, code: 'outline_not_ready', detail: null, check }
  const review = reviewOf(item.id, hash)
  if (!review) return { ok: false, code: 'outline_not_reviewed', detail: null }
  if (input.accept !== true) return { ok: false, code: 'outline_accept_required', detail: null }

  const outline = renderInputFor(item)
  const r = await renderOutlinePdf(outline, { title: item.title, author: documentAuthor(), draft: false, lang: input.lang })
  if (!r.ok) return { ok: false, code: 'docpdf_failed', detail: r.detail, convert: r.code }
  let annexes: { label: string; title: string; pdf: Buffer }[] = []
  if (outline.annexes && outline.annexes.length) {
    if (!resolve) return { ok: false, code: 'annex_missing', detail: null }
    const ax = await annexPdfs(item.id, resolve, { lang: input.lang })
    if (!ax.ok) {
      const f = packageFail(ax)
      return f.code === 'not_installed' || f.code === 'check_failed' ? { ok: false, code: 'docpdf_failed', detail: f.detail, convert: f.code } : f
    }
    annexes = ax.annexes
  }
  const mode = docSettings(item.id).annex_mode
  let bundle: Buffer | null = null
  if (annexes.length && mode === 'combined') {
    const all = await mergePdfs([r.pdf, ...annexes.map((a) => a.pdf)])
    if (!all.ok) return packageFail(all)
    bundle = all.pdf
  }
  // A rendereles alatt valtozhatott: amit atnezett, azt veglegesitjuk, mast nem.
  const fresh = getWorkItem(item.id)
  if (!fresh || contentHash(fresh) !== hash) return { ok: false, code: 'outline_changed', detail: null }

  const label = `${FINAL_LABEL[input.lang]} – ${localDate()}`
  const save = (name: string, pdf: Buffer): { path: string; name: string } | string => {
    const x = attachAsset(fresh, name, pdf, { force: true, createdBy: input.by })
    return x.ok ? { path: x.asset.path, name: x.asset.name } : x.code
  }
  const files: FinalFile[] = []
  const main = save(`${fileStem(fresh.title)} – ${label}.pdf`, bundle ?? r.pdf)
  if (typeof main === 'string') return { ok: false, code: 'docpdf_failed', detail: 'the PDF could not be saved into the work item folder: ' + main }
  files.push({ ...main, role: bundle ? 'bundle' : 'main' })
  if (!bundle) {
    for (const a of annexes) {
      const f = save(`${fileStem(a.label)} – ${fileStem(a.title)}.pdf`, a.pdf)
      if (typeof f === 'string') return { ok: false, code: 'docpdf_failed', detail: `the annex ${a.label} could not be saved into the work item folder: ${f}` }
      files.push({ ...f, role: 'annex', label: a.label })
    }
  }
  const meta: FinalMeta = {
    final: true, label, content_hash: hash,
    pdf_path: main.path, pdf_name: main.name,
    files, annex_mode: annexes.length ? mode : null,
    // A beadvany PDF-je PDF/A-2b; az egyesitett fajl es a mellekletek (a csatolt PDF-ek) nem feltetlenul.
    pdfa: !bundle,
    accepted_by: input.by, accepted_at: now(), accepted_text: ACCEPT_TEXT[input.lang],
    reviewed_at: review.reviewed_at, reviewed_by: review.reviewed_by,
    check: check.items,
  }
  const v = createWorkItemVersion(fresh.id, { prompt: label, created_by: input.by, metadata_json: JSON.stringify(meta) })
  if (!v.ok) return { ok: false, code: 'docpdf_failed', detail: v.code }
  const state = finalState(v.item, hash)
  if (!state) return { ok: false, code: 'docpdf_failed', detail: 'the final version was created but could not be read back' }
  return { ok: true, final: state, asset_path: main.path }
}

const iso = (sec: number | null | undefined): string | null => (sec ? new Date(sec * 1000).toISOString() : null)

/**
 * TECHNIKAI NYOM (K-1.23/b): ki, mikor, mit irt, ellenorzott es erositett meg.
 * Csak rogzit, nem minosit (a Marveen nem allitja, hogy egy dokumentum
 * megfelel egy jogszabalynak vagy mentesul egy jelolesi kotelezettseg alol).
 */
export function documentTrail(item: WorkItemRow): Record<string, unknown> {
  ensureDocFinalTables()
  const o = documentOutline(item.id)
  const hash = contentHash(item)
  const reviews = getDb().prepare('SELECT content_hash, reviewed_at, reviewed_by FROM wb_doc_reviews WHERE work_item_id = ? ORDER BY reviewed_at')
    .all(item.id) as { content_hash: string; reviewed_at: number; reviewed_by: string | null }[]
  const blocks = o.sections.flatMap((s) => s.blocks)
  return {
    kind: 'marveen-document-trail',
    format: 1,
    note: 'Technical record of who wrote, checked and confirmed what, and when. Marveen does not assess whether this satisfies any legal requirement.',
    generated_at: new Date().toISOString(),
    document: { id: item.id, title: item.title, content_hash: hash },
    summary: {
      sections: o.sections.length,
      blocks: blocks.length,
      blocks_written_by_agent: blocks.filter((b) => b.author === 'agent' && !b.owner_edited_at).length,
      blocks_written_or_edited_by_owner: blocks.filter((b) => b.author === 'owner' || !!b.owner_edited_at).length,
      claims: blocks.reduce((n, b) => n + b.claims.length, 0),
    },
    sections: o.sections.map((s) => ({
      title: s.title,
      status: s.status,
      blocks: s.blocks.map((b) => ({
        kind: b.kind,
        text: b.text,
        written_by: b.author,
        created_at: iso(b.created_at),
        updated_at: iso(b.updated_at),
        edited_by_owner_at: iso(b.owner_edited_at),
        claims: b.claims.map((c) => ({
          text: c.text,
          strength: c.strength,
          added_by: c.created_by,
          added_at: iso(c.created_at),
          sources: c.sources.map((src) => ({
            kind: src.kind,
            ...(src.kind === 'document' ? { file: src.path, page: src.page, quote: src.quote } : {}),
            ...(src.kind === 'official' ? { citation: src.citation, url: src.url, retrieved_at: src.retrieved_at, quote: src.quote } : {}),
            ...(src.kind === 'owner' ? { said: src.said, said_at: iso(src.said_at) } : {}),
            ...(src.kind === 'inference' ? { based_on: src.based_on ? JSON.parse(src.based_on) as unknown : [] } : {}),
            verdict: src.verdict,
            checked_at: iso(src.checked_at),
            confirmed_at: iso(src.confirmed_at),
            confirmed_by: src.confirmed_by,
            confirmed_text: src.confirmed_text,
          })),
        })),
      })),
    })),
    annexes: listAnnexes(item.id, resolverFor(item)).map((a) => ({ label: a.label, title: a.title, file: a.path, file_present: a.exists, referenced: a.refs, added_by: a.created_by, added_at: iso(a.created_at) })),
    consistency: consistencyIssues(item.id).map((i) => ({ kind: i.kind, values: i.values, section: i.where, marked_intentional_by: i.acked_by, marked_intentional_at: iso(i.acked_at) })),
    reviews: reviews.map((r) => ({ content_hash: r.content_hash, reviewed_at: iso(r.reviewed_at), reviewed_by: r.reviewed_by })),
    finals: listFinals(item.id).map((f) => ({
      version_no: f.version_no, label: f.label, content_hash: f.content_hash, file: f.pdf_path, files: f.files ?? null, annex_mode: f.annex_mode ?? null,
      accepted_by: f.accepted_by, accepted_at: iso(f.accepted_at), accepted_text: f.accepted_text,
      reviewed_at: iso(f.reviewed_at), reviewed_by: f.reviewed_by, check: f.check,
      still_current: f.content_hash === hash,
    })),
  }
}
