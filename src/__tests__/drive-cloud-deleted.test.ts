// DELETED IN THE CLOUD DOES NOT VANISH FROM THE PAGE (#511).
//
// The Drive page asked Drive for `trashed = false` only, so what was deleted
// up there disappeared here without a word. On request (`withDeleted=1`) the
// list now also carries the folder's items that sit in the Drive trash, in
// their OWN list; "could not look into the trash" is its own answer, never an
// empty list; and `/api/drive/untrash` brings one back.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFile: (_c: string, _a: string[], _o: unknown, cb: (e: null, out: string, err: string) => void) => cb(null, 'tok\n', '') }
})

const { tryHandleDriveBrowser, driveListQuery } = await import('../web/routes/drive-browser.js')

interface Call { url: string; method: string; body: string }
let calls: Call[] = []
let trashFails = false

function fakeDrive() {
  vi.stubGlobal('fetch', vi.fn(async (u: unknown, init: RequestInit = {}) => {
    const url = decodeURIComponent(String(u))
    calls.push({ url, method: String(init.method || 'GET'), body: String(init.body || '') })
    if (init.method === 'PATCH') return new Response('{}', { status: 200 })
    if (url.includes('trashed = true')) {
      if (trashFails) return new Response('boom', { status: 500 })
      return new Response(JSON.stringify({ files: [{ id: 'd1', name: 'torolt.pdf', mimeType: 'application/pdf', size: '10', trashedTime: '2026-10-08T10:00:00Z' }] }), { status: 200 })
    }
    return new Response(JSON.stringify({ files: [{ id: 'f1', name: 'elo.pdf', mimeType: 'application/pdf', size: '20' }] }), { status: 200 })
  }))
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const url = new URL('http://localhost' + path)
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req: any = {
    method, url: path, headers: {},
    on(ev: string, fn: (c?: Buffer) => void) { if (ev === 'data') chunks.forEach((c) => fn(c)); if (ev === 'end') fn(); return req },
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c },
  }
  let status = 200
  let out = ''
  const res: any = {
    writeHead(s: number) { status = s; return res }, setHeader() {}, statusCode: 200,
    end(s?: string) { out = String(s || '') },
  }
  const handled = await tryHandleDriveBrowser({ req, res, path: url.pathname, method, url } as any)
  expect(handled).toBe(true)
  return { status: status || res.statusCode, data: out ? JSON.parse(out) : null }
}

beforeEach(() => { calls = []; trashFails = false; fakeDrive() })
afterAll(() => vi.unstubAllGlobals())

describe('Drive list: deleted in the cloud', () => {
  it('the query can ask for the trash, and still refuses an unsafe folder id', () => {
    expect(driveListQuery('abc', false)).toBe("'abc' in parents and trashed = false")
    expect(driveListQuery('abc', false, true)).toBe("'abc' in parents and trashed = true")
    expect(() => driveListQuery("a' or '1", false, true)).toThrow()
  })

  it('without withDeleted the answer is what it always was (one Drive call)', async () => {
    const r = await call('GET', '/api/drive/list?folderId=root&account=a')
    expect(r.data).toEqual({ files: [expect.objectContaining({ id: 'f1', name: 'elo.pdf' })] })
    expect(calls.length).toBe(1)
  })

  it('withDeleted=1 adds the trashed items in their own list', async () => {
    const r = await call('GET', '/api/drive/list?folderId=root&account=a&withDeleted=1')
    expect(r.status).toBe(200)
    expect(r.data.files.map((f: any) => f.id)).toEqual(['f1'])
    expect(r.data.deleted).toEqual([{ id: 'd1', name: 'torolt.pdf', isFolder: false, mimeType: 'application/pdf', size: 10, trashedTime: '2026-10-08T10:00:00Z' }])
    expect(r.data.deletedError).toBeUndefined()
  })

  it('a trash that cannot be read is said so -- the live list still arrives', async () => {
    trashFails = true
    const r = await call('GET', '/api/drive/list?folderId=root&account=a&withDeleted=1')
    expect(r.status).toBe(200)
    expect(r.data.files.map((f: any) => f.id)).toEqual(['f1'])
    expect(r.data.deleted).toEqual([])
    expect(String(r.data.deletedError)).toContain('500')
  })

  it('untrash sends trashed:false for that file, and refuses a bad id', async () => {
    const ok = await call('POST', '/api/drive/untrash', { fileId: 'd1', account: 'a' })
    expect(ok.data).toEqual({ ok: true })
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.url.endsWith('/files/d1')).toBe(true)
    expect(JSON.parse(patch.body)).toEqual({ trashed: false })
    calls = []
    const bad = await call('POST', '/api/drive/untrash', { fileId: '../x', account: 'a' })
    expect(bad.status).toBe(400)
    expect(calls.length).toBe(0)
  })
})
