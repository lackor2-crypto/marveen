// #424 -- a MEGA oldal "pontosan ugy, mint a Drive": uj mappa, atnevezes,
// athelyezes, kuka, feltoltes, letoltes. Amit itt vedunk:
//   - SOHA nem ir felul (az rclone moveto/copyto magatol felulirna);
//   - a torles a MEGA KUKAJABA megy (--mega-hard-delete=false, kimondva);
//   - a fiok gyokere nem nevezheto at / helyezheto at / torolheto;
//   - mappa nem kerulhet onmagaba; mappat nem "cat"-elunk le;
//   - a "nincs ilyen" csak kimondott not-found-bol jon, halozati hibabol nem;
//   - a feltoltes ideiglenes fajlja a vegen mindig torlodik;
//   - a multipart ekezetes fajlnevet UTF-8-kent olvassa (a Drive-nal is).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const store = mkdtempSync(join(tmpdir(), 'marveen-mega-ops-'))
const fakeBin = join(store, 'rclone-fake')
writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store, PROJECT_ROOT: store }
})

const mega = await import('../mega.js')
const { parseMultipart } = await import('../web/multipart.js')
const { megaErrorStatus } = await import('../web/routes/mega.js')

type Call = string[]
/** Hamis rclone: `tree` mondja meg, mi letezik (true = mappa, false = fajl). */
function fake(tree: Record<string, boolean>, opts: { statFail?: string; opFail?: string } = {}) {
  const calls: Call[] = []
  const run = async (_bin: string, args: string[]) => {
    calls.push(args)
    const target = String(args[args[0] === 'lsjson' ? 2 : 1] || '')
    const path = target.slice(target.indexOf(':') + 1)
    if (args[0] === 'lsjson') {
      if (opts.statFail) return { code: 1, stdout: '', stderr: opts.statFail }
      if (!(path in tree)) return { code: 3, stdout: '', stderr: 'ERROR : error: object not found' }
      return { code: 0, stdout: JSON.stringify({ Path: path, IsDir: tree[path] }), stderr: '' }
    }
    if (opts.opFail) return { code: 1, stdout: '', stderr: opts.opFail }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { run, calls, ops: () => calls.filter((c) => c[0] !== 'lsjson') }
}

beforeEach(() => {
  process.env.MARVEEN_RCLONE = fakeBin
  writeFileSync(join(store, 'mega-accounts.json'), JSON.stringify({
    accounts: [{ name: 'teszt', email: 'teszt@example.com', remote: 'mega_teszt', addedAt: 1 }],
  }))
})

describe('normalizeMegaName', () => {
  it('egyetlen nevet enged, utat es trukkot nem', () => {
    expect(mega.normalizeMegaName('  Fotók 2026 ')).toBe('Fotók 2026')
    for (const bad of ['', '  ', '.', '..', 'a/b', 'a\nb', 'x'.repeat(256), 42]) expect(mega.normalizeMegaName(bad)).toBeNull()
  })
})

describe('uj mappa', () => {
  it('letrehozza a mostani mappaban', async () => {
    const f = fake({ MEGAsync: true })
    expect(await mega.megaMkdir('teszt', 'MEGAsync', 'Új', f.run)).toEqual({ ok: true, path: 'MEGAsync/Új' })
    expect(f.ops()[0].slice(0, 2)).toEqual(['mkdir', 'mega_teszt:MEGAsync/Új'])
  })
  it('meglevo nevre nem ir, es nem hiv mkdir-t', async () => {
    const f = fake({ MEGAsync: true, 'MEGAsync/Új': true })
    expect(await mega.megaMkdir('teszt', 'MEGAsync', 'Új', f.run)).toMatchObject({ ok: false, error: 'exists' })
    expect(f.ops()).toEqual([])
  })
  it('ismeretlen fiok -> not_found, rossz nev -> bad_name', async () => {
    expect(await mega.megaMkdir('nincs', '', 'x', fake({}).run)).toMatchObject({ error: 'not_found' })
    expect(await mega.megaMkdir('teszt', '', 'a/b', fake({}).run)).toMatchObject({ error: 'bad_name' })
  })
})

describe('atnevezes es athelyezes', () => {
  it('atnevezes a sajat mappajaban, sose felulirva', async () => {
    const f = fake({ 'd/a.txt': false })
    expect(await mega.megaRename('teszt', 'd/a.txt', 'b.txt', f.run)).toEqual({ ok: true, path: 'd/b.txt' })
    expect(f.ops()[0].slice(0, 3)).toEqual(['moveto', 'mega_teszt:d/a.txt', 'mega_teszt:d/b.txt'])
    const g = fake({ 'd/a.txt': false, 'd/b.txt': false })
    expect(await mega.megaRename('teszt', 'd/a.txt', 'b.txt', g.run)).toMatchObject({ error: 'exists' })
    expect(g.ops()).toEqual([])
  })
  it('a gyoker vedett', async () => {
    const f = fake({})
    expect(await mega.megaRename('teszt', '', 'x', f.run)).toMatchObject({ error: 'root_protected' })
    expect(await mega.megaMove('teszt', '', 'x', f.run)).toMatchObject({ error: 'root_protected' })
    expect(await mega.megaTrash('teszt', '/', f.run)).toMatchObject({ error: 'root_protected' })
    expect(f.calls).toEqual([])
  })
  it('mappa nem mehet onmagaba vagy az almappajaba', async () => {
    const f = fake({ A: true, 'A/B': true })
    expect(await mega.megaMove('teszt', 'A', 'A/B', f.run)).toMatchObject({ error: 'move_into_self' })
    expect(await mega.megaMove('teszt', 'A', 'A', f.run)).toMatchObject({ error: 'move_into_self' })
    expect(f.ops()).toEqual([])
  })
  it('a cel fajl -> target_not_dir; a celban mar van ilyen -> exists; a gyokerbe mehet', async () => {
    expect(await mega.megaMove('teszt', 'a.txt', 'b.txt', fake({ 'a.txt': false, 'b.txt': false }).run)).toMatchObject({ error: 'target_not_dir' })
    expect(await mega.megaMove('teszt', 'a.txt', 'D', fake({ 'a.txt': false, D: true, 'D/a.txt': false }).run)).toMatchObject({ error: 'exists' })
    const f = fake({ 'D/a.txt': false })
    expect(await mega.megaMove('teszt', 'D/a.txt', '', f.run)).toEqual({ ok: true, path: 'a.txt' })
  })
  it('halozati hiba a stat-nal NEM "nincs ilyen" -- nem irunk vakon', async () => {
    const f = fake({ 'a.txt': false }, { statFail: 'Failed to create file system: dial tcp: i/o timeout' })
    const r = await mega.megaRename('teszt', 'a.txt', 'b.txt', f.run)
    expect(r.ok).toBe(false)
    expect(f.ops()).toEqual([])
  })
})

describe('kuka', () => {
  it('fajl: deletefile, mappa: purge -- mindketto a MEGA kukajaba', async () => {
    const f = fake({ 'a.txt': false, D: true })
    await mega.megaTrash('teszt', 'a.txt', f.run)
    await mega.megaTrash('teszt', 'D', f.run)
    const [one, two] = f.ops()
    expect(one[0]).toBe('deletefile')
    expect(two[0]).toBe('purge')
    for (const c of [one, two]) expect(c).toContain('--mega-hard-delete=false')
  })
  it('ami nincs, az dir_not_found', async () => {
    expect(await mega.megaTrash('teszt', 'nincs', fake({}).run)).toMatchObject({ error: 'dir_not_found' })
  })
})

describe('feltoltes es letoltes', () => {
  it('copyto egy ideiglenes fajlbol, ami a vegen eltunik (hibanal is)', async () => {
    for (const opFail of [undefined, 'ERROR : upload failed']) {
      let seen = ''
      const f = fake({ D: true }, { opFail })
      const run = async (bin: string, args: string[]) => {
        if (args[0] === 'copyto') { seen = args[1]; expect(readFileSync(seen, 'utf-8')).toBe('hello') }
        return f.run(bin, args)
      }
      const r = await mega.megaUpload('teszt', 'D', 'fotó.txt', Buffer.from('hello'), run)
      expect(r.ok).toBe(!opFail)
      expect(seen).not.toBe('')
      expect(existsSync(seen)).toBe(false)
    }
  })
  it('meglevo nevre nem tolt fel', async () => {
    const f = fake({ D: true, 'D/a.txt': false })
    expect(await mega.megaUpload('teszt', 'D', 'a.txt', Buffer.from('x'), f.run)).toMatchObject({ error: 'exists' })
    expect(f.ops()).toEqual([])
  })
  it('letoltes: fajlra cat, mappara NEM (az osszes fajlt kiontene)', async () => {
    const f = fake({ 'D/a.txt': false, D: true })
    const ok = await mega.megaDownloadCommand('teszt', 'D/a.txt', f.run)
    expect(ok).toMatchObject({ ok: true, fileName: 'a.txt' })
    if (ok.ok) expect(ok.args.slice(0, 2)).toEqual(['cat', 'mega_teszt:D/a.txt'])
    expect(await mega.megaDownloadCommand('teszt', 'D', f.run)).toMatchObject({ error: 'is_dir' })
    expect(await mega.megaDownloadCommand('teszt', '', f.run)).toMatchObject({ error: 'bad_path' })
  })
})

describe('HTTP allapot a hibakodhoz', () => {
  it('a mi oldalunk 4xx, a MEGA oldala 5xx', () => {
    expect(megaErrorStatus('exists')).toBe(409)
    expect(megaErrorStatus('root_protected')).toBe(400)
    expect(megaErrorStatus('dir_not_found')).toBe(404)
    expect(megaErrorStatus('too_large')).toBe(413)
    expect(megaErrorStatus('timeout')).toBe(504)
    expect(megaErrorStatus('network')).toBe(502)
  })
})

describe('multipart: ekezetes nev', () => {
  it('a fajlnev es a mezok UTF-8-kent jonnek at, a tartalom bajtra pontos', () => {
    const b = 'XyZ'
    const bin = Buffer.from([0xff, 0x00, 0xc3, 0xa9])
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="dir"\r\n\r\nMEGAsync/Fotók\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="árvíztűrő.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      bin,
      Buffer.from(`\r\n--${b}--\r\n`),
    ])
    const { file, fields } = parseMultipart(body, `multipart/form-data; boundary=${b}`)
    expect(fields.dir).toBe('MEGAsync/Fotók')
    expect(file?.name).toBe('árvíztűrő.jpg')
    expect(Buffer.compare(file!.data, bin)).toBe(0)
  })
})

