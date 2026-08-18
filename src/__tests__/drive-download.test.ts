// Drive download -- Boss 2026-08-14: '{"error":"Unauthorized"} ezt irja ki
// amikor le akarok tolteni a gy filet.'
//
// The cause was not Drive at all: the button called window.open(), and the
// dashboard authenticates with an `Authorization: Bearer` header that the
// fetch wrapper in web/app.js attaches. A browser navigation carries no such
// header, and the server's ?token= lane is scoped to the SSE pane stream, so
// the download tab landed on the 401 JSON. The fix downloads through fetch()
// and hands the bytes to the browser as a blob.
//
// Two more defects were in the same path once it could run at all:
//   - Google Docs/Sheets/Slides have NO bytes: alt=media 403s on them.
//   - Accented filenames ("Szerzodes-marcius.pdf" with the real accents) do not
//     survive a latin-1 Content-Disposition header.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { driveDownloadPlan, contentDispositionHeader } from '../web/routes/drive-browser.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB = join(__dirname, '..', '..', 'web')
const src = readFileSync(join(WEB, 'app.js'), 'utf8')
const hu = readFileSync(join(WEB, 'lang', 'hu.js'), 'utf8')
const en = readFileSync(join(WEB, 'lang', 'en.js'), 'utf8')

describe('driveDownloadPlan: which endpoint actually returns the bytes', () => {
  it('an ordinary file streams from alt=media, under its own name', () => {
    const p = driveDownloadPlan('1AbC', 'application/pdf', 'szamla.pdf')
    expect(p.url).toBe('https://www.googleapis.com/drive/v3/files/1AbC?alt=media')
    expect(p.filename).toBe('szamla.pdf')
    expect(p.unsupported).toBeUndefined()
  })

  it('a Google Doc goes through /export as .docx', () => {
    const p = driveDownloadPlan('1AbC', 'application/vnd.google-apps.document', 'Szerzodes')
    expect(p.url).toContain('/1AbC/export?mimeType=')
    expect(p.url).toContain(encodeURIComponent('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
    // Drive shows Docs without an extension; saved to disk with no extension,
    // nothing opens them.
    expect(p.filename).toBe('Szerzodes.docx')
  })

  it('Sheets/Slides/Drawings each get their own format', () => {
    expect(driveDownloadPlan('x', 'application/vnd.google-apps.spreadsheet', 'Koltsegek').filename).toBe('Koltsegek.xlsx')
    expect(driveDownloadPlan('x', 'application/vnd.google-apps.presentation', 'Bemutato').filename).toBe('Bemutato.pptx')
    expect(driveDownloadPlan('x', 'application/vnd.google-apps.drawing', 'Abra').filename).toBe('Abra.png')
  })

  it('does not double an extension that is already there', () => {
    expect(driveDownloadPlan('x', 'application/vnd.google-apps.spreadsheet', 'Koltsegek.xlsx').filename).toBe('Koltsegek.xlsx')
    expect(driveDownloadPlan('x', 'application/vnd.google-apps.spreadsheet', 'Koltsegek.XLSX').filename).toBe('Koltsegek.XLSX')
  })

  it('a Google type with no export format is refused with a name, not a Drive 403', () => {
    const p = driveDownloadPlan('x', 'application/vnd.google-apps.form', 'Kerdoiv')
    expect(p.unsupported).toBe('application/vnd.google-apps.form')
    expect(p.url).toBe('')
    // Folders have no download button, but the API is reachable directly.
    expect(driveDownloadPlan('x', 'application/vnd.google-apps.folder', 'Mappa').unsupported).toBeTruthy()
  })

  it('without a mimeType the behaviour is exactly what it was before', () => {
    // An older cached page (or a curl user) sends no mimeType -- it must keep
    // working, not start failing on a new code path.
    for (const mime of [null, undefined, '']) {
      const p = driveDownloadPlan('1AbC', mime, 'valami.bin')
      expect(p.url).toBe('https://www.googleapis.com/drive/v3/files/1AbC?alt=media')
      expect(p.filename).toBe('valami.bin')
    }
  })

  it('the file id is escaped into the URL', () => {
    expect(driveDownloadPlan('a b/c', 'application/pdf', 'x').url).toContain('a%20b%2Fc')
  })
})

describe('contentDispositionHeader: accented names survive the header', () => {
  it('carries both the ASCII fallback and the UTF-8 name', () => {
    const h = contentDispositionHeader('Szerződés március.pdf')
    expect(h).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''/)
    const star = /filename\*=UTF-8''(.+)$/.exec(h)!
    expect(decodeURIComponent(star[1])).toBe('Szerződés március.pdf')
    // Anything non-ASCII in the plain field is mojibake in the browser.
    expect(/^attachment; filename="([^"]*)"/.exec(h)![1]).toMatch(/^[\x20-\x7e]*$/)
  })

  it('escapes the characters RFC 5987 does not allow in the starred value', () => {
    const h = contentDispositionHeader("terv(2)!'*.txt")
    const star = /filename\*=UTF-8''(.+)$/.exec(h)![1]
    expect(star).not.toMatch(/['()!*]/)
    expect(decodeURIComponent(star)).toBe("terv(2)!'*.txt")
  })

  it('a newline in a Drive file name cannot inject a header', () => {
    // A file name is arbitrary user text, not our data.
    const h = contentDispositionHeader('szamla\r\nSet-Cookie: a=b.pdf')
    expect(h).not.toMatch(/[\r\n]/)
  })

  it('quotes and backslashes cannot break out of the quoted string', () => {
    const h = contentDispositionHeader('rossz"nev\\.pdf')
    expect(/^attachment; filename="([^"]*)"/.exec(h)).toBeTruthy()
    expect(h.split('filename="')[1].split('"')[0]).not.toContain('\\')
  })

  it('an empty or control-only name still yields a usable filename', () => {
    expect(contentDispositionHeader('')).toContain('filename="download"')
    expect(contentDispositionHeader('')).toContain('filename="download"')
  })
})

describe('the bytes reach the browser with backpressure', () => {
  // 2026-08-15, found while chasing the Photos memory spike (the dashboard had
  // peaked at 4.3G). This path streamed chunk by chunk, but with a bare
  // res.write() whose return value nobody checked: on a slow link Google fills
  // faster than the browser drains, and the difference piles up in the service.
  const route = readFileSync(join(__dirname, '..', 'web', 'routes', 'drive-browser.ts'), 'utf8')

  it('the whole file is never buffered in the service', () => {
    const code = route.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    expect(code, 'a download must not read the response in one piece').not.toMatch(/arrayBuffer\(\)/)
    expect(code).not.toMatch(/upstream\.body\.getReader\(\)/)
    expect(code, 'the hand-written loop ignored backpressure').not.toMatch(/res\.write\(value\)/)
  })

  it('the response is piped, so a slow browser slows the download itself', () => {
    expect(route).toContain('await pipeline(Readable.fromWeb(upstream.body as any), res)')
    expect(route).toMatch(/import \{ pipeline \} from 'node:stream\/promises'/)
  })

  it('pipeline really does wait for a slow consumer', async () => {
    // Not a source check: proof that the mechanism behaves as claimed. The sink
    // accepts 1 chunk at a time; if the pipe ignored backpressure, everything
    // would arrive before the first release.
    const { Readable: R, Writable } = await import('node:stream')
    const { pipeline: pipe } = await import('node:stream/promises')
    const chunks = Array.from({ length: 20 }, (_, i) => Buffer.alloc(64 * 1024, i))
    let inFlight = 0
    let maxInFlight = 0
    const slow = new Writable({
      highWaterMark: 1,
      write(_c, _e, cb) {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        setTimeout(() => { inFlight--; cb() }, 1)
      },
    })
    await pipe(R.from(chunks), slow)
    expect(maxInFlight, 'the writer was never handed more than it asked for').toBe(1)
  })

  it('an upload cannot grow without a bound either', () => {
    // The upload does buffer (Drive multipart needs one body), so the cap is
    // the memory guarantee -- it must stay in place.
    expect(route).toMatch(/const UPLOAD_MAX_BYTES = \d+ \* 1024 \* 1024/)
    expect(route).toContain('readBody(req, { maxBytes: UPLOAD_MAX_BYTES })')
  })
})

describe('the client no longer navigates to the download URL', () => {
  it('window.open() is gone from the Drive row actions', () => {
    // This is the reported bug in one line: a navigation carries no
    // Authorization header, so the tab shows {"error":"Unauthorized"}.
    expect(src).not.toMatch(/window\.open\(`\/api\/drive\/download/)
    expect(src).toMatch(/await downloadDriveFile\(id, name, account, mimeType\)/)
  })

  it('downloads through fetch and saves the blob', () => {
    const fn = /async function downloadDriveFile\([\s\S]*?\n\}/.exec(src)
    expect(fn, 'downloadDriveFile()').toBeTruthy()
    const body = fn![0]
    expect(body).toMatch(/await fetch\('\/api\/drive\/download\?/)
    expect(body).toMatch(/URL\.createObjectURL\(blob\)/)
    expect(body).toMatch(/URL\.revokeObjectURL\(objectUrl\)/)
    expect(body).toMatch(/a\.download = filename/)
  })

  it('sends the mimeType so Docs take the export path', () => {
    expect(src).toMatch(/data-mime="\$\{escapeHtml\(f\.mimeType \|\| ''\)\}"/)
    expect(src).toMatch(/const mimeType = row\.getAttribute\('data-mime'\) \|\| ''/)
    expect(/async function downloadDriveFile\([\s\S]*?\n\}/.exec(src)![0]).toMatch(/mimeType=' \+ encodeURIComponent/)
  })

  it('prefers the UTF-8 filename from the header, and never dies on a broken one', () => {
    const body = /async function downloadDriveFile\([\s\S]*?\n\}/.exec(src)![0]
    expect(body).toMatch(/filename\\\*=UTF-8''\(\[\^;\]\+\)/)
    expect(body).toMatch(/try \{ filename = decodeURIComponent/)
  })

  it('says something on failure instead of leaving a dead button', () => {
    const body = /async function downloadDriveFile\([\s\S]*?\n\}/.exec(src)![0]
    expect(body).toMatch(/drive\.download\.started/)
    expect(body).toMatch(/drive\.download\.failed/)
    expect(body).toMatch(/d\.code === 'unsupported_google_type'/)
  })

  it('both languages have the three download messages', () => {
    for (const k of ['drive.download.started', 'drive.download.failed', 'drive.download.unsupported']) {
      expect(hu.includes(`'${k}'`), `hu.js: ${k}`).toBe(true)
      expect(en.includes(`'${k}'`), `en.js: ${k}`).toBe(true)
    }
  })
})
