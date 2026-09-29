/**
 * MUNKAPAD: DOKUMENTUM SZERKESZTESE A MUNKAPADON BELUL (kanban #444).
 *
 * A tulajdonos (2026-09-29): "hogyha feltoltok egy .doc-ot [...] vagy egy
 * PDF-et, akkor pont, hogy itt kellene tudni szerkeszteni [...] nem az, hogy
 * letolteni, valamivel szerkeszteni, aztan ide-vissza." Dontese: 1A (formazott
 * Word-szerkesztes, a mentes uj .docx verzio) + 2C (PDF-re raíras / kiemeles /
 * kitakaras, ES a PDF atalakitasa szerkesztheto Word-dokumentumma).
 *
 * Az ut NEM uj csomag-fuggoseg, hanem a mar meglevo LibreOffice (ugyanaz, ami
 * az elonezetet kesziti):
 *   - szerkesztesre: dokumentum -> HTML (a kepek beagyazva, a stilusok a
 *     fejben), ezt a bongeszo egy szerkesztheto, szkript nelkuli keretben mutatja;
 *   - mentesre:      HTML -> ugyanaz a formatum (.docx marad .docx), UJ fajl +
 *     UJ verzio -- a regi fajl es a regi verzio erintetlen.
 *   - PDF -> Word:   a Poppler `pdftohtml`-je folyo szoveget ad (felkover,
 *     dolt, kepek megmaradnak), abbol lesz .docx. Ha a Poppler nincs meg, a
 *     LibreOffice sajat PDF-importja a tartalek (az keretekbe tordel, de
 *     szerkesztheto marad).
 *
 * FRISS TELEPITES: a LibreOffice es a Poppler sem kotelezo. Ha hianyzik, a
 * hibat a hivo EMBERI mondatra forditja; a kod (`not_installed` /
 * `check_failed`) a meres eredmenye, nem talalgatas.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { probeCommand, runVersion, type CommandProbe } from './capability-probe.js'
import { renderCacheDir, sofficeConvertFile, type SofficeFileResult } from './office-convert.js'

/** Szoveges dokumentumok, amiket a Munkapadon belul szerkeszteni lehet, es
 *  a LibreOffice celformatuma, amibe a mentes visszair (a formatum marad). */
export const DOC_EDIT_FORMATS: Record<string, string> = {
  docx: 'docx:MS Word 2007 XML',
  doc: 'doc:MS Word 97',
  odt: 'odt:writer8',
  rtf: 'rtf:Rich Text Format',
}

export function docEditExt(name: unknown): string | null {
  const ext = extname(String(name || '')).slice(1).toLowerCase()
  return Object.prototype.hasOwnProperty.call(DOC_EDIT_FORMATS, ext) ? ext : null
}

/** A szerkesztendo HTML felso hatara (a beagyazott kepekkel egyutt). */
export const DOC_EDIT_HTML_MAX = 40 * 1024 * 1024

const HTML_EXPORT = 'html:HTML (StarWriter):{"EmbedImages":{"type":"boolean","value":"true"}}'

export type DocEditFail = Extract<SofficeFileResult, { ok: false }>

/**
 * A HTML, amit a bongeszo szerkeszt, es amit a LibreOffice visszaolvas.
 *
 * A szerkeszto keret SZKRIPT NELKUL fut (sandbox), de a mentett HTML-t a
 * LibreOffice is beolvassa: kulso hivatkozast (kep URL-rol, stiluslap) NEM
 * hagyunk benne, kulonben a konverzio a halozatra nyulna. Csak ami a
 * dokumentumban magaban van (beagyazott kep, sajat stilus), az marad.
 */
