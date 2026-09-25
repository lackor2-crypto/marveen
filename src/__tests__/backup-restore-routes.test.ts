/**
 * #396 Phase 5 -- the restore endpoints through the real route handler: upload
 * (a non-backup is refused), open (preview from the list, the stored key or a
 * typed one, a clear "key needed"), start (never without a restartable
 * service), release, and the fresh-install question (asked only when there is
 * no login, no card, no memory, and only once).
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { Readable, Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-bk-rroutes-'))
afterAll(() => rmSync(store, { recursive: true, force: true }))

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const mem = new Database(':memory:')
mem.exec("CREATE TABLE kanban_cards (id TEXT); CREATE TABLE memories (id INTEGER); CREATE TABLE scheduled_tasks (id TEXT PRIMARY KEY, status TEXT)")
const dbState = { users: 0 }
vi.mock('../db.js', async () => {
  const actual = await vi.importActual<typeof import('../db.js')>('../db.js')
  return { ...actual, countDashboardUsers: () => dbState.users, getDb: () => mem }
})
vi.mock('../self-restart.js', async () => ({
  restartAvailability: () => ({ possible: false, unit: null, reason: 'not a service here' }),
}))

const { tryHandleBackupRestore, shouldAskForBackup } = await import('../web/routes/backup-restore.js')
const { createBackup } = await import('../backup/create.js')
const { getOrCreateKey } = await import('../backup/key-store.js')
const { populatedInstall } = await import('./backup-fixture.js')

const A = populatedInstall('rroutes-a')
afterAll(() => rmSync(A.root, { recursive: true, force: true }))
const key = getOrCreateKey(store).key
const made = await createBackup({ kind: 'manual', ctx: A.ctx, recoveryKey: key, encrypt: { kdfN: 1024 }, appVersion: '1.0.0', appCommit: 't' })
mkdirSync(join(store, 'backups'), { recursive: true })
copyFileSync(made.file!, join(store, 'backups', made.name!))

function call(path: string, method: string, body?: unknown, raw?: Buffer) {
  const chunks: Buffer[] = []
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = new Writable({ write(c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } })
  const finished = new Promise<void>((r) => res.on('finish', () => r()))
  res.writeHead = (s: number) => { out.status = s; return res }
  res.setHeader = () => res
  const req: any = Readable.from([raw ?? Buffer.from(body === undefined ? '' : JSON.stringify(body))])
  req.headers = {}
  const url = new URL(`http://localhost${path}`)
  return (async () => {
    const handled = await tryHandleBackupRestore({ req, res, path: url.pathname, method, url, auth: { kind: 'token' } } as any)
    if (handled) await finished
    try { out.body = JSON.parse(Buffer.concat(chunks).toString()) } catch { out.body = null }
    return { handled, ...out }
  })()
}

beforeEach(() => { dbState.users = 0; rmSync(join(store, 'onboarding-choice.json'), { force: true }) })

describe('upload + open', () => {
  it('refuses a file that is not a backup', async () => {
    const r = await call('/api/backup/restore/upload', 'POST', undefined, Buffer.from('PK\u0003\u0004 not ours'))
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('not_a_backup')
  })

  it('opens an uploaded backup with the typed key, and shows the preview', async () => {
    const up = await call('/api/backup/restore/upload', 'POST', undefined, readFileSync(made.file!))
    expect(up.status).toBe(200)
    const r = await call('/api/backup/restore/open?lang=en', 'POST', { source: 'upload', uploadId: up.body.uploadId, key })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body).toMatchObject({ appVersion: '1.0.0', compat: { ok: true }, agents: ['alpha', 'beta'] })
    expect(r.body.dbCounts.backup.kanban_cards).toBe(5)
    expect(r.body.categories.map((c: any) => c.id)).toContain('database')
    await call('/api/backup/restore/cancel', 'POST', { previewId: r.body.previewId })
  })

  it('from the local list the stored key is used', async () => {
    const r = await call('/api/backup/restore/open', 'POST', { source: 'local', name: made.name })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    await call('/api/backup/restore/cancel', 'POST', { previewId: r.body.previewId })
  })

  it('a wrong typed key is a human sentence, not a crash', async () => {
    const r = await call('/api/backup/restore/open?lang=en', 'POST', { source: 'local', name: made.name, key: 'ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE' })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('wrong_key')
    expect(r.body.message).toMatch(/emergency kit/)
  })

  it('without a stored key it asks for one, names the key id, and keeps the upload', async () => {
    const kf = join(store, '.backup-key')
    const saved = readFileSync(kf)
    rmSync(kf)
    try {
      const up = await call('/api/backup/restore/upload', 'POST', undefined, readFileSync(made.file!))
      const r = await call('/api/backup/restore/open', 'POST', { source: 'upload', uploadId: up.body.uploadId })
      expect(r.body.error).toBe('key_needed')
      expect(r.body.keyId).toMatch(/^[0-9a-f]{8}$/)
      const again = await call('/api/backup/restore/open', 'POST', { source: 'upload', uploadId: r.body.uploadId, key })
      expect(again.status).toBe(200)
      await call('/api/backup/restore/cancel', 'POST', { previewId: again.body.previewId })
    } finally { writeFileSync(kf, saved) }
  })

  it('an unknown name is not found', async () => {
    expect((await call('/api/backup/restore/open', 'POST', { source: 'local', name: '../../etc/passwd' })).status).toBe(404)
  })
})

describe('start / status / release', () => {
  it('refuses when the install cannot restart itself, with the reason', async () => {
    const p = await call('/api/backup/restore/open', 'POST', { source: 'local', name: made.name })
    const r = await call('/api/backup/restore/start?lang=en', 'POST', { previewId: p.body.previewId, exclude: [] })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('cannot_restart')
    expect(r.body.message).toContain('not a service here')
    await call('/api/backup/restore/cancel', 'POST', { previewId: p.body.previewId })
  })

  it('status reads the files; release resumes exactly the paused tasks', async () => {
    const s = await call('/api/backup/restore/status', 'GET')
    expect(s.body).toEqual({ running: false, result: null, channelsHeld: false })
    mem.prepare("INSERT INTO scheduled_tasks VALUES ('t1','paused'), ('t2','paused')").run()
    writeFileSync(join(store, 'schedules-paused-after-restore.json'), JSON.stringify({ planId: 'x', ids: ['t1'] }))
    expect((await call('/api/backup/restore/status', 'GET')).body.channelsHeld).toBe(true)
    const r = await call('/api/backup/restore/release', 'POST')
    expect(r.body).toMatchObject({ ok: true, resumed: 1 })
    expect((mem.prepare("SELECT status FROM scheduled_tasks WHERE id='t2'").get() as any).status).toBe('paused')
    expect(existsSync(join(store, 'schedules-paused-after-restore.json'))).toBe(false)
  })
})

describe('the fresh-install question', () => {
  it('is asked on an empty install, once', async () => {
    expect(shouldAskForBackup()).toBe(true)
    expect((await call('/api/backup/onboarding', 'GET')).body).toEqual({ ask: true })
    expect((await call('/api/backup/onboarding', 'POST', { choice: 'fresh' })).body).toEqual({ ok: true })
    expect((await call('/api/backup/onboarding', 'GET')).body).toEqual({ ask: false })
  })

  it('is not asked when a dashboard login exists', () => {
    dbState.users = 1
    expect(shouldAskForBackup()).toBe(false)
  })

  it('is not asked when there are cards', () => {
    mem.prepare("INSERT INTO kanban_cards VALUES ('c')").run()
    try { expect(shouldAskForBackup()).toBe(false) } finally { mem.prepare('DELETE FROM kanban_cards').run() }
  })

  it('is not asked when there are memories', () => {
    mem.prepare('INSERT INTO memories VALUES (1)').run()
    try { expect(shouldAskForBackup()).toBe(false) } finally { mem.prepare('DELETE FROM memories').run() }
  })

  it('rejects an unknown choice', async () => {
    expect((await call('/api/backup/onboarding', 'POST', { choice: 'maybe' })).status).toBe(400)
  })
})
