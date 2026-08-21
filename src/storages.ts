// Tarolo-nyilvantartas -- a specifikacio 33. pontja ("Tarolokezelo") es a
// 36. pont vegso kepe (`Tarolok / DRIVE_01 ... DRIVE_10, GOOGLE_PHOTOS`).
//
// Boss, 2026-08-21: "tobb fiokosra kell megcsinalni. drive fotok es git is!
// tobb fiokkal."
//
// MERT KELL KULON REGISZTER, ha a lemezen mar ott all minden:
//
//   - A Drive es a Fotok MAR fiokonkenti mappaba ir (`depotAccountDir`), de
//     SEHOL nem latszik EGYUTT, hogy hany tarolo van, melyik el, melyikbe mikor
//     jott le valami. A 33. pont pont ezt keri: lista, allapot, atnevezes,
//     deaktivalas, ellenorzes.
//   - A Git eddig EGY, lapos mappa volt (`Tarolok/Git/<repo>`), fiok nelkul --
//     ez az egyetlen ag, ahol tenyleg hianyzott a tobbfiokossag. A ket
//     GitHub-fiok repoi igy egy halomban alltak, es a 31. pont szabalya (a
//     szemelyes repo SOHA ne keveredjen a cegessel) csak remenykedesen mult.
//
// MIERT NEM A MAPPANEV AZ AZONOSITO: a 35. pont szerint az ember szerint
// rendezunk. A lemezen ezert a mappa neve a FIOK neve marad (`Drive/lackor2`),
// nem `DRIVE_01` -- ugy is megtalalod, ha a Marveen nem fut. A `DRIVE_01`
// AZONOSITO viszont stabil kell legyen (a 20. pont `storageId`-je), ezert a
// kiosztast lemezre irjuk: ha egy fiokot kesobb atneveznek vagy kikapcsolnak,
// a mar rogzitett fizikai hivatkozasok nem csusznak el.

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { atomicWriteFileSync } from './web/atomic-write.js'
import { depotRoot, safeDepotName, DEPOT_DRIVE, DEPOT_PHOTOS, DEPOT_PROJECTS } from './depot.js'
import { PROJECT_ROOT } from './config.js'

/** A harom tarolo-fajta. Kulcs, nem megjelenitendo nev (29. pont). */
export type StorageKind = 'drive' | 'photos' | 'git'

export const STORAGE_KINDS: StorageKind[] = ['drive', 'photos', 'git']

/** Az azonosito elotagja fajtankent (`DRIVE_01`, `PHOTOS_01`, `GIT_01`). */
const ID_PREFIX: Record<StorageKind, string> = {
  drive: 'DRIVE',
  photos: 'PHOTOS',
  git: 'GIT',
}

/** A fa alatti gyoker fajtankent -- ide kerulnek a fiok-mappak. */
export function storageKindRoot(kind: StorageKind): string {
  if (kind === 'drive') return DEPOT_DRIVE
  if (kind === 'photos') return DEPOT_PHOTOS
  return DEPOT_PROJECTS
}

/** Egy tarolo a nyilvantartasban. */
export interface StorageRow {
  /** Stabil azonosito: `DRIVE_01`. Ez megy a fajl-metaadatba (20. pont). */
  id: string
  kind: StorageKind
  /** A fiok kulcsa -- ezzel hivja a Marveen a Google/Git oldalt. */
  account: string
  /** Amit a felhasznalo lat. Alapbol a fiok neve, atnevezheto. */
  name: string
  /** Kikapcsolva: marad a lemezen, de nem szinkronizalunk ra. */
  active: boolean
  /** A depon beluli utvonala (`Rendszer/Tárolók/Drive/lackor2`). */
  rel: string
  /** Teljes utvonal, vagy null ha nincs depo. */
  abs: string | null
  /** All-e mar a mappa a lemezen. */
  present: boolean
  /** Hany bejegyzes van benne (elso szint) -- gyors "van-e benne valami". */
  items: number
  /** Utolso valtozas ms-ben, vagy null. */
  changedAt: number | null
  /**
   * Van-e mogotte hitelesites. Drive/Fotok: van-e Google-tokenje. Git: felvett
   * fiok-e. Ha nincs, a sor MEGJELENIK (a mappa ott van), de figyelmeztet --
   * kulonben a felhasznalo azt hinne, hogy szinkronizalunk, holott nem.
   */
  connected: boolean
}