export function sanitizeDocHtml(html: string): string {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(iframe|object|embed|frameset|frame|applet)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|frame|applet|link|base)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*(?:javascript|vbscript):[^"']*\2/gi, '$1=$2#$2')
    // Kep CSAK beagyazva: a kulso cimet a LibreOffice le akarna tolteni.
    .replace(/<img\b[^>]*>/gi, (tag) => (/\ssrc\s*=\s*("|')?\s*data:/i.test(tag) ? tag : ''))
    .replace(/url\(\s*(["']?)\s*(?:https?:|\/\/|file:)[^)]*\)/gi, 'none')
}

/** Dokumentum -> szerkesztheto HTML. */
export async function docToEditableHtml(abs: string): Promise<{ ok: true; html: string } | DocEditFail> {
  const r = await sofficeConvertFile(abs, HTML_EXPORT, { outExt: 'html' })
  if (!r.ok) return r
  return { ok: true, html: sanitizeDocHtml(r.data.toString('utf-8')) }
}

/** Egy ideiglenes munkamappa a `store/` alatt (sosem a felhasznalo mappajaban). */
function scratchDir(tag: string): string {
  const d = join(renderCacheDir(), `tmp-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(d, { recursive: true })
  return d
}

/** HTML -> a megadott formatum bajtjai (`ext` a DOC_EDIT_FORMATS kulcsa). */
export async function htmlToDocBytes(html: string, ext: string): Promise<{ ok: true; data: Buffer } | DocEditFail> {
  const target = DOC_EDIT_FORMATS[ext]
  if (!target) return { ok: false, code: 'convert_failed', detail: `unsupported target format: ${ext}` }
  let dir: string
  try { dir = scratchDir('edit') } catch (e) {
    return { ok: false, code: 'convert_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  try {
    const src = join(dir, 'document.html')
    writeFileSync(src, sanitizeDocHtml(html), 'utf-8')
    const r = await sofficeConvertFile(src, target, { outExt: ext, infilter: 'HTML (StarWriter)' })
    if (!r.ok) return r
    return { ok: true, data: r.data }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* a takaritas hibaja nem a felhasznalo baja */ }
  }
}

/** Van-e Poppler `pdftohtml` ezen a gepen? */
export function probePdfToHtml(opts: { force?: boolean; candidates?: string[] } = {}): Promise<CommandProbe> {
  return probeCommand({
    id: 'pdftohtml',
    configured: null,
    candidates: ['pdftohtml', '/usr/bin/pdftohtml', '/usr/local/bin/pdftohtml', '/opt/homebrew/bin/pdftohtml'],
    versionArgs: ['-v'],
    timeoutMs: 10_000,
  }, opts)
}

/**
 * A `pdftohtml -noframes` kimenete sorokbol all (`...<br/>`), a lapokat `<hr/>`
 * valasztja, a vegen egy "Document Outline" blokk. Ebbol bekezdes-sorozat lesz:
 * soronkent egy bekezdes, uj lapnal oldaltores -- igy Word-ben rendes, folyo,
 * szerkesztheto szoveg all, nem lebego keretek.
 */
export function pdfHtmlToParagraphs(raw: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(String(raw || ''))
  let body = bodyMatch ? (bodyMatch[1] as string) : String(raw || '')
  const outline = body.search(/<a name="?outline"?><\/a>/i)
  if (outline >= 0) body = body.slice(0, outline)
  body = body.replace(/<a name="?\d+"?><\/a>/gi, '')
  // `<b>Cim<br/></b>Szoveg`: a zaro jelolot a sortores ELE tesszuk, kulonben a
  // felkover atfolyna a kovetkezo bekezdesbe.
  body = body.replace(/<br\/?>((?:\s*<\/(?:b|i|u|em|strong|span|font)>)+)/gi, '$1<br/>')
  const pages = body.split(/<hr\s*\/?>/i)
  const out: string[] = []
  pages.forEach((page) => {
    const lines = page.split(/<br\s*\/?>/i).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l && l !== '&#160;')
    if (!lines.length) return
    lines.forEach((l, i) => {
      out.push(i === 0 && out.length ? `<p style="page-break-before: always">${l}</p>` : `<p>${l}</p>`)
    })
  })
  return '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title></title></head><body>\n'
    + out.join('\n') + '\n</body></html>\n'
}

/** PDF -> szerkesztheto .docx bajtjai. */
export async function pdfToDocxBytes(abs: string, opts: { pdftohtml?: CommandProbe } = {}): Promise<{ ok: true; data: Buffer; via: 'pdftohtml' | 'libreoffice' } | DocEditFail> {
  const probe = opts.pdftohtml || await probePdfToHtml()
  if (probe.available && probe.path) {
    let dir: string | null = null
    try {
      dir = scratchDir('pdf')
      const r = await runVersion(probe.path, ['-noframes', '-dataurls', '-enc', 'UTF-8', '-q', abs, join(dir, 'page')], 180_000)
      if (r.ok) {
        const made = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.html'))
        if (made) {
          const html = pdfHtmlToParagraphs(readFileSync(join(dir, made), 'utf-8'))
          const d = await htmlToDocBytes(html, 'docx')
          if (!d.ok) return d
          return { ok: true, data: d.data, via: 'pdftohtml' }
        }
      }
      // A pdftohtml elhasalt (pl. jelszavas PDF): a LibreOffice-szal is
      // megprobaljuk, es ha az is elbukik, AZ a hibauzenet jon vissza.
    } catch { /* ugyanigy: jon a tartalek ut */ } finally {
      if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* nem a felhasznalo baja */ } }
    }
  }
  const r = await sofficeConvertFile(abs, DOC_EDIT_FORMATS['docx'] as string, { outExt: 'docx', infilter: 'writer_pdf_import' })
  if (!r.ok) return r
  return { ok: true, data: r.data, via: 'libreoffice' }
}

/** Egy PDF alairas-ellenorzese: a bongeszo altal keszitett uj PDF valoban PDF-e. */
export function looksLikePdf(data: Buffer): boolean {
  return data.length > 8 && data.subarray(0, 5).toString('latin1') === '%PDF-' && data.subarray(-1024).toString('latin1').includes('%%EOF')
}
