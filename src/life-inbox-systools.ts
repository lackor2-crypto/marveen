// SYSTEM TOOLS for the Inbox analyzer (card 56530b08).
//
// Boss, 2026-09-18: "ha nincs is claude fiok a gepen akkor ne lepodjon meg es
// azzal csinalja ami van a gepen!" -- the analyzer must use whatever the
// machine already has, and say plainly what it could not use.
//
// Nothing here installs anything. Every tool is looked up on PATH once; a
// missing binary means the function returns null and the caller falls back
// (hand-written PDF parser, filename date, manual choice). A present binary
// that fails at runtime (corrupt file, timeout) ALSO returns null -- the
// analyzer never throws because of an external tool.
//
//   pdftotext / pdfinfo / pdftoppm  -> poppler-utils (PDF text, metadata, render)
//   tesseract                       -> OCR for scans and photos
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const TOOL_TIMEOUT_MS = 30_000
const OCR_TIMEOUT_MS = 60_000
/** How many PDF pages we read as text: the first pages carry sender, date, subject. */
export const PDF_TEXT_PAGES = 5
/** How many PDF pages we OCR: a scan is slow, the first two pages are enough. */
export const PDF_OCR_PAGES = 2

const whichCache = new Map<string, string | null>()

/** Absolute path of an executable on PATH, or null. Cached per process. */
export function which(bin: string): string | null {
  if (whichCache.has(bin)) return whichCache.get(bin) ?? null
  let found: string | null = null
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, bin)
    try {
      if (existsSync(p) && statSync(p).isFile()) { found = p; break }
    } catch { /* unreadable PATH entry */ }
  }
  whichCache.set(bin, found)
  return found
}

/** Tests only: forget the PATH lookups (a test may change PATH). */
export function resetToolCache(): void {
  whichCache.clear()
  ocrLangCache = null
}

function run(bin: string, args: string[], timeout = TOOL_TIMEOUT_MS): string | null {
  const exe = which(bin)
  if (!exe) return null
  const r = spawnSync(exe, args, { timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

/** The PDF text layer via poppler, or null when pdftotext is missing/failed. */
export function pdfTextViaPoppler(absPath: string, pages = PDF_TEXT_PAGES): string | null {
  const out = run('pdftotext', ['-q', '-enc', 'UTF-8', '-f', '1', '-l', String(pages), absPath, '-'])
  return out === null ? null : out
}

export interface PdfInfo {
  title: string
  author: string
  creator: string
  producer: string
  creationDate: string
  modDate: string
  pages: number
}

/** `YYYY-MM-DDThh:mm:ss...` (pdfinfo -isodates) -> `YYYY-MM-DD`, or ''. */
function isoDay(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim())
  if (!m) return ''
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return ''
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** PDF metadata via poppler's pdfinfo, or null when missing/failed. */
export function pdfInfo(absPath: string): PdfInfo | null {
  const out = run('pdfinfo', ['-isodates', absPath])
  if (out === null) return null
  const field = (name: string): string => {
    const m = new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(out)
    return m ? m[1].trim() : ''
  }
  return {
    title: field('Title'),
    author: field('Author'),
    creator: field('Creator'),
    producer: field('Producer'),
    creationDate: isoDay(field('CreationDate')),
    modDate: isoDay(field('ModDate')),
    pages: Number(field('Pages')) || 0,
  }
}

// ---------------------------------------------------------------------------
// OCR (tesseract CLI)
// ---------------------------------------------------------------------------

// Languages we want, in order. German matters: a large share of the owner's
// paperwork comes from German authorities. We only ask for the ones that are
// actually installed -- tesseract fails hard on a missing traineddata.
const WANTED_OCR_LANGS = ['hun', 'deu', 'eng']
let ocrLangCache: string | null = null

/** The `-l` argument for tesseract (`hun+eng`...), or '' if none is usable. */
export function ocrLanguages(): string {
  if (ocrLangCache !== null) return ocrLangCache
  const out = run('tesseract', ['--list-langs'])
  if (out === null) { ocrLangCache = ''; return '' }
  const have = new Set(out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
  const langs = WANTED_OCR_LANGS.filter((l) => have.has(l))
  ocrLangCache = langs.length ? langs.join('+') : (have.has('eng') ? 'eng' : '')
  return ocrLangCache
}

export function tesseractAvailable(): boolean {
  return which('tesseract') !== null && ocrLanguages() !== ''
}

export function pdfRenderAvailable(): boolean {
  return which('pdftoppm') !== null
}

function ocrImageFile(imagePath: string): string | null {
  const langs = ocrLanguages()
  if (!langs) return null
  return run('tesseract', [imagePath, '-', '-l', langs], OCR_TIMEOUT_MS)
}

/**
 * OCR text of an image or a (scanned) PDF. For a PDF the first pages are
 * rendered with pdftoppm into a private temp dir that is always removed.
 */
export function ocrFile(absPath: string, isPdf: boolean): string | null {
  if (!tesseractAvailable()) return null
  if (!isPdf) {
    const t = ocrImageFile(absPath)
    return t && t.trim() ? t : null
  }
  if (!pdfRenderAvailable()) return null
  const dir = mkdtempSync(join(tmpdir(), 'marveen-ocr-'))
  try {
    const rendered = run('pdftoppm', ['-r', '200', '-f', '1', '-l', String(PDF_OCR_PAGES), '-png', absPath, join(dir, 'p')], OCR_TIMEOUT_MS)
    if (rendered === null) return null
    const pages = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
    const parts: string[] = []
    for (const p of pages) {
      const t = ocrImageFile(join(dir, p))
      if (t && t.trim()) parts.push(t)
    }
    return parts.length ? parts.join('\n') : null
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir already gone */ }
  }
}

// ---------------------------------------------------------------------------
// ASYNC variants -- the dashboard route must not block on a multi-second OCR.
// ---------------------------------------------------------------------------
function runAsync(bin: string, args: string[], timeout = TOOL_TIMEOUT_MS): Promise<string | null> {
  const exe = which(bin)
  if (!exe) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout)
    })
  })
}

async function ocrImageFileAsync(imagePath: string): Promise<string | null> {
  const langs = ocrLanguages()
  if (!langs) return null
  return runAsync('tesseract', [imagePath, '-', '-l', langs], OCR_TIMEOUT_MS)
}

/** `ocrFile`, without blocking the event loop. */
export async function ocrFileAsync(absPath: string, isPdf: boolean): Promise<string | null> {
  if (!tesseractAvailable()) return null
  if (!isPdf) {
    const t = await ocrImageFileAsync(absPath)
    return t && t.trim() ? t : null
  }
  if (!pdfRenderAvailable()) return null
  const dir = mkdtempSync(join(tmpdir(), 'marveen-ocr-'))
  try {
    const rendered = await runAsync('pdftoppm', ['-r', '200', '-f', '1', '-l', String(PDF_OCR_PAGES), '-png', absPath, join(dir, 'p')], OCR_TIMEOUT_MS)
    if (rendered === null) return null
    const pages = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
    const parts: string[] = []
    for (const p of pages) {
      const t = await ocrImageFileAsync(join(dir, p))
      if (t && t.trim()) parts.push(t)
    }
    return parts.length ? parts.join('\n') : null
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir already gone */ }
  }
}
