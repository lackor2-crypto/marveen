import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let store: string
beforeEach(() => {
  store = mkdtempSync(join(tmpdir(), 'mc969-'))
  writeFileSync(join(store, 'mega-accounts.json'), JSON.stringify({ accounts: [{ name: 'acc1', email: 'a@x.hu', remote: 'mega_acc1', addedAt: 1 }] }))
  vi.resetModules()
  vi.doMock('../config.js', async (orig) => ({ ...(await orig() as object), STORE_DIR: store }))
})
afterEach(() => { vi.doUnmock('../config.js'); rmSync(store, { recursive: true, force: true }) })

const ok = (stdout = '', stderr = '') => ({ code: 0, stdout, stderr })

describe('#969 MEGA collect', () => {
  it('an empty account copies nothing and creates no folder', async () => {
    const { collectMegaAccount } = await import('../mega-collect.js')
    const calls: string[][] = []
    const dest = join(store, 'dest')
    const r = await collectMegaAccount('acc1', { bin: 'rclone', dest, run: async (_b, a) => { calls.push(a); return ok('[]') } })
    expect(r).toMatchObject({ ok: true, empty: true, copied: 0 })
    expect(calls.every((a) => a[0] === 'lsjson')).toBe(true)
    expect(existsSync(dest)).toBe(false)
  })
  it('copies add-only: copy + --ignore-existing, backup folder excluded, never sync/move/delete', async () => {
    const { collectMegaAccount, MEGA_COLLECT_EXCLUDE } = await import('../mega-collect.js')
    const calls: string[][] = []
    const r = await collectMegaAccount('acc1', {
      bin: 'rclone', dest: join(store, 'dest'),
      run: async (_b, a) => { calls.push(a); return a[0] === 'lsjson' ? ok('[{"Path":"a.txt"},{"Path":"d/b.txt"}]') : ok('', '2026 INFO : a.txt: Copied (new)\n2026 INFO : d/b.txt: Copied (new)\n') },
    })
    expect(r).toMatchObject({ ok: true, copied: 2, remoteFiles: 2 })
    const cp = calls.find((a) => a[0] === 'copy')!
    expect(cp).toContain('--ignore-existing')
    expect(cp).toContain(MEGA_COLLECT_EXCLUDE)
    expect(MEGA_COLLECT_EXCLUDE).toContain('Marveen-backup')
    for (const a of calls) expect(['sync', 'move', 'moveto', 'delete', 'purge', 'deletefile']).not.toContain(a[0])
  })
  it('unknown account, missing rclone and a failed listing are reported, not thrown', async () => {
    const { collectMegaAccount } = await import('../mega-collect.js')
    expect((await collectMegaAccount('nope', { bin: 'rclone', dest: 'x' })).error).toBe('not_found')
    expect((await collectMegaAccount('acc1', { bin: null, dest: 'x' })).error).toBe('rclone_missing')
    const r = await collectMegaAccount('acc1', { bin: 'rclone', dest: 'x', run: async () => ({ code: 1, stdout: '', stderr: 'boom' }) })
    expect(r).toMatchObject({ ok: false, error: 'list_failed', detail: 'boom' })
  })
  it('a second collect of the same account while one runs is refused', async () => {
    const { collectMegaAccount } = await import('../mega-collect.js')
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const first = collectMegaAccount('acc1', { bin: 'rclone', dest: 'x', run: async () => { await gate; return ok('[]') } })
    const second = await collectMegaAccount('acc1', { bin: 'rclone', dest: 'x', run: async () => ok('[]') })
    expect(second.error).toBe('already_running')
    release(); await first
  })
})

describe('#969 MEGA collect route', () => {
  function ctx(method: string) {
    const out: { status: number; body: any } = { status: 0, body: null }
    const res: any = { writeHead: (s: number) => { out.status = s }, setHeader: () => {}, end: (b: string) => { out.body = JSON.parse(b) }, headersSent: false }
    const url = new URL('http://x/api/storages/mega/collect')
    return { out, c: { req: { method, url: url.pathname, headers: {} } as any, res, path: url.pathname, method, url } as any }
  }
  it('with no MEGA account the POST says so and starts nothing; GET answers', async () => {
    writeFileSync(join(store, 'mega-accounts.json'), JSON.stringify({ accounts: [] }))
    const { tryHandleStorages } = await import('../web/routes/storages.js')
    const p = ctx('POST')
    expect(await tryHandleStorages(p.c)).toBe(true)
    expect(p.out.body.ok).toBe(false)
    expect(p.out.body.message).toMatch(/MEGA/)
    const g = ctx('GET')
    expect(await tryHandleStorages(g.c)).toBe(true)
    expect(g.out.body).toMatchObject({ accounts: 0, running: [] })
  })
  it('the page has the button and both languages carry its texts', async () => {
    const { readFileSync } = await import('node:fs')
    const root = join(__dirname, '..', '..')
    expect(readFileSync(join(root, 'web', 'index.html'), 'utf8')).toContain('storagesMegaCollectBtn')
    expect(readFileSync(join(root, 'web', 'app.js'), 'utf8')).toContain("bind('storagesMegaCollectBtn'")
    for (const l of ['hu', 'en']) {
      const s = readFileSync(join(root, 'web', 'lang', `${l}.js`), 'utf8')
      for (const k of ['btn', 'tip', 'run', 'done', 'err']) expect(s).toContain(`'storages.mega_collect_${k}'`)
    }
  })
})
