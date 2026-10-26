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
import { execFile, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { resolveLifePath } from './life-explorer.js'
import { OWNER_NAME_PLACEHOLDER, currentOwnerName } from './config.js'
import { documentCheck, documentOutline, hasDocModel, imageBlockParts, type CheckItem } from './workbench-docmodel.js'
import { consistencyIssues } from './workbench-doccheck.js'
import { imageSize, outlineHash, renderOutlineDocx, renderOutlinePdf, toRenderOutline, type DocLang, type DocxResult, type RenderImage, type RenderResult } from './workbench-docrender.js'
import { variantOf } from './workbench-doclang.js'
import { createWorkItemVersion, getWorkItem, listWorkItemVersions, type WorkItemRow } from './workbench.js'
import { attachAsset, deleteAssetFile, listWorkItemAssets, syncFolderAssets } from './workbench-assets.js'
import { annexListTitle, docSettings, listAnnexes, type FileResolver } from './workbench-docannex.js'
import { annexPdfs, mergePdfs, type PackageError } from './workbench-docpackage.js'
import { letterLanguage, letterSubject, NAMELESS_LETTER } from './workbench-letterinfo.js'
import { checkFiles, getProfile, itemProfileId, profileFileName, saveCourtCheck, type CheckFile, type CourtCheckResult } from './workbench-courtprofile.js'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
export function renderInputFor(item: WorkItemRow, withImages = false): RenderOutline {
  const annexes = listAnnexes(item.id)
  const base = toRenderOutline(documentOutline(item.id))
  if (withImages) for (const sec of base.sections) for (const b of sec.blocks) if (b.kind === 'image') b.img = readDocImage(imageBlockParts(b.text).path)
  return {
    ...base,
    ...(annexes.length ? { annexes: annexes.map((a) => ({ label: a.label, title: a.title })), annexTitle: annexListTitle(docSettings(item.id), docLangFor(item, 'hu')) } : {}),
  }
}

/** Largest picture file an `image` block embeds (a bigger one is shown as missing, not crashing the render). */
export const DOC_IMAGE_MAX_BYTES = 25 * 1024 * 1024

/** RIFF....WEBP */
export function isWebp(b: Buffer): boolean { return b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }

/** WebP bytes to PNG bytes with ffmpeg (an installer dependency); null when ffmpeg is missing or cannot read it. */
export function webpToPng(data: Buffer): Buffer | null {
  try {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], { input: data, maxBuffer: 64 * 1024 * 1024, timeout: 15_000 })
    return out.length ? out : null
  } catch { return null }
}

/** The picture of an `image` block (its path under the Marveen folder), or null when it is gone or not a picture. */
export function readDocImage(rel: string): RenderImage | null {
  const abs = resolveLifePath(rel)
  if (!abs) return null
  try {
    const st = statSync(abs)
    if (!st.isFile() || st.size > DOC_IMAGE_MAX_BYTES) return null
    let data: Buffer<ArrayBuffer> = readFileSync(abs)
    // #719: Word and the PDF renderer know no WebP; it becomes a PNG (transparency kept) before it is measured.
    if (isWebp(data)) { const png = webpToPng(data); if (!png) return null; data = png as Buffer<ArrayBuffer> }
    const dim = imageSize(data)
    return dim ? { data, ...dim } : null
  } catch { return null }
}

