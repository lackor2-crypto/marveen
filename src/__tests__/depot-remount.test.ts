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
import { listDrvfsMounts, usefulMountOptions, depotRemountPlan } from '../depot-remount.js'

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
