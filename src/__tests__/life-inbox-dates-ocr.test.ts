// Card 56530b08: the Inbox analyzer must read a SCANNED document (OCR), pick
// the document's own date (not a birthday, not an expiry, not a future date),
// read image metadata, and match the owner's name without accents -- a German
// authority writes "Laszlo Korpas", the life tree says "Korpás László".
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const depot = mkdtempSync(join(tmpdir(), 'marveen-inboxocr-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-inboxocr-store-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { explorerRoot } = await import('../life-explorer.js')
const A = await import('../life-inbox-analyze.js')
const { saveLifeConfig, inboxDir } = await import('../life-tree.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

const TODAY = new Date(2026, 8, 18)

function scannedPdf(): Buffer {
  const deflated = deflateSync(Buffer.from('q 200 0 0 300 0 0 cm /Im0 Do Q', 'latin1'))
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    deflated,
    Buffer.from('endstream\nendobj\n%%EOF', 'latin1'),
  ])
}

function pngWithText(key: string, value: string): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')])),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'Beérkező'), { recursive: true })
  saveLifeConfig({
    persons: [{ id: 'p1', name: 'Korpás László', role: 'owner', countries: [], mediaGroups: [] }],
    companies: [],
  } as any)
  A.clearPrefetchCache()
})

afterEach(() => {
  A.setOcrAdapter(null)
})

describe('looksLikeRealText', () => {
  it('a valodi mondatot szovegnek latja (nemet, magyar)', () => {
    expect(A.looksLikeRealText('Meldebestätigung für Herrn Korpás, wohnhaft in Stuttgart')).toBe(true)
    expect(A.looksLikeRealText('Értesítés a lakcím bejelentéséről')).toBe(true)
  })

  it('a kepfolyambol kibontott zajt NEM latja szovegnek', () => {
    expect(A.looksLikeRealText('')).toBe(false)
    expect(A.looksLikeRealText('#$%& 0x9f ÿþ ^^ 12 3 ~~  Ñ§ ¤¤')).toBe(false)
    expect(A.looksLikeRealText('xq zz 1 2 3 4 5 6 7 8 9 bcd')).toBe(false)
  })
})

describe('findDatesInText', () => {
  it('a "Datum:" utani datum nyer a szuletesi datum ellen', () => {
    const text = 'Herr Korpas, geboren am 06.05.1980\nStuttgart, Datum: 15.06.2017'
    expect(A.findDatesInText(text, TODAY)[0]).toBe('2017-06-15')
  })

  it('a lejarati es a jovobeli datum hatrebb kerul', () => {
    const text = 'Ausgestellt am 03.02.2020. Gültig bis 03.02.2030.'
    const dates = A.findDatesInText(text, TODAY)
    expect(dates[0]).toBe('2020-02-03')
    expect(dates).toContain('2030-02-03')
  })

  it('honapneveket ert: nemet, magyar, angol', () => {
    expect(A.findDatesInText('Stuttgart, den 15. Juni 2017', TODAY)[0]).toBe('2017-06-15')
    expect(A.findDatesInText('Budapest, 2017. június 15.', TODAY)[0]).toBe('2017-06-15')
    expect(A.findDatesInText('Dated March 4, 2021', TODAY)[0]).toBe('2021-03-04')
  })

  it('ervenytelen napot nem fogad el', () => {
    expect(A.findDatesInText('2021-02-31 es 31.13.2020', TODAY)).toEqual([])
  })
})

describe('parsePngDate', () => {
  it('a PNG tEXt "Creation Time" mezobol datumot olvas', () => {
    const dir = inboxDir('hu') as string
    const abs = join(dir, 'kep.png')
    writeFileSync(abs, pngWithText('Creation Time', '2024:05:17 10:22:01'))
    expect(A.parsePngDate(abs)).toBe('2024-05-17')
  })

  it('metaadat nelkuli PNG-re ures', () => {
    const dir = inboxDir('hu') as string
    const abs = join(dir, 'ures.png')
    writeFileSync(abs, pngWithText('Software', 'GIMP'))
    expect(A.parsePngDate(abs)).toBe('')
  })
})

describe('szkennelt irat OCR-rel (analyzeInboxAsync)', () => {
  it('az OCR szovegebol jon a tulajdonos (ekezet nelkul is) es az irat datuma', async () => {
    const dir = inboxDir('hu') as string
    writeFileSync(join(dir, 'scan.pdf'), scannedPdf())
    let asyncCalls = 0
    A.setOcrAdapter({
      available: () => true,
      extractText: () => { throw new Error('the route must use the async path') },
      extractTextAsync: async () => {
        asyncCalls++
        return 'Meldebestätigung\nHerr Laszlo KORPAS, geboren am 06.05.1980\nStuttgart, Datum: 15.06.2017'
      },
    })
    const res = await A.analyzeInboxAsync(['scan.pdf'], 'hu')
    const sug = res.suggestions.find((s) => s.name === 'scan.pdf')!
    expect(asyncCalls).toBe(1)
    expect(sug.contentSource).toBe('ocr')
    expect(sug.owner.personId).toBe('p1')
    expect(sug.date.value).toBe('2017-06-15')
    expect(sug.date.source).toBe('ocr')
    expect(sug.date.alternatives?.some((a) => a.value === '1980-05-06')).toBe(false)
    expect(res.prefetched.get('scan.pdf')?.content.source).toBe('ocr')
  })

  it('ha az OCR nem talal szoveget, kimondja, hogy lefutott (nem azt, hogy hianyzik)', async () => {
    const dir = inboxDir('hu') as string
    writeFileSync(join(dir, 'ures.pdf'), scannedPdf())
    A.setOcrAdapter({ available: () => true, extractText: () => null, extractTextAsync: async () => '' })
    const res = await A.analyzeInboxAsync(['ures.pdf'], 'hu')
    const sug = res.suggestions.find((s) => s.name === 'ures.pdf')!
    expect(sug.notes.some((n) => n.includes('OCR) lefutott'))).toBe(true)
    expect(sug.notes.some((n) => n.includes('nincs telepítve'))).toBe(false)
    expect(sug.date.source).toBe('filedate')
  })

  it('ugyanazt a fajlt masodszor nem OCR-ezi ujra (gyorsitotar)', async () => {
    const dir = inboxDir('hu') as string
    writeFileSync(join(dir, 'scan2.pdf'), scannedPdf())
    let calls = 0
    A.setOcrAdapter({ available: () => true, extractText: () => null, extractTextAsync: async () => { calls++; return 'Datum: 01.02.2019 Laszlo Korpas' } })
    await A.analyzeInboxAsync(['scan2.pdf'], 'hu')
    await A.analyzeInboxAsync(['scan2.pdf'], 'hu')
    expect(calls).toBe(1)
  })
})
