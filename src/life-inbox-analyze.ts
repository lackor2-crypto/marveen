// A BEERKEZO AI-JAVASLAT elemzoje -- kartya #204 (0fc6d115).
//
// Ez a modul a MAR MUKODO kezi lanc (`life-inbox.ts`) FOLE epul, nem
// helyettesiti: a tenyleges mozgatas es a harom biztonsagi szabaly (soha ne
// talalja ki a gazdat vak modon / soha ne irjon felul / soha ne engedjen be
// hitelesito adatot) TOVABBRA IS ott lakik. Ez a modul csak JAVASLATOT ad --
// tipus, tulajdonos, datum, kategoria, celmappa, fajlnev -- MINDEGYIKHEZ
// bizonytalansaggal (confidence). Alacsony bizonytalansagnal a sor kerdojeles
// marad, es a felhasznalo dont (Boss dontese, ld. a kartya specifikacioja).
//
// CSOMAGTELEPITES-KORLAT: a helyi arcfelismeres (dlib/face_recognition) es az
// OCR (tesseract) telepitese Boss level-2 jovahagyasahoz kotott. Ezert ez a
// modul egyetlen apt/pip csomagot sem felteteleez -- az OCR- es
// arcfelismero-funkciot egy ADAPTER INTERFESZ mogé rejtjuk
// (`OcrAdapter`/`FaceAdapter`), aminek az alapertelmezese "nincs telepitve".
// A valodi implementacio a jovahagyas UTAN egy kulon modulban `setOcrAdapter`/
// `setFaceAdapter` hivassal koto be -- ITT egy sor sem valtozik.
import { existsSync, readdirSync, statSync, openSync, closeSync, readSync, fstatSync } from 'node:fs'
import { extname, join } from 'node:path'
import { inflateSync, inflateRawSync } from 'node:zlib'
import { APP_LANG } from './config.js'
import {
  lifeName, lifeKeyForName, loadLifeConfig, safeLifeName, inboxDir,
  resolveFilingPerson,
  type LifeConfig,
} from './life-tree.js'
import { explorerRoot, humanLocation } from './life-explorer.js'
import { inboxStatus, credentialRisk, type InboxItem, type InboxReason } from './life-inbox.js'

export function T(lang: string, hu: string, en: string): string {
  return lang === 'en' ? en : hu
}

// ---------------------------------------------------------------------------
// TIPUSFELISMERES -- magic-bytes/mime alapon, NEM kiterjesztes alapon.
//
// Az OOXML (docx/xlsx/pptx) es a regi Office-fajlok (doc/xls/ppt) kivetelek:
// ezek egy kozos ZIP ill. OLE-konteneren osztoznak, amit a magic-byte NEM
// kulonboztet meg tovabb -- ott (es CSAK ott) a kiterjesztes DONTI EL a
// pontos alkategoriat, a konteneriseget mar a bajtok igazoltak.
// ---------------------------------------------------------------------------
export type FileKind = 'image' | 'pdf' | 'document' | 'spreadsheet' | 'audio' | 'video' | 'text' | 'unknown'

export interface TypeSniff {
  kind: FileKind
  mime: string
  confidence: number
  imageFormat?: 'jpeg' | 'png' | 'gif' | 'other'
}

function readHead(absPath: string, n: number): Buffer {
  let fd = -1
  try {
    fd = openSync(absPath, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, n)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    return buf
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd >= 0) { try { closeSync(fd) } catch { /* mar zart */ } }
  }
}

function isLikelyText(buf: Buffer): boolean {
  if (!buf.length) return false
  let printable = 0
  for (const b of buf) {
    if (b === 0) return false
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 160) printable++
  }
  return printable / buf.length > 0.85
}

export function sniffType(absPath: string): TypeSniff {
  const buf = readHead(absPath, 64)
  const ext = extname(absPath).toLowerCase()
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg', confidence: 0.98, imageFormat: 'jpeg' }
  }
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { kind: 'image', mime: 'image/png', confidence: 0.98, imageFormat: 'png' }
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'GIF8') {
    return { kind: 'image', mime: 'image/gif', confidence: 0.98, imageFormat: 'gif' }
  }
  if (buf.length >= 4 && buf.toString('ascii', 0, 4) === '%PDF') {
    return { kind: 'pdf', mime: 'application/pdf', confidence: 0.98 }
  }
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    return { kind: 'video', mime: 'video/mp4', confidence: 0.9 }
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const sub = buf.toString('ascii', 8, 12)
    if (sub === 'WAVE') return { kind: 'audio', mime: 'audio/wav', confidence: 0.95 }
    if (sub === 'AVI ') return { kind: 'video', mime: 'video/avi', confidence: 0.95 }
  }
  if (buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return { kind: 'audio', mime: 'audio/mpeg', confidence: 0.9 }
  }
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) {
    return { kind: 'audio', mime: 'audio/mpeg', confidence: 0.6 }
  }
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    if (ext === '.xlsx' || ext === '.xls') return { kind: 'spreadsheet', mime: 'application/vnd.ms-excel', confidence: 0.75 }
    if (ext === '.docx' || ext === '.doc') return { kind: 'document', mime: 'application/msword', confidence: 0.75 }
    if (ext === '.pptx' || ext === '.ppt') return { kind: 'document', mime: 'application/vnd.ms-powerpoint', confidence: 0.7 }
    return { kind: 'document', mime: 'application/zip', confidence: 0.4 }
  }
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    if (ext === '.xls') return { kind: 'spreadsheet', mime: 'application/vnd.ms-excel', confidence: 0.75 }
    return { kind: 'document', mime: 'application/msword', confidence: 0.65 }
  }
  if (ext === '.csv' || ext === '.tsv') return { kind: 'spreadsheet', mime: 'text/csv', confidence: 0.5 }
  if (isLikelyText(buf)) return { kind: 'text', mime: 'text/plain', confidence: 0.5 }
  return { kind: 'unknown', mime: 'application/octet-stream', confidence: 0 }
}

