// A forrásjelvény motorja: `detectSource`/`withStorage` (specifikáció 9. és
// 20. pontja), és a rajtuk át a lista- és info-végpont.
//
// A `storage-index.test.ts` már méri a legalsó réteget (`storageAt`) egy
// kézzel épített regiszteren. Ez a fájl az efölötti réteget méri: azt, hogy a
// `detectSource` TÉNYLEG ráakasztja-e mind az öt mezőt (`logicalPath`,
// `storageId`, `storageType`, `physicalPath`, `sourceProvider`) helyi, Drive-,
// Fotók- és Git-fájlra is, hogy a `vegyes` mappa nem hazudik egyetlen forrást,
// és hogy a nulla-szabály három oka (`no-depot`/`not-storage`/`unregistered`)
// a `life-explorer.ts` lista- és info-végpontjáig ÉR, nem csak a primitívig.
// Enélkül pont az a réteg maradna méretlen, ahol a jelvény csendben elveszhet
// a felület felé menet.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const depot = mkdtempSync(join(tmpdir(), 'marveen-src-depot-'))
const store = mkdtempSync(join(tmpdir(), 'marveen-src-store-'))
const regFile = join(mkdtempSync(join(tmpdir(), 'marveen-src-reg-')), 'storages.json')
process.env.MARVEEN_DEPOT = depot

// A teszt SOSE irjon az eles `store/`-ba (lasd `life-tree.test.ts`) -- a
// STORE_DIR-t ideiglenes helyre iranyitjuk.
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, STORE_DIR: store }
})
// A `storageRegistryPath()` fuggveny a `storages.ts` SAJAT belso hivatkozasa
// a `readStorageRegistry()` alapertelmezett parameterehez -- ezt egy kulso
// mock nem eri el (a ket fuggveny UGYANABBAN a modulban hivja egymast, a
// `vi.mock` csak a MODULOK KOZOTTI hivatkozasokat cimezi at). Ezert nem a
// `storages.js`-t mockoljuk, hanem a `storage-index.js` `storageAt`-jat
// csomagoljuk be: a VALODI fuggvenyt hivjuk, csak a `root`/`registryFile`
// opciot adjuk hozza -- ugyanazt, amit a `storage-index.test.ts` is hasznal.
vi.mock('../storage-index.js', async () => {
  const actual = await vi.importActual<typeof import('../storage-index.js')>('../storage-index.js')
  return {
    ...actual,
    storageAt: (abs: string) => actual.storageAt(abs, { root: process.env.MARVEEN_DEPOT || null, registryFile: regFile }),
  }
})

const {
  detectSource, resetSourceProviders, clearRepoCache, registerSourceProvider, listSourceKinds,
} = await import('../life-sources.js')
const { clearStorageIndexCache } = await import('../storage-index.js')
const { DEPOT_DRIVE, DEPOT_PHOTOS, DEPOT_PROJECTS } = await import('../depot.js')
const { listLife, lifeInfo } = await import('../life-explorer.js')

function writeRegistry(ids: Record<string, number>, names: Record<string, string> = {}): void {
  writeFileSync(regFile, JSON.stringify({ ids, names, disabled: {}, gitAccounts: [] }), 'utf-8')
}

beforeEach(() => {
  clearStorageIndexCache()
  clearRepoCache()
  resetSourceProviders()
  writeRegistry({})
})

afterAll(() => {
  rmSync(depot, { recursive: true, force: true })
  rmSync(store, { recursive: true, force: true })
})

