// MIT HOZTUNK MAR LETRE EGYSZER -- AZ ELETFA NAPLOJA.
//
// Boss, 2026-09-20: "ha a user azt akarja, hogy onnan torlodjon ki es kitorli
// kezzel, akkor azt ne hozza mar vissza, miert szol bele a dashboard meg az
// ellenorzes... Mi az, hogy ellent mondunk a usernek?"
//
// A fa TERVET a kod adja (`planLifeTree`), a lemezen pedig csak azt latjuk,
// hogy egy tervezett mappa VAN-e vagy NINCS. Ez a puszta "nincs" KET,
// EGYMASSAL ELLENTETES dolgot jelenthet:
//
//   1. MEG SOHA NEM LETEZETT -> friss telepites vagy uj szemely a fabam:
//      letre KELL hozni, es addig joggal "hianyzik".
//   2. LETEZETT, ES A FELHASZNALO KITOROLTE -> el kell hagyni: se az
//      `ensureLifeTree` nem irhatja vissza, se az allapot nem jelezheti
//      hibanak. A felhasznalo dontott.
//
// A ket eset a lemezrol nezve TELJESEN egyforma, ezert all itt egy naplo:
// minden tervezett mappa, amit mar egyszer LATTUNK vagy LETREHOZTUNK. Ami
// benne van es megis hianyzik, azt a felhasznalo dobta el.
//
// Friss telepitesen a naplo nem letezik: olyankor minden hianyzo mappa az 1.
// eset (letrehozzuk), es a naplo maga az elso mereskor keletkezik. Nincs
// telepitoi lepes, nincs migracio.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logger } from './logger.js'

const LEDGER_FILE = 'life-tree-created.json'

export interface LifeTreeLedger {
  /** Melyik gyokerhez tartozik a naplo. Mas gyoker -> a naplo nem erre a fara szol. */
  root: string
  /** Relativ utvonalak, amiket mar lattunk/letrehoztunk a lemezen. */
  created: string[]
  updatedAt: string
}

export function lifeLedgerPath(): string {
  return join(STORE_DIR, LEDGER_FILE)
}

/** Ugyanaz a gyoker? (Zaro `/` es `\` nelkul hasonlitunk.) */
function sameRoot(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/[\\/]+$/, '')
  return norm(a) === norm(b)
}

/** A naplo, vagy `null`, ha meg nincs (friss telepites) vagy olvashatatlan. */
export function loadLifeLedger(): LifeTreeLedger | null {
  const p = lifeLedgerPath()
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'))
    const root = typeof raw?.root === 'string' ? raw.root : ''
    const created = Array.isArray(raw?.created) ? raw.created.filter((x: unknown) => typeof x === 'string') : []
    if (!root) return null
    return { root, created, updatedAt: String(raw?.updatedAt || '') }
  } catch (err: any) {
    // Sosem talalgatunk: a tenyleges hibat kiirjuk, es ugy viselkedunk, mintha
    // meg nem lenne naplo -- az a biztonsagos irany (letrehozunk, nem hagyunk el).
    logger.warn({ err: String(err?.message || err), path: p }, '[eletfa] a naplo nem olvashato')
    return null
  }
}

/**
 * Amit ezen a gyokeren mar lattunk. Ures halmaz, ha nincs naplo, vagy ha a
 * naplo MAS gyokerhez tartozik (kulso lemezt cserelt a felhasznalo): olyankor
 * a regi lista nem szol errol a farol, es a biztonsagos olvasat az, hogy meg
 * semmi nem letezett.
 */
export function lifeLedgerSeen(root: string): Set<string> {
  const led = loadLifeLedger()
  if (!led || !sameRoot(led.root, root)) return new Set()
  return new Set(led.created)
}

/**
 * Felvesszuk, hogy ezek a mappak MAR LETEZTEK. Csak akkor ir a lemezre, ha
 * tenylegesen valtozott a lista -- egy allapot-lekerdezes igy nem ir minden
 * masodpercben. Iras-hiba nem all meg semmit: naplozzuk, es a hivo a regi
 * (ovatos) viselkedest kapja.
 */
export function rememberLifeCreated(root: string, rels: string[]): { added: number; total: number } {
  const led = loadLifeLedger()
  const base = led && sameRoot(led.root, root) ? new Set(led.created) : new Set<string>()
  let added = 0
  for (const rel of rels) {
    if (!rel || base.has(rel)) continue
    base.add(rel)
    added++
  }
  const rootChanged = !led || !sameRoot(led.root, root)
  if (!added && !rootChanged) return { added: 0, total: base.size }
  const next: LifeTreeLedger = {
    root,
    created: [...base].sort(),
    updatedAt: new Date().toISOString(),
  }
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(lifeLedgerPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch (err: any) {
    logger.warn({ err: String(err?.message || err) }, '[eletfa] a naplot nem sikerult kiirni')
  }
  return { added, total: base.size }
}