function typeLabel(kind: FileKind, lang: string): string {
  const hu: Record<FileKind, string> = {
    image: 'kép', pdf: 'PDF', document: 'dokumentum', spreadsheet: 'táblázat',
    audio: 'hang', video: 'videó', text: 'szöveg', unknown: 'ismeretlen',
  }
  const en: Record<FileKind, string> = {
    image: 'image', pdf: 'PDF', document: 'document', spreadsheet: 'spreadsheet',
    audio: 'audio', video: 'video', text: 'text', unknown: 'unknown',
  }
  return (lang === 'en' ? en : hu)[kind]
}

// ---------------------------------------------------------------------------
// EXIF -- fuggetlen csomag nelkul, kezzel irt minimal JPEG/TIFF-olvaso.
//
// Csak azt olvassa ki, amire szuksegunk van: a `DateTimeOriginal` (0x9003),
// esetleg `DateTimeDigitized` (0x9004) vagy az IFD0 `DateTime` (0x0132) mezot.
// Nincs benne altalanos EXIF-konyvtar -- az kulon fuggoseg lenne, es a
// specifikacio szerint UJ npm-csomagot nem vezetunk be ehhez.
// ---------------------------------------------------------------------------
function readUInt16(buf: Buffer, off: number, little: boolean): number {
  return little ? buf.readUInt16LE(off) : buf.readUInt16BE(off)
}
function readUInt32(buf: Buffer, off: number, little: boolean): number {
  return little ? buf.readUInt32LE(off) : buf.readUInt32BE(off)
}

const EXIF_SUBIFD_POINTER = 0x8769

function parseIfdAsciiTags(buf: Buffer, ifdOffset: number, tiffStart: number, little: boolean, wantedTags: Set<number>): Map<number, string> {
  const out = new Map<number, string>()
  const ifdAbs = tiffStart + ifdOffset
  if (ifdAbs + 2 > buf.length) return out
  const count = readUInt16(buf, ifdAbs, little)
  let p = ifdAbs + 2
  for (let i = 0; i < count; i++) {
    if (p + 12 > buf.length) break
    const tag = readUInt16(buf, p, little)
    const type = readUInt16(buf, p + 2, little)
    const numValues = readUInt32(buf, p + 4, little)
    const valueOffsetField = p + 8
    if (tag === EXIF_SUBIFD_POINTER && type === 4) {
      out.set(EXIF_SUBIFD_POINTER, String(readUInt32(buf, valueOffsetField, little)))
    } else if (wantedTags.has(tag) && type === 2) {
      const strOffset = numValues <= 4 ? valueOffsetField : tiffStart + readUInt32(buf, valueOffsetField, little)
      if (strOffset >= 0 && strOffset + numValues <= buf.length) {
        const raw = buf.toString('ascii', strOffset, strOffset + numValues).replace(/\0+$/, '')
        if (raw) out.set(tag, raw)
      }
    }
    p += 12
  }
  return out
}

function exifDateToIso(s: string): string {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T]\d{2}:\d{2}:\d{2}/.exec(s.trim())
  if (!m) return ''
  const [, y, mo, d] = m
  const yy = Number(y), mm = Number(mo), dd = Number(d)
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return ''
  return `${y}-${mo}-${d}`
}

/** JPEG APP1/Exif szegmensebol a felvetel datuma, vagy null. */
export function parseJpegExifDate(absPath: string): { value: string; raw: string } | null {
  const buf = readHead(absPath, 262144)
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue }
    const marker = buf[offset + 1]
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    if (marker === 0xd9 || marker === 0xda) break // EOI / SOS -- innentol mar a kepadat jon
    if (offset + 4 > buf.length) break
    const segLen = readUInt16(buf, offset + 2, false)
    if (marker === 0xe1) {
      const segStart = offset + 4
      const header = buf.toString('ascii', segStart, Math.min(segStart + 6, buf.length))
      if (header.startsWith('Exif') && segStart + 8 <= buf.length) {
        const tiffStart = segStart + 6
        const bo = buf.toString('ascii', tiffStart, tiffStart + 2)
        if (bo === 'II' || bo === 'MM') {
          const little = bo === 'II'
          const ifd0Offset = readUInt32(buf, tiffStart + 4, little)
          const ifd0 = parseIfdAsciiTags(buf, ifd0Offset, tiffStart, little, new Set([0x0132]))
          let dateStr = ifd0.get(0x0132) || ''
          const subOffsetStr = ifd0.get(EXIF_SUBIFD_POINTER)
          if (subOffsetStr) {
            const subIfd = parseIfdAsciiTags(buf, Number(subOffsetStr), tiffStart, little, new Set([0x9003, 0x9004]))
            dateStr = subIfd.get(0x9003) || subIfd.get(0x9004) || dateStr
          }
          if (dateStr) {
            const iso = exifDateToIso(dateStr)
            if (iso) return { value: iso, raw: dateStr }
          }
        }
      }
    }
    offset += 2 + segLen
  }
  return null
}