describe('detectSource – a per-fájl forrásjelvény (9. és 20. pont)', () => {
  it('helyi fájlnál a `not-storage` a helyes válasz, nem hiányzó adat', () => {
    const dir = join(depot, 'Munka')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'jegyzet.txt')
    writeFileSync(file, 'x')

    const info = detectSource(file, false)
    expect(info.kind).toBe('local')
    expect(info.sourceProvider).toBe('local')
    expect(info.storageId).toBe(null)
    expect(info.storageType).toBe(null)
    expect(info.storageMiss).toBe('not-storage')
    expect(info.physicalPath).toBe(file)
  })

  it('két Drive-fiók a kiosztott sorszámmal különbözik meg, nem egyformán néz ki', () => {
    mkdirSync(join(depot, ...DEPOT_DRIVE.split('/'), 'lackor2', 'Számlák'), { recursive: true })
    mkdirSync(join(depot, ...DEPOT_DRIVE.split('/'), 'ceges', 'Számlák'), { recursive: true })
    writeRegistry({ 'drive:lackor2': 2, 'drive:ceges': 7 }, { 'drive:ceges': 'Céges fiók' })

    const a = join(depot, ...DEPOT_DRIVE.split('/'), 'lackor2', 'Számlák', '2026.pdf')
    writeFileSync(a, 'x')
    const b = join(depot, ...DEPOT_DRIVE.split('/'), 'ceges', 'Számlák', '2026.pdf')
    writeFileSync(b, 'x')

    const ia = detectSource(a, false)
    expect(ia.kind).toBe('drive')
    expect(ia.sourceProvider).toBe('drive')
    expect(ia.storageId).toBe('DRIVE_02')
    expect(ia.storageType).toBe('drive')
    expect(ia.storageMiss).toBe(null)
    expect(ia.physicalPath).toBe(a)

    const ib = detectSource(b, false)
    expect(ib.storageId).toBe('DRIVE_07')
    expect(ib.storageName).toBe('Céges fiók')
    expect(ia.storageId).not.toBe(ib.storageId)
  })

  it('Drive-fájl be nem sorszámozott fióknál: `unregistered`, nem találgatott azonosító', () => {
    mkdirSync(join(depot, ...DEPOT_DRIVE.split('/'), 'ujfiok'), { recursive: true })
    const file = join(depot, ...DEPOT_DRIVE.split('/'), 'ujfiok', 'x.pdf')
    writeFileSync(file, 'x')
    writeRegistry({})

    const info = detectSource(file, false)
    expect(info.kind).toBe('drive')
    expect(info.storageId).toBe(null)
    expect(info.storageMiss).toBe('unregistered')
  })

  it('Google Fotók fájlnál is a saját sorszáma jelenik meg', () => {
    mkdirSync(join(depot, ...DEPOT_PHOTOS.split('/'), 'usalackor'), { recursive: true })
    const file = join(depot, ...DEPOT_PHOTOS.split('/'), 'usalackor', 'IMG_1.jpg')
    writeFileSync(file, 'x')
    writeRegistry({ 'photos:usalackor': 1 })

    const info = detectSource(file, false)
    expect(info.kind).toBe('photos')
    expect(info.sourceProvider).toBe('photos')
    expect(info.storageId).toBe('PHOTOS_01')
    expect(info.storageType).toBe('photos')
  })

  it('git repó: a forrás git, ÉS a tárolóazonosító is kiosztható neki', () => {
    const repoDir = join(depot, ...DEPOT_PROJECTS.split('/'), 'teamA', 'myrepo')
    mkdirSync(join(repoDir, '.git'), { recursive: true })
    writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(repoDir, '.git', 'config'), '[remote "origin"]\n\turl = git@example.com:teamA/myrepo.git\n')
    const file = join(repoDir, 'README.md')
    writeFileSync(file, 'x')
    writeRegistry({ 'git:teamA': 1 })

    const info = detectSource(file, false)
    expect(info.kind).toBe('git')
    expect(info.sourceProvider).toBe('git')
    expect(info.storageId).toBe('GIT_01')
    expect(info.storageType).toBe('git')
    expect(info.details.some((d) => d.label === 'Branch' && d.value === 'main')).toBe(true)
  })

  it('vegyes mappa: nem választ egyet a forrásai közül, és nem talál ki azonosítót', () => {
    const dir = join(depot, 'Vegyes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sima.txt'), 'x')
    const repoDir = join(dir, 'repo')
    mkdirSync(join(repoDir, '.git'), { recursive: true })
    writeFileSync(join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')

    const info = detectSource(dir, true, true)
    expect(info.kind).toBe('mixed')
    expect(info.sourceProvider).toBe('mixed')
    expect(info.storageId).toBe(null)
    expect(info.storageMiss).toBe(null)
    const kinds = info.details.find((d) => d.label === 'Miből áll')?.value || ''
    expect(kinds).toContain('local')
    expect(kinds).toContain('git')
  })

  it('nincs beállítva raktár: `no-depot`, külön a többi hiányzó-októl', () => {
    const prev = process.env.MARVEEN_DEPOT
    delete process.env.MARVEEN_DEPOT
    try {
      const info = detectSource(join(tmpdir(), 'barmi.txt'), false)
      expect(info.storageId).toBe(null)
      expect(info.storageMiss).toBe('no-depot')
    } finally {
      process.env.MARVEEN_DEPOT = prev
    }
  })

  it('bővíthető: egy új tároló regisztrálása nem igényli a meglévők átírását', () => {
    registerSourceProvider({
      id: 'nas', priority: 200, label: 'NAS', short: 'NAS', icon: '🗄️',
      detect(abs) {
        return abs.includes('MyNas')
          ? { kind: 'nas', label: 'NAS', short: 'NAS', icon: '🗄️', details: [] }
          : null
      },
    })
    const info = detectSource(join(depot, 'MyNas', 'x.txt'), false)
    expect(info.kind).toBe('nas')
    expect(info.sourceProvider).toBe('nas')
  })

  it('listSourceKinds a négy beépített forrást és a vegyeset is felsorolja', () => {
    const ids = listSourceKinds().map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['local', 'drive', 'photos', 'git', 'mixed']))
  })
})

