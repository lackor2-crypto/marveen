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

const {
  safeLifeName, planLifeTree, ensureLifeTree, lifeTreeStatus, saveLifeConfig,
  defaultCountrySplit, defaultMediaKinds, MEDIA_COUNTRY_KEY,
} = await import('../life-tree.js')
const { resolveLifePath, listLife, moveLife, mkdirLife, searchLife, humanSize, humanLocation } = await import('../life-explorer.js')
const { setPhysical, getPhysical, movePhysical } = await import('../life-documents.js')

// A Boss kikotese (2026-08-21): "ne csak nalam, hanem a bakos evanal is ki kell
// epiteni... ugyanugy mint a korpas laszlonal." Ezert a masodik szemely UGYANAZT
// a 12 kategoriat kapja, csak kevesebb orszaggal -- a `cfg` ezt tukrozi.
const cfg = {
  persons: [
    {
      id: 'a', name: 'Teszt Elek', role: 'owner' as const,
      countries: ['Magyarország', 'Németország'],
      countrySplit: [...defaultCountrySplit(), MEDIA_COUNTRY_KEY],
      mediaKinds: defaultMediaKinds(),
      mediaGroups: ['Első család'],
      projects: [{ id: 'p1', name: 'Teszt projekt', development: true }],
    },
    {
      id: 'b', name: 'Példa-Kovács Anna', role: 'person' as const,
      countries: ['Magyarország'],
      countrySplit: defaultCountrySplit(),
      mediaKinds: defaultMediaKinds(),
      mediaGroups: [],
      projects: [],
    },
  ],
  companies: [{ id: 'c', name: 'Teszt Kft', countries: [], countrySplit: [] }],
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
  it('MINDEN szemely a teljes szerkezetet kapja, uresen is', () => {
    // Ez a teszt egyszer mar az ELLENKEZOJET allitotta ("a masodik szemelynek
    // nincs Munka aga"). A Boss ezt kifejezetten felulirta: aki bekerul a faba,
    // ugyanazt a 12 kategoriat kapja, meg ha ma nincs is benne semmi -- mert
    // egy hianyzo mappa miatt a papir a rossz helyre kerul.
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    for (const person of ['Teszt Elek', 'Példa-Kovács Anna']) {
      for (const cat of ['Identitás', 'Munka', 'Jogi', 'Egészség', 'Projektek']) {
        expect(nodes).toContain(`${person}/${cat}`)
      }
    }
  })

  it('nincs kulon ELET gyujtomappa -- a szemely a gyokerben all', () => {
    // Specifikacio 3. pont: "Ne legyen kulon ELET mappa a fenti szintek folott."
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes).toContain('Teszt Elek')
    expect(nodes.some((r) => r === 'ÉLET' || r.startsWith('ÉLET/'))).toBe(false)
  })

  it('az orszag-bontas szemelyenkent kulon all', () => {
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    // A gazdanak ket orszaga van, Annanak egy -- es Annanal SEM jelenik meg
    // olyan orszag, amit nem o adott meg.
    expect(nodes).toContain('Teszt Elek/Jogi/Németország')
    expect(nodes).toContain('Példa-Kovács Anna/Jogi/Magyarország')
    expect(nodes.some((r) => r.startsWith('Példa-Kovács Anna/Jogi/Németország'))).toBe(false)
  })

  it('a media is orszagra bomlik, ha a szemely azt kerte', () => {
    // "a fotok is kulon kellene szedni. mert nekem 3 orszagbol van fotok is
    // videok is." -- ezert kapcsolhato a MEDIA kulon.
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes).toContain('Média/Teszt Elek/Fotók/Németország')
    expect(nodes).toContain('Média/Teszt Elek/Videók/Németország')
    // Anna nem kerte: nala a FOTOK alatt CSOPORT all, nem orszag. (Maga a
    // `Fotók/` elotag nala is letezik -- a csoportok miatt --, ezert a
    // konkret orszagnevre kell kerdezni, kulonben a teszt semmit sem mer.)
    expect(nodes.some((r) => r.startsWith('Média/Példa-Kovács Anna/Fotók/Magyarország'))).toBe(false)
  })

  it('a szemelyes projekt a specifikacio szerinti helyen all', () => {
    // 31. pont: a szemelyes repok SOHA nem keverednek a cegesekkel.
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes).toContain('Teszt Elek/Projektek/Teszt projekt/Fejlesztés/GIT_REPOS')
    // Es NINCS orszag-szint a projekt-utvonalban, ami elrontana.
    expect(nodes.some((r) => r.startsWith('Teszt Elek/Projektek/Magyarország'))).toBe(false)
  })

  // A 36. pont ("a rendszer vegso kepe") szerint a `Rendszer` alatt EGYETLEN ag
  // all: a `Tárolók`. Korabban `Marvin` es `Git` is odakerult a 4. pont vazlata
  // alapjan -- de a `Marvin` a 8. alapszabaly szerint SZEMELYES projekt, a
  // git-repok pedig a 7. pont szerint a szemely/ceg `GIT_REPOS` mappajaban
  // vannak. Ez a teszt azt orzi, hogy egyik se szivarogjon vissza.
  it('a Rendszer alatt CSAK a Tárolók all (36. pont)', () => {
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes).toContain('Rendszer/Tárolók')
    expect(nodes.filter((r) => r.startsWith('Rendszer/'))).toEqual(['Rendszer/Tárolók'])
  })
  it('az orszag csak ott jelenik meg, ahol szamit', () => {
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes.some((r) => r.endsWith('Teszt Elek/Jogi/Németország'))).toBe(true)
    // Felso szinten SOHA nincs orszag.
    expect(nodes.some((r) => r === 'Németország')).toBe(false)
  })
  it('a ceg a CEGEK alatt all, nem a szemely alatt', () => {
    const nodes = planLifeTree(cfg, 'hu').map((n) => n.rel)
    expect(nodes.some((r) => r.startsWith('Cégek/Teszt Kft'))).toBe(true)
  })
})

