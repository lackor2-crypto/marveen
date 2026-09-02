/**
 * MELYIK KULCS AZ AKTÍV -- a legkisebb modul, amit a trezor is behívhat.
 *
 * Boss, 2026-09-02: "akár felvihetne később egy legújabb GLM előfizetést is.
 * másodikat. nem?" -- ehhez kellett, hogy egy szolgáltatásból TÖBB kulcs is
 * elférjen egymás mellett. Amint kettő van, egy kérdés keletkezik, ami eddig
 * nem létezett: MELYIKKEL dolgozzon a flotta? Ez a fájl kizárólag arra a
 * kérdésre felel.
 *
 * MIÉRT KÜLÖN FÁJL. A `vault.ts` `getSecret()`-jének látnia kell a
 * választást, a választás listázásának viszont látnia kell a trezort. Ha egy
 * modulban lenne a kettő, körkörös import lenne belőle. Ezért itt CSAK a
 * mutató lakik (fájl beolvasás/írás, semmi trezor), a lista és a felület
 * logikája a `key-service-slots.ts`-ben.
 *
 * MI NEM KERÜL IDE: maga a kulcs. Ez a fájl csak AZONOSÍTÓKAT tárol, titkot
 * soha -- a titkok a titkosított trezorban maradnak. Ezért is olvasható
 * nyugodtan `0644`-gyel: aki látja, annyit tud meg, hogy két GLM-kulcs közül
 * most a második az aktív.
 *
 * A NULLA / HIÁNY KÉT DOLGOT JELENTHET. Ha nincs fájl, az azt jelenti, hogy a
 * felhasználó SOHA nem választott -- ilyenkor a trezor pontosan úgy viselkedik,
 * ahogy a választás bevezetése előtt (az alap-azonosító nyer). Ez a
 * visszafelé-kompatibilitás lényege: egy friss telepítésen és a mai
 * telepítéseken is bitre ugyanaz marad a viselkedés, amíg valaki nem választ.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { atomicWriteFileSync } from './atomic-write.js'
import { logger } from '../logger.js'

export const KEY_SERVICE_ACTIVE_PATH = join(STORE_DIR, 'key-service-active.json')

/** szolgáltatás-azonosító -> a választott hely (trezor-bejegyzés) azonosítója. */
export type ActiveMap = Record<string, string>

/**
 * A teljes mutató-térkép.
 *
 * Olvashatatlan fájlnál üreset adunk vissza ÉS naplózunk: a hallgatás itt azt
 * jelentené, hogy a flotta némán másik kulccsal (másik előfizetéssel, tehát
 * más pénzen) dolgozik tovább, mint amit a felhasználó kiválasztott.
 */
export function readActiveMap(path: string = KEY_SERVICE_ACTIVE_PATH): ActiveMap {
  if (!existsSync(path)) return {}
  let raw: string
  try { raw = readFileSync(path, 'utf-8') } catch (err) {
    logger.warn({ err, path }, 'key-service-active: a mutato-fajl nem olvashato, az alap-hely lep eletbe')
    return {}
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    logger.warn({ err, path }, 'key-service-active: a mutato-fajl serult, az alap-hely lep eletbe')
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: ActiveMap = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim()
  }
  return out
}

/** A választott hely azonosítója, vagy `null`, ha soha nem választottak. */
export function activeSlotFor(serviceId: string, path: string = KEY_SERVICE_ACTIVE_PATH): string | null {
  return readActiveMap(path)[serviceId] ?? null
}

/** Választás rögzítése. `null` = visszaáll az alapértelmezett helyre. */
export function setActiveSlotFor(serviceId: string, slotId: string | null, path: string = KEY_SERVICE_ACTIVE_PATH): void {
  const map = readActiveMap(path)
  if (slotId === null) delete map[serviceId]
  else map[serviceId] = slotId
  atomicWriteFileSync(path, JSON.stringify(map, null, 2) + '\n', { mode: 0o600 })
}
