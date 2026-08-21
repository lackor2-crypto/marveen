// Az eletfa es az Intezo motorjanak tesztjei.
//
// Amit itt megfogunk, az mind olyan hiba, amit a feluleten nezve NEM lehetne
// eszrevenni: egy kilepes a fabol csendben mukodik, egy felulirt irat pedig
// egyszeruen eltunik. Ezert ezek a tesztek nem a "szep esetet" nezik.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-life-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-store-'))
process.env.MARVEEN_DEPOT = depot

// A teszt SOSE irjon az eles `store/`-ba: a papir-nyilvantartas es az eletfa
// beallitasa ott lakik, es egy teszt-futas kulonben felulirna a Boss valodi
// adatait. Ezert a STORE_DIR-t ideiglenes mappara iranyitjuk.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { safeLifeName, planLifeTree, ensureLifeTree, lifeTreeStatus } = await import('../life-tree.js')
const { resolveLifePath, listLife, moveLife, mkdirLife, searchLife, humanSize, humanLocation } = await import('../life-explorer.js')
const { setPhysical, getPhysical, movePhysical } = await import('../life-documents.js')

const cfg = {
  persons: [
    { id: 'a', name: 'Teszt Elek', role: 'owner' as const, countries: ['MAGYARORSZÁG', 'NÉMETORSZÁG'], mediaGroups: ['ELSŐ CSALÁD'] },
    { id: 'b', name: 'Példa-Kovács Anna', role: 'person' as const, countries: [], mediaGroups: [] },
  ],
  companies: [{ id: 'c', name: 'Teszt Kft' }],
}

describe('safeLifeName', () => {
  it('megtartja az ekezetet es a kotojelet', () => {
    // Ez a lenyeg: egy `Példa-Kovács` nevu ember mappaja ne `P lda Kov cs`
    // legyen. A regi depo-tisztito eppen ezt csinalta volna.
    expect(safeLifeName('Példa-Kovács Anna')).toBe('Példa-Kovács Anna')
    expect(safeLifeName('ÉLET')).toBe('ÉLET')
  })
  it('kiszedi a Windows tiltott jeleit', () => {
    expect(safeLifeName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j')
  })
  it('a foglalt eszkoznevekhez ir egy jelet', () => {
    expect(safeLifeName('CON')).toBe('CON_')
    expect(safeLifeName('com1')).toBe('com1_')
  })
  it('ures nevbol nem csinal ures mappat', () => {
    expect(safeLifeName('   ')).toBe('_')
    expect(safeLifeName('...')).toBe('_')
  })
})

describe('planLifeTree', () => {
  it('a gazdanak tobb kategoriat ad, mint a tobbieknek', () => {
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes.some((r) => r.includes('Teszt Elek/MUNKA'))).toBe(true)
    // A masodik szemelynek NINCS MUNKA aga -- a terv igy kerte.
    expect(nodes.some((r) => r.includes('Példa-Kovács Anna/MUNKA'))).toBe(false)
  })
  it('az orszag csak ott jelenik meg, ahol szamit', () => {
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes.some((r) => r.endsWith('Teszt Elek/JOGI/NÉMETORSZÁG'))).toBe(true)
    // Felso szinten SOHA nincs orszag.
    expect(nodes.some((r) => r === 'NÉMETORSZÁG')).toBe(false)
  })
  it('a ceg a CEGEK alatt all, nem a szemely alatt', () => {
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes.some((r) => r.startsWith('CÉGEK/Teszt Kft'))).toBe(true)
  })
})