/** Size + change time of every picture an `image` block points at: a replaced photo is new content. */
function imagePrints(item: WorkItemRow): string[] {
  const out: string[] = []
  for (const s of documentOutline(item.id).sections) for (const b of s.blocks) {
    if (b.kind !== 'image') continue
    // The path without the size/alignment suffix (#508): a resized picture's file is still the one to watch.
    const abs = resolveLifePath(imageBlockParts(b.text).path)
    try { const st = abs ? statSync(abs) : null; out.push(st ? `img:${b.text}:${st.size}:${Math.floor(st.mtimeMs)}` : `img:${b.text}:missing`) } catch { out.push(`img:${b.text}:missing`) }
  }
  return out
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
  const pics = imagePrints(item)
  if (!annexes.length && !pics.length) return base
  const prints = annexes.map((a) => {
    const f = resolve ? resolve(a.path) : null
    try { const st = f ? statSync(f.abs) : null; return st ? `${a.path}:${st.size}:${Math.floor(st.mtimeMs)}` : `${a.path}:missing` } catch { return `${a.path}:missing` }
  })
  return createHash('sha256').update(base + '\n' + prints.concat(pics).join('\n')).digest('hex')
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
  /**
   * #753: the annexes of a "separate" final that are made when the package is sent (cover + content), not saved as files:
   * the Attachments folder already lists them. Absent on older finals, whose annex PDFs are in `files`.
   */
  annex_labels?: string[]
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
  /** The number of the finalization (1 = the first): the same number the final PDF's name carries ("… – v1.pdf"). */
  final_no: number
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
        out.push({ ...(m as FinalMeta), version_id: v.id, version_no: v.version_no, final_no: 0, created_at: v.created_at })
      }
    } catch { /* rossz JSON: nem veglegesites */ }
  }
  out.forEach((f, i) => { f.final_no = out.length - i })
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
export function fileStem(title: string, max = 120): string {
  const s = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').replace(/\s+/g, ' ').trim().replace(/^[.\s-]+|[.\s]+$/g, '')
  return (s || 'dokumentum').slice(0, max).trim()
}

/** The title cut at its first " - " (the long tail with numbers and names stays out) and at a word, at most 60 characters. */
export function shortTitle(title: string, max = 60): string {
  let t = fileStem(title.split(' - ')[0] || title, 10_000)
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, '')
  return t.trim() || fileStem(title, max)
}

/**
 * The name of a final PDF (Boss, 2026-10-16): "2026-10-16 – <short title> – DE – v5.pdf". The date first (they sort in time
 * order), the language in the name (the Hungarian and the German one never look alike), and the number of the finalization.
 */
export function finalFileName(item: WorkItemRow, lang: DocLang, versionNo: number, d = new Date()): string {
  return `${localDate(d)} – ${letterFileStem(item, lang)} – ${lang.toUpperCase()} – v${versionNo}.pdf`
}

/**
 * #794 (Boss TG 3445): a file that leaves the house is named from the LETTER (its own subject line, in its own language), never
 * from the work item's title, which is the owner's note in his language. A letter without a subject line gets a plain word.
 */
export function letterFileStem(item: WorkItemRow, lang: DocLang): string {
  const subject = letterSubject(item.id)
  return subject ? shortTitle(subject) : NAMELESS_LETTER[lang]
}

/** The language a letter's file name and mail are in: a language version says it, else the TEXT, else the one asked for. */
export function letterNameLang(item: WorkItemRow, ui: 'hu' | 'en'): DocLang {
  if (variantOf(item.id)) return docLangFor(item, ui)
  return letterLanguage(item.id) ?? docLangFor(item, ui)
}

export function draftFileName(item: WorkItemRow, lang: 'hu' | 'en'): string {
  return `${fileStem(item.title)} (${DRAFT_LABEL[lang]}).pdf`
}

/**
 * A dokumentum nyelve a PDF/DOCX feliratainal (lablec, vizjel, nyelvi cimke):
 * nyelvi valtozatnal a valtozate (K-1.27), kulonben a szovege, es csak ha az nem ismerheto fel, a felulete.
 * #794: a German letter written on a Hungarian install must not carry a Hungarian footer or annex list.
 */
export function docLangFor(item: WorkItemRow, ui: 'hu' | 'en'): DocLang {
  const v = variantOf(item.id)
  if (!v) return letterLanguage(item.id) ?? ui
  return v.lang === 'hu' || v.lang === 'de' || v.lang === 'en' ? v.lang : 'en'
}