describe('ensureLifeTree', () => {
  // Nincs egyetlen `ÉLET` mappa, amit letorolhetnank: a fa MINDEN felso agat
  // kulon kell elrakni az utbol, kulonben a "masodszor mar nem csinal semmit"
  // teszt egy felig meglevo fan futna, es zoldre menne akkor is, ha romlott.
  beforeEach(() => {
    for (const n of ['Teszt Elek', 'Példa-Kovács Anna', 'Cégek', 'Média', 'Tudás',
      'Digitális', 'Beérkező', 'Megosztott', 'Archív', 'Rendszer']) {
      rmSync(join(depot, n), { recursive: true, force: true })
    }
  })

  it('letrehozza a fat, es masodszor mar nem csinal semmit', () => {
    const first = ensureLifeTree(cfg, 'hu')
    expect(first.created.length).toBeGreaterThan(10)
    expect(first.failed).toEqual([])
    const second = ensureLifeTree(cfg, 'hu')
    expect(second.created).toEqual([])
  })

  it('nem nyul a mar bent levo fajlokhoz', () => {
    ensureLifeTree(cfg, 'hu')
    const doc = join(depot, 'Teszt Elek', 'Jogi', 'sajat.txt')
    writeFileSync(doc, 'sajat tartalom', 'utf8')
    ensureLifeTree(cfg, 'hu')
    expect(existsSync(doc)).toBe(true)
  })

  it('a status megmondja, mi hianyzik', () => {
    ensureLifeTree(cfg, 'hu')
    rmSync(join(depot, 'Beérkező'), { recursive: true, force: true })
    const st = lifeTreeStatus(cfg, 'hu')
    expect(st.missing).toContain('Beérkező')
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
  // A MENTES IS KELL, nem csak a mappak. A gyokerben a sorrendet a beallitas
  // adja (ki a gazda, kik a szemelyek) -- mappanevbol ezt kitalalni tilos
  // lenne (23. pont). Elesben a felulet mindig ment, mielott epit; a teszt
  // ugyanezt teszi, kulonben nem azt merne, ami valojaban tortenik.
  beforeEach(() => { saveLifeConfig(cfg); ensureLifeTree(cfg, 'hu') })

  it('a gyokerben a GAZDA all elol, a Rendszer leghatul', () => {
    // Ide jar a felhasznalo nap mint nap; a `Rendszer`-hez soha nem kell
    // hozzanyulnia. A sorrend ezt tukrozze, ne a betűrend.
    const l = listLife('', { deep: false })
    expect(l.folders[0]?.name).toBe('Teszt Elek')
    expect(l.folders[l.folders.length - 1]?.name).toBe('Rendszer')
  })
  it('minden tetel kap forrasjelvenyt', () => {
    const l = listLife('Teszt Elek', { deep: false })
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
    const l = listLife('Teszt Elek/Jogi', { deep: false })
    expect(l.breadcrumb.map((b) => b.name)).toEqual(['Marveen', 'Teszt Elek', 'Jogi'])
    expect(l.parent).toBe('Teszt Elek')
  })
})

describe('moveLife', () => {
  beforeEach(() => { ensureLifeTree(cfg, 'hu') })

  it('athelyez, es a papir-nyilvantartas vele megy', () => {
    const from = 'Beérkező/vegzes.pdf'
    writeFileSync(join(depot, 'Beérkező', 'vegzes.pdf'), 'x', 'utf8')
    setPhysical(from, { physical: true, location: 'Teszt Elek/Jogi', note: 'kék dosszié' })

    const r = moveLife(from, 'Teszt Elek/Jogi/Németország')
    expect(r.ok).toBe(true)
    expect(r.rel).toBe('Teszt Elek/Jogi/Németország/vegzes.pdf')
    // A regi utvonalon mar nincs adat, az ujon van -- kulonben a felhasznalo
    // azt latna, hogy "nincs papir peldany", holott van.
    expect(getPhysical(from).physical).toBe(false)
    expect(getPhysical(r.rel).note).toBe('kék dosszié')
  })

  it('SOHA nem ir felul azonos nevu fajlt', () => {
    const dir = join(depot, 'Beérkező')
    writeFileSync(join(dir, 'a.pdf'), 'uj', 'utf8')
    const target = join(depot, 'Teszt Elek', 'Jogi')
    writeFileSync(join(target, 'a.pdf'), 'REGI ES FONTOS', 'utf8')

    const r = moveLife('Beérkező/a.pdf', 'Teszt Elek/Jogi')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('exists')
    expect(existsSync(join(dir, 'a.pdf'))).toBe(true)
  })

  it('mappat nem enged onmagaba tenni', () => {
    const r = moveLife('Teszt Elek', 'Teszt Elek/Jogi')
    expect(r.ok).toBe(false)
    expect(r.code).toBe('into_self')
  })

  it('a fan kivulre nem mozgat', () => {
    expect(moveLife('Beérkező', '../../tmp').ok).toBe(false)
  })
})

describe('mkdirLife', () => {
  beforeEach(() => { ensureLifeTree(cfg, 'hu') })
  it('letrehoz, de utvonalat nem fogad el nevkent', () => {
    expect(mkdirLife('Beérkező', 'Új ügy').ok).toBe(true)
    expect(mkdirLife('Beérkező', 'a/b').ok).toBe(false)
    expect(mkdirLife('Beérkező', '   ').ok).toBe(false)
  })
})

describe('searchLife', () => {
  beforeEach(() => { ensureLifeTree(cfg, 'hu') })
  it('nev szerint talal, mappan atnyulva is', () => {
    writeFileSync(join(depot, 'Teszt Elek', 'Jogi', 'birosagi-vegzes.pdf'), 'x', 'utf8')
    const r = searchLife('', 'vegzes')
    expect(r.entries.some((e) => e.name === 'birosagi-vegzes.pdf')).toBe(true)
  })
  it('ures keresesre nem ad vissza mindent', () => {
    expect(searchLife('', '  ').entries).toEqual([])
  })
})

describe('apro segedek', () => {
  it('a meret emberi', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(2048)).toBe('2.0 KB')
    expect(humanSize(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })
  it('a hely emberi mondat, nem csupa nagybetu', () => {
    expect(humanLocation('Teszt Elek/Jogi/Németország')).toBe('Teszt Elek / Jogi / Németország')
  })
  it('a papir-bejegyzes mappastul koltozik', () => {
    setPhysical('X/a/1.pdf', { physical: true, location: 'polc' })
    setPhysical('X/a/2.pdf', { physical: true, location: 'polc' })
    expect(movePhysical('X/a', 'Y/b')).toBe(2)
    expect(getPhysical('Y/b/1.pdf').physical).toBe(true)
  })
})
