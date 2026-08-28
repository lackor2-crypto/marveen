// A mappavalaszto probaja.
//
// Boss: "/mnt/d/Marveen. szerinted a komuves erti hogy ez mi? jobb lenne ha ki
// lehetne valasztani ugy mint amikor fel akarok tolteni egy filet vagy mappat.
// nem kezzel beirni meg per jel stb..."
//
// Ket kovetelmeny, es mindkettot merni kell:
//   1. amit a felhasznalo LAT, az Windows-alak (D:\Marveen), nem /mnt/d;
//   2. a valaszto csak MAPPAKAT ad vissza, es semmit nem modosit.
//
// Plusz egy harmadik, ami mar egyszer megfogott minket: a `/mnt/d` MAPPA attol
// meg ott lehet, hogy a lemez lecsatolodott. Ezert a lemezlista a
// `/proc/mounts`-bol jon, nem a `/mnt` listazasabol.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { readFileSync as read } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listDrives, toDisplayPath, fromDisplayPath, normalizeDepotPath, browseFolders, humanBytes,
} from '../depot-browse.js'
import { tryHandleDepot } from '../web/routes/depot.js'

const ROOT = join(__dirname, '..', '..')
let tmp = ''

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'valaszto-teszt-')) })
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* mar nincs */ } })

/** Egy `/proc/mounts`-szeru fajl a tesztnek. */
function mounts(lines: string): string {
  const p = join(tmp, 'mounts')
  writeFileSync(p, lines)
  return p
}

describe('milyen lemezeket lat a gep', () => {
  it('a Windows-lemezeket felsorolja, emberi nevvel', () => {
    const p = mounts([
      'C:\\134 /mnt/c drvfs rw,noatime 0 0',
      'D:\\134 /mnt/d drvfs rw,noatime 0 0',
    ].join('\n'))
    const d = listDrives(p)
    expect(d.map((x) => x.display)).toEqual(['C:', 'D:'])
    expect(d[1].label).toBe('D: lemez')
    expect(d[1].path).toBe('/mnt/d')
  })

  it('ami nem lemez, az nem kerul a listaba', () => {
    // A linuxos sajat mappak (/, /proc, /sys) es a WSL belso csatolasai
    // semmit nem jelentenek annak, aki egy lemezt keres.
    //
    // A donto sor a `/mnt/e`: az UGY NEZ KI, mint egy lemez (egybetus mappa a
    // /mnt alatt), de tmpfs -- vagyis a gep memoriaja. Ha ezt lemeznek
    // kinalnank, a felhasznalo oda tehetne a depot, es ujrainditaskor MINDEN
    // ADATA ELTUNNE. A tipus szerinti szures nem szepseghiba.
    const p = mounts([
      '/dev/sdc / ext4 rw 0 0',
      'proc /proc proc rw 0 0',
      'none /mnt/wsl tmpfs rw 0 0',
      'tmpfs /mnt/e tmpfs rw 0 0',
      'C:\\134 /mnt/c drvfs rw 0 0',
    ].join('\n'))
    expect(listDrives(p).map((x) => x.display)).toEqual(['C:'])
  })

  it('a lecsatolt lemez ELTUNIK a listabol, akkor is, ha a mappaja megvan', () => {
    // Ez a mert hibamod: a drvfs-atjaro meghal, a `/mnt/d` mappa ottmarad, es
    // minden muvelet hibara fut. Ha a `/mnt` listazasabol dolgoznank, a lemez
    // valaszthato maradna -- es a kepek egy halott mappaba mennenek.
    const p = mounts('C:\\134 /mnt/c drvfs rw 0 0\n')
    expect(listDrives(p).find((x) => x.path === '/mnt/d')).toBeUndefined()
  })

  it('hianyzo /proc/mounts eseten ures lista, nem osszeomlas', () => {
    expect(listDrives(join(tmp, 'nincs-ilyen'))).toEqual([])
  })

  it('a kod a /proc/mounts-bol dolgozik, nem a /mnt listazasabol', () => {
    const src = read(join(ROOT, 'src', 'depot-browse.ts'), 'utf8')
    const fn = src.slice(src.indexOf('export function listDrives'), src.indexOf('export function diskSpace'))
    expect(fn).toContain('readFileSync(mountsFile')
    expect(fn).not.toMatch(/readdirSync/)
  })
})