/**
 * #794 (Boss TG 3503: "nem lehet benne sehol magyar"): the title written into the PDF / Word properties. The letter's
 * own subject line; without one, the work item's title only when the document is in the dashboard's language (the
 * title is the owner's note in HIS language), else the plain word for a letter in the document's language.
 */
export function docMetaTitle(item: WorkItemRow, ui: 'hu' | 'en'): string {
  const subject = letterSubject(item.id)
  if (subject) return subject
  const lang = docLangFor(item, ui)
  return lang === ui ? item.title : NAMELESS_LETTER[lang]
}

/** A szerkesztheto Word-fajl neve (K-1.26): a cim, datummal (a kiadott munkapeldanyok megkulonbozthetok). */
export function docxFileName(item: WorkItemRow, d = new Date()): string {
  return `${fileStem(item.title)} (${localDate(d)}).docx`
}

/**
 * Szerkesztheto DOCX (K-1.26): barmikor, ugyanabbol a modellbol, mint a PDF.
 * Munkapeldany (pl. ugyvednek tovabbszerkesztesre), nem a vegleges irat: a
 * hiany-jelolesek kiemelve benne maradnak, a mellekletek csak a jegyzekben
 * szerepelnek (a fajlok nem kerulnek bele).
 */
export async function renderDocx(item: WorkItemRow, lang: 'hu' | 'en'): Promise<DocxResult> {
  return renderOutlineDocx(renderInputFor(item, true), { title: docMetaTitle(item, lang), author: documentAuthor(), lang: docLangFor(item, lang) })
}

/** The PDF twin of the Word copy (#636): the plain document, no watermark and no annex cover, for sending straight away. */
export async function renderPlainPdf(item: WorkItemRow, lang: 'hu' | 'en'): Promise<RenderResult> {
  return renderOutlinePdf(renderInputFor(item, true), { title: docMetaTitle(item, lang), author: documentAuthor(), draft: false, lang: docLangFor(item, lang) })
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
  const outline = renderInputFor(item, true)
  const hash = contentHash(item)
  const r = await renderOutlinePdf(outline, { title: docMetaTitle(item, lang), author: documentAuthor(), draft: true, lang: docLangFor(item, lang) })
  if (!r.ok) return { ok: false, code: r.code, detail: r.detail }
  if (!outline.annexes || !outline.annexes.length) return { ok: true, pdf: r.pdf, hash }
  const resolve = resolverFor(item)
  if (!resolve) return { ok: false, code: 'annex_missing', detail: null }
  const ax = await annexPdfs(item.id, resolve, { lang: docLangFor(item, lang) })
  if (!ax.ok) return packageFail(ax)
  const all = await mergePdfs([r.pdf, ...ax.annexes.map((a) => a.pdf)])
  if (!all.ok) return packageFail(all)
  return { ok: true, pdf: all.pdf, hash }
}

export type FinalizeCode =
  | 'outline_empty' | 'outline_override_required' | 'outline_changed' | 'outline_not_reviewed' | 'outline_accept_required'
  | 'docpdf_failed'

export type FinalizeOutcome =
  | { ok: true; final: FinalView & { stale: boolean }; asset_path: string; court: CourtCheckResult | null; reused?: boolean }
  | { ok: false; code: FinalizeCode | string; detail: string | null; check?: ReturnType<typeof documentCheck>; convert?: string; label?: string }

/**
 * VEGLEGESITES (K-1.22, K-1.23, K-1.25). A hivo (utvonal) mar ellenorizte, hogy
 * a tulajdonos sajat kattintasa; itt a tartalmi feltetelek allnak.
 * `hash`: az az ujjlenyomat, amit a tulajdonos a kepernyon latott -- ha a
 * dokumentum kozben valtozott, nem veglegesitunk "vakon".
 * Mellekletekkel: "separate" -- a beadvany (PDF/A) es mellekletenkent egy PDF
 * (boritolap + tartalom); "combined" -- minden egy PDF-ben.
 */
