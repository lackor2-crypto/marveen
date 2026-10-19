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
import { execFileSync } from 'node:child_process'
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
  return { ok: true, html: restoreFreePictures(sanitizeDocHtml(r.data.toString('utf-8')), abs) }
}

/**
 * #719 (Boss TG 3834): LibreOffice's Word -> HTML export drops the place of a freely placed picture (a `wp:anchor` with
 * `wrapNone`): it comes back as a plain left-aligned image at the top of its paragraph, so a signature the owner had placed
 * jumped to the top-left corner after "Save as a new version" and a reopen. The place is still in the .docx (`posOffset`:
 * left from the text column, top from the paragraph, in EMU); this puts it back on the images, in the same document order
 * (the editor reads `position:absolute; left; top` in cm). When the counts of pictures differ, nothing is touched.
 */
export function freePictureOffsets(docXml: string): ({ left: number; top: number } | null)[] {
  const out: ({ left: number; top: number } | null)[] = []
  const re = /<w:drawing>([\s\S]*?)<\/w:drawing>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(docXml))) {
    const d = m[1]
    const h = /<wp:positionH relativeFrom="column">\s*<wp:posOffset>(-?\d+)<\/wp:posOffset>/.exec(d)
    const v = /<wp:positionV relativeFrom="paragraph">\s*<wp:posOffset>(-?\d+)<\/wp:posOffset>/.exec(d)
    out.push(/<wp:anchor\b/.test(d) && /<wp:wrapNone\b/.test(d) && h && v
      ? { left: Math.round(Number(h[1]) / 3600) / 100, top: Math.round(Number(v[1]) / 3600) / 100 } : null)
  }
  return out
}

export function applyFreePictures(html: string, offsets: ({ left: number; top: number } | null)[]): string {
  const imgs = html.match(/<img\b[^>]*>/gi) || []
  if (!imgs.length || imgs.length !== offsets.length || !offsets.some(Boolean)) return html
  let i = 0
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const o = offsets[i++]
    if (!o) return tag
    const pos = `position:absolute; left:${o.left}cm; top:${o.top}cm; margin:0`
    let t = tag.replace(/\salign\s*=\s*("[^"]*"|'[^']*'|[^\s>/]+)/i, '')
    t = /\sstyle\s*=\s*"/i.test(t) ? t.replace(/\sstyle\s*=\s*"/i, ` style="${pos}; `) : t.replace(/<img\b/i, `<img style="${pos}"`)
    return t
  })
}

function restoreFreePictures(html: string, abs: string): string {
  if (!/\.docx$/i.test(abs)) return html
  try {
    const xml = execFileSync('unzip', ['-p', abs, 'word/document.xml'], { maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }).toString('utf-8')
    return applyFreePictures(html, freePictureOffsets(xml))
  } catch { return html }
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

/** Formats the printable page can be exported to (Boss, TG 2243: "amibe csak lehet"): file
 *  extension -> LibreOffice target filter and download MIME type. */
export const DOC_EXPORT_FORMATS: Record<string, { filter: string; mime: string }> = {
  docx: { filter: 'docx:MS Word 2007 XML', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { filter: 'doc:MS Word 97', mime: 'application/msword' },
  odt: { filter: 'odt:writer8', mime: 'application/vnd.oasis.opendocument.text' },
  rtf: { filter: 'rtf:Rich Text Format', mime: 'application/rtf' },
  txt: { filter: 'txt:Text (encoded):UTF8', mime: 'text/plain; charset=utf-8' },
  epub: { filter: 'epub:EPUB', mime: 'application/epub+zip' },
}

/** The printable page HTML -> the bytes of one of DOC_EXPORT_FORMATS. */
export async function htmlToExportBytes(html: string, ext: string): Promise<{ ok: true; data: Buffer } | DocEditFail> {
  const fmt = DOC_EXPORT_FORMATS[ext]
  if (!fmt) return { ok: false, code: 'convert_failed', detail: `unsupported target format: ${ext}` }
  let dir: string
  try { dir = scratchDir('export') } catch (e) {
    return { ok: false, code: 'convert_failed', detail: e instanceof Error ? e.message : String(e) }
  }
  try {
    const src = join(dir, 'document.html')
    writeFileSync(src, sanitizeDocHtml(html), 'utf-8')
    const r = await sofficeConvertFile(src, fmt.filter, { outExt: ext, infilter: 'HTML (StarWriter)' })
    if (!r.ok) return r
    return { ok: true, data: r.data }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* cleanup failure is not the user's problem */ }
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