// ---------------------------------------------------------------------------
// OCR / ARCFELISMERES -- adapter-interfesz, alapertelmezesben "nincs
// telepitve". A valodi (tesseract/dlib) implementaciot Boss level-2
// jovahagyasa utan egy KULON modul koti be `setOcrAdapter`/`setFaceAdapter`
// hivassal -- ez a fajl nem valtozik akkor sem.
// ---------------------------------------------------------------------------
export interface OcrAdapter {
  available(): boolean
  extractText(absPath: string): string | null
}

export interface FaceMatch {
  personId: string
  confidence: number
}

export interface FaceAdapter {
  available(): boolean
  recognize(absPath: string): FaceMatch[]
}

export const unavailableOcrAdapter: OcrAdapter = {
  available: () => false,
  extractText: () => null,
}

export const unavailableFaceAdapter: FaceAdapter = {
  available: () => false,
  recognize: () => [],
}

let ocrAdapter: OcrAdapter = unavailableOcrAdapter
let faceAdapter: FaceAdapter = unavailableFaceAdapter

export function setOcrAdapter(a: OcrAdapter | null): void { ocrAdapter = a || unavailableOcrAdapter }
export function setFaceAdapter(a: FaceAdapter | null): void { faceAdapter = a || unavailableFaceAdapter }
export function getOcrAdapter(): OcrAdapter { return ocrAdapter }
export function getFaceAdapter(): FaceAdapter { return faceAdapter }

// ---------------------------------------------------------------------------
// TANULAS (Paperless-minta): a MAR helyre tett fajlok nevebol tanul, a
// Beerkezoben levokbol NEM. A fa szerkezete adja a cimket -- a szemely-mappa
// neve a tulajdonost, az alatta levo kategoria-mappa neve a teruletet.
// ---------------------------------------------------------------------------
export interface LearnedIndex {
  personTokens: Map<string, Map<string, number>>
  categoryTokens: Map<string, Map<string, number>>
  sampleCount: number
}

const MAX_SCAN_FILES = 8000
const MAX_SCAN_DEPTH = 14
// A gyoker kozvetlen agai, amik NEM szemelyt jelentenek -- ezeket a tanulas
// at sem lepi (a szemelyeket a `config.persons` neve adja meg, ld. lent).
const SKIP_ROOT_DIRS = new Set(['Rendszer', 'System', 'Beérkező', 'Inbox', 'Cégek', 'Companies', 'Közös', 'Common'])
const SKIP_ANY_DIR = new Set(['.git', 'node_modules', 'GIT_REPOS'])

export function tokenize(name: string): string[] {
  const base = name.replace(/\.[^.]+$/, '')
  return base
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
}

function bump(map: Map<string, Map<string, number>>, token: string, key: string): void {
  let inner = map.get(token)
  if (!inner) { inner = new Map(); map.set(token, inner) }
  inner.set(key, (inner.get(key) || 0) + 1)
}

/** A mar besorolt fajlokbol tanult tulajdonos/kategoria kulcsszavak. */
export function buildLearnedIndex(config: LifeConfig): LearnedIndex {
  const idx: LearnedIndex = { personTokens: new Map(), categoryTokens: new Map(), sampleCount: 0 }
  const root = explorerRoot()
  if (!root) return idx
  const personByName = new Map(config.persons.map((p) => [p.name, p]))
  let scanned = 0

  function walk(absDir: string, depth: number, ownerPersonId: string | null, categoryKey: string | null): void {
    if (depth > MAX_SCAN_DEPTH || scanned >= MAX_SCAN_FILES) return
    let entries: string[]
    try { entries = readdirSync(absDir) } catch { return }
    for (const entry of entries) {
      if (scanned >= MAX_SCAN_FILES) return
      if (entry.startsWith('.')) continue
      if (SKIP_ANY_DIR.has(entry)) continue
      if (depth === 0 && SKIP_ROOT_DIRS.has(entry)) continue
      const abs = join(absDir, entry)
      let st: ReturnType<typeof statSync>
      try { st = statSync(abs) } catch { continue }
      if (st.isDirectory()) {
        let nextOwner = ownerPersonId
        let nextCategory = categoryKey
        if (depth === 0) {
          const person = personByName.get(entry)
          if (!person) continue // egyeb gyoker-ag (peldaul egy meg fel nem vett szemely) -- kihagyjuk
          nextOwner = person.id
        } else if (depth === 1 && ownerPersonId) {
          const key = lifeKeyForName(entry)
          if (key) nextCategory = key
        }
        walk(abs, depth + 1, nextOwner, nextCategory)
      } else if (st.isFile() && ownerPersonId && categoryKey) {
        scanned++
        idx.sampleCount++
        for (const tok of tokenize(entry)) {
          bump(idx.personTokens, tok, ownerPersonId)
          bump(idx.categoryTokens, tok, categoryKey)
        }
      }
    }
  }
  walk(root, 0, null, null)
  return idx
}

function guessFromIndex(tokens: string[], map: Map<string, Map<string, number>>): { key: string; confidence: number } | null {
  const score = new Map<string, number>()
  let matchedTokens = 0
  for (const tok of tokens) {
    const inner = map.get(tok)
    if (!inner) continue
    matchedTokens++
    for (const [key, count] of inner) score.set(key, (score.get(key) || 0) + count)
  }
  if (!score.size) return null
  let bestKey = ''
  let bestScore = 0
  let total = 0
  for (const [key, s] of score) {
    total += s
    if (s > bestScore) { bestScore = s; bestKey = key }
  }
  if (!bestKey || !total) return null
  const spread = Math.min(1, matchedTokens / Math.max(1, tokens.length))
  const confidence = Math.min(0.9, (bestScore / total) * spread + 0.1)
  return { key: bestKey, confidence }
}