export async function finalizeDocument(item: WorkItemRow, input: { accept: unknown; hash: unknown; override?: unknown; by: string | null; lang: 'hu' | 'en' }): Promise<FinalizeOutcome> {
  if (!hasDocModel(item.id)) return { ok: false, code: 'outline_empty', detail: null }
  const hash = contentHash(item)
  if (typeof input.hash === 'string' && input.hash && input.hash !== hash) return { ok: false, code: 'outline_changed', detail: null }
  const resolve = resolverFor(item)
  const check = documentCheck(item.id, resolve)
  const review = reviewOf(item.id, hash)
  if (!review) return { ok: false, code: 'outline_not_reviewed', detail: null }
  if (input.accept !== true) return { ok: false, code: 'outline_accept_required', detail: null }
  // #751 (Boss, TG 4201): "ne akasszuk meg a veglegesitest semmivel. csak szoljunk!" -- the content points are to-dos,
  // not a gate. A missing signature or an annex that is not in order only asks for the owner's "finalize anyway" tick.
  const override = input.override === true
  if (check.needs_override && !override) return { ok: false, code: 'outline_override_required', detail: null, check }

  // #738 (Boss, TG 4110): an unchanged document that is finalized again must not put the same PDF into the Finished materials a
  // second time. The same content (hash), the same language and the files still on disk -> the new final version points at them.
  const reused = reusableFinal(item, hash, input.lang)
  if (reused) return finalizeFromExisting(item, reused, { hash, review, check, by: input.by, lang: input.lang })

  const outline = renderInputFor(item, true)
  const r = await renderOutlinePdf(outline, { title: docMetaTitle(item, input.lang), author: documentAuthor(), draft: false, lang: docLangFor(item, input.lang) })
  if (!r.ok) return { ok: false, code: 'docpdf_failed', detail: r.detail, convert: r.code }
  let annexes: { label: string; title: string; pdf: Buffer }[] = []
  if (outline.annexes && outline.annexes.length) {
    if (!resolve) return { ok: false, code: 'annex_missing', detail: null }
    // With the owner's "finalize anyway" tick an annex whose file is gone (or cannot become a PDF) is left out, not an error.
    const ax = await annexPdfs(item.id, resolve, { lang: docLangFor(item, input.lang), skipBroken: override })
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

  // #753 (Boss, TG 4258 "3A"): a PDF of this document that is already in its folder (made earlier from the Word file, by hand,
  // or by an older final) and says word for word what the fresh one says IS the final: no second copy is written.
  if (!bundle) {
    const same = await samePdfInFolder(fresh, r.pdf)
    if (same) return finalizeOnFile(fresh, same, { hash, review, check, by: input.by, lang: input.lang, annexes, mode })
  }

  const label = `${FINAL_LABEL[input.lang]} – ${localDate()}`
  // Celbirosag-profil (K-1.36): a fajlnevek a profil szabalya szerint (pl. ERVB: 01_Klage.pdf).
  const profile = getProfile(itemProfileId(fresh.id))
  const total = bundle ? 1 : 1 + annexes.length
  let index = 0
  const checkIn: CheckFile[] = []
  // Only the submission (or the one combined file) goes to Finished materials. #753 (Boss, TG 4240): the annexes are listed
  // in Attachments already (linked Life-tree documents stand there as links), so their cover + content PDFs are NOT saved
  // anywhere -- they are checked here and made again, the same, when the package is sent (the content hash covers them).
  const x = attachAsset(fresh, profileFileName(finalFileName(fresh, letterNameLang(fresh, input.lang), listFinals(fresh.id).length + 1), profile, index++, total), bundle ?? r.pdf, { force: true, createdBy: input.by, into: 'finished' as const })
  if (!x.ok) return { ok: false, code: 'docpdf_failed', detail: 'the PDF could not be saved into the work item folder: ' + x.code, ...(x.code === 'unreachable' ? { convert: 'folder_unreachable' } : {}) }
  const main = { path: x.asset.path, name: x.asset.name }
  checkIn.push({ name: main.name, pdf: bundle ?? r.pdf, role: bundle ? 'bundle' : 'main', path: main.path })
  const files: FinalFile[] = [{ ...main, role: bundle ? 'bundle' : 'main' }]
  if (!bundle) {
    for (const a of annexes) {
      const annexId = annexIdOf(fresh.id, a.label)
      checkIn.push({ name: annexFinalName(a, profile, index++, total), pdf: a.pdf, role: 'annex', label: a.label, ...(annexId ? { annex_id: annexId } : {}) })
    }
  }
  const meta: FinalMeta = {
    final: true, label, content_hash: hash,
    pdf_path: main.path, pdf_name: main.name,
    files, annex_mode: annexes.length ? mode : null,
    ...(!bundle && annexes.length ? { annex_labels: annexes.map((a) => a.label) } : {}),
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
  supersedeEarlierFinals(fresh.id, files.map((f) => f.path))
  // K-1.37: a KESZ fajlok gepi ellenorzese a profil mai szabalyverzioja szerint.
  // Nem akadalyozza a veglegesitest: a tulajdonos latja, mit talalt, es dont.
  let court: CourtCheckResult | null = null
  if (profile) {
    court = await checkFiles(profile, checkIn)
    saveCourtCheck(fresh.id, state.version_id, court)
  }
  return { ok: true, final: state, asset_path: main.path, court }
}

/**
 * Boss TG 10494: finalizing a changed document again REPLACES this work item's own earlier final PDF in Finished materials
 * (no "- v2" pile next to it). Only files the earlier finals of THIS item saved are touched; another item's PDF in the same
 * folder is never one of them. A file the new final points at too (kept) or one something else still uses stays.
 */
function supersedeEarlierFinals(itemId: string, keep: string[]): void {
  const keepSet = new Set(keep)
  const finals = listFinals(itemId)
  for (const f of finals.slice(1)) {
    for (const file of f.files && f.files.length ? f.files : [{ path: f.pdf_path, role: 'main' as const }]) {
      if (file.role === 'annex' || !file.path || keepSet.has(file.path)) continue
      const row = getDb().prepare('SELECT id FROM work_item_assets WHERE work_item_id = ? AND path = ? AND removed_at IS NULL').get(itemId, file.path) as { id: string } | undefined
      if (!row) continue
      try { deleteAssetFile(itemId, row.id) } catch (e) { logger.warn({ err: e, itemId, path: file.path }, 'docfinal: earlier final PDF could not be replaced') }
    }
  }
}

/** The latest final of this exact content and language whose submission file is still on disk, else null (#738). */
function reusableFinal(item: WorkItemRow, hash: string, lang: 'hu' | 'en'): FinalView | null {
  const prev = listFinals(item.id)[0]
  if (!prev || prev.content_hash !== hash || !prev.files || !prev.files.length) return null
  if (!String(prev.label || '').startsWith(FINAL_LABEL[lang])) return null
  // The annex mode is a setting, not part of the content hash: a switch (separate <-> combined) needs the files made again.
  const wanted = listAnnexes(item.id).length ? docSettings(item.id).annex_mode : null
  if ((prev.annex_mode ?? null) !== wanted) return null
  for (const f of prev.files) {
    // #753: an annex PDF an older final saved is made again when sent, so its being gone does not need a new final.
    if (f.role === 'annex') continue
    const abs = resolveLifePath(f.path)
    if (!abs || !existsSync(abs)) return null
  }
  return prev
}

/** Records a new final version for an unchanged document without writing any file: the earlier PDFs stay the only copies. */
async function finalizeFromExisting(
  item: WorkItemRow, prev: FinalView,
  ctx: { hash: string; review: { reviewed_at: number; reviewed_by: string | null }; check: { items: CheckItem[] }; by: string | null; lang: 'hu' | 'en' },
): Promise<FinalizeOutcome> {
  const label = `${FINAL_LABEL[ctx.lang]} – ${localDate()}`
  const files = prev.files ?? []
  const main = files.find((f) => f.role === 'main' || f.role === 'bundle') ?? files[0]!
  const meta: FinalMeta = {
    final: true, label, content_hash: ctx.hash,
    pdf_path: main.path, pdf_name: main.name,
    files, annex_mode: prev.annex_mode, pdfa: prev.pdfa,
    ...(prev.annex_labels ? { annex_labels: prev.annex_labels } : {}),
    accepted_by: ctx.by, accepted_at: now(), accepted_text: ACCEPT_TEXT[ctx.lang],
    reviewed_at: ctx.review.reviewed_at, reviewed_by: ctx.review.reviewed_by,
    check: ctx.check.items,
  }
  const v = createWorkItemVersion(item.id, { prompt: label, created_by: ctx.by, metadata_json: JSON.stringify(meta) })
  if (!v.ok) return { ok: false, code: 'docpdf_failed', detail: v.code }
  const state = finalState(v.item, ctx.hash)
  if (!state) return { ok: false, code: 'docpdf_failed', detail: 'the final version was created but could not be read back' }
  return { ok: true, final: state, asset_path: main.path, court: null, reused: true }
}

/** The words of a PDF, whitespace folded (line breaks and column layout differ between makers), or null without pdftotext. */
function pdfWords(abs: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(process.env['MARVEEN_PDFTOTEXT'] || 'pdftotext', ['-q', '-enc', 'UTF-8', abs, '-'], { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      done(err ? null : String(out).split(/\s+/).filter(Boolean).join(' '))
    })
  })
}