describe('life-explorer.ts – a jelvény tényleg eléri a lista- és info-végpontot', () => {
  it('listLife: a sor storageId-t hordoz, nem csak a fajtát', () => {
    mkdirSync(join(depot, ...DEPOT_DRIVE.split('/'), 'lackor2'), { recursive: true })
    writeFileSync(join(depot, ...DEPOT_DRIVE.split('/'), 'lackor2', 'szamla.pdf'), 'x')
    writeRegistry({ 'drive:lackor2': 3 })

    const listing = listLife(DEPOT_DRIVE + '/lackor2', { deep: false })
    expect(listing.message).toBe(null)
    const file = listing.files.find((f) => f.name === 'szamla.pdf')
    expect(file).toBeTruthy()
    expect(file!.source.kind).toBe('drive')
    expect(file!.source.storageId).toBe('DRIVE_03')
  })

  it('lifeInfo: mind az öt mező kitöltve, kiosztott sorszámnál üres a figyelmeztetés', () => {
    mkdirSync(join(depot, ...DEPOT_PHOTOS.split('/'), 'usalackor'), { recursive: true })
    const abs = join(depot, ...DEPOT_PHOTOS.split('/'), 'usalackor', 'IMG_1.jpg')
    writeFileSync(abs, 'x')
    writeRegistry({ 'photos:usalackor': 1 })

    const rel = DEPOT_PHOTOS + '/usalackor/IMG_1.jpg'
    const info = lifeInfo(rel)
    expect(info).toBeTruthy()
    expect(info!.storage.logicalPath).toBe(rel)
    expect(info!.storage.storageId).toBe('PHOTOS_01')
    expect(info!.storage.storageType).toBe('photos')
    expect(info!.storage.physicalPath).toBe(abs)
    expect(info!.storage.sourceProvider).toBe('photos')
    expect(info!.storage.storageNote).toBe('')
  })

  it('lifeInfo: nincs kiosztva sorszám -> emberi mondat, nem hallgatás és nem találgatás', () => {
    mkdirSync(join(depot, ...DEPOT_DRIVE.split('/'), 'ujfiok'), { recursive: true })
    const abs = join(depot, ...DEPOT_DRIVE.split('/'), 'ujfiok', 'x.pdf')
    writeFileSync(abs, 'x')
    writeRegistry({})

    const info = lifeInfo(DEPOT_DRIVE + '/ujfiok/x.pdf')
    expect(info!.storage.storageId).toBe(null)
    expect(info!.storage.sourceProvider).toBe('drive')
    expect(info!.storage.storageNote).toMatch(/Tárolók/)
  })

  it('lifeInfo: helyi fájlnál a figyelmeztetés azt mondja, ez a gépen van, nem hiányzó adat', () => {
    const dir = join(depot, 'Munka')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'jegyzet.txt'), 'x')

    const info = lifeInfo('Munka/jegyzet.txt')
    expect(info!.storage.storageId).toBe(null)
    expect(info!.storage.sourceProvider).toBe('local')
    expect(info!.storage.storageNote).toMatch(/gépeden/)
  })
})