// ---------------------------------------------------------------------------
// TARTALOM-KINYERES -- a fajl TENYLEGES szovege, nem csak a neve (kartya #265).
// KIZAROLAG node beepitett eszkozok: nincs uj csomag, nincs apt/pip.
//   - txt/csv: kozvetlen (bounded) olvasas
//   - PDF:     a szoveg-reteg FlateDecode-olt content-streamjeibol (zlib)
//   - docx:    ZIP central-directory -> word/document.xml -> inflateRaw -> XML-strip
// A "nincs benne datum/nev" es a "nem tudtam elolvasni (OCR kellene)" KET
// kulonbozo allapot -- a `needsOcr` valasztja szet oket (Boss szabalya: a
// nulla ket dolgot jelenthet, a kodnak kulon kell tudnia a kettot).
// ---------------------------------------------------------------------------
const MAX_CONTENT_BYTES = 8 * 1024 * 1024 // ennel nagyobb fajlbol csak az elejet olvassuk
const MAX_TEXT_CHARS = 200_000            // a kivont szoveget ennyinel levagjuk (datum/token boven elfer)
const MAX_PDF_STREAMS = 800               // patologias PDF ellen: ennyi streamnel megallunk

export interface ExtractedContent {
  /** A fajlbol kiolvasott sima szoveg (ures, ha nem volt/nem sikerult). */
  text: string
  /** true, ha a tipus szoveges tartalmat NEM sikerult kiolvasni es OCR kellene
   *  (kep, vagy szoveg-reteg nelkuli, szkennelt PDF). Ez kulonbozteti meg a
   *  "nincs benne datum" allapotot a "nem lattam a tartalmat" allapottol. */
  needsOcr: boolean
}

function clampText(s: string): string {
  return s.length > MAX_TEXT_CHARS ? s.slice(0, MAX_TEXT_CHARS) : s
}

/** A fajl nyers bajtjai, felulrol korlatozva (nagy fajlnal csak az eleje). */
function readBoundedFile(absPath: string): Buffer {
  let fd = -1
  try {
    fd = openSync(absPath, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, MAX_CONTENT_BYTES)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, 0)
    return buf
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd >= 0) { try { closeSync(fd) } catch { /* mar zart */ } }
  }
}

// --- PDF szoveg-reteg ---

/** PDF literal string ((...)) escape-jei feloldva. */
function decodePdfString(raw: string): string {
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_m, g: string) => {
    switch (g) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case 'b': return '\b'
      case 'f': return '\f'
      case '(': return '('
      case ')': return ')'
      case '\\': return '\\'
      default: {
        const code = parseInt(g, 8)
        return Number.isNaN(code) ? '' : String.fromCharCode(code)
      }
    }
  })
}

/** Egy dekodolt content-streambol a Tj/TJ szovegoperandusok szovege. */
function textFromPdfContent(content: string): string {
  const out: string[] = []
  // (...) literal stringek -- content-streamben zarojel csak string-literalban van
  const litRe = /\((?:\\.|[^\\()])*\)/g
  let m: RegExpExecArray | null
  while ((m = litRe.exec(content))) out.push(decodePdfString(m[0].slice(1, -1)))
  // <...> hex stringek
  const hexRe = /<([0-9A-Fa-f\s]{2,})>/g
  while ((m = hexRe.exec(content))) {
    const hex = m[1].replace(/\s+/g, '')
    let s = ''
    for (let i = 0; i + 1 < hex.length; i += 2) {
      const code = parseInt(hex.slice(i, i + 2), 16)
      if (code) s += String.fromCharCode(code)
    }
    if (s) out.push(s)
  }
  return out.join(' ')
}

/** A PDF osszes content-streamjebol kiolvasott szoveg + volt-e egyaltalan stream. */
function extractPdfText(buf: Buffer): { text: string; hadStream: boolean } {
  const latin = buf.toString('latin1')
  const parts: string[] = []
  let hadStream = false
  let seen = 0
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(latin)) && seen < MAX_PDF_STREAMS) {
    const start = m.index + m[0].length
    const end = latin.indexOf('endstream', start)
    if (end < 0) break
    hadStream = true
    seen++
    const streamBytes = buf.subarray(start, end)
    let decoded: string | null = null
    try {
      decoded = inflateSync(streamBytes).toString('latin1')
    } catch {
      try {
        decoded = inflateRawSync(streamBytes).toString('latin1')
      } catch {
        // nem tomoritett content-stream? csak akkor hasznaljuk, ha szovegoperator van benne
        const asText = streamBytes.toString('latin1')
        decoded = /\bTj\b|\bTJ\b|\bBT\b/.test(asText) ? asText : null
      }
    }
    if (decoded) {
      const t = textFromPdfContent(decoded)
      if (t.trim()) parts.push(t)
    }
    re.lastIndex = end + 'endstream'.length
  }
  return { text: parts.join('\n'), hadStream }
}

// --- docx (ZIP) ---

/** Egy nevesitett bejegyzes tartalma egy ZIP-bufferbol, central-directory alapjan. */
function readZipEntry(buf: Buffer, wantName: string): Buffer | null {
  const EOCD_SIG = 0x06054b50
  const CDH_SIG = 0x02014b50
  const LFH_SIG = 0x04034b50
  // End Of Central Directory: hatulrol keressuk (a comment miatt max 64K + 22)
  let eocd = -1
  const from = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break }
  }
  if (eocd < 0) return null
  const cdCount = buf.readUInt16LE(eocd + 10)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  let p = cdOffset
  for (let i = 0; i < cdCount; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CDH_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (name === wantName) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LFH_SIG) return null
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const data = buf.subarray(dataStart, dataStart + compSize)
      if (method === 0) return Buffer.from(data)
      if (method === 8) { try { return inflateRawSync(data) } catch { return null } }
      return null
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9A-Fa-f]+);/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&') // utoljara, hogy ne dekodoljunk ketszer
}