describe('amit a felhasznalo lat', () => {
  it('/mnt/d/Marveen -> D:\\Marveen', () => {
    expect(toDisplayPath('/mnt/d/Marveen')).toBe('D:\\Marveen')
    expect(toDisplayPath('/mnt/d')).toBe('D:')
    expect(toDisplayPath('/mnt/c/Users/Laszlo/Kepek')).toBe('C:\\Users\\Laszlo\\Kepek')
  })

  it('ami nem lemezen van, annak nem talalunk ki hamis Windows-utvonalat', () => {
    expect(toDisplayPath('/home/boss/marveen')).toBe('/home/boss/marveen')
  })

  it('amit begepel, azt is ertjuk -- mindket alakban', () => {
    expect(fromDisplayPath('D:\\Marveen')).toBe('/mnt/d/Marveen')
    expect(fromDisplayPath('d:/Marveen')).toBe('/mnt/d/Marveen')
    expect(fromDisplayPath('D:')).toBe('/mnt/d')
    expect(fromDisplayPath('D:\\')).toBe('/mnt/d')
    expect(fromDisplayPath('D:\\Marveen\\')).toBe('/mnt/d/Marveen')
    // Ami mar linuxos, az valtozatlanul megy tovabb.
    expect(fromDisplayPath('/mnt/d/Marveen')).toBe('/mnt/d/Marveen')
  })

  it('oda-vissza ugyanaz jon ki', () => {
    for (const p of ['/mnt/d/Marveen', '/mnt/c/Users/x', '/mnt/e']) {
      expect(fromDisplayPath(toDisplayPath(p))).toBe(p)
    }
  })

  it('a D: -> /mnt/d forditas CSAK Linuxon tortenik', () => {
    // Egy macOS-telepitesen egy `D:`-vel kezdodo utvonal nem Windows-lemez;
    // ott ebbol a forditasbol csak kar szarmazna.
    expect(normalizeDepotPath('D:\\Marveen', 'linux')).toBe('/mnt/d/Marveen')
    expect(normalizeDepotPath('D:\\Marveen', 'darwin')).toBe('D:\\Marveen')
    expect(normalizeDepotPath('   ', 'linux')).toBe('')
  })
})

