/**
 * #396 Phase 3 -- Settings -> Backup endpoints through the real route handler:
 * run -> job -> done, one run at a time, the download guard (only listed names,
 * no path from input), who may read the recovery key, config validation, and
 * that every error carries a human sentence.
 */
import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-bk-routes-'))
afterAll(() => rmSync(store, { recursive: true, force: true }))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const dbState = { users: 0 }
vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  const { hashPassword } = await import('../web/password-hash.js')
  const hash = await hashPassword('Helyes-Jelszo-123')
  return {
    ...actual,
    countDashboardUsers: () => dbState.users,
    getDashboardUser: (u: string) => (u === 'boss' ? { id: 1, username: 'boss', password_hash: hash, disabled: 0 } : undefined),
    getDb: () => { throw new Error('no db in this test') },
  }
})

const routes = await import('../web/routes/backup.js')
const { tryHandleBackup, _setBackupRunForTest, _resetBackupJobsForTest } = routes
const { getOrCreateKey } = await import('../backup/key-store.js')
const { backupFileName } = await import('../backup/create.js')

type Auth = { kind: 'session' | 'token' | 'federation' | 'device'; user?: string }

function call(path: string, method: string, body?: unknown, auth: Auth = { kind: 'token' }) {
  const chunks: Buffer[] = []
  const out: { status: number; headers: Record<string, string>; body: any; raw: Buffer } = { status: 200, headers: {}, body: null, raw: Buffer.alloc(0) }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const finished = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number, h?: Record<string, string>) => { out.status = s; Object.assign(out.headers, h || {}); return res }
  res.setHeader = (k: string, v: unknown) => { out.headers[k] = String(v); return res }
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req: any = Readable.from([Buffer.from(raw)])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost${path}`)
  const ctx: any = { req, res, path: url.pathname, method, url, auth }
  return (async () => {
    const handled = await tryHandleBackup(ctx)
    await finished
    out.raw = Buffer.concat(chunks)
    try { out.body = JSON.parse(out.raw.toString()) } catch { out.body = null }
    return { handled, ...out }
  })()
}

beforeEach(() => {
  _resetBackupJobsForTest()
  dbState.users = 0
})

describe('run -> job -> done', () => {
  it('reports the stages and the result when the job FINISHES', async () => {
    let finish!: () => void
    _setBackupRunForTest(async (o) => {
      o.onStage?.('collecting')
      await new Promise<void>((r) => { finish = r })
      o.onStage?.('encrypting')
      return { ok: true, name: 'x.mbk', size: 10, durationMs: 5, warnings: [], replicas: [{ dest: 'local', ok: true, reachable: true }] } as any
    })
    const start = await call('/api/backup/run', 'POST')
    expect(start.status).toBe(202)
    const id = start.body.jobId
    const mid = await call(`/api/backup/jobs/${id}`, 'GET')
    expect(mid.body).toMatchObject({ done: false, stage: 'collecting', result: null })
    const busy = await call('/api/backup/run', 'POST')
    expect(busy.status).toBe(409)
    expect(busy.body.message).toMatch(/fut|running/i)
    finish()
    await new Promise((r) => setTimeout(r, 10))
    const end = await call(`/api/backup/jobs/${id}`, 'GET')
    expect(end.body).toMatchObject({ done: true, result: { ok: true, name: 'x.mbk' } })
    _setBackupRunForTest(null)
  })

  it('a failed run carries a human message', async () => {
    _setBackupRunForTest(async () => ({ ok: false, error: 'io_error', detail: 'disk full', durationMs: 1, warnings: [] }) as any)
    const start = await call('/api/backup/run?lang=en', 'POST')
    await new Promise((r) => setTimeout(r, 10))
    const end = await call(`/api/backup/jobs/${start.body.jobId}?lang=en`, 'GET')
    expect(end.body.message).toBe('The backup failed: disk full')
    _setBackupRunForTest(null)
  })

  it('an unknown job is a 404 with a sentence, not an empty object', async () => {
    const r = await call('/api/backup/jobs/0123456789abcdef', 'GET')
    expect(r.status).toBe(404)
    expect(r.body.message.length).toBeGreaterThan(10)
  })
})

describe('download', () => {
  it('serves only names that are listed in store/backups', async () => {
    const dir = join(store, 'backups')
    mkdirSync(dir, { recursive: true })
    const name = backupFileName(new Date(2026, 0, 1, 1, 2, 3), 'host')
    writeFileSync(join(dir, name), 'ENCRYPTED')
    writeFileSync(join(store, 'secret.txt'), 'SECRET')
    const ok = await call(`/api/backup/download/${name}`, 'GET')
    expect(ok.status).toBe(200)
    expect(ok.raw.toString()).toBe('ENCRYPTED')
    expect(ok.headers['Content-Disposition']).toContain(name)
    for (const bad of ['..%2Fsecret.txt', '..%2F..%2Fetc%2Fpasswd', 'secret.txt', encodeURIComponent(backupFileName(new Date(2020, 0, 1), 'host'))]) {
      const r = await call(`/api/backup/download/${bad}`, 'GET')
      expect(r.status, bad).toBe(404)
      expect(r.raw.toString()).not.toContain('SECRET')
    }
  })
})

describe('the recovery key (kit)', () => {
  it('without a dashboard login the token caller may read it', async () => {
    const k = getOrCreateKey(store)
    const r = await call('/api/backup/kit', 'POST', {})
    expect(r.status).toBe(200)
    expect(r.body.current.key).toBe(k.key)
  })

  it('with a login: a token (agents hold it) is refused, a session needs the password', async () => {
    dbState.users = 1
    expect((await call('/api/backup/kit', 'POST', {})).status).toBe(403)
    expect((await call('/api/backup/kit', 'POST', {}, { kind: 'session', user: 'boss' })).status).toBe(401)
    const wrong = await call('/api/backup/kit', 'POST', { password: 'rossz' }, { kind: 'session', user: 'boss' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error).toBe('password_wrong')
    const right = await call('/api/backup/kit', 'POST', { password: 'Helyes-Jelszo-123' }, { kind: 'session', user: 'boss' })
    expect(right.status).toBe(200)
    expect(right.body.current.key).toMatch(/-/)
  })

  it('a federation peer or a device never gets it', async () => {
    expect((await call('/api/backup/kit', 'POST', {}, { kind: 'federation' })).status).toBe(403)
    expect((await call('/api/backup/kit', 'POST', {}, { kind: 'device' })).status).toBe(403)
  })

  it('confirm marks the kit saved; rotate with an own password checks its length', async () => {
    getOrCreateKey(store)
    const c = await call('/api/backup/kit/confirm', 'POST')
    expect(c.body.ok).toBe(true)
    const short = await call('/api/backup/key/rotate', 'POST', { ownPassword: 'rovid' })
    expect(short.status).toBe(400)
    const ok = await call('/api/backup/key/rotate', 'POST', { ownPassword: 'ez egy eleg hosszu jelszo' })
    expect(ok.body).toMatchObject({ ok: true, custom: true })
    const kf = JSON.parse(readFileSync(join(store, '.backup-key'), 'utf8'))
    expect(kf.current.confirmedAt).toBeNull()
    expect(kf.previous.length).toBeGreaterThan(0)
  })
})

describe('config + status', () => {
  it('validates and saves', async () => {
    expect((await call('/api/backup/config', 'PUT', { schedule: { time: '25:00' } })).status).toBe(400)
    expect((await call('/api/backup/config', 'PUT', { cloud: { kind: 'dropbox', account: 'x' } })).status).toBe(400)
    expect((await call('/api/backup/config', 'PUT', { cloud: { kind: 'gdrive', account: '' } })).status).toBe(400)
    const ok = await call('/api/backup/config', 'PUT', { schedule: { time: '04:15' }, cloud: { kind: 'gdrive', account: 'a@b.c', folderName: 'Mentesek' }, depot: { enabled: false } })
    expect(ok.body.config).toMatchObject({ schedule: { time: '04:15' }, cloud: { kind: 'gdrive', account: 'a@b.c', folderName: 'Mentesek' }, depot: { enabled: false } })
  })

  it('status names the health, the login mode and the destinations', async () => {
    const r = await call('/api/backup/status', 'GET')
    expect(r.status).toBe(200)
    expect(r.body.health.id).toMatch(/^backup_/)
    expect(r.body.loginOn).toBe(false)
    expect(r.body.destinations.map((d: any) => d.id)).toEqual(['local', 'depot', 'cloud'])
  })

  it('does not answer other paths', async () => {
    expect((await tryHandleBackup({ path: '/api/backup-rules', method: 'GET' } as any))).toBe(false)
  })
})
