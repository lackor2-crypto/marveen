// BEKOTESEK: a fa egy pontja mashol levo tartalmat mutat.
//
// A ket dolog, amit itt biztosra kell tudni:
//   - a bekotesen AT SEM lehet kilepni a fabol (kulonben a bekotes egy
//     megkerulo ut lenne a `resolveLifePath` korul),
//   - egy athelyezes utan a felhasznalo a FA szerinti utvonalat kapja vissza,
//     nem azt, hogy `drive/<fiok>/...` -- olyan helyet, amit sose latott.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-mount-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-mstore-'))
process.env.MARVEEN_DEPOT = depot

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})

const { ensureLifeTree } = await import('../life-tree.js')
const { addMount, removeMount, listMounts, resolveMount, unresolveMount } = await import('../life-mounts.js')
const { resolveLifePath, listLife, moveLife } = await import('../life-explorer.js')
const { mountCandidates } = await import('../life-mount-candidates.js')
const { DEPOT_PROJECTS, DEPOT_PHOTOS, DEPOT_DRIVE } = await import('../depot.js')

const cfg = {
  persons: [{ id: 'a', name: 'Teszt Elek', role: 'owner' as const, countries: ['Magyarország'], mediaGroups: ['Első család'] }],
  companies: [],
}

// A media a specifikacio 18. pontja ota KOZOS ag: `Média/<név>/Fotók`.
// Korabban a szemely alatt allt (`ÉLET/Teszt Elek/Média/Fotók`).
const MEDIA_PHOTOS = 'Média/Teszt Elek/Fotók'

beforeEach(() => {
  rmSync(join(store, 'life-mounts.json'), { force: true })
  rmSync(join(depot, ...DEPOT_PHOTOS.split('/')), { recursive: true, force: true })
  rmSync(join(depot, ...DEPOT_DRIVE.split('/')), { recursive: true, force: true })
  mkdirSync(join(depot, ...DEPOT_PHOTOS.split('/'), 'teszt-fiok'), { recursive: true })
  writeFileSync(join(depot, ...DEPOT_PHOTOS.split('/'), 'teszt-fiok', 'nyaralas.jpg'), 'x', 'utf8')
  ensureLifeTree(cfg, 'hu')
})