describe('a mappak felsorolasa', () => {
  it('csak mappakat ad vissza, fajlokat nem', () => {
    mkdirSync(join(tmp, 'Kepek'))
    mkdirSync(join(tmp, 'Zene'))
    writeFileSync(join(tmp, 'jegyzet.txt'), 'x')
    const r = browseFolders(tmp)
    expect(r.folders.map((f) => f.name)).toEqual(['Kepek', 'Zene'])
  })

  it('a rejtett es rendszermappak nem zavarnak be', () => {
    mkdirSync(join(tmp, '.git'))
    mkdirSync(join(tmp, '$RECYCLE.BIN'))
    mkdirSync(join(tmp, 'System Volume Information'))
    mkdirSync(join(tmp, 'Dokumentumok'))
    expect(browseFolders(tmp).folders.map((f) => f.name)).toEqual(['Dokumentumok'])
  })

  it('minden mappa mellett ott a Windows-alak is', () => {
    mkdirSync(join(tmp, 'Kepek'))
    const f = browseFolders(tmp).folders[0]
    expect(f.path).toBe(join(tmp, 'Kepek'))
    expect(f.display).toBe(toDisplayPath(join(tmp, 'Kepek')))
  })

  it('nem letezo mappa: emberi uzenet, nem osszeomlas', () => {
    const r = browseFolders(join(tmp, 'nincs-ilyen'))
    expect(r.folders).toEqual([])
    expect(r.message).toMatch(/nincs meg/i)
  })

  it('fajlra mutatva megmondja, hogy az nem mappa', () => {
    const f = join(tmp, 'kep.jpg')
    writeFileSync(f, 'x')
    expect(browseFolders(f).message).toMatch(/nem mappa/i)
  })

  it('utvonal nelkul a lemezlista jon, es semmi mas', () => {
    const r = browseFolders(null)
    expect(r.path).toBeNull()
    expect(r.display).toBe('Saját gép')
    expect(r.folders).toEqual([])
    expect(r.parent).toBeNull()
  })

  it('a lemez gyokerebol a lemezlistara lepunk vissza, nem a /mnt-be', () => {
    // A `/mnt` egy linuxos reszlet. Aki a D: gyokerebol visszalep, az a
    // gepe lemezeit akarja latni, nem egy linuxos belso mappat.
    expect(browseFolders('/mnt/d').parent).toBeNull()
    expect(browseFolders('D:').parent).toBeNull()
  })

  it('mappan belul viszont van hova visszalepni', () => {
    mkdirSync(join(tmp, 'Kepek'))
    expect(browseFolders(join(tmp, 'Kepek')).parent).toBe(tmp)
  })

  it('a felsorolas NEM modosit semmit', () => {
    mkdirSync(join(tmp, 'Kepek'))
    browseFolders(tmp)
    browseFolders(join(tmp, 'Kepek'))
    // Egy valaszto olvas. Ha barmit letrehozna, az egy kattintgatas kozben
    // szemetet szorna szet a felhasznalo lemezen.
    const src = read(join(ROOT, 'src', 'depot-browse.ts'), 'utf8')
    expect(src).not.toMatch(/mkdirSync|writeFileSync|rmSync|renameSync|unlinkSync/)
  })

  it('a tulzsufolt mappa sem fagyasztja le a feluletet', () => {
    const big = join(tmp, 'sok')
    mkdirSync(big)
    for (let i = 0; i < 520; i++) mkdirSync(join(big, 'm' + String(i).padStart(4, '0')))
    expect(browseFolders(big).folders.length).toBe(500)
  })

  it('egy torott jelzolanc nem viszi el az egesz listat', () => {
    mkdirSync(join(tmp, 'Jo'))
    symlinkSync(join(tmp, 'nincs-ilyen'), join(tmp, 'Torott'))
    const r = browseFolders(tmp)
    expect(r.folders.map((f) => f.name)).toEqual(['Jo'])
  })
})

