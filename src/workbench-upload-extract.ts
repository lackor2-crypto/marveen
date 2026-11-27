// #794 (Boss TG 10480, 10482): EVERYTHING that arrives at a work item -- Attachments, Uploads, Agent, a folder next to the
// item, any file type -- is READ OUT and its content written into the item's context file, so the chat and the AI see it
// without anyone having to open the file ("the fine of the Berlin letter said 13:30-13:50, nobody read the PNG").
//
// The sweep of the context file (workbench-item-context.ts) calls this: every file of the item's materials list is read
// ONCE (again when its size or time changed): text files as they are, PDF by its text layer (a scan by OCR), Word / OpenDocument
// by their XML, a picture by OCR. The result is kept in a table and drawn into the machine block of the context file. A file
// that could not be read is NAMED there as unread (never silently skipped), so the AI reads it by hand and says so.
// #986: audio and video are read too -- their speech, by the local recogniser, in the background (workbench-media-transcript.ts).
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { getDb } from './db.js'
import { logger } from './logger.js'
import { ol } from './owner-lang.js'
import { ocrFileAsync, pdfTextViaPopplerAsync, tesseractAvailable, which } from './life-inbox-systools.js'
import { ensureExtractTable, isOwnOutputPath, isSpeechKind, liveTranscript } from './workbench-media-state.js'
import { queueTranscript, speechInstalled, type SpeechResult } from './workbench-media-transcript.js'
export { isOwnOutputPath }

/** One file's text is kept up to this long; the whole block of a context file up to BLOCK_MAX_CHARS. */
export const EXTRACT_BEGIN = '<!-- marveen:extract:begin -->'
export const EXTRACT_END = '<!-- marveen:extract:end -->'

/** The context file text split into the part the AI sees as the notes and the machine-read content of the uploads. */
export function splitExtraction(text: string): { rest: string; extraction: string } {
  const a = text.indexOf(EXTRACT_BEGIN)
  const b = text.indexOf(EXTRACT_END)
  if (a < 0 || b < a) return { rest: text, extraction: '' }
  return { rest: text.slice(0, a) + text.slice(b + EXTRACT_END.length), extraction: text.slice(a + EXTRACT_BEGIN.length, b).trim() }
}

export const FILE_TEXT_MAX = 8_000
export const BLOCK_MAX_CHARS = 48_000
/** A file bigger than this is not read (the OCR / unzip of a huge file would stall the sweep). */
export const FILE_BYTES_MAX = 25 * 1024 * 1024
/** At most this many files are read per item and per sweep; the rest follow at the next pass. */
export const READS_PER_ITEM = 3
const PDF_PAGES = 12

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.rtf', '.eml', '.log', '.ics'])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff'])
const ZIPXML: Record<string, { entry: string; para: RegExp }> = {
  '.docx': { entry: 'word/document.xml', para: /<\/w:p>|<w:br\s*\/>|<w:tab\s*\/>/g },
  '.odt': { entry: 'content.xml', para: /<\/text:p>|<\/text:h>|<text:line-break\s*\/>/g },
}

export type ExtractMethod = 'text' | 'pdf' | 'pdf_ocr' | 'word' | 'ocr'
/** `missing`: a program this machine does not have; the file is read again once it is there. */
export type ExtractResult = { ok: true; method: ExtractMethod; text: string } | { ok: false; reason: string; missing?: 'tesseract' | 'unzip' }

/** True for a kind of file this module can read at all (an archive is not "unreadable", it is just not text). */
export function isReadableKind(name: string): boolean {
  const e = extname(name).toLowerCase()
  return TEXT_EXT.has(e) || IMAGE_EXT.has(e) || e === '.pdf' || e in ZIPXML || isSpeechKind(name)
}

function entities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&')
}

