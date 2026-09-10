// GET /api/life/file -- a fajl BAJTJAINAK kiszolgalasa (kartya #164, 1. fazis).
//
// A LEGFONTOSABB szabaly (a kartya sajat szavaival): a vegpont a MAR MEGLEVO
// resolveLifePath()-et hasznalja utvonal-vedelemre, nem ir sajat logikat --
// mert egy ujraírt/hianyos ellenorzes egy `../../etc/passwd`-szeru kerest
// engedne at, es akkor BARMELY fajl olvashato lenne a gepen. Ez a teszt EZT
// meri, nem csak azt hogy a "boldog ut" mukodik.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const depot = mkdtempSync(join(tmpdir(), 'marveen-lfile-'))
// Ez a "titkos" fajl a depon KIVUL all -- pontosan olyan, mint egy
// /etc/passwd: soha nem szabad, hogy a vegpont kiadja a tartalmat.
const outsideDir = mkdtempSync(join(tmpdir(), 'marveen-lfile-outside-'))
const secretFile = join(outsideDir, 'titok.txt')
writeFileSync(secretFile, 'EZT SOSEM SZABAD LATNIA A KLIENSNEK')

process.env.MARVEEN_DEPOT = depot

const { tryHandleLife } = await import('../web/routes/life.js')

afterAll(() => {
  rmSync(depot, { recursive: true, force: true })
  rmSync(outsideDir, { recursive: true, force: true })
})

/** Valodi irhato folyam, mert a vegpont `pipeline()`-nal folyat at bajtokat -- */
/** egy sima objektum-mock itt nem eleg, a `pipeline` valodi Writable-t var.  */
function fakeRes() {
  const chunks: Buffer[] = []
  const res: any = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) { chunks.push(chunk); cb() },
  })
  res.statusCode = 0
  res.headers = {}
  res.writeHead = (status: number, headers?: Record<string, unknown>) => {
    res.statusCode = status
    if (headers) Object.assign(res.headers, headers)
    return res
  }
  res.setHeader = (k: string, v: unknown) => { res.headers[k] = v; return res }
  res.body = () => Buffer.concat(chunks)
  res.text = () => Buffer.concat(chunks).toString('utf-8')
  return res
}

function ctxFor(path: string, headers: Record<string, string> = {}) {
  const res = fakeRes()
  const req: any = Readable.from([])
  req.headers = headers
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext, res }
}

describe('GET /api/life/file -- utvonal-vedelem (a legfontosabb szabaly)', () => {
  beforeAll(() => {
    mkdirSync(join(depot, 'Dokumentumok'), { recursive: true })
    writeFileSync(join(depot, 'Dokumentumok', 'proba.txt'), 'szia vilag')
  })

  it('a fan BELULI fajlt rendben kiadja', async () => {
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent('Dokumentumok/proba.txt'))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.text()).toBe('szia vilag')
  })

  it('klasszikus "../"-lancolas NEM lep ki a fabol -- nem adja ki a titkos fajlt', async () => {
    // A depo es a titkos fajl konyvtaranak kozos ose a rendszer temp-mappaja,
    // tehat eleg sok "../"-t felfele menni ahhoz, hogy oda erjunk.
    const traversal = '../'.repeat(20) + secretFile.replace(/^\/+/, '')
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent(traversal))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.text()).not.toContain('EZT SOSEM SZABAD')
    const body = JSON.parse(res.text())
    expect(body.error).toBe('outside')
  })

  it('abszolut utvonal a titkos fajlra szinten elutasitva', async () => {
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent(secretFile))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.text()).not.toContain('EZT SOSEM SZABAD')
  })

  it('szimlinken at kivezeto utvonal is elutasitva (realpath-szinten)', async () => {
    // Egy szimlink a depo BELSEJEBEN, ami a depon KIVULRE mutat -- a
    // resolveLifePath() ezt a realpath-osszehasonlitassal fogja meg, egy
    // csupasz string-osszehasonlitas ("kezdodik-e a gyoker nevevel") atengedne.
    const linkPath = join(depot, 'kifele-mutato-link')
    try { symlinkSync(outsideDir, linkPath) } catch { return } // ha a fs nem tamogatja, kihagyjuk
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent('kifele-mutato-link/titok.txt'))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(res.text()).not.toContain('EZT SOSEM SZABAD')
  })

  it('nem letezo fajlnal is 404 emberi mondattal, nem nyers hiba', async () => {
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent('Dokumentumok/nincs-ilyen.txt'))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.text())
    expect(typeof body.message).toBe('string')
    expect(body.message.length).toBeGreaterThan(0)
  })

  it('mappara mutato rel-t elutasitja (ez nem fajl)', async () => {
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent('Dokumentumok'))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/life/file -- tartalom-fejlecek es viselkedes tipus szerint', () => {
  beforeAll(() => {
    mkdirSync(join(depot, 'Media'), { recursive: true })
    writeFileSync(join(depot, 'Media', 'kep.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(depot, 'Media', 'program.exe'), Buffer.from([0x4d, 0x5a]))
    // "Videonak" szanjuk -- eleg nagy ahhoz, hogy resz-kerest tudjunk rajta probalni.
    writeFileSync(join(depot, 'Media', 'film.mp4'), Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)))
  })

  it('kep: elonezetre alkalmas -- inline diszpozicio, helyes content-type', async () => {
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent('Media/kep.png'))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('image/png')
    expect(String(res.headers['Content-Disposition'])).toContain('inline')
  })

  it('?download=1 KENYSZERITI a letoltest meg elonezetkepes tipusnal is', async () => {
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent('Media/kep.png') + '&download=1')
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(String(res.headers['Content-Disposition'])).toContain('attachment')
  })

  it('ismeretlen/veszelyes kiterjesztes (.exe): SOHA nem inline, akkor sem, ha nem kerik a letoltest', async () => {
    const { ctx, res } = ctxFor('/api/life/file?rel=' + encodeURIComponent('Media/program.exe'))
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['Content-Disposition'])).toContain('attachment')
  })

  it('video: resz-keres (Range) 206-ot ad, csak a keret bajtokkal', async () => {
    const { ctx, res } = ctxFor(
      '/api/life/file?rel=' + encodeURIComponent('Media/film.mp4'),
      { range: 'bytes=10-19' },
    )
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(206)
    expect(res.headers['Content-Range']).toBe('bytes 10-19/1000')
    expect(res.headers['Content-Length']).toBe(10)
    const body = res.body()
    expect(body.length).toBe(10)
    expect(body[0]).toBe(10) // a film.mp4 tartalma index szerint noveksik
  })

  it('video: ervenytelen Range-nel 416-ot ad, nem szemetet', async () => {
    const { ctx, res } = ctxFor(
      '/api/life/file?rel=' + encodeURIComponent('Media/film.mp4'),
      { range: 'bytes=5000-6000' },
    )
    expect(await tryHandleLife(ctx)).toBe(true)
    expect(res.statusCode).toBe(416)
  })
})