describe('ensureLifeTree', () => {
  beforeEach(() => { rmSync(join(depot, 'ÉLET'), { recursive: true, force: true }) })

  it('letrehozza a fat, es masodszor mar nem csinal semmit', () => {
    const first = ensureLifeTree(cfg, 'hu')
    expect(first.created.length).toBeGreaterThan(10)
    expect(first.failed).toEqual([])
    const second = ensureLifeTree(cfg, 'hu')
    expect(second.created).toEqual([])
  })

  it('nem nyul a mar bent levo fajlokhoz', () => {
    ensureLifeTree(cfg, 'hu')
    const doc = join(depot, 'ÉLET', 'Teszt Elek', 'JOGI', 'sajat.txt')
    writeFileSync(doc, 'sajat tartalom', 'utf8')
    ensureLifeTree(cfg, 'hu')
    expect(existsSync(doc)).toBe(true)
  })

  it('a status megmondja, mi hianyzik', () => {
    ensureLifeTree(cfg, 'hu')
    rmSync(join(depot, 'ÉLET', 'BEÉRKEZŐ'), { recursive: true, force: true })
    const st = lifeTreeStatus(cfg, 'hu')
    expect(st.missing).toContain('BEÉRKEZŐ')
  })
})

describe('resolveLifePath -- a gyokerbol nem lehet kilepni', () => {
  it('elutasitja a ..-t', () => {
    expect(resolveLifePath('../../etc')).toBeNull()
    expect(resolveLifePath('ÉLET/../../etc/passwd')).toBeNull()
  })
  it('az abszolut utvonalat a fan BELULRE ertelmezi', () => {
    // Nem hibat adunk, hanem a gyokerhez kepest olvassuk: a `/etc/passwd`
    // igy a fan beluli `etc/passwd` lesz (ami nincs is), nem a gep
    // jelszofajlja. A lenyeg, hogy kifele SEMMIKEPP ne mutasson.
    const r = resolveLifePath('/etc/passwd')
    expect(r).not.toBeNull()
    expect(r!.startsWith(depot)).toBe(true)
  })
  it('elutasitja a kifele mutato jelkapcsolatot', () => {
    // Ez az igazi proba: a `..`-ra szuro ellenorzesek ezen mennek at.
    const outside = mkdtempSync(join(tmpdir(), 'marveen-outside-'))
    writeFileSync(join(outside, 'titok.txt'), 'nem latszodhat', 'utf8')
    const link = join(depot, 'kifele')
    rmSync(link, { force: true })
    try { symlinkSync(outside, link) } catch { return } // ahol nem lehet linket csinalni, ott nincs mit tesztelni
    expect(resolveLifePath('kifele/titok.txt')).toBeNull()
    rmSync(link, { force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  it('a fan belul feloldja a meg nem letezo utvonalat is', () => {
    // Kell: egy uj mappa celjat is fel kell tudni oldani, mielott letezne.
    expect(resolveLifePath('ÉLET/MEGNINCS/ILYEN')).toContain('ÉLET')
  })
})

describe('listLife', () => {
  beforeEach(() => { ensureLifeTree(cfg, 'hu') })

  it('a gyokerben az ELET all elol', () => {
    const l = listLife('', { deep: false })
    expect(l.folders[0]?.name).toBe('ÉLET')
  })
  it('minden tetel kap forrasjelvenyt', () => {
    const l = listLife('ÉLET', { deep: false })
    expect(l.folders.length).toBeGreaterThan(0)
    for (const f of l.folders) {
      expect(f.source.icon).toBeTruthy()
      expect(f.source.label).toBeTruthy()
    }
  })
  it('a fan kivulre mutato keresre nem listaz, hanem uzen', () => {
    const l = listLife('../../etc')
    expect(l.folders).toEqual([])
    expect(l.message).toContain('nincs a Marveen')
  })
  it('morzsakat ad a visszalepeshez', () => {
    const l = listLife('ÉLET/Teszt Elek/JOGI', { deep: false })
    expect(l.breadcrumb.map((b) => b.name)).toEqual(['Marveen', 'ÉLET', 'Teszt Elek', 'JOGI'])
    expect(l.parent).toBe('ÉLET/Teszt Elek')
  })
})

describe('moveLife', () => {
  beforeEach(() => { ensureLifeTree(cfg, 'hu') })

  it('athelyez, es a papir-nyilvantartas vele megy', () => {
    const from = 'ÉLET/BEÉRKEZŐ/vegzes.pdf'
    writeFileSync(join(depot, 'ÉLET', 'BEÉRKEZŐ', 'vegzes.pdf'), 'x', 'utf8')
    setPhysical(from, { physical: true, location: 'ÉLET/Teszt Elek/JOGI', note: 'kék dosszié' })

    const r = moveLife(from, 'ÉLET/Teszt Elek/JOGI/NÉMETORSZÁG')
    expect(r.ok).toBe(true)
    expect(r.rel).toBe('ÉLET/Teszt Elek/JOGI/NÉMETORSZÁG/vegzes.pdf')
    // A regi utvonalon mar nincs adat, az ujon van -- kulonben a felhasznalo
    // azt latna, hogy "nincs papir peldany", holott van.
    expect(getPhysical(from).physical).toBe(false)
    expect(getPhysical(r.rel).note).toBe('kék dosszié')
  })

  it('SOHA nem ir felul azonos nevu fajlt', () => {
    const dir = join(depot, 'ÉLET', 'BEÉRKEZŐ')
    writeFileSync(join(dir, 'a.pdf'), 'uj', 'utf8')
    const target = join(depot, 'ÉLET', 'Teszt Elek', 'JOGI')
    writeFileSync(join(target, 'a.pdf'), 'REGI ES FONTOS', 'utf8')

    const r = moveLife('ÉLET/BEÉRKEZŐ/a.pdf', 'ÉLET/Teszt Elek/JOGI')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('exists')
    expect(existsSync(join(dir, 'a.pdf'))).toBe(true)
  })

  it('mappat nem enged onmagaba tenni', () => {
    const r = moveLife('ÉLET/Teszt Elek', 'ÉLET/Teszt Elek/JOGI')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('into_self')
  })

  it('a fan kivulre nem mozgat', () => {
    expect(moveLife('ÉLET/BEÉRKEZŐ', '../../tmp').ok).toBe(false)
  })
})

describe('mkdirLife', () => {
  beforeEach(() => { ensureLifeTree(cfg, 'hu') })
  it('letrehoz, de utvonalat nem fogad el nevkent', () => {
    expect(mkdirLife('ÉLET/BEÉRKEZŐ', 'Új ügy').ok).toBe(true)
    expect(mkdirLife('ÉLET/BEÉRKEZŐ', 'a/b').ok).toBe(false)
    expect(mkdirLife('ÉLET/BEÉRKEZŐ', '   ').ok).toBe(false)
  })
})

describe('searchLife', () => {
  beforeEach(() => { ensureLifeTree(cfg, 'hu') })
  it('nev szerint talal, mappan atnyulva is', () => {
    writeFileSync(join(depot, 'ÉLET', 'Teszt Elek', 'JOGI', 'birosagi-vegzes.pdf'), 'x', 'utf8')
    const r = searchLife('ÉLET', 'vegzes')
    expect(r.entries.some((e) => e.name === 'birosagi-vegzes.pdf')).toBe(true)
  })
  it('ures keresesre nem ad vissza mindent', () => {
    expect(searchLife('ÉLET', '  ').entries).toEqual([])
  })
})

describe('apro segedek', () => {
  it('a meret emberi', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
  it('a hely emberi mondat, nem csupa nagybetu', () => {
    expect(humanLocation('ÉLET/Teszt Elek/JOGI/NÉMETORSZÁG')).toBe('Teszt Elek / Jogi / Németország')
  })
  it('a papir-bejegyzes mappastul koltozik', () => {
    setPhysical('X/a/1.pdf', { physical: true, location: 'polc' })
    setPhysical('X/a/2.pdf', { physical: true, location: 'polc' })
    expect(movePhysical('X/a', 'Y/b')).toBe(2)
    expect(getPhysical('Y/b/1.pdf').physical).toBe(true)
  })
})
