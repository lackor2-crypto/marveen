// A DEPO UJRACSATOLASI TERVE.
//
// Boss, 2026-08-26: "amikor reggel mountoltal azt nem lehet megkerulni? mert ha
// uj telepites van a marveen ban akkor a usert ujra es ujra fogja zavarni a
// mountolassal? globalisra tudod...."
//
// A valasz merve: nem a Marveen kerdez ra, es friss telepitesen sem fog -- a
// WSL magatol csatolja a Windows meghajtokat. A baj az, hogy a 9p kapcsolat
// ELSZAKAD (WSL-hibamod, tipikusan a Windows Gyors inditas miatt), es utana a
// felhasznalo magara marad. Ezek a tesztek azt orzik, hogy a helyreallito
// parancs MERESBOL keszul, es hogy a "nem tudom" sose alakuljon at tippe.

import { describe, it, expect, vi } from 'vitest'
import {
  listDrvfsMounts, usefulMountOptions, depotRemountPlan,
  remountArgv, remountSudoersLine,
} from '../depot-remount.js'

// A gepen 2026-08-26-an ez allt a /proc/mounts-ban. A `rfd=12` az eredeti
// automount (ez halt meg), a `rfd=3` a kezi ujracsatolas.
const MOUNTS = [
  'none /mnt/wsl tmpfs rw,relatime 0 0',
  'C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,cache=0x5,access=client,msize=65536,trans=fd,rfd=12,wfd=12 0 0',
  'F: /mnt/f 9p rw,relatime,aname=drvfs;path=F:;uid=1000;gid=1000;symlinkroot=/mnt/,cache=0x5,access=client,msize=65536,trans=fd,rfd=3,wfd=3 0 0',
  '/dev/sdb /home ext4 rw,relatime 0 0',
].join('\n')

describe('csatolasok beolvasasa', () => {
  it('csak a Windows-meghajtokat veszi, a linuxos particiot nem', () => {
    const m = listDrvfsMounts(MOUNTS)!
    expect(m.map((x) => x.mountpoint)).toEqual(['/mnt/c', '/mnt/f'])
  })

  // A NULLA KET DOLGOT JELENTHET. Ha a /proc/mounts nem olvashato, az NEM
  // ugyanaz, mint hogy nincs csatolt meghajto -- az elso esetben nem latunk
  // oda, es errol a hivonak tudnia kell.
  it('ures lista es "nem latok oda" KET kulon valasz', () => {
    expect(listDrvfsMounts('')).toEqual([])
    expect(listDrvfsMounts('none /mnt/wsl tmpfs rw 0 0')).toEqual([])
  })

  it('olvashatatlan /proc/mounts: null, NEM ures lista', async () => {
    vi.resetModules()
    vi.doMock('node:fs', () => ({
      readFileSync: () => {
        throw new Error('EACCES: permission denied')
      },
    }))
    const { listDrvfsMounts: friss } = await import('../depot-remount.js')
    expect(friss()).toBeNull()
    vi.doUnmock('node:fs')
    vi.resetModules()
  })
})

describe('csatolasi opciok', () => {
  // A MERT HIBA (2026-08-26 reggel): a kezenfekvo parancsba bekerult egy
  // `metadata` kapcsolo, ami az eredeti csatolason NEM volt rajta. Az ilyesmi
  // eszrevetlenul atallitja az egesz depo jogosultsag-kezeleset.
  it('a valodi opciokat viszi, a WSL sajat belsoit nem', () => {
    const m = listDrvfsMounts(MOUNTS)!.find((x) => x.mountpoint === '/mnt/f')!
    const o = usefulMountOptions(m.raw)
    expect(o).toContain('uid=1000')
    expect(o).toContain('gid=1000')
    for (const tilos of ['rfd', 'wfd', 'trans', 'aname', 'msize', 'cache', 'symlinkroot']) {
      expect(o).not.toContain(tilos)
    }
  })

  it('amit nem latott, azt nem talalja ki -- nincs kitalalt metadata', () => {
    const m = listDrvfsMounts(MOUNTS)!.find((x) => x.mountpoint === '/mnt/f')!
    expect(usefulMountOptions(m.raw)).not.toContain('metadata')
  })
})

