// MEGJELENITETT MAPPANEVEK: a lemezen mas a nev, a feluleten mas.
//
// A fa mappanevei a LEMEZROL jonnek (a listLife nem forditja oket). Nehol
// viszont a lemez-nev technikai vagy semmitmondo -- pl. a `GIT_REPOS`, amit a
// git es a szinkron-utvonalak hasznalnak, ezert atnevezni TILOS (elszakadna a
// life-mounts.json minden bekotese). Ezert nem a mappat nevezzuk at, hanem egy
// MEGJELENITETT nevet adunk hozza: a lemezen marad `GIT_REPOS`, a feluleten
// "Marveen Repos" latszik. A navigacio tovabbra is az eredeti uton megy.
//
// A parositas host-specifikus DATA (mint a life-mounts.json), ezert a
// store/-ban el, nem a kodban. Friss telepitesen a fajl nincs meg -> ures map
// -> minden mappa a valodi nevet mutatja (semmi nem torik). A felhasznalo a
// feluletrol allithatja at (POST /api/life/display-name).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const STORE_PATH = join(STORE_DIR, 'life-labels.json')

/** rel (per-jeles, gyoker-relativ) -> a feluleten mutatott nev. */
type LabelMap = Record<string, string>

let cache: LabelMap | null = null
let cacheMtimeMs = -1

export function normRel(rel: string): string {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function load(): LabelMap {
  let mtimeMs = -1
  try { mtimeMs = existsSync(STORE_PATH) ? statSync(STORE_PATH).mtimeMs : -1 } catch { mtimeMs = -1 }
  if (cache !== null && mtimeMs === cacheMtimeMs) return cache
  if (mtimeMs === -1) { cache = {}; cacheMtimeMs = -1; return cache }
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, 'utf8'))
    const src = raw && typeof raw.labels === 'object' && raw.labels ? raw.labels : {}
    const out: LabelMap = {}
    for (const [k, v] of Object.entries(src)) {
      const key = normRel(k)
      if (key && typeof v === 'string' && v.trim()) out[key] = v.trim()
    }
    cache = out; cacheMtimeMs = mtimeMs
    return out
  } catch (err: any) {
    // Serult fajlnal NEM allunk meg: cimke nelkul a fa tovabbra is hasznalhato,
    // csak a valodi mappaneveket mutatja. Egy figyelmeztetes jobb, mint egy
    // elindulni sem hajlando Intezo.
    logger.warn({ err: err?.message }, '[eletfa] serult life-labels.json, megjelenitett nevek nelkul')
    cache = {}; cacheMtimeMs = mtimeMs
    return cache
  }
}

function save(map: LabelMap): void {
  mkdirSync(STORE_DIR, { recursive: true })
  const tmp = `${STORE_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify({ labels: map }, null, 2), 'utf8')
  renameSync(tmp, STORE_PATH)
  cache = null; cacheMtimeMs = -1 // kovetkezo load ujraolvas
}

/** A mappa MEGJELENITETT neve, vagy `null`, ha nincs beallitva (ekkor a valodi nev). */
export function displayLabelFor(rel: string): string | null {
  const key = normRel(rel)
  if (!key) return null
  return load()[key] ?? null
}

/** Az egesz parositas (a beallito felulethez). */
export function listDisplayLabels(): LabelMap {
  return { ...load() }
}

export interface SetLabelResult { ok: boolean; message: string; code?: string }

/**
 * Egy mappa megjelenitett nevet beallitja vagy TORLI (ures nev = torles ->
 * visszaall a valodi lemez-nevre). A rel-t a hivo mar ellenorizte (a fan
 * belul van); itt csak a nev-oldalt valogatjuk.
 */
export function setDisplayLabel(rel: string, name: string): SetLabelResult {
  const key = normRel(rel)
  if (!key) return { ok: false, code: 'no_rel', message: 'Nincs megadva, melyik mappa nevet allitanam.' }
  const map = { ...load() }
  const trimmed = String(name || '').trim()
  if (!trimmed) {
    if (!(key in map)) return { ok: true, message: 'Ennek a mappanak eddig sem volt kulon neve.' }
    delete map[key]
    save(map)
    return { ok: true, message: 'A megjelenitett nev torolve -- visszaallt a valodi mappanev.' }
  }
  if (trimmed.length > 120) return { ok: false, code: 'too_long', message: 'A nev tul hosszu (max 120 karakter).' }
  map[key] = trimmed
  save(map)
  return { ok: true, message: `A mappa mostantol "${trimmed}" neven latszik.` }
}
