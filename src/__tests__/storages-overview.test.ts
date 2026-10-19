// Card #714: the per-account overview (/api/storages/overview) and its size
// measurement (/api/storages/overview/measure). The handler really runs here, with
// its own RouteContext; nothing is matched against the source text.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'

const store = mkdtempSync(join(tmpdir(), 'marveen-ovw-store-'))
const depot = mkdtempSync(join(tmpdir(), 'marveen-ovw-depot-'))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store, DEPOT_ROOT_CONFIGURED: depot }
})

const { setBackupRulesFileForTests } = await import('../backup-rules.js')
const RULES = join(store, 'backup-rules.json')
setBackupRulesFileForTests(RULES)

function writeRules(rules: unknown[]): void {
  writeFileSync(RULES, JSON.stringify({ version: 1, rules }), 'utf8')
}

async function call(path: string, query = '') {
  const { tryHandleStorages } = await import('../web/routes/storages.js')
  let body = ''
  let status = 0
  const res = {
    statusCode: 0,
    setHeader() { /* not relevant */ },
    writeHead(code: number) { status = code; return res },
    end(chunk?: any) { if (chunk) body += String(chunk) },
    write(chunk: any) { body += String(chunk); return true },
  } as unknown as http.ServerResponse
  const handled = await tryHandleStorages({
    req: { method: 'GET', headers: {} } as unknown as http.IncomingMessage,
    res,
    path,
    method: 'GET',
    url: new URL('http://x' + path + query),
  })
  return { handled, status: status || (res as any).statusCode, json: body ? JSON.parse(body) : null }
}

function put(rel: string, bytes: number): void {
  const abs = join(depot, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, Buffer.alloc(bytes, 'a'))
}

beforeEach(() => {
  rmSync(RULES, { force: true })
  rmSync(depot, { recursive: true, force: true })
  mkdirSync(depot, { recursive: true })
})

afterAll(() => {
  setBackupRulesFileForTests(null)
  rmSync(store, { recursive: true, force: true })
  rmSync(depot, { recursive: true, force: true })
})

describe('/api/storages/overview', () => {
  it('a fresh install (no rules file) answers with an empty list, no error', async () => {
    const r = await call('/api/storages/overview')
    expect(r.handled).toBe(true)
    expect(r.json.accounts).toEqual([])
    expect(r.json.error).toBeUndefined()
  })

  it('groups the marked folders per account; a "do not back up" rule creates no account', async () => {
    writeRules([
      { path: 'Cegek/B', target: { kind: 'drive', account: 'lackor2' }, setAt: 't' },
      { path: 'Cegek/A', target: { kind: 'drive', account: 'lackor2' }, setAt: 't', exclude: ['x/y'] },
      { path: 'Foto', target: { kind: 'mega', account: 'm1' }, setAt: 't' },
      { path: 'Nem', target: null, setAt: 't' },
    ])
    const r = await call('/api/storages/overview')
    const keys = r.json.accounts.map((a: any) => a.kind + ':' + a.account)
    expect(keys.sort()).toEqual(['drive:lackor2', 'mega:m1'])
    const drive = r.json.accounts.find((a: any) => a.kind === 'drive')
    expect(drive.entries.map((e: any) => e.path)).toEqual(['Cegek/A', 'Cegek/B'])
    expect(drive.entries[0].exclude).toEqual(['x/y'])
  })

  it('an unreadable rules file is reported, never shown as "nothing is marked"', async () => {
    writeFileSync(RULES, '{ not json', 'utf8')
    const r = await call('/api/storages/overview')
    expect(r.json.accounts).toEqual([])
    expect(r.json.code).toBe('rules_unreadable')
    expect(String(r.json.error)).not.toBe('')
  })
})

describe('/api/storages/overview/measure', () => {
  const q = '?kind=drive&account=lackor2'

  it('counts files and bytes of a marked folder', async () => {
    put('Cegek/A/f1.txt', 100)
    put('Cegek/A/sub/f2.txt', 50)
    writeRules([{ path: 'Cegek/A', target: { kind: 'drive', account: 'lackor2' }, setAt: 't' }])
    const r = await call('/api/storages/overview/measure', q)
    expect(r.json.entries).toHaveLength(1)
    expect(r.json.entries[0]).toMatchObject({ path: 'Cegek/A', ok: true, files: 2, bytes: 150 })
  })

  it('leaves out the rule\'s own exclusions and a sub-folder marked for another account', async () => {
    put('Cegek/A/keep.txt', 10)
    put('Cegek/A/skip/s.txt', 1000)
    put('Cegek/A/other/o.txt', 2000)
    writeRules([
      { path: 'Cegek/A', target: { kind: 'drive', account: 'lackor2' }, setAt: 't', exclude: ['skip'] },
      { path: 'Cegek/A/other', target: { kind: 'drive', account: 'masik' }, setAt: 't' },
    ])
    const r = await call('/api/storages/overview/measure', q)
    expect(r.json.entries).toHaveLength(1)
    expect(r.json.entries[0]).toMatchObject({ path: 'Cegek/A', ok: true, files: 1, bytes: 10 })
  })

  it('says a marked folder is missing instead of reporting "0 files"', async () => {
    writeRules([{ path: 'Cegek/Torolt', target: { kind: 'drive', account: 'lackor2' }, setAt: 't' }])
    const r = await call('/api/storages/overview/measure', q)
    expect(r.json.entries[0]).toMatchObject({ path: 'Cegek/Torolt', ok: false, missing: true })
    expect(r.json.entries[0].files).toBeUndefined()
  })

  it('only measures the asked account\'s folders', async () => {
    put('Foto/p.jpg', 7)
    writeRules([{ path: 'Foto', target: { kind: 'mega', account: 'm1' }, setAt: 't' }])
    const r = await call('/api/storages/overview/measure', q)
    expect(r.json.entries).toEqual([])
  })
})