describe('helyreallitasi terv', () => {
  it('a sajat csatolasrol olvasva: "measured"', () => {
    const t = depotRemountPlan('/mnt/f/Marveen', listDrvfsMounts(MOUNTS))!
    expect(t.drive).toBe('F')
    expect(t.mountpoint).toBe('/mnt/f')
    expect(t.optionSource).toBe('measured')
    expect(t.command).toContain("mount -t drvfs 'F:' /mnt/f")
  })

  // Ha a depo csatolasa mar eltunt, egy MASIK elo Windows-meghajto ugyanattol a
  // WSL-tol ugyanazokat az opciokat kapta. Ez meres, nem tipp -- de a felulet
  // KIMONDJA, hogy honnan jott, mert nem ugyanaz a bizonyossag.
  it('eltunt csatolasnal testverbol tanul, es ezt jelzi is', () => {
    const nelkule = listDrvfsMounts(MOUNTS)!.filter((x) => x.mountpoint !== '/mnt/f')
    const t = depotRemountPlan('/mnt/f/Marveen', nelkule)!
    expect(t.optionSource).toBe('sibling')
    expect(t.options).toContain('uid=1000')
  })

  it('ha egy csatolast sem latunk, azt MEGMONDJA -- nem tippel opciokat', () => {
    const t = depotRemountPlan('/mnt/f/Marveen', [])!
    expect(t.optionSource).toBe('unknown')
    expect(t.options).toBe('')
    // Parancs ilyenkor is van (a WSL alapertelmezesevel csatol), de a lap a
    // forras alapjan tudja, hogy ovatosan kell fogalmaznia.
    expect(t.command).toContain("mount -t drvfs 'F:' /mnt/f")
  })

  // A MERT HIBA: `&&` utan az `umount` "nincs is csatolva" valasza ELNYELTE
  // volna a lenyeget, magat a `mount`-ot.
  it('a parancs `;`-vel valaszt, nem `&&`-vel', () => {
    const t = depotRemountPlan('/mnt/f/Marveen', listDrvfsMounts(MOUNTS))!
    expect(t.command).toContain(' ; ')
    expect(t.command).not.toContain('&&')
  })

  // Nem minden depo Windows-meghajton van. Egy sima Linux-utvonalnal az
  // ujracsatolas nem a valasz, es javasolni is karos volna.
  it('nem Windows-meghajton nincs terv', () => {
    expect(depotRemountPlan('/home/boss/depo', listDrvfsMounts(MOUNTS))).toBeNull()
    expect(depotRemountPlan('/srv/adat', listDrvfsMounts(MOUNTS))).toBeNull()
  })
})

describe('onjavitas: argv es sudoers', () => {
  const terv = () => depotRemountPlan('/mnt/f/Marveen', listDrvfsMounts(MOUNTS))!

  // Ha a Marveen MAGA futtatja, nem hejjen keresztul megy: minden hejj-
  // ertelmezes (idezojel, pontosvesszo) egy lehetoseg arra, hogy mas parancs
  // fusson, mint amit a sudoers engedelyezett.
  it('ket kulon argv, hejj nelkul', () => {
    const [le, fel] = remountArgv(terv())
    expect(le).toEqual(['umount', '/mnt/f'])
    expect(fel!.slice(0, 5)).toEqual(['mount', '-t', 'drvfs', 'F:', '/mnt/f'])
    expect(fel).toContain('-o')
    // Semmi, amit egy hejj ertelmezne.
    for (const a of [...le!, ...fel!]) {
      expect(a).not.toContain(';')
      expect(a).not.toContain('&&')
      expect(a).not.toContain("'")
    }
  })

  it('opciok nelkul nincs ures -o', () => {
    const [, fel] = remountArgv(depotRemountPlan('/mnt/f/Marveen', [])!)
    expect(fel).not.toContain('-o')
  })

  // A LEGKENYESEBB PONT. A sudoers-ben a vesszo PARANCSOKAT valaszt el, az
  // opcio-listankban viszont (`uid=1000,gid=1000`) adat. Escape nelkul a sor
  // MAST engedelyezne, mint amit a felhasznalo lat rajta -- pont azt a fajta
  // csendes elteresti, ami miatt egy jogosultsag-sort sosem szabad tippbol irni.
  it('a vesszo ki van vedve az opciokban', () => {
    const sor = remountSudoersLine(terv(), 'boss')
    expect(sor).toContain('uid=1000\\,gid=1000')
    // Egyetlen valodi parancs-elvalaszto vesszo van: a ket parancs kozott.
    const elvalasztok = sor.split('NOPASSWD:')[1]!.replace(/\\,/g, '').match(/,/g) || []
    expect(elvalasztok.length).toBe(1)
  })

  it('teljes eleresi utat ad, es csak a ket parancsot engedi', () => {
    const sor = remountSudoersLine(terv(), 'boss')
    expect(sor).toContain('boss ALL=(root) NOPASSWD:')
    expect(sor).toContain('/usr/bin/umount /mnt/f')
    expect(sor).toContain('/usr/bin/mount -t drvfs F: /mnt/f')
    // Ami TILOS: barmi szabadon hagyott hatokor.
    expect(sor).not.toContain('ALL=(ALL)')
    expect(sor).not.toMatch(/NOPASSWD:\s*ALL/)
    expect(sor).not.toContain('*')
  })

  // A sor es a tenylegesen futtatott parancs UGYANABBOL a tervbol keszul.
  // Ha elcsusznanak egymastol, a felhasznalo engedelyt adna valamire, amit a
  // Marveen sosem futtat -- es a javitas tovabbra sem mukodne, ok nelkul.
  it('a sudoers-sor es az argv nem tud elcsuszni egymastol', () => {
    const p = terv()
    const sor = remountSudoersLine(p, 'boss')
    for (const argv of remountArgv(p)) {
      for (const a of argv.slice(1)) {
        expect(sor).toContain(a.replace(/,/g, '\\,'))
      }
    }
  })
})
