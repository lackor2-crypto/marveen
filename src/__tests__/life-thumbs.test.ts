// Card #373 -- thumbnails for the Intezo icon view.
//
// What is measured here, and why:
//   1. Which file names get a preview at all (image / video / nothing).
//   2. WITHOUT FFmpeg (a fresh install): a browser-viewable photo is served
//      as the original bytes, a video says `no_ffmpeg` -- an explained reason,
//      never a silent empty picture.
//   3. WITH FFmpeg (a fake binary, so CI does not need the real one): the
//      thumbnail is generated once and then comes from the cache.
//   4. A failing FFmpeg: a photo still falls back to the original, a video
//      says `failed` -- "the tool is missing" and "this file is broken" are
//      two different answers.
//   5. The route keeps the same path boundary as /api/life/file, answers with
//      a human sentence, and honours If-None-Match.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const depot = mkdtempSync(join(tmpdir(), 'marveen-lthumb-'))
const cache = mkdtempSync(join(tmpdir(), 'marveen-lthumb-cache-'))
const bin = mkdtempSync(join(tmpdir(), 'marveen-lthumb-bin-'))
process.env.MARVEEN_DEPOT = depot

const thumbs = await import('../life-thumbs.js')
const { tryHandleLife } = await import('../web/routes/life.js')

// A fake FFmpeg: writes a few bytes into its LAST argument (the output file).
const okFfmpeg = join(bin, 'ffmpeg-ok')
writeFileSync(okFfmpeg, '#!/bin/sh\nfor a; do last="$a"; done\nprintf THUMB > "$last"\n')
chmodSync(okFfmpeg, 0o755)
const badFfmpeg = join(bin, 'ffmpeg-bad')
writeFileSync(badFfmpeg, '#!/bin/sh\nexit 1\n')
chmodSync(badFfmpeg, 0o755)

let n = 0
/** Every test gets its own file, so the module's failed-key memory cannot leak between them. */
function mediaFile(ext: string, body = 'PIXELS'): { abs: string; name: string; rel: string } {
  const name = `m${++n}.${ext}`
  mkdirSync(join(depot, 'Fotok'), { recursive: true })
  const abs = join(depot, 'Fotok', name)
  writeFileSync(abs, body)
  return { abs, name, rel: 'Fotok/' + name }
}

beforeAll(() => { thumbs.setThumbCacheDirForTests(cache) })
beforeEach(() => { thumbs.setThumbFfmpegForTests(null) })
afterAll(() => {
  thumbs.setThumbCacheDirForTests(null)
  thumbs.setThumbFfmpegForTests(undefined)
  for (const d of [depot, cache, bin]) rmSync(d, { recursive: true, force: true })
})

describe('thumbMediaKind', () => {
  it('photos, videos and everything else', () => {
    expect(thumbs.thumbMediaKind('IMG_0001.JPG')).toBe('image')
    expect(thumbs.thumbMediaKind('kep.heic')).toBe('image')
    expect(thumbs.thumbMediaKind('film.MP4')).toBe('video')
    expect(thumbs.thumbMediaKind('film.mov')).toBe('video')
    expect(thumbs.thumbMediaKind('szamla.pdf')).toBeNull()
    expect(thumbs.thumbMediaKind('README')).toBeNull()
  })
})

describe('lifeThumb without FFmpeg (fresh install)', () => {
  it('a jpg is served as the original', async () => {
    const f = mediaFile('jpg')
    const r = await thumbs.lifeThumb(f.abs, f.name)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.kind).toBe('original')
      expect(r.path).toBe(f.abs)
      if (r.kind === 'original') expect(r.mime).toMatch(/^image\//)
    }
  })

  it('a video says no_ffmpeg', async () => {
    const f = mediaFile('mp4')
    expect(await thumbs.lifeThumb(f.abs, f.name)).toEqual({ ok: false, reason: 'no_ffmpeg' })
  })

  it('a non-media file says not_media', async () => {
    const f = mediaFile('txt')
    expect(await thumbs.lifeThumb(f.abs, f.name)).toEqual({ ok: false, reason: 'not_media' })
  })
})

describe('lifeThumb with FFmpeg', () => {
  it('generates once, then serves from the cache', async () => {
    thumbs.setThumbFfmpegForTests(okFfmpeg)
    const f = mediaFile('mp4')
    const r = await thumbs.lifeThumb(f.abs, f.name)
    expect(r.ok && r.kind).toBe('thumb')
    // No temp file left behind next to the thumbnail.
    expect(readdirSync(cache).some((x) => x.includes('.part'))).toBe(false)
    // The cache answers even when the tool is gone.
    thumbs.setThumbFfmpegForTests(null)
    const again = await thumbs.lifeThumb(f.abs, f.name)
    expect(again.ok && again.kind).toBe('thumb')
    if (r.ok && again.ok) expect(again.etag).toBe(r.etag)
  })

  it('a failing FFmpeg: photo falls back to the original, video says failed', async () => {
    thumbs.setThumbFfmpegForTests(badFfmpeg)
    const img = mediaFile('png')
    const ri = await thumbs.lifeThumb(img.abs, img.name)
    expect(ri.ok && ri.kind).toBe('original')
    const vid = mediaFile('mov')
    expect(await thumbs.lifeThumb(vid.abs, vid.name)).toEqual({ ok: false, reason: 'failed' })
  })
})

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

describe('GET /api/life/thumb', () => {
  it('serves the thumbnail, then answers If-None-Match with 304', async () => {
    thumbs.setThumbFfmpegForTests(okFfmpeg)
    const f = mediaFile('jpg')
    const a = ctxFor('/api/life/thumb?rel=' + encodeURIComponent(f.rel))
    expect(await tryHandleLife(a.ctx)).toBe(true)
    expect(a.res.statusCode).toBe(200)
    expect(a.res.headers['Content-Type']).toBe('image/jpeg')
    expect(a.res.text()).toBe('THUMB')
    const etag = String(a.res.headers.ETag)
    const b = ctxFor('/api/life/thumb?rel=' + encodeURIComponent(f.rel), { 'if-none-match': etag })
    await tryHandleLife(b.ctx)
    expect(b.res.statusCode).toBe(304)
  })

  it('a video without FFmpeg: 404 with a human sentence in both languages', async () => {
    const f = mediaFile('mp4')
    const hu = ctxFor('/api/life/thumb?lang=hu&rel=' + encodeURIComponent(f.rel))
    await tryHandleLife(hu.ctx)
    expect(hu.res.statusCode).toBe(404)
    const bodyHu = JSON.parse(hu.res.text())
    expect(bodyHu.reason).toBe('no_ffmpeg')
    expect(bodyHu.message).toContain('FFmpeg')
    const en = ctxFor('/api/life/thumb?lang=en&rel=' + encodeURIComponent(f.rel))
    await tryHandleLife(en.ctx)
    expect(JSON.parse(en.res.text()).message).toMatch(/Workbench/)
  })

  it('never leaves the depot', async () => {
    const { ctx, res } = ctxFor('/api/life/thumb?rel=' + encodeURIComponent('../../etc/passwd'))
    await tryHandleLife(ctx)
    expect(res.statusCode).toBe(404)
    expect(res.text()).not.toContain('root:')
  })
})