describe('addMount', () => {
  it('bekot egy letezo helyet', () => {
    const r = addMount({ rel: MEDIA_PHOTOS, target: `${DEPOT_PHOTOS}/teszt-fiok`, kind: 'photos', label: 'teszt-fiok Google Fotók' })
    expect(r.ok).toBe(true)
    expect(listMounts()).toHaveLength(1)
  })

  it('nem enged nem letezo celt', () => {
    // Elgepelt fioknev: itt kell megallni, mert kesobb csak egy ures mappa
    // latszana, es a felhasznalo azt hinne, elvesztek a kepei.
    const r = addMount({ rel: MEDIA_PHOTOS, target: `${DEPOT_PHOTOS}/nincs-ilyen` })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('missing')
  })

  it('nem enged egymasba agyazott bekotest', () => {
    const r = addMount({ rel: 'Média', target: 'Média/Teszt Elek' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('nested')
  })

  it('nem enged ket bekotest ugyanoda', () => {
    addMount({ rel: MEDIA_PHOTOS, target: `${DEPOT_PHOTOS}/teszt-fiok` })
    const r = addMount({ rel: MEDIA_PHOTOS, target: `${DEPOT_PHOTOS}/teszt-fiok` })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('exists')
  })

  it('nem enged a depon kivulre mutatni', () => {
    const r = addMount({ rel: MEDIA_PHOTOS, target: '../../../etc' })
    expect(r.ok).toBe(false)
  })
})

describe('a bekotes a fan at latszik', () => {
  beforeEach(() => { addMount({ rel: MEDIA_PHOTOS, target: `${DEPOT_PHOTOS}/teszt-fiok`, kind: 'photos', label: 'teszt-fiok Google Fotók' }) })

  it('a bekotott mappa tartalma a fa-utvonalon nyilik', () => {
    const l = listLife(MEDIA_PHOTOS, { deep: false })
    expect(l.files.map((f) => f.name)).toContain('nyaralas.jpg')
    // A gyerek utvonala a FA nyelven all, nem `fotok/...` -- kulonben a
    // kovetkezo kattintas mar a nyers helyre vinne.
    expect(l.files[0].rel.startsWith(MEDIA_PHOTOS)).toBe(true)
  })

  it('a szulomappaban jelolve latszik', () => {
    const l = listLife('Média/Teszt Elek', { deep: false })
    const photos = l.folders.find((f) => f.name === 'Fotók')
    expect(photos).toBeTruthy()
    expect(photos!.mounted).toBe('teszt-fiok Google Fotók')
    // A jelveny a CELT irja le: ranezesre latszik, hogy fotokat nyit meg.
    expect(photos!.source.kind).toBe('photos')
  })

  it('a bekotesen AT SEM lehet kilepni a fabol', () => {
    expect(resolveLifePath(MEDIA_PHOTOS + '/../../../../../../etc/passwd')).toBeNull()
  })

  it('a leghosszabb illeszkedo bekotes nyer', () => {
    mkdirSync(join(depot, ...DEPOT_DRIVE.split('/'), 'fiok2', 'Dokumentumok'), { recursive: true })
    addMount({ rel: 'Teszt Elek', target: `${DEPOT_DRIVE}/fiok2` })
    // A MEDIA/FOTOK-ra kulon bekotes van: azt kell latni, nem a Drive-ot.
    expect(resolveMount(MEDIA_PHOTOS + '/nyaralas.jpg')!.target).toBe(`${DEPOT_PHOTOS}/teszt-fiok/nyaralas.jpg`)
    expect(resolveMount('Teszt Elek/Jogi')!.target).toBe(`${DEPOT_DRIVE}/fiok2/Jogi`)
  })

  it('visszafele is fordit', () => {
    expect(unresolveMount(`${DEPOT_PHOTOS}/teszt-fiok/nyaralas.jpg`)).toBe(MEDIA_PHOTOS + '/nyaralas.jpg')
  })

  it('athelyezes utan a FA szerinti utvonalat kapjuk vissza', () => {
    writeFileSync(join(depot, 'Beérkező', 'kep.jpg'), 'x', 'utf8')
    const r = moveLife('Beérkező/kep.jpg', MEDIA_PHOTOS)
    expect(r.ok).toBe(true)
    expect(r.rel).toBe(MEDIA_PHOTOS + '/kep.jpg')
    // A fajl viszont VALOJABAN a fotok mappaban all -- egy peldanyban.
    expect(existsSync(join(depot, ...DEPOT_PHOTOS.split('/'), 'teszt-fiok', 'kep.jpg'))).toBe(true)
  })
})

describe('removeMount', () => {
  it('megszunteti a bekotest, de a fajlokhoz nem nyul', () => {
    addMount({ rel: MEDIA_PHOTOS, target: `${DEPOT_PHOTOS}/teszt-fiok` })
    const r = removeMount(MEDIA_PHOTOS)
    expect(r.ok).toBe(true)
    expect(existsSync(join(depot, ...DEPOT_PHOTOS.split('/'), 'teszt-fiok', 'nyaralas.jpg'))).toBe(true)
    expect(listMounts()).toEqual([])
  })
  it('nem letezo bekotesnel is emberi valaszt ad', () => {
    expect(removeMount('NINCS').ok).toBe(false)
  })
})

describe('mountCandidates', () => {
  it('felajanlja a fotok-fiokot es a Drive-mappakat', () => {
    mkdirSync(join(depot, ...DEPOT_DRIVE.split('/'), 'fiok2', 'Dokumentumok'), { recursive: true })
    const opts = mountCandidates()
    expect(opts.some((o) => o.target === `${DEPOT_PHOTOS}/teszt-fiok` && o.kind === 'photos')).toBe(true)
    expect(opts.some((o) => o.target === `${DEPOT_DRIVE}/fiok2` && o.kind === 'drive')).toBe(true)
    expect(opts.some((o) => o.target === `${DEPOT_DRIVE}/fiok2/Dokumentumok`)).toBe(true)
  })
  it('csak a valodi git repot ajanlja fel', () => {
    // A repok helye `Rendszer/Git` lett (specifikacio 4. pont); a `DEPOT_PROJECTS`
    // konstansbol dolgozunk, hogy egy kesobbi athelyezes ne itt bukjon el.
    mkdirSync(join(depot, DEPOT_PROJECTS, 'nem-repo'), { recursive: true })
    mkdirSync(join(depot, DEPOT_PROJECTS, 'igazi-repo', '.git'), { recursive: true })
    const opts = mountCandidates()
    expect(opts.some((o) => o.target === `${DEPOT_PROJECTS}/igazi-repo` && o.kind === 'git')).toBe(true)
    expect(opts.some((o) => o.target === `${DEPOT_PROJECTS}/nem-repo`)).toBe(false)
  })
})
