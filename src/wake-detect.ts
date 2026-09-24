/**
 * EBREDES-ERZEKELO: eszreveszi, ha a gep aludt.
 *
 * Boss, 2026-08-26: „ne legyen mar ilyen hogy minden reggel indulasnal
 * alandoan sargat jelez. (...) minden rendben van de o szol hogy nincs."
 *
 * A MERT ESET (2026-08-26 reggel, ket kulon sor, UGYANAZ az ok):
 *
 *  1. A git-lehuzas 06:49-kor futott, kozvetlenul ebredes utan. A WSL-ben
 *     ekkor meg nem volt nevfeloldas, ezert mind a het tavoli tarolo
 *     `Could not resolve host: github.com`-mal elhasalt. Hetkor mar mukodott
 *     a halozat -- de senki nem merte ujra, es a sarga sor ott maradt egesz
 *     napra.
 *  2. A Google elo ellenorzese utoljara elozo este 22:50-kor futott. Az orás
 *     `setInterval` alvas kozben NEM ketyeg, es ebredes utan nem potolja be a
 *     kimaradt korot -- a felulet ezert „8 oraja nem futott le"-t irt. Ez
 *     igaz volt, csak nem azt jelentette, hogy elromlott valami: azt
 *     jelentette, hogy a gep aludt.
 *
 * Mindket eset ugyanaz a hibaalak, mint a CLAUDE.md nulla-szabalya: a
 * „nem futott le" ket dolgot jelenthet -- „elromlott" vagy „nem is jart itt
 * az ido". A kettot a kodnak KULON kell tudnia, kulonben minden reggel
 * riaszt egy alvas miatt.
 *
 * A MEGOLDAS: egy percenkenti szivveres. Ha ket ver kozott sokkal tobb ido
 * telt el, mint egy perc, akkor a folyamat nem futott -- a gep aludt. Ez a
 * NAGYON olcso jel (egy `Date.now()` percenkent), es nem kell hozza sem
 * platformfuggo API, sem kulso csomag, sem jogosultsag. Friss telepitesen is
 * azonnal mukodik: nincs mit beallitani hozza.
 */

import { logger } from './logger.js'

/** Milyen suruen verunk. Egy perc eleg finom ahhoz, hogy az ebredest percre
 *  pontosan lassuk, es olyan olcso, hogy meg sem kottyan. */
const TICK_MS = 60 * 1000

/**
 * Ennel nagyobb kihagyast tekintunk alvasnak.
 *
 * Miert nem szoros a hatar? Mert egy terhelt gepen a `setInterval` amugy is
 * keshet nehany masodpercet, es egy hosszu szinkron muvelet is elnyelhet
 * egy-ket verest. Ot perc bizton tobb annal, amit rendes futas okozhat, es
 * bizton kevesebb annal, amit egy ejszakai alvas jelent.
 */
const SLEEP_GAP_MS = 5 * 60 * 1000

type WakeHandler = (aludtMs: number) => void

const handlers: WakeHandler[] = []

/** Mikor indult ez a folyamat. Ez maga is „ebredes": indulas utan ugyanugy
 *  nincs meg friss meres, mint alvas utan. */
const PROCESS_START = Date.now()

let utolsoEbredes = PROCESS_START
let timer: NodeJS.Timeout | null = null

/**
 * Mikor ebredt utoljara a gep (vagy indult a folyamat), epoch ms-ben.
 *
 * Az onellenorzes ezt hasznalja tureshez: egy meres, ami „N oraja nem
 * futott", de az ebredes ket perce volt, NEM hiba -- eppen most potolja.
 */
export function lastWakeAt(): number {
  return utolsoEbredes
}

/** Hany ms telt el az utolso ebredes ota. */
export function msSinceWake(now: number = Date.now()): number {
  return Math.max(0, now - utolsoEbredes)
}

/**
 * Iratkozz fel az ebredesre.
 *
 * A kezelo hibaja NEM allithatja meg a tobbit: ha a git-szinkron elszall, a
 * Google-ellenorzesnek attol meg le kell futnia. Ezert mindegyiket sajat
 * `try/catch` veszi korul.
 */
export function onWake(cb: WakeHandler): void {
  handlers.push(cb)
}

/** Csak teszthez: uritjuk a feliratkozokat es visszaallitjuk az orat. */
export function resetWakeDetectForTest(now: number = Date.now()): void {
  handlers.length = 0
  utolsoEbredes = now
}

/**
 * Csak teszthez / belso hasznalatra: kezzel jelentunk egy ebredest.
 *
 * Kulon fuggveny, hogy a logika (mi tortenik ebredeskor) tesztelheto legyen
 * anelkul, hogy barmelyik teszt valoban varna ot percet.
 */
export function fireWake(aludtMs: number, now: number = Date.now()): void {
  utolsoEbredes = now
  logger.info({ aludtPerc: Math.round(aludtMs / 60000) }, '[wake] a gep aludt -- a kimaradt ellenorzesek potlasa indul')
  for (const cb of handlers) {
    try { cb(aludtMs) } catch (err) {
      logger.warn({ err }, '[wake] egy ebredes-kezelo elszallt -- a tobbi ettol meg fut')
    }
  }
}

/**
 * Elinditja a szivverest.
 *
 * Az `unref()` fontos: ez a timer SOSE tarthatja eletben a folyamatot. Egy
 * percenkenti ver miatt nem szabad, hogy a leallitas beragadjon.
 */
export function startWakeDetect(): NodeJS.Timeout {
  let elozo = Date.now()
  timer = setInterval(() => {
    const most = Date.now()
    const res = most - elozo
    elozo = most
    if (res > SLEEP_GAP_MS) fireWake(res, most)
  }, TICK_MS)
  if (typeof timer.unref === 'function') timer.unref()
  logger.info({ tickSec: TICK_MS / 1000, alvasHatarPerc: SLEEP_GAP_MS / 60000 }, '[wake] ebredes-erzekelo beallitva')
  return timer
}

/** Leallitas -- a folyamat rendes kilepesehez. */
export function stopWakeDetect(): void {
  if (timer) { clearInterval(timer); timer = null }
}