/** A PDF of the work item (its own file, not a shared one) whose text is the same as the fresh render's, else null (#753). */
async function samePdfInFolder(item: WorkItemRow, pdf: Buffer): Promise<{ path: string; name: string; abs: string } | null> {
  // A PDF the owner put into the folder by hand is listed too, not only what the app wrote there.
  try { syncFolderAssets(item.id) } catch { /* the known files are still compared */ }
  const annexPaths = new Set(listAnnexes(item.id).map((a) => a.path))
  const candidates = listWorkItemAssets(item.id).filter((a) => a.present && !a.shared && /\.pdf$/i.test(a.name) && !annexPaths.has(a.path))
  if (!candidates.length) return null
  const dir = mkdtempSync(joinPath(tmpdir(), 'wb-final-'))
  try {
    const own = joinPath(dir, 'fresh.pdf')
    writeFileSync(own, pdf)
    const want = await pdfWords(own)
    if (!want) return null
    // Newest first: of two equal copies the latest one is the one the owner has been working with.
    for (const a of [...candidates].reverse()) {
      const abs = resolveLifePath(a.path)
      if (!abs) continue
      if ((await pdfWords(abs)) === want) return { path: a.path, name: a.name, abs }
    }
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Records the final on a PDF already in the folder (#753 3A): nothing is written, the court check still runs on the file. */
async function finalizeOnFile(
  item: WorkItemRow, file: { path: string; name: string; abs: string },
  ctx: { hash: string; review: { reviewed_at: number; reviewed_by: string | null }; check: { items: CheckItem[] }; by: string | null; lang: 'hu' | 'en'; annexes: { label: string; title: string; pdf: Buffer }[]; mode: FinalMeta['annex_mode'] },
): Promise<FinalizeOutcome> {
  const label = `${FINAL_LABEL[ctx.lang]} – ${localDate()}`
  const meta: FinalMeta = {
    final: true, label, content_hash: ctx.hash,
    pdf_path: file.path, pdf_name: file.name,
    files: [{ path: file.path, name: file.name, role: 'main' }], annex_mode: ctx.annexes.length ? ctx.mode : null,
    ...(ctx.annexes.length ? { annex_labels: ctx.annexes.map((a) => a.label) } : {}),
    // Made by another program (e.g. Word / LibreOffice): it is not known to be PDF/A.
    pdfa: false,
    accepted_by: ctx.by, accepted_at: now(), accepted_text: ACCEPT_TEXT[ctx.lang],
    reviewed_at: ctx.review.reviewed_at, reviewed_by: ctx.review.reviewed_by,
    check: ctx.check.items,
  }
  const v = createWorkItemVersion(item.id, { prompt: label, created_by: ctx.by, metadata_json: JSON.stringify(meta) })
  if (!v.ok) return { ok: false, code: 'docpdf_failed', detail: v.code }
  const state = finalState(v.item, ctx.hash)
  if (!state) return { ok: false, code: 'docpdf_failed', detail: 'the final version was created but could not be read back' }
  const profile = getProfile(itemProfileId(item.id))
  let court: CourtCheckResult | null = null
  if (profile) {
    const total = 1 + ctx.annexes.length
    const checkIn: CheckFile[] = [{ name: file.name, pdf: readFileSync(file.abs), role: 'main', path: file.path }]
    ctx.annexes.forEach((a, i) => {
      const annexId = annexIdOf(item.id, a.label)
      checkIn.push({ name: annexFinalName(a, profile, i + 1, total), pdf: a.pdf, role: 'annex', label: a.label, ...(annexId ? { annex_id: annexId } : {}) })
    })
    court = await checkFiles(profile, checkIn)
    saveCourtCheck(item.id, state.version_id, court)
  }
  return { ok: true, final: state, asset_path: file.path, court, reused: true }
}

/** The file name an annex of the package carries when sent: "<label> – <title>.pdf", numbered by the court profile. */
function annexFinalName(a: { label: string; title: string }, profile: ReturnType<typeof getProfile>, index: number, total: number): string {
  return profileFileName(`${fileStem(a.label)} – ${fileStem(a.title)}.pdf`, profile, index, total)
}

/** The language a final was made in (its label says it), for the annex cover pages made again when it is sent. */
export function finalLang(f: { label: string }, fallback: 'hu' | 'en'): 'hu' | 'en' {
  const l = String(f.label || '')
  return l.startsWith(FINAL_LABEL.en) ? 'en' : l.startsWith(FINAL_LABEL.hu) ? 'hu' : fallback
}

export interface PackageFile { name: string; pdf: Buffer; role: FinalFile['role']; label?: string; path?: string }

/**
 * Every file of a final's package, as it goes out: the saved submission (or combined file) and -- #753 -- the annexes made
 * now (cover + content) when the final did not save them. Older finals saved their annex PDFs: those are read from `files`.
 * Null when a saved file is gone or an annex cannot be made.
 */
export async function finalPackageFiles(item: WorkItemRow, f: FinalView, lang: 'hu' | 'en'): Promise<{ ok: true; files: PackageFile[] } | { ok: false; code: string; detail: string | null }> {
  const list: FinalFile[] = f.files && f.files.length ? f.files : [{ path: f.pdf_path, name: f.pdf_name, role: 'main' }]
  const out: PackageFile[] = []
  // An older final's saved annex PDF that is gone (moved away as a duplicate, #753) is made again instead, under its name.
  const remake: { at: number; label: string; name: string }[] = []
  for (const x of list) {
    const abs = resolveLifePath(x.path)
    if (!abs || !existsSync(abs)) {
      if (x.role !== 'annex' || !x.label) return { ok: false, code: 'court_file_missing', detail: x.name }
      remake.push({ at: out.length, label: x.label, name: x.name })
      out.push({ name: x.name, pdf: Buffer.alloc(0), role: 'annex', label: x.label })
      continue
    }
    // #794: the file on disk names it: a final renamed in the folder (before its stored name followed renames) goes out under the new name.
    const onDisk = x.role === 'annex' ? x.name : x.path.slice(x.path.lastIndexOf('/') + 1) || x.name
    out.push({ name: onDisk, pdf: readFileSync(abs), role: x.role, ...(x.label ? { label: x.label } : {}), path: x.path })
  }
  const labels = f.annex_labels ?? []
  if (!labels.length && !remake.length) return { ok: true, files: out }
  const resolve = resolverFor(item)
  if (!resolve) return { ok: false, code: 'annex_missing', detail: null }
  // skipBroken + the label list: the annexes the owner finalized, an annex left out then ("finalize anyway") stays out.
  const ax = await annexPdfs(item.id, resolve, { lang: docLangFor(item, lang), skipBroken: true })
  if (!ax.ok) return { ok: false, code: ax.code, detail: ax.detail ?? null }
  for (const r of remake) {
    const a = ax.annexes.find((y) => y.label === r.label)
    if (!a) return { ok: false, code: 'court_file_missing', detail: r.name }
    out[r.at] = { name: r.name, pdf: a.pdf, role: 'annex', label: r.label }
  }
  const profile = getProfile(itemProfileId(item.id))
  const total = 1 + labels.length
  let index = 1
  for (const label of labels) {
    const a = ax.annexes.find((y) => y.label === label)
    if (!a) return { ok: false, code: 'annex_missing', detail: label }
    out.push({ name: annexFinalName(a, profile, index++, total), pdf: a.pdf, role: 'annex', label })
  }
  return { ok: true, files: out }
}

/** A mellekletjegyzek-cimkehez (K1, Anlage K2 ...) tartozo melleklet azonositoja; csak PDF-forrasnal (annak lehet kereshető masolata). */
function annexIdOf(itemId: string, label: string): string | undefined {
  const a = listAnnexes(itemId).find((x) => x.label === label)
  return a && /\.pdf$/i.test(a.path) ? a.id : undefined
}

export type CourtRecheck =
  | { ok: true; court: CourtCheckResult }
  | { ok: false; code: 'court_no_profile' | 'court_no_final' | 'court_file_missing'; detail: string | null }

/**
 * Az ellenorzes ujrafuttatasa a legutobbi veglegesites fajljain (pl. mas
 * profil valasztasa, vagy a profil frissitese utan).
 */
export async function recheckFinal(item: WorkItemRow): Promise<CourtRecheck> {
  const profile = getProfile(itemProfileId(item.id))
  if (!profile) return { ok: false, code: 'court_no_profile', detail: null }
  const f = listFinals(item.id)[0]
  if (!f) return { ok: false, code: 'court_no_final', detail: null }
  // A vegleges fajlok utja a Raktarhoz kepest van (mint minden anyage), nem a projektmappahoz.
  const pkg = await finalPackageFiles(item, f, finalLang(f, 'hu'))
  if (!pkg.ok) return { ok: false, code: 'court_file_missing', detail: pkg.detail }
  const files: CheckFile[] = pkg.files.map((x) => {
    const annexId = x.label ? annexIdOf(item.id, x.label) : undefined
    return { ...x, ...(annexId ? { annex_id: annexId } : {}) }
  })
  const court = await checkFiles(profile, files)
  saveCourtCheck(item.id, f.version_id, court)
  return { ok: true, court }
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
    annexes: listAnnexes(item.id, resolverFor(item)).map((a) => ({ label: a.label, title: a.title, file: a.linked ? (a.life_rel || a.name) : a.path, linked: a.linked, file_present: a.exists, referenced: a.refs, added_by: a.created_by, added_at: iso(a.created_at) })),
    consistency: consistencyIssues(item.id).map((i) => ({ kind: i.kind, values: i.values, section: i.where, marked_intentional_by: i.acked_by, marked_intentional_at: iso(i.acked_at) })),
    reviews: reviews.map((r) => ({ content_hash: r.content_hash, reviewed_at: iso(r.reviewed_at), reviewed_by: r.reviewed_by })),
    finals: listFinals(item.id).map((f) => ({
      version_no: f.version_no, final_no: f.final_no, label: f.label, content_hash: f.content_hash, file: f.pdf_path, files: f.files ?? null, annex_mode: f.annex_mode ?? null,
      accepted_by: f.accepted_by, accepted_at: iso(f.accepted_at), accepted_text: f.accepted_text,
      reviewed_at: iso(f.reviewed_at), reviewed_by: f.reviewed_by, check: f.check,
      still_current: f.content_hash === hash,
    })),
  }
}
