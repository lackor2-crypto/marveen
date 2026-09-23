// /vendor/pdfjs/* -- a PDF-nezegeto kiszolgalasa a SAJAT gepunkrol (kartya f7d423e7).
//
// Amit bizonyitunk:
//   - az utvonal-feloldas csak a ket build-fajlt es a NEVEZETT adatmappakat
//     engedi at (`..`, visszaper, alkonyvtar, `.map` -> elutasitva),
//   - a letezo fajl bajtjai tenyleg kimennek, JAVASCRIPT tipussal (ESM: a
//     bongeszo octet-stream eseten NEMA hibaval elszall),
//   - a hianyzo fajl NEM ures 404: a torzs megmondja, MI a baj -- es a "nincs
//     telepitve a csomag" mas mondat, mint a "hianyzik egy adatfajlja".
import { describe, it, expect } from 'vitest'
import { Readable, Writable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'
import {
  resolvePdfjsAsset, pdfjsInstalled, pdfjsMissingMessage, pdfjsAssetMissingMessage,
  tryHandleVendor, PDFJS_PACKAGE,
} from '../web/routes/vendor.js'

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
  res.getHeader = (k: string) => res.headers[k]
  res.body = () => Buffer.concat(chunks)
  res.text = () => Buffer.concat(chunks).toString('utf-8')
  return res
}

function ctxFor(path: string) {
  const res = fakeRes()
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL(`http://localhost:3420${path}`)
  return { ctx: { req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext, res }
}

/** A valasz megvarasa: a serveFile folyamot pipe-ol, az nem szinkron. */
function whenFinished(res: any): Promise<void> {
  return new Promise((resolve) => {
    if (res.writableEnded) return resolve()
    res.on('finish', () => resolve())
    res.on('close', () => resolve())
    setTimeout(resolve, 1500)
  })
}

describe('resolvePdfjsAsset -- mit szabad kiadni', () => {
  it('a ket build-fajlt atengedi', () => {
    expect(resolvePdfjsAsset('build/pdf.min.mjs')).toBe('build/pdf.min.mjs')
    expect(resolvePdfjsAsset('build/pdf.worker.min.mjs')).toBe('build/pdf.worker.min.mjs')
  })

  it('a build/ tobbi fajljat NEM (terkep, sandbox, nem minositett valtozat)', () => {
    expect(resolvePdfjsAsset('build/pdf.mjs.map')).toBeNull()
    expect(resolvePdfjsAsset('build/pdf.sandbox.min.mjs')).toBeNull()
    expect(resolvePdfjsAsset('build/pdf.mjs')).toBeNull()
  })

  it('a nevezett adatmappakbol a megfelelo kiterjesztest engedi', () => {
    expect(resolvePdfjsAsset('cmaps/78-EUC-H.bcmap')).toBe('cmaps/78-EUC-H.bcmap')
    expect(resolvePdfjsAsset('standard_fonts/FoxitFixed.pfb')).toBe('standard_fonts/FoxitFixed.pfb')
    expect(resolvePdfjsAsset('iccs/CGATS001Compat-v2-micro.icc')).toBe('iccs/CGATS001Compat-v2-micro.icc')
  })

  it('mas mappat, alkonyvtarat es rossz kiterjesztest elutasit', () => {
    expect(resolvePdfjsAsset('web/viewer.mjs')).toBeNull()
    expect(resolvePdfjsAsset('package.json')).toBeNull()
    expect(resolvePdfjsAsset('cmaps/sub/dir.bcmap')).toBeNull()
    expect(resolvePdfjsAsset('iccs/LICENSE')).toBeNull()
  })

  it('utvonal-kitorest minden formaban elutasit', () => {
    expect(resolvePdfjsAsset('../../../etc/passwd')).toBeNull()
    expect(resolvePdfjsAsset('build/../../../etc/passwd')).toBeNull()
    expect(resolvePdfjsAsset('cmaps/..%2Fpackage.json')).toBeNull()
    expect(resolvePdfjsAsset('/etc/passwd')).toBeNull()
    expect(resolvePdfjsAsset('build\\pdf.min.mjs')).toBeNull()
    expect(resolvePdfjsAsset('')).toBeNull()
    expect(resolvePdfjsAsset('cmaps/' + 'a'.repeat(300) + '.bcmap')).toBeNull()
  })
})

describe('tryHandleVendor', () => {
  it('nem a sajat utvonalara nem valaszol', () => {
    const { ctx } = ctxFor('/api/kanban')
    expect(tryHandleVendor(ctx)).toBe(false)
  })

  it('a konyvtarat JAVASCRIPT tipussal adja ki (ESM: octet-stream eseten nema hiba lenne)', async () => {
    // A csomag a package.json fuggosege, tehat `npm ci` utan ott kell lennie.
    expect(pdfjsInstalled()).toBe(true)
    const { ctx, res } = ctxFor('/vendor/pdfjs/build/pdf.min.mjs')
    expect(tryHandleVendor(ctx)).toBe(true)
    await whenFinished(res)
    expect(res.statusCode).toBe(200)
    expect(String(res.headers['Content-Type'])).toMatch(/javascript/)
    expect(res.body().length).toBeGreaterThan(1000)
  })

  it('tiltott utra ures 404 (nincs mit magyarazni: rossz utat kertek)', () => {
    const { ctx, res } = ctxFor('/vendor/pdfjs/build/pdf.mjs.map')
    expect(tryHandleVendor(ctx)).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  it('engedelyezett, de hianyzo fajlnal a torzs MEGMONDJA, mi a baj', () => {
    const { ctx, res } = ctxFor('/vendor/pdfjs/cmaps/nincs-ilyen-terkep.bcmap')
    expect(tryHandleVendor(ctx)).toBe(true)
    expect(res.statusCode).toBe(404)
    const body = JSON.parse(res.text())
    // A csomag fent van, tehat NEM a "nincs telepitve" agat kell kapnunk.
    expect(body.error).toBe('pdfjs_asset_missing')
    expect(body.message).toBeTruthy()
    expect(body.message).not.toMatch(/^[a-z_]+$/)          // ember, nem gepi kod
    expect(body.detail).toContain('nincs-ilyen-terkep.bcmap')
  })
})

describe('a ket nulla kulon mondata', () => {
  it('"nincs telepitve" es "hianyzik egy adatfajl" NEM ugyanaz a szoveg', () => {
    const missing = pdfjsMissingMessage('hu')
    const partial = pdfjsAssetMissingMessage('hu', 'cmaps/x.bcmap')
    expect(missing.message).not.toBe(partial.message)
  })

  it('mindket mondat ketnyelvu es a potlo parancsot is megadja', () => {
    for (const m of [pdfjsMissingMessage('hu'), pdfjsMissingMessage('en'),
      pdfjsAssetMissingMessage('hu', 'x'), pdfjsAssetMissingMessage('en', 'x')]) {
      expect(m.message.length).toBeGreaterThan(20)
      expect(m.detail).toContain('npm install')
    }
    expect(pdfjsMissingMessage('hu').message).not.toBe(pdfjsMissingMessage('en').message)
    expect(pdfjsMissingMessage('hu').detail).toContain(PDFJS_PACKAGE)
  })
})
