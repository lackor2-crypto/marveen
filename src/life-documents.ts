// FIZIKAI PELDANY: van-e papir alapon is, es hol.
//
// Boss, 2026-08-21: "Nem kell QR-kod. Nem kell mappa-ID. Nem kell kulon fizikai
// adatbazis. [...] Ha Marvin meghal, akkor is: Laci -> Jogi -> Nemetorszag ->
// Birosag, es megtalalod a papirt."
//
// Ezert ez a modul feltunoen keveset tud, es ez SZANDEKOS:
//
//  - Nincs azonosito-rendszer. A fizikai hely egy UTVONAL ugyanabban a faban,
//    amit a kepernyon latsz. `Nev / Jogi / NEMETORSZAG / BIROSAG` -- ugyanaz a
//    mondat mukodik a merevlemezen es a polcon allo iratrendezon.
//  - Nincs adatbazis-tabla. Egy JSON fajl a `store/`-ban, amit egy ember is el
//    tud olvasni es ki tud menteni. Ha egyszer serult, a fa ES a papirok
//    ugyanugy a helyukon vannak -- csak a Marveen nem tudja, melyiknek van
//    papir parja.
//  - A kulcs a fan BELULI relativ utvonal, nem az abszolut. Igy egy depo-
//    koltoztetes (mas lemez, mas gep) nem szakitja el a bejegyzeseket a
//    fajloktol.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const STORE_PATH = join(STORE_DIR, 'life-physical.json')

export interface PhysicalRecord {
  /** Van-e papir peldany. */
  physical: boolean
  /**
   * Hol all a papir -- ugyanazzal a fa-utvonallal, amit a kepernyon latsz.
   * Ures, ha `physical` hamis, vagy ha a felhasznalo meg nem mondta meg.
   */
  location: string
  /** Barmi, ami segit megtalalni: "kek dosszie", "2. fiok". */
  note: string
  updatedAt: string
}

type Store = Record<string, PhysicalRecord>

function load(): Store {
  try {
    if (!existsSync(STORE_PATH)) return {}
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    return raw && typeof raw === 'object' ? (raw as Store) : {}
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[eletfa] serult life-physical.json, ures nyilvantartassal indulok')
    return {}
  }
}

/**
 * Mentes ugy, hogy egy felbeszakadt iras ne vigye el az egeszet.
 *
 * Eloszor egy ideiglenes fajlba irunk, es csak utana nevezzuk at a helyere.
 * Egy aramszunet igy vagy a REGI, vagy az UJ tartalmat hagyja ott -- felig
 * megirt JSON-t nem.
 */
function save(store: Store): void {
  mkdirSync(STORE_DIR, { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, STORE_PATH)
}

/** Egy uresen indulo bejegyzes -- a felulet ezt mutatja, ha meg nincs adat. */
export function emptyPhysical(): PhysicalRecord {
  return { physical: false, location: '', note: '', updatedAt: '' }
}

/** Mi tudunk errol a fajlrol? Ismeretlen utvonalnal ures bejegyzes, nem hiba. */
export function getPhysical(rel: string): PhysicalRecord {
  const store = load()
  return store[normalizeKey(rel)] || emptyPhysical()
}

/**
 * Bejegyzes rogzitese.
 *
 * Ha `physical` hamis, a helyet es a megjegyzest is TOROLJUK. Kulonben ott
 * maradna egy "Jogi / Nemetorszag / Birosag" felirat egy olyan iratnal,
 * amirol epp azt mondtuk, hogy nincs papir peldanya -- es a felhasznalo
 * hiaba menne oda.
 */
export function setPhysical(rel: string, input: Partial<PhysicalRecord>): PhysicalRecord {
  const key = normalizeKey(rel)
  const store = load()
  const physical = Boolean(input.physical)
  const rec: PhysicalRecord = {
    physical,
    location: physical ? String(input.location ?? '').trim() : '',
    note: physical ? String(input.note ?? '').trim() : '',
    updatedAt: new Date().toISOString(),
  }
  // Az "nincs papir, nincs megjegyzes" allapot az ALAPERTELMEZES: ilyet nem
  // orzunk meg, kulonben a fajl minden megnezett irattal nonne.
  if (!rec.physical && !rec.note) delete store[key]
  else store[key] = rec
  save(store)
  return rec
}

/**
 * Minden bejegyzes -- ebbol keszul a "papir-terkep" (hol mi all a polcon).
 *
 * Hasznos akkor is, ha valaki egyszeruen ki akarja nyomtatni, mi van
 * dossziekban: pont ez a "Marvin nelkul is mukodjon" resze.
 */
export function listPhysical(): Array<PhysicalRecord & { path: string }> {
  const store = load()
  return Object.entries(store)
    .filter(([, r]) => r.physical)
    .map(([path, r]) => ({ path, ...r }))
    .sort((a, b) => a.location.localeCompare(b.location, 'hu') || a.path.localeCompare(b.path, 'hu'))
}

/**
 * A bejegyzes koveti a fajlt, ha atmozgatjuk.
 *
 * Enelkul egy Intezo-beli athelyezes utan a papir-informacio a REGI utvonalon
 * maradna, vagyis a semmin -- a felhasznalo pedig azt latna, hogy "nincs
 * fizikai peldany", holott van. Mappat is kezel: ami alatta volt, az is jon.
 */
export function movePhysical(fromRel: string, toRel: string): number {
  const from = normalizeKey(fromRel)
  const to = normalizeKey(toRel)
  if (!from || from === to) return 0
  const store = load()
  let moved = 0
  for (const key of Object.keys(store)) {
    if (key !== from && !key.startsWith(from + '/')) continue
    const suffix = key.slice(from.length)
    store[to + suffix] = store[key]
    delete store[key]
    moved++
  }
  if (moved) save(store)
  return moved
}

/** Egysegesitett kulcs: per-jel, se elol, se hatul felesleges jel. */
function normalizeKey(rel: string): string {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}
