// Amit a Google SZABALYBOL nem ad ki -- egyszer megjegyezve, tobbet nem
// probalva.
//
// Boss, 2026-09-23: "ha valami olyasmi tortenik, amit nem tud letolteni ...
// csak azert, mert a Google nem engedi ... akkor is ezeket tegye be egy
// listaba, es viszont ne irja ki azt az onellenorzesnel, hogy ez egy problema.
// Nincs itt semmi problema ... Es innentol kezdve azt nem is probalja meg
// leszinkronizalni."
//
// Egy `cannotDownloadAbusiveFile` nem atmeneti hiba: a Google SEMMILYEN
// programnak nem adja oda a fajlt, se ujralogin, se helyfelszabaditas nem
// valtoztat rajta. Amig ez nem volt feljegyezve, minden ejszakai futas ujra
// nekifutott ugyanannak a negy fajlnak, es ujra sarga sort termelt -- a
// felhasznalo szamara ugyanaz a "hiba" jott vissza vegtelenszer, holott nem
// volt mit tennie vele.
//
// A lista NEM titkos es NEM vegleges: a Raktar oldalon latszik, es egy
// gombbal uritheto (`clearDriveSkiplist`), mert egy elhagyott jeloles utan a
// fajl ujra lehozhato. A "nem probaljuk ujra" nem jelentheti azt, hogy
// "elfelejtettuk".
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

export const DRIVE_SKIPLIST_PATH = join(PROJECT_ROOT, 'store', 'drive-skiplist.json')

export interface DriveSkipEntry {
  /** Melyik Google-fiokon. Tiz Drive mellett enelkul a sor ertelmezhetetlen. */
  account: string
  /** A Drive-fajlazonosito -- EZ a stabil kulcs, a nev valtozhat. */
  driveId: string
  /** A fajl neve a Drive-on, hogy a listaban felismerheto legyen. */
  driveName: string
  /** A teljes helyi ut, ahova kerult volna -- ide masolhato be kezzel. */
  localPath: string
  /** A paros ember-olvashato neve. */
  pair: string
  /** A Google SAJAT mondata. Sose a mi atfogalmazasunk. */
  reason: string
  /** Mikor jegyeztuk fel eloszor (ISO). */
  at: string
}

type SkipFile = Record<string, DriveSkipEntry>

/** A kulcs a fiok es a fajlazonosito parosa: ugyanaz a fajl ket fiokon ket tetel. */
export function skipKey(account: string, driveId: string): string {
  return `${account}|${driveId}`
}

/**
 * A feljegyzett kihagyasok.
 *
 * Hiba eseten URES -- es ez fontos: a hianyzo lista nem hazugsag, csak azt
 * jelenti, hogy nem tudunk kihagyni semmit, tehat a szinkron mindent
 * megprobal. Egy olvashatatlan fajl SOSE vezethet oda, hogy csendben tobb
 * fajlt hagyunk ki, mint amit a felhasznalo lat.
 */
export function loadDriveSkiplist(path: string = DRIVE_SKIPLIST_PATH): SkipFile {
  try {
    if (!existsSync(path)) return {}
    const o = JSON.parse(readFileSync(path, 'utf8'))
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: SkipFile = {}
    for (const [k, v] of Object.entries(o as Record<string, any>)) {
      if (!v || typeof v !== 'object') continue
      const account = String(v.account || '')
      const driveId = String(v.driveId || '')
      if (!account || !driveId) continue     // kulcs nelkul nem tudnank atugrani
      out[k || skipKey(account, driveId)] = {
        account,
        driveId,
        driveName: String(v.driveName || ''),
        localPath: String(v.localPath || ''),
        pair: String(v.pair || ''),
        reason: String(v.reason || ''),
        at: String(v.at || ''),
      }
    }
    return out
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-skiplist] a kihagyandó-listát nem tudtam beolvasni')
    return {}
  }
}

/** Egy tetel felvetele. Sose dob: a naplozas nem allithatja meg a szinkront. */
export function recordDriveSkip(e: DriveSkipEntry, path: string = DRIVE_SKIPLIST_PATH): void {
  if (!e.account || !e.driveId) return
  try {
    const all = loadDriveSkiplist(path)
    const kulcs = skipKey(e.account, e.driveId)
    // A MEGLEVO bejegyzest nem irjuk felul: az `at` az ELSO elutasitas ideje,
    // es abbol latszik, mennyi ideje all a listan. A nev es az ut viszont
    // frissul, mert azok valtozhattak.
    const regi = all[kulcs]
    all[kulcs] = regi
      ? { ...regi, driveName: e.driveName || regi.driveName, localPath: e.localPath || regi.localPath, pair: e.pair || regi.pair }
      : e
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`)
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-skiplist] a kihagyandó-listát nem tudtam kiírni')
  }
}

/** Rajta van-e? Betoltott listaval hivva egy bejarasban EGYSZER kell olvasni a lemezt. */
export function isDriveSkipped(account: string, driveId: string, list: SkipFile = loadDriveSkiplist()): boolean {
  return !!list[skipKey(account, driveId)]
}

/** Egyetlen tetel levetele -- a felhasznalo ujra megprobalhatja. */
export function removeDriveSkip(key: string, path: string = DRIVE_SKIPLIST_PATH): boolean {
  try {
    const all = loadDriveSkiplist(path)
    if (!all[key]) return false
    delete all[key]
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`)
    return true
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-skiplist] a kihagyandó tételt nem tudtam törölni')
    return false
  }
}

/** A teljes lista uritese -- a kovetkezo futas mindennek ujra nekifut. */
export function clearDriveSkiplist(path: string = DRIVE_SKIPLIST_PATH): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-skiplist] a kihagyandó-listát nem tudtam üríteni')
  }
}

/** A lista tomborol, LEGUJABB ELOL -- a kepernyo ezt jeleniti meg. */
export function driveSkiplistItems(list: SkipFile = loadDriveSkiplist()): Array<DriveSkipEntry & { key: string }> {
  return Object.entries(list)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
}
