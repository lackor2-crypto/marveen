import { join, dirname } from 'node:path'
import { readFileSync, mkdirSync } from 'node:fs'
import { PROJECT_ROOT } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'

// Van-e csatolmanya egy uzenetnek: himalaya ezt NEM adja meg a boritek-JSON-ben,
// ezert uzenetenkent egy kulon `attachment list` hivas kell -- azaz egy kulon
// himalaya PROCESSZ, sajat IMAP-bejelentkezessel. Egy 50 leveles oldal igy 50
// bejelentkezes, ami merhetoen megfogta az egesz dashboardot: 2026-08-19-en a
// hullamkepben a /api/overview 11,5 mp, a /api/settings 7,9 mp lett, mikozben
// eppen egy ilyen kapocs-vizsgalat futott a hatterben (Boss: "az elso oszlop es
// masodik oszlop sem toltodik be hamar").
//
// Egy uzenet csatolmanya viszont SOSE valtozik meg, tehat ezt eleg egyszer
// megnezni -- oruran at ervenyes. A cache lemezre kerul, kulonben minden
// dashboard-ujraindulas (minden telepites) ujra lefuttatna az egeszet.
//
// A kulcs a Message-ID, nem a mappan beluli szamozott id: az id csak mappan
// belul egyedi, es torles utan akar el is csuszhat, a Message-ID viszont a
// levelhez tartozik (ugyanezert parositja a Fontos-jelzo is Message-ID-vel).
// Igy a Beerkezettben es az Elkuldottben levo ugyanazon level egy bejegyzes.
const STORE_PATH = join(PROJECT_ROOT, 'store', 'email-attachment-flags.json')

// Felso korlat, hogy a fajl ne hizzon vegtelenul. Tulcsordulaskor a
// legregebben beirt bejegyzesek esnek ki (a JSON kulcssorrendje = beirasi
// sorrend), azokat ugyis a legritkabban nezi meg ujra a felhasznalo.
const MAX_ENTRIES = 20000
const WRITE_DEBOUNCE_MS = 2000

let cache: Record<string, boolean> | null = null
let dirty = false
let writeTimer: ReturnType<typeof setTimeout> | null = null

function load(): Record<string, boolean> {
  if (cache) return cache
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf-8'))
    cache = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
      : {}
  } catch {
    cache = {}
  }
  return cache
}

function persist(): void {
  const data = load()
  const keys = Object.keys(data)
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete data[k]
  }
  try {
    mkdirSync(dirname(STORE_PATH), { recursive: true })
    atomicWriteFileSync(STORE_PATH, JSON.stringify(data))
    dirty = false
  } catch { /* a cache memoriaban igy is jo */ }
}

/** Amit mar tudunk: csak a listaban szereplo, ismert Message-ID-k. */
export function readAttachmentFlags(messageIds: string[]): Record<string, boolean> {
  const data = load()
  const out: Record<string, boolean> = {}
  for (const id of messageIds) {
    if (id && id in data) out[id] = data[id]
  }
  return out
}

/** Frissen megnezett uzenetek eredmenye. A lemezre iras kesleltetve, kotegelve. */
export function saveAttachmentFlags(flags: Record<string, boolean>): void {
  const data = load()
  let changed = false
  for (const [id, has] of Object.entries(flags)) {
    if (!id) continue
    if (data[id] === has) continue
    data[id] = has
    changed = true
  }
  if (!changed) return
  dirty = true
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(() => { writeTimer = null; persist() }, WRITE_DEBOUNCE_MS)
  // A folyamat leallasat ne tartsa eletben egy fuggo cache-iras.
  if (typeof (writeTimer as { unref?: () => void }).unref === 'function') (writeTimer as { unref: () => void }).unref()
}

/** Azonnali kiiras (leallitaskor / tesztben), a kesleltetes megvarasa nelkul.
 *  Ha nincs uj tudas, nem nyul a fajlhoz -- felesleges iras nem kockaztatja a
 *  meglevo cache-t. */
export function flushAttachmentFlags(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  if (cache && dirty) persist()
}

/** Csak teszthez: memoria-cache eldobasa, hogy a fajlbol toltson ujra. */
export function resetAttachmentFlagCache(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  cache = null
  dirty = false
}
