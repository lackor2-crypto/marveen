// #398 -- a MEGA fiok tartalma helyben bongeszheto (Raktar -> MEGA), mint a Drive.
//
// A listazas csak OLVAS (`rclone lsjson`, egy szint). Amit itt vedunk:
//   - az ut nem lephet ki a fiok gyokerebol, es nem lehet rclone-kapcsolo;
//   - az ures mappa CSAK sikeres listazasbol jon -- minden mas (nincs rclone,
//     belepes elbukott, idotullepes, nincs ilyen mappa) kulon hibakod;
//   - a vegpont a hibakodot kulon HTTP-allapottal adja vissza.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

const store = mkdtempSync(join(tmpdir(), 'marveen-mega-browse-'))
// Hamis rclone: a mappa neve donti el, mit valaszol. Csak az lsjson-t tudja.
const fakeBin = join(store, 'rclone-fake')
writeFileSync(fakeBin, `#!/bin/sh
[ "$1" = "version" ] && { echo "rclone v1.71.0"; exit 0; }
[ "$1" = "lsjson" ] || exit 9
case "$2" in
  *:ures) echo '[]' ;;
  *:eltunt) echo "2026/09/26 ERROR : error listing: directory not found" >&2; exit 3 ;;
  *) echo '[{"Path":"b.txt","Name":"b.txt","Size":12,"ModTime":"2026-09-01T10:00:00+02:00","IsDir":false},{"Path":"Zeta","Name":"Zeta","Size":-1,"ModTime":"2021-07-26T15:33:23+02:00","IsDir":true},{"Path":"a.pdf","Name":"a.pdf","Size":0,"ModTime":"2026-09-02T10:00:00+02:00","IsDir":false},{"Path":"Alfa","Name":"Alfa","Size":-1,"IsDir":true}]' ;;
esac
`, { mode: 0o755 })

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const mega = await import('../mega.js')
const { tryHandleMega } = await import('../web/routes/mega.js')

function account(name = 'teszt') {
  writeFileSync(join(store, 'mega-accounts.json'), JSON.stringify({
    accounts: [{ name, email: `${name}@example.com`, remote: `mega_${name}`, addedAt: 1 }],
  }))
}

beforeEach(() => {
  process.env.MARVEEN_RCLONE = fakeBin
  for (const f of ['mega-accounts.json', 'mega-quota.json', 'rclone']) rmSync(join(store, f), { recursive: true, force: true })
})

describe('normalizeMegaPath', () => {
  it('a gyoker ures ut; a felesleges perjelek eltunnek', () => {
    expect(mega.normalizeMegaPath(undefined)).toBe('')
    expect(mega.normalizeMegaPath('')).toBe('')
    expect(mega.normalizeMegaPath('/Samsung fotók//2021/')).toBe('Samsung fotók/2021')
  })

  it('a fiok gyokerebol kilepo vagy vezerlokarakteres ut el van utasitva', () => {
    for (const bad of ['..', 'a/../b', './a', 'a\nb', 'a\u0000b', 'x'.repeat(2000)]) {
      expect(mega.normalizeMegaPath(bad)).toBeNull()
    }
    expect(mega.normalizeMegaPath(42)).toBeNull()
  })
})

