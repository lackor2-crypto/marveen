// BEKOTESEK: a fa egy pontja MASHOL levo tartalmat mutat.
//
// Ez az a darab, amitol az "egyseges eletfa" tenyleg egyseges lesz. A terv
// harom retege ugyanis nem ugyanaz a hely a lemezen:
//
//   ELET/<Nev>/Dokumentumok   <- amit a felhasznalo lat
//   drive/<fiok>/<mappa>      <- ahol a Drive-szinkron TENYLEG tartja
//   fotok/<fiok>              <- ahol a Google Photos kepei allnak
//   Rendszer/Git/<repo>      <- ahol a git repo van
//
// Ha ezeket ATMASOLNANK a fa ala, ket peldany lenne mindenbol, es a
// Drive-szinkron a masikat irna. Ha viszont csak LINKELNENK a fajlrendszerben,
// egy Windows Intezobol nezve egy jelkapcsolat-erdo fogadna a felhasznalot.
//
// Ezert BEKOTUNK: a Marveen tudja, hogy `ELET/<Nev>/MEDIA/FOTOK` mogott a
// `fotok/<fiok>` all, es oda navigal. Egy fajl EGY peldanyban letezik, es
// pontosan ott, ahol a szinkron amugy is tartja.
//
// Amit ez SZANDEKOSAN nem csinal: nem hoz letre semmit a Google oldalan, es
// nem masol. A bekotes egy MUTATO -- ha torlod, a fajlok a helyukon maradnak.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { STORE_DIR } from './config.js'
import { depotRoot } from './depot.js'
import { logger } from './logger.js'

const STORE_PATH = join(STORE_DIR, 'life-mounts.json')

export interface LifeMount {
  /**
   * Hol latszik a faban -- a DEPO gyokerehez kepest, per-jellel.
   * Peldaul: `Média/Kovács Anna/Fotók`.
   */
  rel: string
  /**
   * Hol van valojaban -- szinten a depo gyokerehez kepest.
   * Peldaul: `fotok/lackor2`. Depon KIVULRE nem mutathat.
   */
  target: string
  /** `drive` | `photos` | `git` | `local` -- csak a felirathoz kell. */
  kind: string
  /** Emberi felirat a feluletre: "lackor2 Google Fotók". */
  label: string
  addedAt: string
}

type Store = { mounts: LifeMount[] }

function load(): Store {
  try {
    if (!existsSync(STORE_PATH)) return { mounts: [] }
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    const mounts = Array.isArray(raw?.mounts) ? raw.mounts : []
    return { mounts: mounts.filter((m: any) => m && typeof m.rel === 'string' && typeof m.target === 'string') }
  } catch (err: any) {
    // Serult fajlnal NEM allunk meg: bekotes nelkul a fa tovabbra is
    // hasznalhato, csak a Drive/Fotok agak lesznek uresek. Egy hibauzenet
    // jobb, mint egy elindulni sem hajlando Intezo.
    logger.warn({ err: err?.message }, '[eletfa] serult life-mounts.json, bekotesek nelkul indulok')
    return { mounts: [] }
  }
}

