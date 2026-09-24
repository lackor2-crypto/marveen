import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { tryHandleStatic } from '../web/routes/static.js'

// #377: index.html (~380KB) was sent uncompressed on every full load.
function fakeCtx(headers: Record<string, string>) {
  const out: { status?: number; headers?: Record<string, string>; body?: Buffer | string } = {}
  const res = {
    writeHead(status: number, h: Record<string, string>) { out.status = status; out.headers = h },
    end(b?: Buffer | string) { out.body = b },
  }
  const ctx = { req: { headers }, res, path: '/', method: 'GET', url: new URL('http://x/') } as never
  return { ctx, out }
}

describe('index.html gzip (#377)', () => {
  let webDir: string
  const html = '<html><head><title>x</title></head><body>' + 'lorem ipsum '.repeat(500) + '</body></html>'
  beforeEach(() => {
    webDir = mkdtempSync(join(tmpdir(), 'idx-gz-'))
    writeFileSync(join(webDir, 'index.html'), html)
  })
  afterEach(() => rmSync(webDir, { recursive: true, force: true }))

  it('gzips when the client accepts it, with a distinct -gz ETag', async () => {
    const { ctx, out } = fakeCtx({ 'accept-encoding': 'gzip, deflate, br' })
    await tryHandleStatic(ctx, webDir)
    expect(out.status).toBe(200)
    expect(out.headers!['Content-Encoding']).toBe('gzip')
    expect(out.headers!.Vary).toBe('Accept-Encoding')
    expect(out.headers!.ETag).toMatch(/-gz"$/)
    const plain = gunzipSync(out.body as Buffer).toString('utf-8')
    expect(plain).toContain('lorem ipsum')
    expect((out.body as Buffer).length).toBeLessThan(plain.length / 4)
  })

  it('sends plain HTML without Accept-Encoding: gzip', async () => {
    const { ctx, out } = fakeCtx({})
    await tryHandleStatic(ctx, webDir)
    expect(out.headers!['Content-Encoding']).toBeUndefined()
    expect(out.headers!.ETag).not.toMatch(/-gz"$/)
    expect(String(out.body)).toContain('lorem ipsum')
  })

  it('answers 304 to a matching conditional GET of the gzip variant', async () => {
    const first = fakeCtx({ 'accept-encoding': 'gzip' })
    await tryHandleStatic(first.ctx, webDir)
    const etag = first.out.headers!.ETag
    const again = fakeCtx({ 'accept-encoding': 'gzip', 'if-none-match': etag })
    await tryHandleStatic(again.ctx, webDir)
    expect(again.out.status).toBe(304)
    // The plain variant must not validate against the gzip ETag.
    const plain = fakeCtx({ 'if-none-match': etag })
    await tryHandleStatic(plain.ctx, webDir)
    expect(plain.out.status).toBe(200)
  })
})