describe('listMegaDir', () => {
  it('mappak elol, nev szerint; a mappa merete null, az ut a fiokon beluli', async () => {
    account()
    const calls: string[][] = []
    const r = await mega.listMegaDir('teszt', 'Docs/2026', async (_b, args) => {
      calls.push(args)
      return { code: 0, stdout: '[{"Name":"b","Size":5,"IsDir":false},{"Name":"A","Size":-1,"IsDir":true,"ModTime":"2021-01-01T00:00:00Z"}]', stderr: '' }
    })
    expect(r).toEqual({
      ok: true, path: 'Docs/2026', items: [
        { name: 'A', path: 'Docs/2026/A', isDir: true, size: null, modTime: '2021-01-01T00:00:00Z' },
        { name: 'b', path: 'Docs/2026/b', isDir: false, size: 5, modTime: null },
      ],
    })
    // Az ut mindig a `remote:` utan all -- nem lehet belole rclone-kapcsolo.
    expect(calls[0].slice(0, 2)).toEqual(['lsjson', 'mega_teszt:Docs/2026'])
    expect(calls[0]).toContain('--config')
  })

  it('az ures mappa ures lista -- sikeres listazasbol', async () => {
    account()
    const r = await mega.listMegaDir('teszt', '', async () => ({ code: 0, stdout: '[]\n', stderr: '' }))
    expect(r).toEqual({ ok: true, path: '', items: [] })
  })

  it('"nem lattam oda": minden hibanak kulon kodja van, soha nem ures lista', async () => {
    account()
    const fail = (code: number, stderr: string) => async () => ({ code, stdout: '', stderr })
    expect(await mega.listMegaDir('teszt', 'x', fail(3, 'ERROR : error listing: directory not found')))
      .toMatchObject({ ok: false, error: 'dir_not_found' })
    expect(await mega.listMegaDir('teszt', '', fail(1, "couldn't login: Object (typically, node or user) not found")))
      .toMatchObject({ ok: false, error: 'login_failed' })
    expect(await mega.listMegaDir('teszt', '', fail(mega.RCLONE_TIMEOUT_CODE, 'rclone timeout after 45s')))
      .toMatchObject({ ok: false, error: 'timeout' })
    expect(await mega.listMegaDir('teszt', '', async () => ({ code: 0, stdout: 'nem json', stderr: '' })))
      .toMatchObject({ ok: false, error: 'bad_output' })
  })

  it('ismeretlen fiok, rossz ut, hianyzo rclone: rclone-hivas nelkul, kulon koddal', async () => {
    account()
    const never = async () => { throw new Error('nem szabadna futnia') }
    expect(await mega.listMegaDir('masik', '', never)).toEqual({ ok: false, error: 'not_found' })
    expect(await mega.listMegaDir('teszt', '../..', never)).toEqual({ ok: false, error: 'bad_path' })
    process.env.MARVEEN_RCLONE = join(store, 'nincs-ilyen')
    expect(await mega.listMegaDir('teszt', '', never)).toEqual({ ok: false, error: 'rclone_missing' })
  })

  it('az idotullepes a sajat kodjat adja, nem altalanos hibat', async () => {
    const r = await mega.makeRunner(100)('/bin/sleep', ['5'])
    expect(r.code).toBe(mega.RCLONE_TIMEOUT_CODE)
  })
})

function fakeRes() {
  const chunks: Buffer[] = []
  const res: any = new Writable({ write(chunk: Buffer, _e: string, cb: () => void) { chunks.push(chunk); cb() } })
  res.statusCode = 0
  res.headers = {}
  res.writeHead = (status: number, headers?: Record<string, unknown>) => { res.statusCode = status; if (headers) Object.assign(res.headers, headers); return res }
  res.setHeader = (k: string, v: unknown) => { res.headers[k] = v; return res }
  res.end = (chunk?: any) => { if (chunk) chunks.push(Buffer.from(chunk)); return res }
  res.body = () => JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  return res
}

async function get(pathAndQuery: string) {
  const res = fakeRes()
  const req: any = Readable.from([])
  req.headers = {}
  const url = new URL('http://localhost:3420' + pathAndQuery)
  const handled = await tryHandleMega({ req, res, path: url.pathname, method: 'GET', url } as unknown as RouteContext)
  return { handled, status: res.statusCode || 200, body: res.body() }
}

describe('GET /api/mega/list', () => {
  it('a fiok gyokere a valodi rclone-hivasbol, rendezve', async () => {
    account()
    const r = await get('/api/mega/list?name=teszt')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body.items.map((i: any) => i.name)).toEqual(['Alfa', 'Zeta', 'a.pdf', 'b.txt'])
    expect(r.body.items[2].size).toBe(0)
  })

  it('ures mappa: 200 es ures lista; eltunt mappa: 404 dir_not_found', async () => {
    account()
    expect(await get('/api/mega/list?name=teszt&path=ures')).toMatchObject({ status: 200, body: { ok: true, items: [] } })
    const gone = await get('/api/mega/list?name=teszt&path=eltunt')
    expect(gone.status).toBe(404)
    expect(gone.body.error).toBe('dir_not_found')
    expect(gone.body.detail).toContain('directory not found')
  })

  it('rossz ut 400, ismeretlen fiok 404, hianyzo rclone 409 -- egyik sem ures lista', async () => {
    account()
    expect(await get('/api/mega/list?name=teszt&path=' + encodeURIComponent('../x'))).toMatchObject({ status: 400, body: { error: 'bad_path' } })
    expect(await get('/api/mega/list?name=senki')).toMatchObject({ status: 404, body: { error: 'not_found' } })
    process.env.MARVEEN_RCLONE = join(store, 'nincs-ilyen')
    expect(await get('/api/mega/list?name=teszt')).toMatchObject({ status: 409, body: { error: 'rclone_missing' } })
  })

  it('friss telepites: nincs fiok -> 404, nem osszeomlas', async () => {
    expect(await get('/api/mega/list?name=barki')).toMatchObject({ status: 404, body: { error: 'not_found' } })
  })
})