function save(store: Store): void {
  mkdirSync(STORE_DIR, { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, STORE_PATH)
}

function norm(rel: string): string {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

export function listMounts(): LifeMount[] {
  return load().mounts.slice().sort((a, b) => a.rel.localeCompare(b.rel, 'hu'))
}

export interface MountResult { ok: boolean; message: string; code?: string; mount?: LifeMount }

/**
 * Uj bekotes.
 *
 * Harom dolgot utasitunk vissza, mind a harmat azert, mert kesobb csak zavart
 * okozna:
 *   - ha a cel nincs meg (elgepelt fiok- vagy mappanev),
 *   - ha ugyanoda mar van bekotes (melyik latszana?),
 *   - ha a bekotes SAJAT MAGA ALA mutat (vegtelen fa).
 */
export function addMount(input: { rel: string; target: string; kind?: string; label?: string }): MountResult {
  const root = depotRoot()
  if (!root) return { ok: false, code: 'no_depot', message: 'Nincs beállítva a raktár, ezért nincs mit bekötni.' }
  const rel = norm(input.rel)
  const target = norm(input.target)
  if (!rel) return { ok: false, code: 'bad_rel', message: 'Nem derült ki, a fa melyik pontjára kötnéd be.' }
  if (!target) return { ok: false, code: 'bad_target', message: 'Nem derült ki, mit kötnél be.' }
  if (rel === target) return { ok: false, code: 'same', message: 'Ez a mappa saját magára mutatna.' }
  if (target.startsWith(rel + '/') || rel.startsWith(target + '/')) {
    return { ok: false, code: 'nested', message: 'A bekötés és a célja nem lehet egymáson belül — a fa így önmagába érne vissza.' }
  }

  const absTarget = join(root, ...target.split('/'))
  if (absTarget !== root && !absTarget.startsWith(root + sep)) {
    return { ok: false, code: 'outside', message: 'A bekötés célja nincs a Marveen mappáján belül.' }
  }
  let isDir = false
  try { isDir = statSync(absTarget).isDirectory() } catch { isDir = false }
  if (!isDir) {
    return { ok: false, code: 'missing', message: `Ez a hely most nem létezik: ${target}. Előbb hozd létre vagy szinkronizáld.` }
  }

  const store = load()
  if (store.mounts.some((m) => m.rel === rel)) {
    return { ok: false, code: 'exists', message: 'Erre a helyre már van bekötés. Előbb töröld a régit.' }
  }
  const mount: LifeMount = {
    rel, target,
    kind: String(input.kind || 'local'),
    label: String(input.label || target),
    addedAt: new Date().toISOString(),
  }
  store.mounts.push(mount)
  save(store)
  logger.info({ rel, target }, '[eletfa] bekotes hozzaadva')
  return { ok: true, message: `Bekötve: ${rel} → ${target}`, mount }
}

/** Bekotes torlese. A FAJLOKHOZ NEM NYULUNK -- csak a mutato tunik el. */
export function removeMount(rel: string): MountResult {
  const key = norm(rel)
  const store = load()
  const before = store.mounts.length
  store.mounts = store.mounts.filter((m) => m.rel !== key)
  if (store.mounts.length === before) {
    return { ok: false, code: 'missing', message: 'Ilyen bekötés nincs.' }
  }
  save(store)
  return { ok: true, message: 'A bekötés megszűnt. A fájlok a helyükön maradtak — csak innen nem látszanak többé.' }
}

/**
 * Egy fa-beli utvonal leforditasa valodi helyre.
 *
 * A LEGHOSSZABB illeszkedo bekotes nyer: ha `X` es `X/Y` is be van
 * kotve, egy `X/Y/z.pdf` a masodikhoz tartozik. Ez nem elmeleti eset --
 * eppen ilyen lesz egy szemely dokumentum-Drive-ja alatt egy kulon
 * media-Drive.
 *
 * `null`, ha ezt az utvonalat egyetlen bekotes sem erinti (akkor a hivo a
 * szokasos modon dolgozik tovabb).
 */
export function resolveMount(rel: string): { target: string; mount: LifeMount } | null {
  const key = norm(rel)
  let best: LifeMount | null = null
  for (const m of load().mounts) {
    if (key === m.rel || key.startsWith(m.rel + '/')) {
      if (!best || m.rel.length > best.rel.length) best = m
    }
  }
  if (!best) return null
  const suffix = key.slice(best.rel.length).replace(/^\/+/, '')
  return { target: suffix ? `${best.target}/${suffix}` : best.target, mount: best }
}

/**
 * Visszafele: egy VALODI hely -> a fa-beli utvonal, ha bekotesen at latszik.
 *
 * Erre az athelyezes utan van szukseg: a felhasznalonak azt kell visszakapnia,
 * amit a kepernyon lat (`Kovács Anna/...`), nem azt, hogy `drive/lackor2/...`. A
 * legHOSSZABB celt valasztjuk ugyanazert, amiert oda is.
 */
export function unresolveMount(target: string): string | null {
  const key = norm(target)
  let best: LifeMount | null = null
  for (const m of load().mounts) {
    if (key === m.target || key.startsWith(m.target + '/')) {
      if (!best || m.target.length > best.target.length) best = m
    }
  }
  if (!best) return null
  const suffix = key.slice(best.target.length).replace(/^\/+/, '')
  return suffix ? `${best.rel}/${suffix}` : best.rel
}

/** Mely bekotesek jelennek meg KOZVETLENUL ebben a mappaban? */
export function mountsInside(rel: string): LifeMount[] {
  const key = norm(rel)
  const prefix = key ? key + '/' : ''
  return load().mounts.filter((m) => {
    if (!m.rel.startsWith(prefix)) return false
    return !m.rel.slice(prefix.length).includes('/')
  })
}