/** OOXML/HTML-szeru XML -> sima szoveg, a bekezdes/tab/sortores hatarok megtartasaval. */
function stripXml(xml: string): string {
  const withBreaks = xml
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
  return decodeXmlEntities(withBreaks.replace(/<[^>]+>/g, ''))
}

/**
 * A Beerkezo-tetel TENYLEGES szovege, ha built-in eszkozzel kiolvashato.
 * A hivo (analyzeInboxItem) egyszer hivja, es a datum/tulajdonos/kategoria
 * mind ebbol dolgozik -- egy olvasas, tobb felhasznalas.
 */
export function extractTextContent(sniff: TypeSniff, absPath: string): ExtractedContent {
  if (sniff.kind === 'text' || (sniff.kind === 'spreadsheet' && sniff.mime === 'text/csv')) {
    return { text: clampText(readBoundedFile(absPath).toString('utf8')), needsOcr: false }
  }
  if (sniff.kind === 'pdf') {
    const { text, hadStream } = extractPdfText(readBoundedFile(absPath))
    const clean = clampText(text)
    if (clean.trim()) return { text: clean, needsOcr: false }
    // Volt content-stream, de nem jott ki szoveg -> szkennelt PDF -> OCR kellene.
    return { text: '', needsOcr: hadStream }
  }
  if (sniff.kind === 'document') {
    const buf = readBoundedFile(absPath)
    // Csak az uj, ZIP-alapu .docx-et olvassuk built-innel; a regi binaris .doc-ot nem.
    if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b) {
      const doc = readZipEntry(buf, 'word/document.xml')
      if (doc) {
        const clean = clampText(stripXml(doc.toString('utf8')))
        if (clean.trim()) return { text: clean, needsOcr: false }
      }
    }
    return { text: '', needsOcr: false }
  }
  if (sniff.kind === 'image') return { text: '', needsOcr: true }
  return { text: '', needsOcr: false }
}

/** A kivont szoveg tokenizalasa (a fajlnev-tokenekkel azonos normalizalas). */
function tokenizeText(text: string): string[] {
  if (!text) return []
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t))
    .slice(0, 4000)
}

// ---------------------------------------------------------------------------
// DATUM -- EXIF -> tartalom-szoveg -> OCR -> fajlnev -> nincs (kerdojel).
// ---------------------------------------------------------------------------
const DATE_PATTERNS: RegExp[] = [
  /(\d{4})[-.](\d{2})[-.](\d{2})/, // 2026-08-21 / 2026.08.21
  /(\d{2})[-.](\d{2})[-.](\d{4})/, // 21-08-2026 / 21.08.2026 (magyar: nap-honap-ev)
  /(\d{4})(\d{2})(\d{2})(?!\d)/,   // 20260821
]

function findDateInText(text: string): string {
  for (const re of DATE_PATTERNS) {
    const m = re.exec(text)
    if (!m) continue
    const fourFirst = m[1].length === 4
    const y = fourFirst ? m[1] : m[3]
    const mo = m[2]
    const d = fourFirst ? m[3] : m[1]
    const yy = Number(y), mm = Number(mo), dd = Number(d)
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || yy < 1970 || yy > 2100) continue
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  return ''
}

export interface DateGuess {
  value: string
  source: 'exif' | 'content' | 'ocr' | 'filename' | 'none'
  confidence: number
}

function guessDate(sniff: TypeSniff, abs: string, filename: string, content: ExtractedContent, lang: string, notes: string[]): DateGuess {
  if (sniff.kind === 'image' && sniff.imageFormat === 'jpeg') {
    const exif = parseJpegExifDate(abs)
    if (exif) return { value: exif.value, source: 'exif', confidence: 0.9 }
  }
  // A fajl TENYLEGES szovegebol (txt / PDF-szovegreteg / docx) -- kartya #265.
  if (content.text) {
    const found = findDateInText(content.text)
    if (found) return { value: found, source: 'content', confidence: 0.75 }
  }
  // Ha a tartalmat NEM lehetett szovegkent kiolvasni (kep vagy szkennelt PDF),
  // az OCR a kovetkezo esely -- ha be van kotve.
  if (content.needsOcr) {
    const ocr = getOcrAdapter()
    if (ocr.available()) {
      const text = ocr.extractText(abs)
      const found = text ? findDateInText(text) : ''
      if (found) return { value: found, source: 'ocr', confidence: 0.55 }
    } else {
      notes.push(T(lang,
        'A dokumentum szkennelt (nincs kiolvasható szövegréteg), és OCR nincs telepítve, ezért csak a fájlnévből tudok dátumot olvasni.',
        'The document is scanned (no extractable text layer) and OCR is not installed, so I can only read a date from the filename.'))
    }
  }
  const fromName = findDateInText(filename)
  if (fromName) return { value: fromName, source: 'filename', confidence: 0.4 }
  // Elolvastuk a szoveget, de tenyleg nem volt benne datum -- ez NEM olvasasi
  // hiba (a nulla ket dolgot jelenthet, itt a "nincs" agat mondjuk ki).
  if (content.text) {
    notes.push(T(lang,
      'Elolvastam a dokumentum szövegét, de nem találtam benne dátumot – ez nem olvasási hiba, tényleg nincs felismerhető dátum.',
      'I read the document text but found no date in it – this is not a read error, there is genuinely no recognizable date.'))
  }
  return { value: '', source: 'none', confidence: 0 }
}

