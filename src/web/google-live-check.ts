/**
 * Elo Google-ellenorzes, ami MAGATOL fut -- es ezert be tud kerulni az
 * Attekintes onellenorzesebe.
 *
 * Boss, 2026-08-22: "ami a legnagyobb baj itt az az, hogy miert nincsen ez sem
 * bekotve az attekintes oldalra az onellenorzesbe!?!? [...] mostmar veglegesen
 * koss be mindent es ne legyen nyitott semmi!"
 *
 * A MERT hiba, ami ezt kikenyszeritette (2026-08-22): mind a 10 Google-fiok
 * `invalid_grant`-ot adott, es errol SEMMI nem szolt. Harom fuggetlen retegen
 * csuszott at ugyanaz a kieses:
 *
 *  1. A lejarat-figyelo (credential-expiry.ts) fajl-alapu, es rossz orat mert:
 *     az access-token belyege oranként ujult, igy a refresh-token hatarideje
 *     minden frissiteskor egy hettel elore ugrott. (Ma javitva.)
 *  2. Az elo probe (google-auth-runner.ts) CSAK akkor fut, ha valaki megnyitja
 *     a Fiokok oldalt, es az eredmenye memoriaban el, 5 percig. Ha senki nem
 *     nyitja meg, soha senki nem kerdezi meg a Google-t.
 *  3. A python szkript hibaja sehova nem kerul: az `invalid_grant` 10 napra
 *     visszamenoleg NULLA-szor szerepel a systemd-naploban.
 *
 * Vagyis a rendszer egyetlen olyan pontja sem volt, ahol egy halott hozzaferes
 * magatol lathatova valt volna. Ez a modul az: oranként vegigkerdezi a
 * fiokokat, es az eredmenyt LEMEZRE irja. Onnan az onellenorzes (system-health)
 * halozat nelkul, azonnal olvassa -- tehat az Attekintes gyors marad, de mar
 * nem vak.
 *
 * Miert lemezre es nem memoriaba: a dashboard ujraindul (frissites, service
 * restart, osszeomlas), es egy memoriaban tartott eredmennyel az ujraindulas
 * utan megint "meg nem tudom" allapotbol indulnank -- pont akkor, amikor a
 * legtobbet szamit. A fajl tullel egy ujraindulast, es a KORA maga is jelzes:
 * ha az ellenorzo all, azt az onellenorzes kiirja (`google_live_stale`).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'
import { listGoogleAccounts, probeGoogleAccount } from './google-auth-runner.js'

export const GOOGLE_LIVE_FILE = '.google-live-check.json'

/** Oranként. A refresh-token hetente jar le, tehat ez boven surun van ahhoz,
 *  hogy a 2 napos figyelmezteto sav elott szoljunk -- es elég ritkan ahhoz,
 *  hogy tiz fiok napi 240 Google-hivasnal ne kerüljön többe. */
export const GOOGLE_LIVE_INTERVAL_MS = 60 * 60 * 1000

/** Indulas utan nem azonnal: a start a legterheltebb pillanat, es tiz python
 *  folyamat pont ott nem kell. Ket perc mulva mar minden a helyen van. */
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000

export interface GoogleLiveAccount {
  id: string
  ok: boolean
  /** 'expired' | 'test-user' | null -- a google-accounts.ts osztalyozasa. */
  kind: string | null
}

export interface GoogleLiveCheck {
  /** Epoch ms: mikor fejezodott be a kor. */
  checkedAt: number
  accounts: GoogleLiveAccount[]
}

export function readGoogleLiveCheck(storeDir: string = STORE_DIR): GoogleLiveCheck | null {
  const path = join(storeDir, GOOGLE_LIVE_FILE)
  if (!existsSync(path)) return null
  try {
    const d = JSON.parse(readFileSync(path, 'utf-8')) as GoogleLiveCheck
    if (!d || typeof d.checkedAt !== 'number' || !Array.isArray(d.accounts)) return null
    return d
  } catch {
    // Romlott fajl: ez "nem tudom", nem "minden rendben". A hivo a null-t
    // ugyanugy hangosan kezeli, mint a hianyzo fajlt.
    return null
  }
}

/** Atmeneti fajlon keresztul irunk: egy felbeszakadt iras ne hagyjon maga utan
 *  fel-JSON-t, amit az onellenorzes "nem tudom"-kent olvasna vissza. */
function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Egy kor: minden bekotott fiokot megkerdezunk, es leirjuk, mit valaszolt.
 *
 * `force: true`, mert az 5 perces probe-gyorsitotar itt pont a lenyeget venne
 * el: nem azt akarjuk tudni, mit valaszolt a Google, amikor valaki utoljara
 * megnyitotta a Fiokok oldalt, hanem azt, hogy MOST el-e a hozzaferes.
 * Sorosan, nem parhuzamosan -- tiz egyideju python folyamat ugyanazon a gepen
 * fut, mint az agensek.
 */
export async function runGoogleLiveCheck(storeDir: string = STORE_DIR): Promise<GoogleLiveCheck> {
  const accounts: GoogleLiveAccount[] = []
  for (const row of listGoogleAccounts()) {
    try {
      const r = await probeGoogleAccount(row.id, true)
      accounts.push({ id: row.id, ok: !!r.ok, kind: r.kind ?? null })
    } catch (err) {
      // Egy fiokon elhasalt probe nem viheti el az egesz kort: a tobbi fiokrol
      // szolo hir tobbet er, mint a semmi.
      logger.warn({ err, account: row.id }, '[google-live] a fiok ellenorzese nem sikerult')
      accounts.push({ id: row.id, ok: false, kind: null })
    }
  }
  const result: GoogleLiveCheck = { checkedAt: Date.now(), accounts }
  try {
    writeAtomic(join(storeDir, GOOGLE_LIVE_FILE), result)
  } catch (err) {
    logger.warn({ err }, '[google-live] az eredmenyt nem sikerult kiirni')
  }
  const rossz = accounts.filter(a => !a.ok).length
  if (rossz > 0) {
    logger.warn({ rossz, osszes: accounts.length }, '[google-live] elutasitott Google-fiokok')
  }
  return result
}

/**
 * Ugyanaz a kor, de a felulet gombjarol. Ha epp fut egy, a hivo ARRA var --
 * tiz fiok tiz python folyamat, es ket egyidejű kor a gepet is terheli, meg
 * fel-eredmenyt is irna. A gomb tehat sosem indit masodikat, csak
 * csatlakozik ahhoz, ami mar megy.
 */
let futoKor: Promise<GoogleLiveCheck> | null = null

export function runGoogleLiveCheckOnce(storeDir: string = STORE_DIR): Promise<GoogleLiveCheck> {
  if (!futoKor) {
    futoKor = runGoogleLiveCheck(storeDir).finally(() => { futoKor = null })
  }
  return futoKor
}

export function startGoogleLiveCheck(): NodeJS.Timeout | null {
  setTimeout(() => {
    runGoogleLiveCheck().catch(err => logger.warn({ err }, '[google-live] az elso kor nem sikerult'))
  }, FIRST_RUN_DELAY_MS)
  const timer = setInterval(() => {
    runGoogleLiveCheck().catch(err => logger.warn({ err }, '[google-live] a kor nem sikerult'))
  }, GOOGLE_LIVE_INTERVAL_MS)
  logger.info({ everyMinutes: GOOGLE_LIVE_INTERVAL_MS / 60000 }, '[google-live] elo Google-ellenorzes beallitva')
  return timer
}
