// Kartya #265 (cff50fdf): a Beerkezo MELY iratelemzese -- a fajl TENYLEGES
// tartalmabol (txt / PDF-szovegreteg / docx) olvassunk datumot es tulajdonost,
// ne csak a fajlnevbol, es keresztezzuk az eletfa szemelyneveivel. A fixture-oket
// (PDF FlateDecode, docx ZIP) node beepitett eszkozzel allitjuk elo, hogy a
// teszt is bizonyitsa: nem kell hozza kulso csomag.
//
// Boss szabalya, amit ez ellenoriz: a nulla ket dolgot jelenthet. A "elolvastam,
// de nincs benne datum" es a "nem tudtam elolvasni (OCR kellene)" KET kulon
// allapot, es a felhasznalonak KULON uzenetet kell latnia rola.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, deflateRawSync, crc32 } from 'node:zlib'
import type { InboxItem } from '../life-inbox.js'

const depot = mkdtempSync(join(tmpdir(), 'marveen-inboxcontent-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-inboxcontent-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { explorerRoot } = await import('../life-explorer.js')
const { analyzeInboxItem, extractTextContent, sniffType, buildLearnedIndex } = await import('../life-inbox-analyze.js')
const { loadLifeConfig, saveLifeConfig, inboxDir } = await import('../life-tree.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

const PERSON = 'Korpás László'

// --- Fixture-epitok, kizarolag node beepitett eszkozzel ---

/** Minimalis, FlateDecode-olt content-streamet tartalmazo PDF. */
function makePdf(streamInner: string): Buffer {
  const deflated = deflateSync(Buffer.from(streamInner, 'latin1'))
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    deflated,
    Buffer.from('endstream\nendobj\n%%EOF', 'latin1'),
  ])
}

/** Egy-bejegyzeses ZIP (docx-vaz): word/document.xml deflate-elve (method 8). */
function makeDocx(bodyText: string): Buffer {
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body></w:document>`
  const data = Buffer.from(xml, 'utf8')
  const comp = deflateRawSync(data)
  const crc = crc32(data) >>> 0
  const nameBuf = Buffer.from('word/document.xml', 'utf8')

  const lfh = Buffer.alloc(30)
  lfh.writeUInt32LE(0x04034b50, 0)
  lfh.writeUInt16LE(20, 4); lfh.writeUInt16LE(0, 6); lfh.writeUInt16LE(8, 8)
  lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0, 12)
  lfh.writeUInt32LE(crc, 14); lfh.writeUInt32LE(comp.length, 18); lfh.writeUInt32LE(data.length, 22)
  lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28)
  const localPart = Buffer.concat([lfh, nameBuf, comp])

  const cdh = Buffer.alloc(46)
  cdh.writeUInt32LE(0x02014b50, 0)
  cdh.writeUInt16LE(20, 4); cdh.writeUInt16LE(20, 6); cdh.writeUInt16LE(0, 8)
  cdh.writeUInt16LE(8, 10); cdh.writeUInt16LE(0, 12); cdh.writeUInt16LE(0, 14)
  cdh.writeUInt32LE(crc, 16); cdh.writeUInt32LE(comp.length, 20); cdh.writeUInt32LE(data.length, 24)
  cdh.writeUInt16LE(nameBuf.length, 28); cdh.writeUInt16LE(0, 30); cdh.writeUInt16LE(0, 32)
  cdh.writeUInt16LE(0, 34); cdh.writeUInt16LE(0, 36); cdh.writeUInt32LE(0, 38); cdh.writeUInt32LE(0, 42)
  const cdPart = Buffer.concat([cdh, nameBuf])

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(cdPart.length, 12); eocd.writeUInt32LE(localPart.length, 16); eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localPart, cdPart, eocd])
}

/** JPEG-magic (a sniffType kepnek lassa, tartalmat nem tudunk belole olvasni). */
function makeJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x20)])
}

function writeInbox(name: string, data: Buffer): InboxItem {
  const dir = inboxDir('hu') as string
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), data)
  return { name, rel: name, isDir: false, size: data.length, sizeHuman: `${data.length} B`, mtime: '', credentialWarning: '' }
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Beérkező'), { recursive: true })
  saveLifeConfig({
    persons: [{ id: 'p1', name: PERSON, role: 'owner', countries: [], mediaGroups: [] }],
    companies: [],
  } as any)
})

describe('extractTextContent -- built-in tartalom-kinyeres', () => {
  it('txt: a sima szoveget kozvetlenul kiolvassa, needsOcr false', () => {
    const item = writeInbox('jegyzet.txt', Buffer.from('Kelt: 2026-08-21, tárgy: valami', 'utf8'))
    const c = extractTextContent(sniffType(join(inboxDir('hu') as string, item.name)), join(inboxDir('hu') as string, item.name))
    expect(c.text).toContain('2026-08-21')
    expect(c.needsOcr).toBe(false)
  })

  it('PDF: a FlateDecode-olt szovegreteget kibontja (zlib), needsOcr false', () => {
    const pdf = makePdf('BT /F1 12 Tf 72 720 Td (Számla kelte 2026-08-21 Korpás László) Tj ET')
    const item = writeInbox('scan001.pdf', pdf)
    const abs = join(inboxDir('hu') as string, item.name)
    const c = extractTextContent(sniffType(abs), abs)
    expect(c.text).toContain('2026-08-21')
    expect(c.text).toContain('Korpás')
    expect(c.needsOcr).toBe(false)
  })

  it('szkennelt PDF (van stream, de nincs szoveg-operator): needsOcr true, text ures', () => {
    const pdf = makePdf('q 200 0 0 300 0 0 cm /Im0 Do Q') // csak kep-rajzolas, nincs Tj
    const item = writeInbox('szkennelt.pdf', pdf)
    const abs = join(inboxDir('hu') as string, item.name)
    const c = extractTextContent(sniffType(abs), abs)
    expect(c.text).toBe('')
    expect(c.needsOcr).toBe(true)
  })

  it('docx: a ZIP central-directorybol a word/document.xml szoveget adja (inflateRaw + XML-strip)', () => {
    const docx = makeDocx('Bérleti szerződés, kelt 2026-08-21, bérlő: Korpás László')
    const item = writeInbox('level.docx', docx)
    const abs = join(inboxDir('hu') as string, item.name)
    const c = extractTextContent(sniffType(abs), abs)
    expect(c.text).toContain('2026-08-21')
    expect(c.text).toContain('Korpás László')
    expect(c.needsOcr).toBe(false)
  })

  it('kep: needsOcr true (a datum/tulajdonos csak OCR/arcfelismeressel jonne)', () => {
    const item = writeInbox('foto.jpg', makeJpeg())
    const abs = join(inboxDir('hu') as string, item.name)
    const c = extractTextContent(sniffType(abs), abs)
    expect(c.needsOcr).toBe(true)
  })
})

describe('analyzeInboxItem -- tartalombol datum + eletfa-kereszthivatkozas', () => {
  it('PDF tartalmabol: tulajdonos a NEVBOL, datum a szovegbol -- a fajlnev semleges', () => {
    const config = loadLifeConfig()
    const index = buildLearnedIndex(config)
    // A fajlnevben SEM datum, SEM nev nincs -- csak a tartalom dontheti el.
    const item = writeInbox('scan001.pdf', makePdf('BT (Ertesites 2026-08-21 Korpás László reszere) Tj ET'))
    const sug = analyzeInboxItem(item, config, index, 'hu')

    expect(sug.date.value).toBe('2026-08-21')
    expect(sug.date.source).toBe('content')
    expect(sug.owner.personId).toBe('p1')
    expect(sug.owner.uncertain).toBe(false)
    expect(sug.notes.some((n) => n.includes('szövegében talált név'))).toBe(true)
  })

  it('olvasható tartalom datum NELKUL: source none + kulon uzenet ("nem olvasasi hiba")', () => {
    const config = loadLifeConfig()
    const index = buildLearnedIndex(config)
    const item = writeInbox('jegyzet.txt', Buffer.from('Bevásárlólista: kenyér, tej, Korpás László telefonszáma', 'utf8'))
    const sug = analyzeInboxItem(item, config, index, 'hu')

    expect(sug.date.value).toBe('')
    expect(sug.date.source).toBe('none')
    // Elolvastuk a szoveget -> a "nincs datum" agat mondjuk ki, NEM az OCR-hianyt.
    expect(sug.notes.some((n) => n.includes('nem találtam benne dátumot'))).toBe(true)
    expect(sug.notes.some((n) => n.includes('OCR'))).toBe(false)
    // a nev viszont a tartalombol felismerheto
    expect(sug.owner.personId).toBe('p1')
  })

  it('szkennelt PDF, OCR nelkul: az OCR-hiany uzenet all, NEM a "nincs datum"', () => {
    const config = loadLifeConfig()
    const index = buildLearnedIndex(config)
    const item = writeInbox('szkennelt.pdf', makePdf('q 200 0 0 300 0 0 cm /Im0 Do Q'))
    const sug = analyzeInboxItem(item, config, index, 'hu')

    expect(sug.date.source).toBe('none')
    expect(sug.notes.some((n) => n.includes('szkennelt') || n.includes('OCR'))).toBe(true)
    expect(sug.notes.some((n) => n.includes('nem találtam benne dátumot'))).toBe(false)
  })

  it('a fajlnevben levo datum akkor is megjelenik, ha a tartalom nem ad jobbat', () => {
    const config = loadLifeConfig()
    const index = buildLearnedIndex(config)
    // szkennelt PDF (nincs tartalom-datum), de a fajlnevben ott a datum
    const item = writeInbox('2026-08-21_hatarozat.pdf', makePdf('q /Im0 Do Q'))
    const sug = analyzeInboxItem(item, config, index, 'hu')
    expect(sug.date.value).toBe('2026-08-21')
    expect(sug.date.source).toBe('filename')
  })
})