function tidy(text: string): string {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function unzipEntry(abs: string, entry: string): Promise<string | null> {
  const exe = which('unzip')
  if (!exe) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(exe, ['-p', abs, entry], { timeout: 30_000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  })
}

/** Reads one file's content. Never throws; an unreadable file answers with the reason (stored, shown, and said to the owner). */
export async function extractFile(abs: string): Promise<ExtractResult> {
  const ext = extname(abs).toLowerCase()
  try {
    if ((await stat(abs)).size > FILE_BYTES_MAX) return { ok: false, reason: ol('a fájl túl nagy az automatikus kiolvasáshoz', 'the file is too large for the automatic read') }
    if (TEXT_EXT.has(ext)) {
      const t = tidy(await readFile(abs, 'utf8'))
      return t ? { ok: true, method: 'text', text: t } : { ok: false, reason: ol('a fájl üres', 'the file is empty') }
    }
    if (ext === '.pdf') {
      const layer = await pdfTextViaPopplerAsync(abs, PDF_PAGES)
      if (layer && layer.replace(/\s+/g, '').length >= 40) return { ok: true, method: 'pdf', text: tidy(layer) }
      // A scan has no text layer: read the pages as pictures.
      if (!tesseractAvailable()) return { ok: false, missing: 'tesseract', reason: ol('szkennelt PDF, és az OCR (tesseract) nincs telepítve', 'a scanned PDF, and OCR (tesseract) is not installed') }
      const ocr = await ocrFileAsync(abs, true)
      return ocr && ocr.trim() ? { ok: true, method: 'pdf_ocr', text: tidy(ocr) } : { ok: false, reason: ol('a PDF-ből nem jött ki szöveg (sem szövegréteg, sem OCR)', 'no text came out of the PDF (neither a text layer nor OCR)') }
    }
    const zx = ZIPXML[ext]
    if (zx) {
      const xml = await unzipEntry(abs, zx.entry)
      if (xml === null) return { ok: false, ...(which('unzip') ? {} : { missing: 'unzip' as const }), reason: ol('a dokumentum nem bontható ki (unzip hiányzik vagy a fájl sérült)', 'the document cannot be opened (unzip missing or the file is damaged)') }
      const t = tidy(entities(xml.replace(zx.para, '\n').replace(/<[^>]+>/g, '')))
      return t ? { ok: true, method: 'word', text: t } : { ok: false, reason: ol('a dokumentumban nincs szöveg', 'the document holds no text') }
    }
    if (IMAGE_EXT.has(ext)) {
      if (!tesseractAvailable()) return { ok: false, missing: 'tesseract', reason: ol('a kép kiolvasásához az OCR (tesseract) nincs telepítve', 'reading the picture needs OCR (tesseract), which is not installed') }
      const ocr = await ocrFileAsync(abs, false)
      return ocr && ocr.trim() ? { ok: true, method: 'ocr', text: tidy(ocr) } : { ok: false, reason: ol('az OCR nem talált szöveget a képen', 'OCR found no text in the picture') }
    }
    return { ok: false, reason: ol('ezt a fájltípust nem tudom automatikusan kiolvasni', 'this file type cannot be read automatically') }
  } catch (err: any) {
    return { ok: false, reason: String(err?.message || err).slice(0, 200) }
  }
}

interface Row { item_id: string; rel: string; size: number; mtime_ms: number; method: string; text: string; error: string }

function readRows(itemId: string): Map<string, Row> {
  ensureExtractTable()
  const rows = getDb().prepare('SELECT item_id, rel, size, mtime_ms, method, text, error FROM work_item_file_extract WHERE item_id = ?').all(itemId) as Row[]
  return new Map(rows.map((r) => [r.rel, r]))
}

export interface MaterialFile { rel: string; abs: string }

function saveRow(itemId: string, f: MaterialFile, size: number, mtimeMs: number, method: string, text: string, error: string): void {
  getDb().prepare(`INSERT INTO work_item_file_extract (item_id, rel, size, mtime_ms, method, text, error, extracted_at, abs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, rel) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, method = excluded.method,
      text = excluded.text, error = excluded.error, extracted_at = excluded.extracted_at, abs = excluded.abs`)
    .run(itemId, f.rel, size, Math.floor(mtimeMs), method, text, error, Math.floor(Date.now() / 1000), f.abs)
}

/** A recording goes in line for the recogniser; one another item already heard is taken over at once. */
function readSpeech(itemId: string, f: MaterialFile, size: number, mtimeMs: number, onSpeech?: () => Promise<void>): boolean {
  const heard = getDb().prepare('SELECT method, text, error FROM work_item_file_extract WHERE abs = ? AND size = ? AND mtime_ms = ? LIMIT 1')
    .get(f.abs, size, Math.floor(mtimeMs)) as { method: string; text: string; error: string } | undefined
  if (heard) { saveRow(itemId, f, size, mtimeMs, heard.method, heard.text, heard.error); return true }
  if (!speechInstalled()) return false
  queueTranscript({ abs: f.abs, size, mtimeMs }, `${itemId}\u0000${f.rel}`, async (r: SpeechResult | null) => {
    if (r) saveRow(itemId, f, size, mtimeMs, 'speech', r.ok ? r.text : '', r.ok ? '' : r.reason)
    await onSpeech?.()
  })
  return false
}

/**
 * Reads the files of the item that were not read yet (or changed). Returns how many rows were written.
 * `limit` bounds the work of one call: the OCR of a picture takes seconds. Recordings do not count against it: they
 * only go in line here, and `onSpeech` runs when one of them is ready (or failed).
 */
export async function readNewMaterials(itemId: string, files: MaterialFile[], limit = READS_PER_ITEM, onSpeech?: () => Promise<void>): Promise<number> {
  ensureExtractTable()
  const have = readRows(itemId)
  let done = 0
  let reads = 0
  for (const f of files) {
    if (isOwnOutputPath(f.rel) || !isReadableKind(f.abs)) continue
    const speech = isSpeechKind(f.abs)
    if (!speech && reads >= limit) continue
    let st: import('node:fs').Stats
    try { st = await stat(f.abs) } catch { continue }
    const old = have.get(f.rel)
    const stale = !!old && old.method.startsWith('missing:') && (old.method === 'missing:tesseract' ? tesseractAvailable() : which('unzip') !== null)
    if (old && !stale && old.size === st.size && old.mtime_ms === Math.floor(st.mtimeMs)) continue
    if (speech) { if (readSpeech(itemId, f, st.size, st.mtimeMs, onSpeech)) done++; continue }
    const r = await extractFile(f.abs)
    saveRow(itemId, f, st.size, st.mtimeMs, r.ok ? r.method : r.missing ? `missing:${r.missing}` : '', r.ok ? r.text : '', r.ok ? '' : r.reason)
    if (!r.ok) logger.warn({ item: itemId, rel: f.rel, reason: r.reason }, '[upload-extract] a file could not be read out')
    reads++
    done++
  }
  return done
}

/** What the block says about a recording that has no transcript yet. */
function pendingSpeechLine(abs: string): string {
  const now = liveTranscript(abs)
  if (now?.state === 'failed') return `⚠ ${ol('Az átirat nem készült el', 'The transcript was not made')}: ${now.reason}. ${ol('Az újraindítás után újra megpróbálom.', 'It is tried again after a restart.')}`
  if (!now && !speechInstalled()) {
    return `⚠ ${ol('Nincs átirat: a helyi beszédfelismerő nincs telepítve ezen a gépen. Telepítés: Beállítás-varázsló, „Hang-eszköztár” lépés, „Telepítés” gomb.', 'No transcript: the local speech recogniser is not installed on this machine. Install: setup wizard, “Voice toolkit” step, “Install” button.')}`
  }
  return `⏳ ${ol('Az átirat még készül a háttérben (egy felvételnél ez percekig tarthat). Amíg nincs itt, a felvétel tartalmát nem ismered.', 'The transcript is still being made in the background (minutes for one recording). Until it is here you do not know what the recording says.')}`
}

const METHOD_LABEL: Record<string, [string, string]> = {
  text: ['szöveg', 'text'], pdf: ['PDF szövegréteg', 'PDF text layer'], pdf_ocr: ['PDF, OCR', 'PDF, OCR'],
  word: ['dokumentum', 'document'], ocr: ['kép, OCR', 'picture, OCR'],
  speech: ['hang átirata, gépi felismerés', 'transcript of the sound, machine recognised'],
}

/**
 * The lines the context file carries for the materials that are there NOW (a file that went away drops out). Every
 * readable kind that has no row yet is listed as waiting; one that failed is listed as UNREAD with the reason.
 */
export function extractionBlockLines(itemId: string, files: MaterialFile[]): string[] {
  const rows = readRows(itemId)
  const out: string[] = []
  let used = 0
  let waiting = 0
  // Documents first, recordings after them: a long transcript must not push the documents out of what is read first.
  const ordered = [...files.filter((f) => !isSpeechKind(f.abs)), ...files.filter((f) => isSpeechKind(f.abs))]
  for (const f of ordered) {
    if (isOwnOutputPath(f.rel) || !isReadableKind(f.abs)) continue
    const speech = isSpeechKind(f.abs)
    const r = rows.get(f.rel)
    if (!r) { if (speech) out.push(`### ${f.rel}`, pendingSpeechLine(f.abs), ''); else waiting++; continue }
    if (r.error && speech) { out.push(`### ${f.rel}`, `⚠ ${ol('Nincs átirat', 'No transcript')}: ${r.error}.`, ''); continue }
    if (r.error) { out.push(`### ${f.rel}`, `⚠ ${ol('Nem sikerült kiolvasni', 'Could not be read out')}: ${r.error}. ${ol('Olvasd be kézzel, és írd a Kontextusba, mi áll benne.', 'Read it by hand and write what it says into the Context.')}`, ''); continue }
    const [hu, en] = METHOD_LABEL[r.method] ?? [r.method, r.method]
    // A transcript is the only way to know what a recording says, so it goes in whole (the file itself cannot be opened).
    const cut = !speech && r.text.length > FILE_TEXT_MAX
    // The text sits between our own markers and inside a fence: neither may be closed from the inside.
    const body = (cut ? r.text.slice(0, FILE_TEXT_MAX) : r.text).replace(/<!--\s*marveen:/g, '<!-- ').replace(/```/g, "'''")
    if (!speech && used + body.length > BLOCK_MAX_CHARS) { out.push(`### ${f.rel}`, ol('(a hely elfogyott: a kiolvasott szöveg nem fér ide, nyisd meg a fájlt)', '(out of room: the text does not fit here, open the file)'), ''); continue }
    if (!speech) used += body.length
    out.push(`### ${f.rel} (${ol(hu, en)})`, '```', body, '```', cut ? ol('(a szöveg itt le van vágva, a fájl teljes)', '(the text is cut here, the file is complete)') : '', '')
  }
  if (!out.length && !waiting) return []
  const head = `## ${ol('Feltöltött anyagok kiolvasott tartalma (automatikus, ne szerkeszd)', 'Read-out content of the uploaded materials (automatic, do not edit)')}`
  const lead = ol(
    'Minden fájl tartalma itt van; ha ellentmond annak, amit a felhasználó mondott, jelezd neki.',
    'The content of every file is here; if it contradicts what the user said, tell them.',
  )
  const tail = waiting ? [ol(`(${waiting} fájl kiolvasása még sorra vár)`, `(${waiting} file(s) still waiting to be read out)`)] : []
  return [EXTRACT_BEGIN, head, lead, '', ...out, ...tail, EXTRACT_END]
}
