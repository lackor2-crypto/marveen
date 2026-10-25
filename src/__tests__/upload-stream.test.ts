// #663: the streamed upload over a REAL http connection (the route tests feed a fake request).
import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { streamBodyToStage, placeStaged } from '../upload-stream.js'
import { RequestBodyTooLargeError } from '../web/http-helpers.js'

let server: http.Server | null = null
let dir = ''

// The staging dir is shared with every other test file running in parallel, so "no staging file left" means "no NEW
// one from this test", not "the dir holds none at all".
const partFiles = (): string[] => {
  try { return readdirSync(join(STORE_DIR, 'upload-tmp')).filter((n) => n.endsWith('.part')) } catch { return [] }
}

afterEach(() => {
  server?.close()
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function start(limit: number): Promise<number> {
  dir = mkdtempSync(join(tmpdir(), 'marveen-upstream-'))
  server = http.createServer(async (req, res) => {
    try {
      const s = await streamBodyToStage(req, limit)
      placeStaged(s, join(dir, 'out.bin'))
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ bytes: s.bytes }))
    } catch (e) {
      res.writeHead(e instanceof RequestBodyTooLargeError ? 413 : 500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: e instanceof RequestBodyTooLargeError ? 'upload_too_large' : String(e) }))
    }
  })
  server.requestTimeout = 0
  return new Promise((resolve) => server!.listen(0, () => resolve((server!.address() as { port: number }).port)))
}

function post(port: number, size: number, declare: boolean): Promise<{ status: number | string; body: string }> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = declare ? { 'content-length': String(size) } : {}
    const r = http.request({ port, method: 'POST', path: '/', headers }, (rs) => {
      let b = ''
      rs.on('data', (d) => { b += d })
      rs.on('end', () => resolve({ status: rs.statusCode ?? 0, body: b }))
    })
    r.on('error', (e: NodeJS.ErrnoException) => resolve({ status: 'client-error ' + e.code, body: e.message }))
    const chunk = Buffer.alloc(256 * 1024, 7)
    let sent = 0
    const pump = (): void => {
      while (sent < size) {
        const n = Math.min(chunk.length, size - sent)
        sent += n
        if (!r.write(n === chunk.length ? chunk : chunk.subarray(0, n))) { r.once('drain', pump); return }
      }
      r.end()
    }
    pump()
  })
}

describe('streamBodyToStage over a real connection', () => {
  it('a multi-MB body arrives byte-exact and leaves no staging file', async () => {
    const before = new Set(partFiles())
    const port = await start(0)
    const size = 6 * 1024 * 1024 + 5
    const r = await post(port, size, true)
    expect(r.status).toBe(201)
    expect(JSON.parse(r.body).bytes).toBe(size)
    expect(readFileSync(join(dir, 'out.bin')).length).toBe(size)
    expect(partFiles().filter((n) => !before.has(n))).toEqual([])
  })

  it('a body refused before its staging file is even open leaves no empty .part behind (open/unlink race)', async () => {
    const { EventEmitter } = await import('node:events')
    const before = partFiles()
    // A request whose first chunk is already over the limit, delivered synchronously: the write stream has not opened
    // its file yet when the refusal comes. Before the fix the unlink ran first and the late open left a 0-byte .part.
    const req = Object.assign(new EventEmitter(), { pause() {}, resume() {} })
    const p = streamBodyToStage(req as unknown as http.IncomingMessage, 10)
    req.emit('data', Buffer.alloc(64, 1))
    await expect(p).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    await new Promise((r) => setTimeout(r, 200))
    expect(partFiles().filter((n) => !before.includes(n))).toEqual([])
  })

  it('a body over the limit WITHOUT a Content-Length still gets the 413 answer, not a dropped connection', async () => {
    const before = new Set(partFiles())
    const port = await start(1024 * 1024)
    const r = await post(port, 8 * 1024 * 1024, false)
    expect(r.status).toBe(413)
    expect(JSON.parse(r.body).error).toBe('upload_too_large')
    expect(partFiles().filter((n) => !before.has(n))).toEqual([])
  })
})
