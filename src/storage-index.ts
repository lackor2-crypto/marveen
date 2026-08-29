// EGY UTVONAL -> MELYIK TAROLO? A specifikacio 20. pontjanak `storageId`-je,
// per fajl.
//
// A 20. pont ot mezot ker minden fajlhoz: `logicalPath`, `storageId`,
// `storageType`, `physicalPath`, `sourceProvider`. Ebbol negy eddig is
// kiszamolhato volt (`life-sources.ts`), EGY nem: a `storageId`. A
// forrasjelveny a mappa bekotesebol KOVETKEZTETETT ("a Drive alatt van, tehat
// Drive"), es sosem mondta meg, MELYIK Drive-fiokrol van szo -- `DRIVE_02` es
// `DRIVE_07` ugyanugy nezett ki.
//
// MIERT KULON MODUL, es miert nem a `storages.ts`-ben:
//
//   A `listStorages()` a Google-fiokokat is kerdezi, es KIOSZT uj sorszamokat
//   (ir a lemezre). Egy mappalistazas minden soraert ezt lefuttatni ketszeresen
//   is rossz: lassu, es egy listazas kozben nem szabad, hogy a nyilvantartas
//   megvaltozzon. Ez a modul ezert CSAK OLVAS: a mar kiosztott sorszamokat
//   nezi, es sosem oszt ki ujat.
//
// A NULLA KET DOLGOT JELENTHET. Ha nincs `storageId`, annak harom KULONBOZO oka
// lehet, es a harmat kulon is mondjuk (`StorageMatch.reason`):
//
//   - `no-depot`      -- nincs beallitva raktar. Nem hiba, egy meg el nem
//                        vegzett beallitas; a felulet a Depo oldalra kuld.
//   - `not-storage`   -- ez az utvonal nem tarolo alatt van (helyi fajl).
//                        Ez a helyes valasz, nem hianyzo adat.
//   - `unregistered`  -- tarolo alatt VAN, de a fiokhoz meg nincs kiosztva
//                        sorszam. Ilyenkor a felulet nem talal ki azonositot,
//                        hanem megmondja, hova menjen erte.
//
// Amit sosem teszunk: sorszamot TIPPELNI a mappa sorrendjebol. A `DRIVE_02`
// egy tartos hivatkozas (a 20. pont szerint fajl-metaadatba megy); egy
// talalgatasbol szuletett azonosito kesobb mas tarolora mutatna.
import { existsSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { depotRoot, safeDepotName } from './depot.js'
import {
  readStorageRegistry, storageId, storageKey, storageKindRoot, storageRegistryPath,
  STORAGE_KINDS, type StorageKind, type StorageRegistryFile,
} from './storages.js'

export type StorageMissReason = 'no-depot' | 'not-storage' | 'unregistered'

export interface StorageMatch {
  /** `DRIVE_01`, vagy null ha nem allapithato meg. */
  id: string | null
  /** `drive` | `photos` | `git`, vagy null. */
  kind: StorageKind | null
  /** A fiok mappaneve (`lackor2`), vagy ures. */
  account: string
  /** Az ember adta nev, ha van; kulonben a fiok neve. Ures, ha nincs talalat. */
  name: string
  /** Miert nincs azonosito. `null`, ha VAN. */
  reason: StorageMissReason | null
}

const NO_DEPOT: StorageMatch = { id: null, kind: null, account: '', name: '', reason: 'no-depot' }
const NOT_STORAGE: StorageMatch = { id: null, kind: null, account: '', name: '', reason: 'not-storage' }

/**
 * Gyorsitotar a regiszterre.
 *
 * Egy 2000 soros mappalistazas kulonben 2000-szer olvasna ugyanazt a JSON-t.
 * A kulcs a fajl merete es modositasi ideje: ha a Tarolok oldalon atneveznek
 * egy tarolot, a kovetkezo listazas mar az uj nevet hozza -- ujraindulas
 * nelkul. Ha a fajl nem letezik, azt is CACHE-eljuk (`mtime = 0`), kulonben a
 * leggyakoribb eset -- friss telepites, meg nincs regiszter -- egyaltalan nem
 * gyorsulna.
 */
let cache: { stamp: string; reg: StorageRegistryFile } | null = null

/** Csak a teszteknek (es ha a raktar helye megvaltozik). */
export function clearStorageIndexCache(): void {
  cache = null
}

function registry(file?: string): StorageRegistryFile {
  let stamp = '0'
  const path = file
  try {
    const p = path ?? storageRegistryPath()
    const st = existsSync(p) ? statSync(p) : null
    stamp = st ? `${st.mtimeMs}:${st.size}` : '0'
  } catch {
    stamp = 'err'
  }
  if (cache && cache.stamp === stamp) return cache.reg
  const reg = path ? readStorageRegistry(path) : readStorageRegistry()
  cache = { stamp, reg }
  return reg
}

/** Utvonal-tartalmazas, ami nem dol be a `/a/bc` vs `/a/b` esetnek. */
function isUnder(abs: string, base: string): boolean {
  if (!base) return false
  const a = abs.replace(/[\\/]+$/, '')
  const b = base.replace(/[\\/]+$/, '')
  return a === b || a.startsWith(b + sep) || a.startsWith(b + '/')
}

function firstSegmentUnder(abs: string, base: string): string {
  const rest = abs.slice(base.length).replace(/^[\\/]+/, '')
  return rest.split(/[\\/]/)[0] || ''
}

/**
 * Melyik tarolobol jon ez az utvonal?
 *
 * SOSE DOB: egy lecsatolt lemez vagy egy serult regiszter nem allithatja meg
 * a mappalistazast -- ilyenkor `unregistered`/`no-depot` a valasz, es a
 * felhasznalo egy emberi mondatot lat, nem egy ures kepernyot.
 */
export function storageAt(abs: string, opts: { root?: string | null; registryFile?: string } = {}): StorageMatch {
  const root = opts.root === undefined ? depotRoot() : opts.root
  if (!root) return NO_DEPOT
  let reg: StorageRegistryFile
  try {
    reg = registry(opts.registryFile)
  } catch {
    // Olvashatatlan regiszter. A tarolo-fajtat meg meg tudjuk mondani az
    // utvonalbol, a sorszamot nem -- es nem is talaljuk ki.
    reg = { ids: {}, names: {}, disabled: {}, gitAccounts: [] }
  }

  for (const kind of STORAGE_KINDS) {
    const base = join(root, ...storageKindRoot(kind).split('/'))
    if (!isUnder(abs, base)) continue
    const folder = firstSegmentUnder(abs, base)
    // Maga a fajta-gyoker (`Tárolók/Drive`), fiok nelkul: nem EGY tarolo.
    if (!folder) return { id: null, kind, account: '', name: '', reason: 'unregistered' }
    // A lemezen a mappanev mar atesett a `safeDepotName`-en, a regiszter
    // kulcsa viszont a NYERS fioknev. Ezert a kulcsokat alakitjuk at, nem a
    // mappanevet vissza -- az utobbi nem egyertelmu (`a.b` es `a_b` ugyanaz
    // a mappa lenne).
    const hit = Object.entries(reg.ids).find(([key, n]) => {
      if (!key.startsWith(kind + ':') || typeof n !== 'number') return false
      return safeDepotName(key.slice(kind.length + 1)) === folder
    })
    if (!hit) return { id: null, kind, account: folder, name: folder, reason: 'unregistered' }
    const account = hit[0].slice(kind.length + 1)
    return {
      id: storageId(kind, hit[1]),
      kind,
      account,
      name: reg.names[storageKey(kind, account)] || account,
      reason: null,
    }
  }
  return NOT_STORAGE
}

/**
 * Emberi mondat arrol, MIERT nincs azonosito.
 *
 * Sosem talalgat okot: mind a harom ag egy MERT allapotbol jon (nincs raktar /
 * nem tarolo alatt van / nincs kiosztva sorszam), es mindegyik megmondja a
 * kovetkezo lepest.
 */
export function storageMissText(reason: StorageMissReason, lang = 'hu'): string {
  const hu = lang !== 'en'
  if (reason === 'no-depot') {
    return hu
      ? 'Nincs azonosító: még nincs beállítva, hol tárolja a Marveen a fájljaidat. Nyisd meg a Raktár oldalt.'
      : 'No identifier: the storage location is not set up yet. Open the Depot page.'
  }
  if (reason === 'not-storage') {
    return hu
      ? 'Nem tárolóból jön — ez a fájl a gépeden van.'
      : 'Not from a storage — this file lives on your machine.'
  }
  return hu
    ? 'Ismeretlen azonosító: ehhez a fiókhoz még nem osztottunk ki sorszámot. Nyisd meg a Raktár → Tárolók oldalt, ott megkapja.'
    : 'Unknown identifier: no number has been assigned to this account yet. Open Depot → Storages and it will get one.'
}
