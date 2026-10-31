/**
 * MELLEKLETEK A PDF-BEN (kanban #441, v4 spec 1/A, K-1.25).
 *
 * A beadvany es a mellekletei EGY PDF-ben ("combined") vagy KULON fajlokban
 * ("separate" -- az elektronikus beadasnal ez a szokasos: beA, CM/ECF,
 * e-per), mindegyik melleklet elott boritolappal ("K1. melleklet"). A
 * mellekletet ezen a gepen alakitjuk PDF-fe: a PDF valtozatlan marad, az
 * irodai fajl es a fenykep a LibreOffice-szal, a szoveg (TXT, MD) a sajat
 * PDF-keszitonkkel lesz PDF. Az egyesites a Poppler `pdfunite`-javal megy
 * (az iratolvasashoz ugyis kell a Poppler).
 *
 * Nincs csendes kudarc: ha egy melleklet nem alakithato, vagy hianyzik egy
 * program, a hiba megnevezi, MELYIK melleklet es MI a teendo.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runVersion } from './capability-probe.js'
import { convertOfficeToPdf, renderCacheDir } from './office-convert.js'
import { annexPdfKind, docSettings, listAnnexes, type AnnexScheme, type FileResolver } from './workbench-docannex.js'
import { buildCoverFodt, buildTextFodt, renderFodtPdf, PDF_FILTER_DRAFT, type DocLang } from './workbench-docrender.js'

export interface AnnexPdf { label: string; title: string; pdf: Buffer; fileName: string }

/**
 * #794 (Boss TG 3865): an annex goes out under the name of the file in the Life tree, never a name made up when it is sent.
 * The file is sent as a PDF: a name that is already .pdf is unchanged, another extension becomes .pdf.
 */
export function annexAttachmentName(fileName: string): string {
  return /\.pdf$/i.test(fileName) ? fileName : `${fileName.replace(/\.[A-Za-z0-9]{1,8}$/, '')}.pdf`
}

export type PackageError =
  | { code: 'annex_missing'; label: string; detail: string | null }
  | { code: 'annex_unsupported'; label: string; detail: string | null }
  | { code: 'annex_convert_failed'; label: string; detail: string | null; convert?: string }
  | { code: 'merge_not_installed'; detail: string | null }
  | { code: 'merge_failed'; detail: string | null }

type Out<T> = ({ ok: true } & T) | ({ ok: false } & PackageError)

/** Egy melleklet tartalma PDF-kent (boritolap nelkul). */
export async function annexContentPdf(abs: string, name: string): Promise<{ ok: true; pdf: Buffer } | { ok: false; code: 'annex_unsupported' | 'annex_convert_failed'; detail: string | null; convert?: string }> {
  const kind = annexPdfKind(name)
  if (!kind) return { ok: false, code: 'annex_unsupported', detail: name }
  try {
    if (kind === 'pdf') return { ok: true, pdf: readFileSync(abs) }
    if (kind === 'text') {
      const r = await renderFodtPdf(buildTextFodt(readFileSync(abs, 'utf-8'), name), PDF_FILTER_DRAFT)
      return r.ok ? { ok: true, pdf: r.pdf } : { ok: false, code: 'annex_convert_failed', detail: r.detail, convert: r.code }
    }
    const r = await convertOfficeToPdf(abs, { anyFile: kind === 'image' })
    if (!r.ok) return { ok: false, code: 'annex_convert_failed', detail: r.detail, convert: r.code }
    return { ok: true, pdf: readFileSync(r.pdf) }
  } catch (e) {
    return { ok: false, code: 'annex_convert_failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** PDF-ek egymas utan egy PDF-be (Poppler pdfunite). Egyetlen bemenet valtozatlanul jon vissza. */
export async function mergePdfs(parts: Buffer[]): Promise<Out<{ pdf: Buffer }>> {
  if (parts.length === 1) return { ok: true, pdf: parts[0] as Buffer }
  const dir = join(renderCacheDir(), `pkg-${randomUUID().slice(0, 12)}`)
  try {
    mkdirSync(dir, { recursive: true })
    const files = parts.map((b, i) => {
      const p = join(dir, `${String(i).padStart(3, '0')}.pdf`)
      writeFileSync(p, b)
      return p
    })
    const out = join(dir, 'out.pdf')
    const r = await runVersion(process.env['MARVEEN_PDFUNITE'] || 'pdfunite', [...files, out], 120_000)
    if (!r.ok) return r.code === 'not_found' ? { ok: false, code: 'merge_not_installed', detail: r.detail } : { ok: false, code: 'merge_failed', detail: r.detail }
    return { ok: true, pdf: readFileSync(out) }
  } catch (e) {
    return { ok: false, code: 'merge_failed', detail: e instanceof Error ? e.message : String(e) }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* a takaritas hibaja nem a felhasznalo baja */ }
  }
}

/** A boritolap szovege: "K1. melleklet" / "Anlage K1" / "Exhibit A". */
export function coverText(scheme: AnnexScheme, label: string, lang: DocLang = 'hu'): string {
  if (scheme !== 'k') return label
  // #794: the cover speaks the document's language: "Anlage K1" in a German letter, never "K1. melléklet".
  return lang === 'de' ? `Anlage ${label}` : lang === 'en' ? `Annex ${label}` : `${label}. melléklet`
}

/** Minden melleklet: boritolap + tartalom, egy PDF-ben mellekletenkent. */
export async function annexPdfs(itemId: string, resolve: FileResolver, opts: { lang: DocLang; skipBroken?: boolean }): Promise<Out<{ annexes: AnnexPdf[] }>> {
  const s = docSettings(itemId)
  const out: AnnexPdf[] = []
  for (const a of listAnnexes(itemId, resolve)) {
    const f = resolve(a.path)
    // #751: `skipBroken` -- the owner ticked "finalize anyway": an annex that is gone or cannot be read is left out.
    if (!f) { if (opts.skipBroken) continue; return { ok: false, code: 'annex_missing', label: a.label, detail: a.path } }
    const content = await annexContentPdf(f.abs, f.name)
    if (!content.ok) { if (opts.skipBroken && content.code === 'annex_unsupported') continue; return { ...content, label: a.label } }
    const cover = await renderFodtPdf(buildCoverFodt(coverText(s.annex_scheme, a.label, opts.lang), a.title, opts.lang), PDF_FILTER_DRAFT)
    if (!cover.ok) return { ok: false, code: 'annex_convert_failed', label: a.label, detail: cover.detail, convert: cover.code }
    const merged = await mergePdfs([cover.pdf, content.pdf])
    if (!merged.ok) return merged
    out.push({ label: a.label, title: a.title, pdf: merged.pdf, fileName: annexAttachmentName(f.name) })
  }
  return { ok: true, annexes: out }
}
