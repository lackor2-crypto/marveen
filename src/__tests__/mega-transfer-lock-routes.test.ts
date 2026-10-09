// Card #465: one MEGA account has ONE per-IP transfer budget, so an upload must
// not start while a download runs (and the other way round). The pure helper
// `megaTransferBusyCode` is unit-tested in mega-download.test.ts, but the bug was
// in the WIRING -- the upload run endpoint never asked about the download job --
// and a helper test stays green even when a route does not call the helper.
// So this drives the REAL backup-rules route handler: a download really starts
// (rclone is faked), and the upload run endpoint is asked while it runs.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => {
  let finish: (() => void) | null = null
  return {
    depot: '' as string,
    /** The fake download stays "running" until the test calls finishDownload(). */
    startDownload: () => new Promise<void>((resolve) => { finish = resolve }),
    finishDownload: () => { finish?.() },
  }
})
h.depot = mkdtempSync(join(tmpdir(), 'marveen-mega-lock-'))
afterAll(() => rmSync(h.depot, { recursive: true, force: true }))

vi.mock('../mega.js', async () => {
  const actual = await vi.importActual<typeof import('../mega.js')>('../mega.js')
  return {
    ...actual,
    readMegaAccounts: () => [{ name: 'teszt', email: 'teszt@example.com', remote: 'mega_teszt', addedAt: 0 }],
    rcloneBin: () => '/fake/rclone',
  }
})
vi.mock('../depot.js', async () => {
  const actual = await vi.importActual<typeof import('../depot.js')>('../depot.js')
  return { ...actual, depotRoot: () => h.depot, depotAccountDir: (account: string) => join(h.depot, account) }
})
vi.mock('../mega-download.js', async () => {
  const actual = await vi.importActual<typeof import('../mega-download.js')>('../mega-download.js')
  return {
    ...actual,
    listMegaRemoteSized: async () => ({ ok: true, files: [{ rel: 'a.txt', size: 1 }] }),
    freeDiskBytes: () => null,
    runMegaDownload: async () => { await h.startDownload(); return { downloaded: 1, failed: [], error: null } },
  }
})

const { tryHandleBackupRules } = await import('../web/routes/backup-rules.js')
type RouteContext = import('../web/routes/types.js').RouteContext

function call(path: string, method: string, body?: unknown) {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    writeHead(s: number) { out.status = s; return res },
    setHeader() { return res },
    write() { return true },
    end(chunk?: string) { if (chunk) { try { out.body = JSON.parse(chunk) } catch { /* ignore */ } } },
    on() { return res },
  }
  const req: any = Readable.from([Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf-8')])
  req.headers = { 'content-type': 'application/json' }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req, res, path: url.pathname, method, url, auth: { kind: 'session' as const, user: 'teszt' } } as unknown as RouteContext
  return tryHandleBackupRules(ctx).then((handled) => ({ handled, ...out }))
}

// #513: only the backups stay under Rendszer -- so LOOKING at a preview must
// not create the account's folder there. Runs first: the lock test below
// starts a (fake) download, after which the folder may legitimately exist.
describe('a MEGA preview creates nothing on the disk (#513)', () => {
  it('the download preview answers without making the account folder', async () => {
    expect(existsSync(join(h.depot, 'teszt'))).toBe(false)
    const pv = await call('/api/backup-rules/mega/download/preview', 'POST', { account: 'teszt' })
    expect(pv.status).toBe(200)
    expect(pv.body.files).toBe(1)
    expect(existsSync(join(h.depot, 'teszt'))).toBe(false)
  })

  it('the mirror upload preview says there is no mirror folder -- and does not walk a missing folder as an empty one', async () => {
    const pv = await call('/api/backup-rules/mega/mirror/preview', 'POST', { account: 'teszt' })
    expect(pv.status).toBe(404)
    expect(pv.body.code).toBe('no_mirror_folder')
    expect(String(pv.body.error)).toContain('Életf')
    expect(existsSync(join(h.depot, 'teszt'))).toBe(false)
  })
})

describe('MEGA transfer lock through the real route handler (card #465)', () => {
  it('a running download blocks the upload run, and the lock lets go once the download ends', async () => {
    const pv = await call('/api/backup-rules/mega/download/preview', 'POST', { account: 'teszt' })
    expect(pv.status).toBe(200)
    expect(pv.body.files).toBe(1)
    const run = await call('/api/backup-rules/mega/download/run', 'POST', { account: 'teszt' })
    expect(run.status).toBe(200)
    expect(run.body.job.running).toBe(true)

    // The regression: before #465 the upload run checked only for a running
    // upload, so it got past this point and answered `no_preview` instead.
    const up = await call('/api/backup-rules/mega/mirror/run', 'POST', { account: 'teszt' })
    expect(up.handled).toBe(true)
    expect(up.status).toBe(409)
    expect(up.body.code).toBe('busy_down')
    expect(String(up.body.error).length).toBeGreaterThan(10)

    // A second download is refused the same way.
    const again = await call('/api/backup-rules/mega/download/run', 'POST', { account: 'teszt' })
    expect(again.status).toBe(409)
    expect(again.body.code).toBe('busy_down')

    // Download ends -> the upload is no longer blocked by the lock: it reaches
    // the next check (no upload preview was taken), not `busy_down`.
    h.finishDownload()
    await vi.waitFor(async () => {
      const st = await call('/api/backup-rules/mega/download/status', 'GET')
      expect(st.body.job.running).toBe(false)
    })
    const after = await call('/api/backup-rules/mega/mirror/run', 'POST', { account: 'teszt' })
    expect(after.status).toBe(409)
    expect(after.body.code).toBe('no_preview')
  })
})