/** A lemezre irt resz: csak az, amit NEM lehet ujraszamolni. */
export interface StorageRegistryFile {
  /** `<kind>:<account>` -> kiosztott sorszam. Sosem hasznaljuk ujra. */
  ids: Record<string, number>
  /** `<kind>:<account>` -> ember adta nev. */
  names: Record<string, string>
  /** `<kind>:<account>` -> ki van-e kapcsolva. Csak a true-k szamitanak. */
  disabled: Record<string, boolean>
  /** A Git-fiokok -- ezeknek nincs Google-tokenjuk, csak itt leteznek. */
  gitAccounts: string[]
}

export function storageRegistryPath(): string {
  return join(PROJECT_ROOT, 'store', 'storages.json')
}

export function storageKey(kind: StorageKind, account: string): string {
  return kind + ':' + account
}

/**
 * A regiszter beolvasasa. Hibas vagy hianyzo fajl = ures regiszter: a tarolok
 * ettol meg latszanak (a lemez a forras), csak a nevek es az azonositok
 * allnak vissza alapertelmezesre. Sose dobunk, mert ez az oldal betoltesenek
 * az utjaban all.
 */
export function readStorageRegistry(file = storageRegistryPath()): StorageRegistryFile {
  const empty: StorageRegistryFile = { ids: {}, names: {}, disabled: {}, gitAccounts: [] }
  if (!existsSync(file)) return empty
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8'))
    return {
      ids: pick<number>(raw?.ids, (v) => typeof v === 'number' && v > 0),
      names: pick<string>(raw?.names, (v) => typeof v === 'string' && !!String(v).trim()),
      disabled: pick<boolean>(raw?.disabled, (v) => v === true),
      gitAccounts: Array.isArray(raw?.gitAccounts)
        ? raw.gitAccounts.filter((a: unknown) => typeof a === 'string' && !!a.trim()).map((a: string) => a.trim())
        : [],
    }
  } catch {
    return empty
  }
}

function pick<T>(raw: unknown, ok: (v: unknown) => boolean): Record<string, T> {
  const out: Record<string, T> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (ok(v)) out[k] = v as T
  }
  return out
}

export function writeStorageRegistry(reg: StorageRegistryFile, file = storageRegistryPath()): void {
  atomicWriteFileSync(file, JSON.stringify(reg, null, 2))
}

/**
 * Sorszam-kiosztas: minden `<fajta>:<fiok>` parhoz EGY szam, orokre.
 *
 * A szamokat NEM hasznaljuk ujra torles utan sem. Ha a `DRIVE_02` fiokot
 * levesszuk es kesobb ujat veszunk fel, az `DRIVE_04` lesz, nem `DRIVE_02` --
 * kulonben egy regi hivatkozas hirtelen mas tarolora mutatna. Ez ugyanaz az
 * ok, amiert egy szamlaszamot sem adnak ki ketszer.
 *
 * TISZTA fuggveny: a modositott regisztert adja vissza, nem ir lemezre.
 */
export function assignStorageId(
  reg: StorageRegistryFile,
  kind: StorageKind,
  account: string,
): { reg: StorageRegistryFile; id: string } {
  const key = storageKey(kind, account)
  let n = reg.ids[key]
  if (!n) {
    const used = Object.entries(reg.ids)
      .filter(([k]) => k.startsWith(kind + ':'))
      .map(([, v]) => v)
    n = (used.length ? Math.max(...used) : 0) + 1
    reg = { ...reg, ids: { ...reg.ids, [key]: n } }
  }
  return { reg, id: storageId(kind, n) }
}

/** `drive` + 1 -> `DRIVE_01`. Ketjegyu, mert a spec 10 tarolot emleget. */
export function storageId(kind: StorageKind, n: number): string {
  return ID_PREFIX[kind] + '_' + String(n).padStart(2, '0')
}

/**
 * A tarolok osszeszedese HAROM forrasbol, ebben a sorrendben:
 *
 *   1. a bekotott fiokok (Google-tokenek, illetve a felvett Git-fiokok),
 *   2. ami tenylegesen ott all a lemezen (akkor is, ha a token mar lejart),
 *   3. a regiszter (nev, azonosito, ki/be).
 *
 * A 2. pont a lenyeg: egy lejart tokenu fiok mappaja NEM tunhet el a listarol,
 * mert a fajlok ott vannak. Ilyenkor a sor `connected: false` -- lathato, hogy
 * a tartalom megvan, de szinkron nincs mogotte.
 */