// ---------------------------------------------------------------------------
// KATEGORIA -- tanult index + kulcsszo-listak + tipus-alapu alapertelmezes.
// ---------------------------------------------------------------------------
const CATEGORY_KEYWORDS: Array<{ key: string; words: string[] }> = [
  { key: 'finance', words: ['szamla', 'invoice', 'befizetes', 'atutalas', 'bankszamla', 'adoslevel', 'nav'] },
  { key: 'legal', words: ['szerzodes', 'contract', 'vegzes', 'birosag', 'ugyved', 'meghatalmazas'] },
  { key: 'authorities', words: ['onkormanyzat', 'hatosag', 'hivatal', 'okmany', 'hatarozat', 'kerelem'] },
  { key: 'health', words: ['lelet', 'recept', 'orvosi', 'korhaz', 'egeszsegugyi', 'medical', 'prescription'] },
  { key: 'identity', words: ['szemelyi', 'igazolvany', 'jogositvany', 'utlevel', 'passport'] },
  { key: 'home', words: ['lakas', 'rezsi', 'kozoskoltseg', 'alberlet', 'berlet'] },
  { key: 'work', words: ['munkaszerzodes', 'fizetesi', 'berpapir', 'payslip'] },
]

export interface CategoryGuess {
  key: string
  confidence: number
}

function guessCategory(sniff: TypeSniff, tokens: string[], contentTokens: string[], index: LearnedIndex): CategoryGuess {
  const nameFlat = tokens.join(' ')
  const contentFlat = contentTokens.join(' ')
  // A tanult index a MAR besorolt fajlok NEVEIBOL epult, ezert azt a fajlnev-
  // tokenekre futtatjuk; a tartalom csak a kulcsszo-egyezest erositi (#265).
  const fromIndex = guessFromIndex(tokens, index.categoryTokens)
  for (const row of CATEGORY_KEYWORDS) {
    const inName = row.words.some((w) => nameFlat.includes(w))
    const inContent = !inName && contentFlat !== '' && row.words.some((w) => contentFlat.includes(w))
    if (inName || inContent) {
      const base = inName ? 0.65 : 0.6 // a tartalom valamivel gyengebb jel mint a nev, de eros
      const confidence = fromIndex && fromIndex.key === row.key ? Math.max(0.7, fromIndex.confidence) : base
      return { key: row.key, confidence }
    }
  }
  if (fromIndex && fromIndex.confidence >= 0.4) return fromIndex
  if (sniff.kind === 'image' || sniff.kind === 'video' || sniff.kind === 'audio') {
    return { key: 'media', confidence: 0.4 }
  }
  return { key: 'personal', confidence: 0.15 }
}

// ---------------------------------------------------------------------------
// TULAJDONOS -- arcfelismeres (ha van) -> tanult index -> bizonytalan.
// A `resolveFilingPerson()` mindig lefut a nyers talalaton: "gyerek mindig az
// anya alá" (custodianId, kartya #204).
// ---------------------------------------------------------------------------
export interface OwnerGuess {
  personId: string
  name: string
  confidence: number
  uncertain: boolean
  options: Array<{ id: string; name: string }>
}

function personOptions(config: LifeConfig): Array<{ id: string; name: string }> {
  return config.persons.map((p) => ({ id: p.id, name: p.name }))
}

const OWNER_REVIEW_THRESHOLD = 0.55

function finalizeOwner(rawPersonId: string, confidence: number, config: LifeConfig): OwnerGuess | null {
  const person = config.persons.find((p) => p.id === rawPersonId)
  if (!person) return null
  const finalId = resolveFilingPerson(person.id, config)
  const finalPerson = config.persons.find((p) => p.id === finalId) || person
  return {
    personId: finalId, name: finalPerson.name, confidence,
    uncertain: confidence < OWNER_REVIEW_THRESHOLD, options: [],
  }
}

function guessOwnerFromFace(sniff: TypeSniff, abs: string, config: LifeConfig, lang: string, notes: string[]): OwnerGuess | null {
  if (sniff.kind !== 'image') return null
  const face = getFaceAdapter()
  if (!face.available()) {
    notes.push(T(lang,
      'A helyi arcfelismerő nincs telepítve (jóváhagyásra vár), ezért a tulajdonost nem tudom a fotóról kitalálni.',
      'The local face recognizer is not installed (pending approval), so I cannot guess the owner from the photo.'))
    return null
  }
  const matches = face.recognize(abs)
  if (!matches.length) return null
  const best = matches.reduce((a, b) => (b.confidence > a.confidence ? b : a))
  return finalizeOwner(best.personId, best.confidence, config)
}

function guessOwnerFromIndex(tokens: string[], index: LearnedIndex, config: LifeConfig): OwnerGuess | null {
  const guess = guessFromIndex(tokens, index.personTokens)
  if (!guess) return null
  return finalizeOwner(guess.key, guess.confidence, config)
}

/**
 * ELETFA-KERESZTHIVATKOZAS (kartya #265): ha a dokumentum SZOVEGEBEN szerepel
 * egy, az eletfaban ismert szemely neve, az eros tulajdonos-jel. A nevet a
 * fajlnev-tokenekkel azonosan normalizaljuk (`tokenize`), es a tartalom-tokenek
 * halmaza ellen egyeztetunk -- igy az ekezetes nevek (Laszlo/László) is
 * megbizhatoan illeszkednek, regex-hatar nelkul. A teljes nev (vezetek + kereszt)
 * egyuttes talalata magabiztos; a reszleges kevesbe az.
 */