describe('a MEGA oldal (web)', () => {
  const app = readFileSync(join(__dirname, '..', '..', 'web', 'app.js'), 'utf-8')
  const html = readFileSync(join(__dirname, '..', '..', 'web', 'index.html'), 'utf-8')
  it('soronkent letoltes / atnevezes / athelyezes / kuka, a kuka kerdez', () => {
    for (const a of ['download', 'rename', 'move', 'trash']) expect(app).toContain(`data-mega-action="${a}"`)
    expect(app).toMatch(/if \(!confirm\(t\('megadepot\.confirm\.trash'/)
  })
  it('bal felul a fiok emailje, fejlecben feltoltes / uj mappa / frissites', () => {
    for (const id of ['megadepotAccountTitle', 'megadepotUploadInput', 'megadepotNewFolderBtn', 'megadepotRefreshBtn', 'megadepotMultiUploadInput']) expect(html).toContain(`id="${id}"`)
    expect(app).toMatch(/title\.textContent = _megaLabel\(account\)/)
  })
  it('a MEGAsync gyoker helyett magatol a tartalma latszik, egyszer fiokonkent', () => {
    expect(app).toMatch(/function _megaAutoEnter\(account, stack, items\)/)
    expect(app).toMatch(/_megaAutoEntered\.has\(account\)/)
    expect(app).toMatch(/if \(_megaAutoEnter\(account, stack, r\.items\)\) \{ loadMegaFolder\(\); return \}/)
    expect(app).toMatch(/if \(_megaAutoEnter\(account, stack, r\.items\)\) \{ loadMegaColumn\(account\); return \}/)
  })
  it('a felhobol eltunt mappabol a legkozelebbi letezo szulore lep vissza, nem reked hibaoldalon', () => {
    expect(app).toMatch(/function _megaStepBackIfGone\(stack, r\)/)
    expect(app).toMatch(/code !== 'dir_not_found' && code !== 'not_found'/)
    expect(app).toMatch(/if \(_megaStepBackIfGone\(stack, r\)\) \{ loadMegaFolder\(\); return \}/)
    expect(app).toMatch(/if \(_megaStepBackIfGone\(stack, r\)\) \{ loadMegaColumn\(account\); return \}/)
  })
})

process.on('exit', () => rmSync(store, { recursive: true, force: true }))