export function listStorages(opts: {
  driveAccounts: string[]
  photosAccounts: string[]
  root?: string | null
  registry?: StorageRegistryFile
}): { rows: StorageRow[]; registry: StorageRegistryFile; changed: boolean } {
  const root = opts.root === undefined ? depotRoot() : opts.root
  let reg = opts.registry ?? readStorageRegistry()
  const before = JSON.stringify(reg.ids)

  const connectedBy: Record<StorageKind, string[]> = {
    drive: opts.driveAccounts,
    photos: opts.photosAccounts,
    git: reg.gitAccounts,
  }

  const rows: StorageRow[] = []
  for (const kind of STORAGE_KINDS) {
    const kindRel = storageKindRoot(kind)
    const kindAbs = root ? join(root, kindRel) : null
    const onDisk = kindAbs ? subdirs(kindAbs) : []
    // Uniozzuk: ami be van kotve ES ami a lemezen all. A sorrend a bekotottek
    // szerint indul, hogy az elo fiokok legyenek elol.
    const accounts: string[] = []
    for (const a of connectedBy[kind]) if (a && !accounts.includes(a)) accounts.push(a)
    for (const d of onDisk) {
      // A lemezen a mappanev mar atesett a `safeDepotName`-en, ezert a bekotott
      // fiokot is azon at hasonlitjuk -- kulonben egy pontot tartalmazo fiok
      // ketszer jelenne meg.
      if (accounts.some((a) => safeDepotName(a) === d)) continue
      accounts.push(d)
    }

    for (const account of accounts) {
      const r = assignStorageId(reg, kind, account)
      reg = r.reg
      const key = storageKey(kind, account)
      const rel = kindRel + '/' + safeDepotName(account)
      const abs = root ? join(root, kindRel, safeDepotName(account)) : null
      const st = abs ? safeStat(abs) : null
      rows.push({
        id: r.id,
        kind,
        account,
        name: reg.names[key] || account,
        active: reg.disabled[key] !== true,
        rel,
        abs,
        present: !!st,
        items: abs && st ? countEntries(abs) : 0,
        changedAt: st ? st.mtimeMs : null,
        connected: connectedBy[kind].includes(account),
      })
    }
  }

  return { rows, registry: reg, changed: JSON.stringify(reg.ids) !== before }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

function safeStat(p: string): { mtimeMs: number } | null {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

function countEntries(dir: string): number {
  try {
    return readdirSync(dir).length
  } catch {
    return 0
  }
}

/**
 * Uj Git-fiok felvetele.
 *
 * A Drive/Fotok fiokjai a Google-bejelentkezesbol jonnek -- azokat itt nem
 * lehet "felvenni". A Git-fioknak viszont nincs mas forrasa: ez a mappa neve,
 * ami ala a repoi kerulnek. Ezert csak ezt az EGY fajtat engedjuk hozzaadni,
 * kulonben egy elgepelt Drive-fiok ures, sosem szinkronizalodo sort szulne.
 */
export function addGitAccount(
  reg: StorageRegistryFile,
  account: string,
): { reg: StorageRegistryFile; error?: string } {
  const name = String(account || '').trim()
  if (!name) return { reg, error: 'Adj meg egy fióknevet.' }
  if (safeDepotName(name) !== name) {
    return { reg, error: 'A fiók neve csak betű, szám, kötőjel és aláhúzás lehet — mappanév lesz belőle.' }
  }
  if (reg.gitAccounts.includes(name)) return { reg, error: 'Ez a fiók már fel van véve.' }
  return { reg: { ...reg, gitAccounts: [...reg.gitAccounts, name] } }
}

/** Atnevezes -- csak a MEGJELENITETT nev valtozik, a mappa nem mozdul. */
export function renameStorage(
  reg: StorageRegistryFile,
  kind: StorageKind,
  account: string,
  name: string,
): StorageRegistryFile {
  const key = storageKey(kind, account)
  const trimmed = String(name || '').trim()
  const names = { ...reg.names }
  if (!trimmed || trimmed === account) delete names[key]
  else names[key] = trimmed.slice(0, 80)
  return { ...reg, names }
}

/** Ki/be kapcsolas. A fajlokhoz NEM nyulunk -- csak a szinkron all le. */
export function setStorageActive(
  reg: StorageRegistryFile,
  kind: StorageKind,
  account: string,
  active: boolean,
): StorageRegistryFile {
  const key = storageKey(kind, account)
  const disabled = { ...reg.disabled }
  if (active) delete disabled[key]
  else disabled[key] = true
  return { ...reg, disabled }
}

/** Egy fajta aktiv fiokjai -- ezt kerdezi a szinkron, mielott dolgozna. */
export function activeAccounts(rows: StorageRow[], kind: StorageKind): string[] {
  return rows.filter((r) => r.kind === kind && r.active && r.connected).map((r) => r.account)
}