function guessOwnerFromContentNames(contentTokens: string[], config: LifeConfig, lang: string, notes: string[]): OwnerGuess | null {
  if (!contentTokens.length) return null
  const present = new Set(contentTokens)
  let best: { id: string; name: string; score: number; full: boolean } | null = null
  for (const p of config.persons) {
    const parts = tokenize(p.name)
    if (!parts.length) continue
    let matched = 0
    for (const part of parts) if (present.has(part)) matched++
    if (!matched) continue
    const full = parts.length >= 2 && matched === parts.length
    const score = matched + (full ? 2 : 0)
    if (!best || score > best.score) best = { id: p.id, name: p.name, score, full }
  }
  if (!best) return null
  const confidence = best.full ? 0.85 : Math.min(0.7, 0.4 + best.score * 0.1)
  const guess = finalizeOwner(best.id, confidence, config)
  if (guess) {
    notes.push(T(lang,
      `A tulajdonost a dokumentum szövegében talált név alapján ismertem fel: ${best.name}.`,
      `I recognized the owner from a name found in the document text: ${best.name}.`))
  }
  return guess
}

// ---------------------------------------------------------------------------
// FAJLNEV-JAVASLAT: tulajdonos_év-hónap_tárgy, a fa nevezéktanát követve.
// ---------------------------------------------------------------------------
const NOISE_TOKENS = new Set([
  'img', 'dsc', 'dscn', 'photo', 'picture', 'scan', 'document', 'doc',
  'whatsapp', 'image', 'video', 'signal', 'screenshot', 'kep', 'fenykep', 'file',
])

function suggestFileName(ownerName: string, dateValue: string, tokens: string[]): string {
  const topicTokens = tokens.filter((t) => !NOISE_TOKENS.has(t)).slice(0, 3)
  const parts: string[] = []
  if (ownerName) parts.push(safeLifeName(ownerName))
  if (dateValue) parts.push(dateValue.slice(0, 7))
  if (topicTokens.length) parts.push(topicTokens.join('-'))
  return parts.join('_')
}

// ---------------------------------------------------------------------------
// ISMERT CELMAPPAK -- a MAR LETEZO szemely/kategoria mappak, autokiegesziteshez
// a feluleten (nem talal ki uj mappat, csak a meglevoket kinalja).
// ---------------------------------------------------------------------------
export interface KnownFolder {
  rel: string
  display: string
  personId: string
}

// A teljes fa vegigjarasat felulrol korlatozzuk -- egy bekotott (Drive/Fotok)
// ag ala ne induljon el egy tobbezres bejaras, csak mert valaki egyszer
// rakattintott egy szemelyre. A mely mappastruktura (Boss, 2026-09-08: "a
// hova kerulne ott a legmelyebb pontig lehessen kivalasztani") tobb szaz
// sajat mappaig biztosan elfer eb ala.
const MAX_KNOWN_FOLDERS = 4000
const MAX_KNOWN_FOLDER_DEPTH = 12

function walkKnownFolders(absDir: string, relPrefix: string, personId: string, out: KnownFolder[], depth: number): void {
  if (depth > MAX_KNOWN_FOLDER_DEPTH || out.length >= MAX_KNOWN_FOLDERS) return
  let names: string[]
  try { names = readdirSync(absDir) } catch { return }
  for (const name of names) {
    if (out.length >= MAX_KNOWN_FOLDERS) return
    // A rejtett/rendszer-tetelek itt is zajt visznek, ugyanugy mint az
    // Intezoben -- lasd `life-explorer.ts` listLife().
    if (name.startsWith('.') || name === '$RECYCLE.BIN' || name === 'System Volume Information') continue
    const abs = join(absDir, name)
    let st
    try { st = statSync(abs) } catch { continue }
    if (!st.isDirectory()) continue
    const rel = relPrefix ? `${relPrefix}/${name}` : name
    out.push({ rel, display: humanLocation(rel), personId })
    walkKnownFolders(abs, rel, personId, out, depth + 1)
  }
}

/**
 * A MAR LETEZO mappak a fan belul, teljes melysegben (kartya #246).
 *
 * Korabban ez csak a rogzitett `PERSON_CATEGORIES` ket szintjet (pl.
 * `Név/Hatóságok`) ellenorizte -- egy mar letrehozott melyebb almappa (pl.
 * `Név/Hatóságok/Németország/Jobcenter`) nem volt kivalaszthato a "hova
 * kerulne" listaban, csak a ket felso szint. Boss (2026-09-08): "a hova
 * kerulne ott a legmelyebb pontig lehessen kivalasztani a legalso mappat is".
 */
export function buildKnownFolders(config: LifeConfig, lang: string = APP_LANG): KnownFolder[] {
  const root = explorerRoot()
  if (!root) return []
  const out: KnownFolder[] = []
  for (const person of config.persons) {
    const personAbs = join(root, person.name)
    if (!existsSync(personAbs)) continue
    walkKnownFolders(personAbs, person.name, person.id, out, 0)
  }
  return out
}

// ---------------------------------------------------------------------------
// OSSZERAKAS -- egy tetel es a teljes Beerkezo elemzese.
// ---------------------------------------------------------------------------
export interface InboxSuggestion {
  name: string
  rel: string
  credentialWarning: string
  type: { value: FileKind; label: string; confidence: number }
  owner: OwnerGuess
  date: DateGuess
  category: { key: string; label: string; confidence: number }
  targetRel: string
  targetDisplay: string
  targetExists: boolean
  suggestedName: string
  ext: string
  needsReview: boolean
  notes: string[]
}

const REVIEW_THRESHOLD = 0.55

