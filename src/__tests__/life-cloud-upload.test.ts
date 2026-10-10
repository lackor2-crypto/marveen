// FROM THE LIFE TREE UP TO DRIVE / MEGA (#525): nothing is overwritten, a
// target that could not be looked into stops the plan, a picked folder goes up
// as a folder, and a refusal that would repeat stops the run.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'

const store = mkdtempSync(join(tmpdir(), 'cloud-up-store-'))
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, PROJECT_ROOT: store, STORE_DIR: join(store, 'store') }
})

const { planCloudUpload, runCloudUpload, driveBackend, driveQuote, isCloudKind } = await import('../life-cloud-upload.js')
type CloudBackend = import('../life-cloud-upload.js').CloudBackend

let depot = ''
const put = (rel: string, content: string): void => {
  const abs = join(depot, ...rel.split('/'))
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

/** A cloud folder tree kept in memory: 'a/b' -> names in it. */
function fakeCloud(initial: Record<string, string[]> = {}) {
  const dirs = new Map<string, Set<string>>(Object.entries({ '': [], ...initial }).map(([k, v]) => [k, new Set(v)]))
  const log: string[] = []
  let failList: string | null = null
  let failPut: { message: string; stop?: boolean } | null = null
  const backend: CloudBackend = {
    async list(dir) {
      log.push('list ' + dir.join('/'))
      if (failList) return { ok: false, message: failList }
      const s = dirs.get(dir.join('/'))
      return { ok: true, names: s ? new Set(s) : null }
    },
    async ensureDir(dir) {
      for (let i = 1; i <= dir.length; i++) {
        const key = dir.slice(0, i).join('/')
        if (!dirs.has(key)) { dirs.set(key, new Set()); dirs.get(dir.slice(0, i - 1).join('/'))!.add(dir[i - 1]!); log.push('mkdir ' + key) }
      }
      return { ok: true }
    },
    async put(dir, name) {
      if (failPut) return { ok: false, ...failPut }
      log.push('put ' + [...dir, name].join('/'))
      dirs.get(dir.join('/'))!.add(name)
      return { ok: true }
    },
  }
  return { backend, dirs, log, failList: (m: string | null) => { failList = m }, failPut: (f: typeof failPut) => { failPut = f } }
}

beforeEach(() => {
  if (depot) rmSync(depot, { recursive: true, force: true })
  depot = mkdtempSync(join(tmpdir(), 'cloud-up-depot-'))
  process.env['MARVEEN_DEPOT'] = depot
})
afterAll(() => {
  rmSync(store, { recursive: true, force: true })
  if (depot) rmSync(depot, { recursive: true, force: true })
  delete process.env['MARVEEN_DEPOT']
})

describe('the plan', () => {
  it('a picked file goes straight into the target; a picked folder goes up as a folder with what is below it', async () => {
    put('Iratok/nyugdij.pdf', 'aaaa')
    put('Iratok/Jobcenter/level.pdf', 'bb')
    put('Iratok/Jobcenter/2026/hatarozat.pdf', 'c')
    put('kulon.txt', 'dd')
    const c = fakeCloud()
    const plan = await planCloudUpload(['Iratok', 'kulon.txt'], c.backend)
    expect(plan.blocked).toBeNull()
    expect(plan.upload.map((f) => [...f.dir, f.name].join('/')).sort()).toEqual([
      'Iratok/Jobcenter/2026/hatarozat.pdf', 'Iratok/Jobcenter/level.pdf', 'Iratok/nyugdij.pdf', 'kulon.txt',
    ])
    expect(plan.uploadBytes).toBe(4 + 2 + 1 + 2)
    // Planning creates nothing in the cloud.
    expect(c.log.some((l) => l.startsWith('mkdir') || l.startsWith('put'))).toBe(false)
    // A folder that is not there is asked about once; its subfolders are not.
    expect(c.log).toEqual(['list ', 'list Iratok'])
  })

  it('a name that is already in the target folder is left alone and counted', async () => {
    put('a.pdf', '1'); put('b.pdf', '22')
    const c = fakeCloud({ '': ['a.pdf'] })
    const plan = await planCloudUpload(['a.pdf', 'b.pdf'], c.backend)
    expect(plan.exists).toBe(1)
    expect(plan.upload.map((f) => f.name)).toEqual(['b.pdf'])
  })

  it('two picked files with the same name: only the first goes, the other is counted', async () => {
    put('egy/igazolas.pdf', '1'); put('ketto/igazolas.pdf', '2')
    const plan = await planCloudUpload(['egy/igazolas.pdf', 'ketto/igazolas.pdf'], fakeCloud().backend)
    expect(plan.upload.length).toBe(1)
    expect(plan.clash).toBe(1)
  })

  it('a target that could not be looked into blocks the plan -- it is not read as empty', async () => {
    put('a.pdf', '1')
    const c = fakeCloud()
    c.failList('Google 403: insufficient permission')
    const plan = await planCloudUpload(['a.pdf'], c.backend)
    expect(plan.blocked).toBe('Google 403: insufficient permission')
    expect(plan.upload).toEqual([])
  })

  it('a path outside the tree or a missing file is reported, nothing is concluded about it', async () => {
    put('a.pdf', '1')
    const plan = await planCloudUpload(['../../etc/passwd', 'nincs.pdf', 'a.pdf'], fakeCloud().backend)
    expect(plan.unreadable.length).toBe(2)
    expect(plan.upload.map((f) => f.name)).toEqual(['a.pdf'])
  })

  it('hidden files and a git repository are not sent', async () => {
    put('M/.rejtett', 'x'); put('M/desktop.ini', 'x'); put('M/jo.txt', 'x')
    put('Repo/.git/config', 'x'); put('Repo/kod.ts', 'x')
    const plan = await planCloudUpload(['M', 'Repo'], fakeCloud().backend)
    expect(plan.upload.map((f) => f.rel)).toEqual(['M/jo.txt'])
    expect(plan.unreadable).toEqual(['Repo'])
  })
})

describe('the run', () => {
  it('makes the folders, sends the files, and reports the counts', async () => {
    put('Iratok/nyugdij.pdf', 'aaaa'); put('Iratok/Al/b.pdf', 'b')
    const c = fakeCloud()
    const plan = await planCloudUpload(['Iratok'], c.backend)
    const seen: string[] = []
    const r = await runCloudUpload(plan, c.backend, { onProgress: (d, t, cur) => seen.push(`${d}/${t} ${cur}`) })
    expect(r).toEqual({ uploaded: 2, skipped: 0, failed: [], stopped: null, remaining: 0 })
    expect(Array.from(c.dirs.get('Iratok')!).sort()).toEqual(['Al', 'nyugdij.pdf'])
    expect(Array.from(c.dirs.get('Iratok/Al')!)).toEqual(['b.pdf'])
    expect(seen[seen.length - 1]).toBe('2/2 ')
  })

  it('a file that turned up in the target after the plan is not overwritten', async () => {
    put('a.pdf', '1')
    const c = fakeCloud()
    const plan = await planCloudUpload(['a.pdf'], c.backend)
    c.dirs.get('')!.add('a.pdf')
    const r = await runCloudUpload(plan, c.backend)
    expect(r.uploaded).toBe(0)
    expect(r.skipped).toBe(1)
    expect(c.log.some((l) => l.startsWith('put'))).toBe(false)
  })

  it('a refusal that would repeat stops the run in the service\'s words; the rest is counted as remaining', async () => {
    put('a.pdf', '1'); put('b.pdf', '2'); put('c.pdf', '3')
    const c = fakeCloud()
    const plan = await planCloudUpload(['a.pdf', 'b.pdf', 'c.pdf'], c.backend)
    c.failPut({ message: 'Google 403: storage quota exceeded', stop: true })
    const r = await runCloudUpload(plan, c.backend)
    expect(r.stopped).toBe('Google 403: storage quota exceeded')
    expect(r.uploaded).toBe(0)
    expect(r.remaining).toBe(3)
  })

  it('one file\'s own trouble does not stop the others', async () => {
    put('a.pdf', '1'); put('b.pdf', '2')
    const c = fakeCloud()
    const plan = await planCloudUpload(['a.pdf', 'b.pdf'], c.backend)
    let n = 0
    const inner = c.backend.put
    c.backend.put = async (dir, name, abs, bytes) => (++n === 1 ? { ok: false, message: 'read error' } : inner(dir, name, abs, bytes))
    const r = await runCloudUpload(plan, c.backend)
    expect(r.failed).toEqual([{ rel: 'a.pdf', detail: 'read error' }])
    expect(r.uploaded).toBe(1)
    expect(r.remaining).toBe(0)
  })

  it('stops when asked', async () => {
    put('a.pdf', '1'); put('b.pdf', '2')
    const c = fakeCloud()
    const plan = await planCloudUpload(['a.pdf', 'b.pdf'], c.backend)
    let asked = false
    const r = await runCloudUpload(plan, c.backend, { onProgress: (d) => { if (d === 0) asked = true }, shouldStop: () => asked })
    expect(r.uploaded).toBe(1)
    expect(r.remaining).toBe(1)
  })
})

describe('Google Drive', () => {
  interface Call { method: string; url: string; body: string; headers: Record<string, string> }
  async function drain(body: unknown): Promise<string> {
    if (body === undefined || body === null) return ''
    if (typeof body === 'string') return body
    const chunks: Buffer[] = []
    for await (const ch of body as Readable) chunks.push(Buffer.from(ch))
    return Buffer.concat(chunks).toString('utf8')
  }
  /** Folders by id -> children; answers the three kinds of call the backend makes. */
  function fakeDrive() {
    const calls: Call[] = []
    const folders = new Map<string, Array<{ id: string; name: string; folder: boolean }>>([['root', []]])
    let n = 0
    let refuse: { status: number; text: string } | null = null
    const res = (status: number, text: string, location: string | null = null) => ({ ok: status < 300, status, text: async () => text, header: (h: string) => (h.toLowerCase() === 'location' ? location : null) })
    const http = async (url: string, init: any) => {
      const body = await drain(init.body)
      calls.push({ method: init.method, url, body, headers: init.headers })
      if (refuse) return res(refuse.status, refuse.text)
      const u = new URL(url)
      if (init.method === 'GET') {
        const q = u.searchParams.get('q') || ''
        const parent = /^'([^']+)' in parents/.exec(q)![1]!
        const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, '$1')
        const kids = folders.get(parent) || []
        if (name !== undefined) return res(200, JSON.stringify({ files: kids.filter((k) => k.folder && k.name === name).map((k) => ({ id: k.id })) }))
        return res(200, JSON.stringify({ files: kids.map((k) => ({ name: k.name })) }))
      }
      if (init.method === 'POST' && u.pathname === '/drive/v3/files') {
        const m = JSON.parse(body)
        const id = 'f' + (++n)
        folders.get(m.parents[0])!.push({ id, name: m.name, folder: true })
        folders.set(id, [])
        return res(200, JSON.stringify({ id }))
      }
      if (init.method === 'POST') {
        const m = JSON.parse(body)
        return res(200, '', `https://www.googleapis.com/upload/drive/v3/files?upload_id=${encodeURIComponent(m.parents[0] + '|' + m.name)}`)
      }
      const [parent, name] = decodeURIComponent(u.searchParams.get('upload_id')!).split('|') as [string, string]
      folders.get(parent)!.push({ id: 'd' + (++n), name, folder: false })
      return res(200, JSON.stringify({ id: 'x' }))
    }
    return { http, calls, folders, refuse: (r: typeof refuse) => { refuse = r } }
  }

  it('a quote in a name cannot break out of the query', () => {
    expect(driveQuote("O'Brien\\x")).toBe("O\\'Brien\\\\x")
  })

  it('creates the folder once, streams the file bytes, and never sends the token to the upload address', async () => {
    put('Iratok/nyugdij.pdf', 'PDF-BYTES'); put('Iratok/masik.pdf', 'M')
    const d = fakeDrive()
    const b = driveBackend('TOKEN', 'root', d.http)
    const plan = await planCloudUpload(['Iratok'], b)
    expect(plan.upload.length).toBe(2)
    const r = await runCloudUpload(plan, b)
    expect(r).toEqual({ uploaded: 2, skipped: 0, failed: [], stopped: null, remaining: 0 })
    const made = d.calls.filter((c) => c.method === 'POST' && new URL(c.url).pathname === '/drive/v3/files')
    expect(made.length).toBe(1)
    const sent = d.calls.filter((c) => c.method === 'PUT')
    expect(sent.map((c) => c.body).sort()).toEqual(['M', 'PDF-BYTES'])
    expect(sent.every((c) => !('Authorization' in c.headers))).toBe(true)
    expect(sent.find((c) => c.body === 'PDF-BYTES')!.headers['Content-Length']).toBe('9')
    const id = d.folders.get('root')![0]!.id
    expect(d.folders.get(id)!.map((k) => k.name).sort()).toEqual(['masik.pdf', 'nyugdij.pdf'])
  })

  it('a second upload of the same things sends nothing: the names are already there', async () => {
    put('Iratok/nyugdij.pdf', 'X')
    const d = fakeDrive()
    const b = driveBackend('TOKEN', 'root', d.http)
    await runCloudUpload(await planCloudUpload(['Iratok'], b), b)
    const again = await planCloudUpload(['Iratok'], driveBackend('TOKEN', 'root', d.http))
    expect(again.upload).toEqual([])
    expect(again.exists).toBe(1)
  })

  it('a 403 from Google blocks the plan with Google\'s own sentence', async () => {
    put('a.pdf', '1')
    const d = fakeDrive()
    d.refuse({ status: 403, text: JSON.stringify({ error: { message: 'Insufficient Permission' } }) })
    const plan = await planCloudUpload(['a.pdf'], driveBackend('TOKEN', 'root', d.http))
    expect(plan.blocked).toBe('Google 403: Insufficient Permission')
  })

  it('an empty file goes up without a body', async () => {
    put('ures.txt', '')
    const d = fakeDrive()
    const b = driveBackend('TOKEN', 'root', d.http)
    const r = await runCloudUpload(await planCloudUpload(['ures.txt'], b), b)
    expect(r.uploaded).toBe(1)
    expect(d.calls.find((c) => c.method === 'PUT')!.headers['Content-Length']).toBe('0')
  })
})

describe('kinds', () => {
  it('only drive and mega', () => {
    expect(isCloudKind('drive')).toBe(true)
    expect(isCloudKind('mega')).toBe(true)
    expect(isCloudKind('photos')).toBe(false)
  })
})