describe('a meretek emberi alakja', () => {
  it('a nagysagrendhez igazodik', () => {
    expect(humanBytes(null)).toBe('?')
    expect(humanBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(humanBytes(443 * 1024 ** 3)).toBe('443 GB')
    expect(humanBytes(2 * 1024 ** 4)).toBe('2.0 TB')
  })
})

describe('a depo-hely mentese', () => {
  const route = () => read(join(ROOT, 'src', 'web', 'routes', 'depot.ts'), 'utf8')

  // A mentes-vegpont valodi probaja. A beallitasfajlt elmentjuk es
  // visszaallitjuk: egy teszt nem valtoztathatja meg, hova mentse a Marveen a
  // fajljait -- meg akkor sem, ha a vizsgalt vedokorlat eppen el van rontva.
  const overrides = join(ROOT, 'store', 'config-overrides.json')
  let before: string | null = null
  beforeEach(() => { before = existsSync(overrides) ? read(overrides, 'utf8') : null })
  afterEach(() => {
    if (before === null) rmSync(overrides, { force: true })
    else writeFileSync(overrides, before)
  })

  async function postRoot(body: unknown): Promise<{ status: number; body: any }> {
    const out = { status: 200, body: null as any }
    const res: any = {
      writeHead(status: number) { out.status = status; return res },
      end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
      once() { /* ez a vegpont nem hasznalja */ },
    }
    const bodyStr = JSON.stringify(body)
    const req: any = {
      on(event: string, cb: (c?: Buffer) => void) {
        if (event === 'data') cb(Buffer.from(bodyStr))
        if (event === 'end') cb()
      },
    }
    const url = new URL('http://localhost:3420/api/depot/root')
    await tryHandleDepot({ req, res, path: url.pathname, method: 'POST', url } as any)
    return out
  }

  it('lecsatolt lemeznel VISSZAUTASITJA, es egyetlen mappat sem gyart', async () => {
    // Ez a legveszelyesebb hibamod: ha a `/mnt/d` atjaro meghal, a
    // `/mnt/d/Marveen` letrehozasa egy kozonseges linux-mappat csinalna a WSL
    // gyokeren, es a Marveen boldogan irna oda a kepeket -- a D: lemez helyett.
    const soha = join(tmp, 'nincs-ilyen-szulo')
    const r = await postRoot({ parent: soha, name: 'Marveen' })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('parent_missing')
    expect(existsSync(soha)).toBe(false)
    expect(existsSync(join(soha, 'Marveen'))).toBe(false)
  })

  it('letezo mappaban viszont elmenti, es nem hagy maga utan szemetet', async () => {
    const r = await postRoot({ parent: tmp, name: 'Marveen' })
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    expect(existsSync(join(tmp, 'Marveen'))).toBe(true)
    // Az iras-proba fajlja NEM maradhat ott.
    expect(existsSync(join(tmp, 'Marveen', '.marveen-iras-proba'))).toBe(false)
    // Es kimondja, hogy ujraindulas kell -- kulonben a futo folyamat
    // tovabbra is a regi helyet hasznalna, szotlanul.
    expect(r.body.requiresRestart).toBe(true)
  })

  it('per-jeles mappanevet nem fogad el', async () => {
    // A nev egyedi: kulonben egy KORABBI futas maradeka dontene el a tesztet.
    // (Ez nem elmelet: a szabotazs-proba egyszer tenylegesen ottfelejtett egy
    // `/tmp/kifele` mappat, amikor a vedokorlatot szandekosan elrontottam.)
    const escapeName = 'kifele-' + Math.random().toString(36).slice(2)
    const r = await postRoot({ parent: tmp, name: '../' + escapeName })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('bad_name')
    expect(existsSync(join(tmp, '..', escapeName))).toBe(false)
  })

  it('ures keresre nem all be sehova', async () => {
    expect((await postRoot({})).status).toBe(400)
    expect((await postRoot({ parent: tmp, name: '  ' })).status).toBe(400)
  })

  it('nem hisszuk el, hogy irhato: MEGPROBALJUK', () => {
    // Egy olvashato, de nem irhato hely (jogosultsag, csak-olvashato csatolas)
    // kulonben csak 8 GB kep felenel derulne ki.
    const r = route()
    expect(r).toContain('const probe = join(target, \'.marveen-iras-proba\')')
    expect(r).toMatch(/writeFileSync\(probe, 'x'\)\s*\n\s*rmSync\(probe, \{ force: true \}\)/)
  })

  it('a szulomappa hianyaban NEM gyart mappakat', () => {
    // Lecsatolt D: eseten a `/mnt/d/...` letrehozasa a linux gyokerre irna a
    // kepeket, nem a lemezre -- ugyanaz a hibamod, mint az ensureDepotSkeleton-nel.
    const r = route()
    expect(r).toContain("code: 'parent_missing'")
    const block = r.slice(r.indexOf("path === '/api/depot/root'"), r.length)
    expect(block.indexOf('parentOk')).toBeLessThan(block.indexOf('mkdirSync(target'))
  })

  it('a mappaneve nem lehet utvonal', () => {
    // `..` vagy per-jel eseten nem az lenne a depo, amit a felhasznalo lat.
    const r = route()
    expect(r).toContain("if (/[\\\\/]/.test(name) || name === '.' || name === '..')")
    expect(r).toContain("code: 'bad_name'")
  })

  it('a mentes utan kimondja, hogy ujrainditas kell', () => {
    expect(route()).toContain('requiresRestart: true')
  })
})
