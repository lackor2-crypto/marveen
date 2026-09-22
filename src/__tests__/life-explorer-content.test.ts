/**
 * Kartya #341 -- "jelold a nem ures mappakat + darabszam".
 *
 * A lenyeg nem a szamok szepsege, hanem hogy a NULLA KET DOLGOT JELENTHET:
 * "nincs benne semmi" vagy "nem lattam bele". Ez a teszt mindharom allapotot
 * kulon meri -- kulonben egy jogosultsag-hiba csendben "ures mappanak"
 * latszana, es a felhasznalo epp arra epitene, hogy nem kell belenezni.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-content-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-cstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { listLife, explorerRoot, mkdirLife, clearContentCache } = await import('../life-explorer.js')

const root = explorerRoot() as string
if (!root || !root.startsWith(depot)) {
  throw new Error('A teszt nem az ideiglenes depon all — nem indulok el.')
}

function folder(rel: string, name: string) {
  const l = listLife(rel, { lang: 'hu' })
  const f = l.folders.find((x) => x.name === name)
  if (!f) throw new Error(`nincs ilyen mappa a listaban: ${name} (${rel})`)
  return f
}

beforeEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  clearContentCache()
})

describe('mappa-tartalom meres (#341)', () => {
  it('aki NEM mutat darabszamot, az ne is fizessen erte (content: false)', () => {
    // A Beerkezo besorolo lanca csak nevet/utat olvas. Ha a meres ott is
    // lefutna, egy hideg halozati meghajton masodperceket varna a felhasznalo
    // egy olyan adatert, amit a kepernyon senki nem lat.
    mkdirSync(join(root, 'tele', 'egy'), { recursive: true })
    writeFileSync(join(root, 'tele', 'a.txt'), 'x')

    const nelkul = listLife('', { lang: 'hu', content: false })
    const f1 = nelkul.folders.find((x) => x.name === 'tele')
    expect(f1).toBeTruthy()
    expect(f1?.content).toBeUndefined()

    // Az alapertelmezes valtozatlan: aki nem mond semmit, meri.
    const vel = listLife('', { lang: 'hu' })
    expect(vel.folders.find((x) => x.name === 'tele')?.content?.state).toBe('has')
  })

  it('URES mappa: bizonyitottan ures, nulla darabszammal', () => {
    mkdirSync(join(root, 'ures'))
    const f = folder('', 'ures')
    expect(f.content?.state).toBe('empty')
    expect(f.content?.folders).toBe(0)
    expect(f.content?.files).toBe(0)
    expect(f.content?.deep).toBe('empty')
    expect(f.content?.reason).toBe('')
  })

  it('TELE mappa: "has", es a kozvetlen darabszamok pontosak', () => {
    mkdirSync(join(root, 'tele', 'egy'), { recursive: true })
    mkdirSync(join(root, 'tele', 'ketto'), { recursive: true })
    writeFileSync(join(root, 'tele', 'a.txt'), 'x')
    writeFileSync(join(root, 'tele', 'b.txt'), 'y')
    writeFileSync(join(root, 'tele', 'c.txt'), 'z')
    const f = folder('', 'tele')
    expect(f.content?.state).toBe('has')
    expect(f.content?.folders).toBe(2)
    expect(f.content?.files).toBe(3)
    expect(f.content?.deep).toBe('has')
  })

  it('CSAK URES ALMAPPAK: van benne valami, de sehol lent egy fajl sem', () => {
    // Ez Boss valos esete: Média > Audio / Fotók / Szkennek / Videók.
    for (const n of ['Audio', 'Fotók', 'Szkennek', 'Videók']) {
      mkdirSync(join(root, 'Média', n), { recursive: true })
    }
    const f = folder('', 'Média')
    expect(f.content?.state).toBe('has')
    expect(f.content?.folders).toBe(4)
    expect(f.content?.files).toBe(0)
    expect(f.content?.deep).toBe('empty')
  })

  it('MELYEN levo fajl: az ag "has", akkor is, ha kozvetlenul nincs fajl', () => {
    mkdirSync(join(root, 'ag', 'egy', 'ketto'), { recursive: true })
    writeFileSync(join(root, 'ag', 'egy', 'ketto', 'melyen.txt'), 'x')
    const f = folder('', 'ag')
    expect(f.content?.state).toBe('has')
    expect(f.content?.files).toBe(0)
    expect(f.content?.deep).toBe('has')
  })

  it('REJTETT tetelek nem szamitanak bele -- a lista sem mutatja oket', () => {
    mkdirSync(join(root, 'rejtett'))
    mkdirSync(join(root, 'rejtett', '.git'), { recursive: true })
    writeFileSync(join(root, 'rejtett', '.titok'), 'x')
    const f = folder('', 'rejtett')
    expect(f.content?.state).toBe('empty')
    expect(f.content?.folders).toBe(0)
    expect(f.content?.files).toBe(0)
  })

  it('NEM MERHETO (nincs jog): "unknown", NEM "empty", es megmondja az okat', () => {
    // Root-kent a jogosultsag-korlat nem ervenyes: ott nincs mit merni.
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    mkdirSync(join(root, 'zart'))
    writeFileSync(join(root, 'zart', 'benne.txt'), 'x')
    chmodSync(join(root, 'zart'), 0o000)
    try {
      const f = folder('', 'zart')
      expect(f.content?.state).toBe('unknown')
      expect(f.content?.folders).toBe(null)
      expect(f.content?.files).toBe(null)
      expect(f.content?.deep).toBe('unknown')
      // A valodi hibakod ott all az emberi mondatban -- nem talalgatas.
      expect(f.content?.reason).toMatch(/EACCES|EPERM/)
    } finally {
      chmodSync(join(root, 'zart'), 0o700)
    }
  })

  it('a hibauzenet KET NYELVEN jon, a felulet nyelve szerint', () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) return
    mkdirSync(join(root, 'zart2'))
    chmodSync(join(root, 'zart2'), 0o000)
    try {
      const hu = listLife('', { lang: 'hu' }).folders.find((x) => x.name === 'zart2')
      const en = listLife('', { lang: 'en' }).folders.find((x) => x.name === 'zart2')
      expect(hu?.content?.reason).toContain('jogom')
      expect(en?.content?.reason).toContain('permission')
    } finally {
      chmodSync(join(root, 'zart2'), 0o700)
    }
  })

  it('FAJLNAL nincs tartalom-mezo (nincs mit merni)', () => {
    writeFileSync(join(root, 'egy.txt'), 'x')
    const l = listLife('', { lang: 'hu' })
    const f = l.files.find((x) => x.name === 'egy.txt')
    expect(f?.content).toBeUndefined()
  })

  it('FRISS TELEPITES: ures fa eseten sem hasal el, es nem hazudik tartalmat', () => {
    const l = listLife('', { lang: 'hu' })
    expect(l.message).toBe(null)
    expect(l.folders).toEqual([])
    expect(l.files).toEqual([])
  })
})

describe('gyorsitotar (#341)', () => {
  it('a fa valtozasa utan MAR AZ UJ szamot mutatja, nem a regit', () => {
    mkdirSync(join(root, 'valtozo'))
    expect(folder('', 'valtozo').content?.state).toBe('empty')
    // Ugyanaz a mappa, uj tartalommal -- a gyorsitotar TTL-je meg le sem jart.
    const r = mkdirLife('valtozo', 'uj-almappa')
    expect(r.ok).toBe(true)
    const f = folder('', 'valtozo')
    expect(f.content?.state).toBe('has')
    expect(f.content?.folders).toBe(1)
  })

  it('a masodik lekeres ugyanazt mondja, mint az elso (a tar nem torzit)', () => {
    mkdirSync(join(root, 'ketszer', 'a'), { recursive: true })
    writeFileSync(join(root, 'ketszer', 'f.txt'), 'x')
    const egyszer = folder('', 'ketszer').content
    const megegyszer = folder('', 'ketszer').content
    expect(megegyszer).toEqual(egyszer)
  })
})

describe('koltsegkeret (#341 bugkereses)', () => {
  it('a keret miatt felbehagyott meres NEM ragad be "nem mert"-kent', async () => {
    // Melyen agazo fa: a bejaras biztosan tobb lepes, mint amennyit egy
    // kimerult keret enged. A lenyeg: a valasz vagy kesz szamokat hoz, vagy
    // BEVALLJA, hogy meg merik -- de sosem hazudik uresat.
    let hely = join(root, 'melyfa')
    for (let i = 0; i < 5; i++) { hely = join(hely, 'szint' + i) }
    mkdirSync(hely, { recursive: true })
    writeFileSync(join(hely, 'lent.txt'), 'x')
    const f = folder('', 'melyfa')
    expect(f.content?.state === 'has' || f.content?.pending === true).toBe(true)
    if (f.content?.state === 'has') expect(f.content?.folders).toBe(1)
    // Ures SOHA nem lehet: van alatta tartalom.
    expect(f.content?.state).not.toBe('empty')
  })

  it('a "meg merem" allapot MASIK dolog, mint a "nem tudom" -- es sosem ures', () => {
    mkdirSync(join(root, 'akarmi'))
    const c = folder('', 'akarmi').content
    if (c?.pending) {
      // Ha meg merjuk: nincs kitalalt darabszam.
      expect(c.folders).toBe(null)
      expect(c.files).toBe(null)
      expect(c.state).toBe('unknown')
      expect(c.reason).not.toBe('')
    } else {
      expect(c?.state).toBe('empty')
    }
  })
})