export function analyzeInboxItem(item: InboxItem, config: LifeConfig, index: LearnedIndex, lang: string = APP_LANG): InboxSuggestion {
  const dir = inboxDir(lang) || ''
  const abs = join(dir, item.name)
  const ext = extname(item.name)
  const notes: string[] = []
  const options = personOptions(config)

  if (item.credentialWarning) {
    // A 3. biztonsagi szabaly meg a javaslatban is all: hitelesito adatra nem
    // ajanlunk sem tulajdonost, sem celmappat -- csak a Vault-uzenetet.
    return {
      name: item.name, rel: item.rel, credentialWarning: item.credentialWarning,
      type: { value: 'unknown', label: typeLabel('unknown', lang), confidence: 0 },
      owner: { personId: '', name: '', confidence: 0, uncertain: true, options },
      date: { value: '', source: 'none', confidence: 0 },
      category: { key: '', label: '', confidence: 0 },
      targetRel: '', targetDisplay: '', targetExists: false, suggestedName: '', ext,
      needsReview: true, notes: [item.credentialWarning],
    }
  }

  const sniff = sniffType(abs)
  const tokens = tokenize(item.name)
  // Egyszer olvassuk ki a TENYLEGES tartalmat, es a datum/tulajdonos/kategoria
  // mind ebbol dolgozik (kartya #265) -- egy olvasas, tobb felhasznalas.
  const content = extractTextContent(sniff, abs)
  const contentTokens = tokenizeText(content.text)

  let ownerGuess = guessOwnerFromFace(sniff, abs, config, lang, notes)
  if (!ownerGuess) ownerGuess = guessOwnerFromContentNames(contentTokens, config, lang, notes)
  if (!ownerGuess) ownerGuess = guessOwnerFromIndex(tokens, index, config)
  if (!ownerGuess) ownerGuess = { personId: '', name: '', confidence: 0, uncertain: true, options: [] }
  ownerGuess = { ...ownerGuess, options }

  const dateGuess = guessDate(sniff, abs, item.name, content, lang, notes)
  const categoryGuess = guessCategory(sniff, tokens, contentTokens, index)

  const ownerPerson = config.persons.find((p) => p.id === ownerGuess.personId)
  const categoryLabel = categoryGuess.key ? lifeName(categoryGuess.key, lang) : ''
  const targetRel = ownerPerson && categoryGuess.key ? `${ownerPerson.name}/${categoryLabel}` : ''
  const targetAbs = targetRel ? join(explorerRoot() || '', ...targetRel.split('/')) : ''
  const targetExists = targetAbs ? existsSync(targetAbs) : false
  // A megjelenites AKKOR IS all, ha a mappa meg nem letezik -- kulonben a
  // felhasznalo nem latna, MIT ajanlunk fel neki letrehozasra (elonezet
  // nelkul visszafordithatatlan lepest kockazna).
  const targetDisplay = targetRel ? humanLocation(targetRel) : ''

  if (targetRel && !targetExists) {
    notes.push(T(lang,
      'A javasolt célmappa még nem létezik – kattints a „Mappa létrehozása" gombra, ha ide szeretnéd tenni, vagy válassz másik célt.',
      'The suggested target folder does not exist yet – click "Create folder" if you want to file it here, or pick another target.'))
  }

  const suggestedName = suggestFileName(ownerPerson?.name || '', dateGuess.value, tokens)

  const needsReview = ownerGuess.uncertain
    || categoryGuess.confidence < REVIEW_THRESHOLD
    || !targetRel || !targetExists

  return {
    name: item.name, rel: item.rel, credentialWarning: '',
    type: { value: sniff.kind, label: typeLabel(sniff.kind, lang), confidence: sniff.confidence },
    owner: ownerGuess, date: dateGuess,
    category: { key: categoryGuess.key, label: categoryLabel, confidence: categoryGuess.confidence },
    targetRel, targetDisplay, targetExists, suggestedName, ext,
    needsReview, notes,
  }
}

export interface AnalyzeResult {
  reason: InboxReason | 'empty'
  message: string
  suggestions: InboxSuggestion[]
  knownFolders: KnownFolder[]
  ocrAvailable: boolean
  faceRecognitionAvailable: boolean
}

/** A Beerkezo AI-javaslatai -- `names` nelkul MINDEN tetelre. */
export function analyzeInbox(names: string[] | undefined, lang: string = APP_LANG): AnalyzeResult {
  const base = {
    knownFolders: [] as KnownFolder[],
    ocrAvailable: getOcrAdapter().available(),
    faceRecognitionAvailable: getFaceAdapter().available(),
  }
  const status = inboxStatus(lang)
  if (status.reason !== 'ok') {
    return { reason: status.reason, message: status.message, suggestions: [], ...base }
  }
  const wanted = names && names.length ? new Set(names) : null
  const items = (wanted ? status.items.filter((i) => wanted.has(i.name)) : status.items).filter((i) => !i.isDir)
  if (!items.length) {
    return {
      reason: 'empty', suggestions: [], ...base,
      message: T(lang, 'A BEÉRKEZŐ üres – nincs mit elemezni.', 'The INBOX is empty – nothing to analyze.'),
    }
  }
  const config = loadLifeConfig()
  const index = buildLearnedIndex(config)
  const suggestions = items.map((item) => analyzeInboxItem(item, config, index, lang))
  return {
    reason: 'ok', suggestions,
    knownFolders: buildKnownFolders(config, lang),
    ocrAvailable: base.ocrAvailable, faceRecognitionAvailable: base.faceRecognitionAvailable,
    message: T(lang, `${suggestions.length} tétel elemezve.`, `${suggestions.length} item(s) analyzed.`),
  }
}
