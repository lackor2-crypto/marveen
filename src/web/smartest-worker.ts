/**
 * "Ki a legokosabb ELO, tokennel biro agens?" -- tiszta dontesi logika.
 *
 * Boss, 2026-09-18: a "Commit es Push Most" gomb a legokosabb ELO, token-nel
 * biro (nem rate-limitelt) agensre bizza az elmaradt tarolok commit+push-at.
 * "ha egynel tobb tud dolgozni, akkor mindig azt valaszsza, amelyik az
 * okosabb. Tehat ne a haikut valaszsza, hanem inkabb az opus 5-ost ha van, meg
 * akarmelyik modellnel is mindig a legmagasabb verzioju modellt valaszsza."
 *
 * Ez a modul SZANDEKOSAN I/O-mentes es tiszta, hogy egysegteszt lefedhesse a
 * rangsort es a "van-e tokenje" dontest. Az ELO adatot (fut-e, mennyi a
 * keret) a hivo gyujti ossze es adja at.
 *
 * KIZAROLAG AZ 5 ORAS keretet nezzuk. Boss ismetelt szabalya (2026-08-16,
 * 2026-08-28): a heti (7 napos) szam KIJELZES, nem korlat -- a munkakepesseget
 * egyedul az 5 oras ablak donti el. Ezert ez a modul az 5 oras szazalekot
 * kapja, nem a ket ablak rosszabbikat (ellentetben a context-broker-rel).
 */

import { tierForPct, STALE_AFTER_MS } from '../rate-limit-status.js'

export interface WorkerCandidate {
  agent: string
  /** A konkret modell-azonosito, amin az agens fut (readAgentModel). */
  model: string
  /** Fut-e most az agens tmux munkamenete. */
  running: boolean
  /** Az 5 ORAS keret hasznalata 0..100, vagy null ha nincs meres. */
  fiveHourPct: number | null
  /** A meres idobelyege (epoch ms), vagy null ha nincs. */
  usageAt: number | null
}

export interface WorkerPick {
  agent: string
  model: string
}

/**
 * Mennyire alkalmas egy modell OVATOS, sok-eszkozos git-munkara (atvizsgalas,
 * ertelmes commit-uzenet, push, szetvalt ag felismerese)? Nagyobb = okosabb.
 *
 * A Claude-csalad megbizhatoan hasznal eszkozoket, ezert MINDEN Claude-szint a
 * nem-Claude (ingyenes OpenRouter / egyeb) modellek fole kerul. Csaladon belul:
 * Opus > Sonnet > Haiku, a verzio pedig a masodlagos rendezo -- igy az
 * "opus-5" megelozi az "opus-4-8"-at, az pedig a "sonnet-5"-ot es a "haiku"-t.
 *
 * Tiszta, determinisztikus fuggveny (nincs I/O, nincs ido).
 */
export function rankModelTier(model: string): number {
  const m = String(model || '').toLowerCase()
  const claude = m.match(/claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/)
  if (claude) {
    const familyBase = claude[1] === 'opus' ? 400 : claude[1] === 'sonnet' ? 300 : 200
    const major = Number(claude[2]) || 0
    const minor = claude[3] ? Number(claude[3]) : 0
    // opus-5 => 450, opus-4-8 => 448, sonnet-5 => 350, haiku-4-5 => 245
    return familyBase + major * 10 + Math.min(minor, 9)
  }
  // Nem-Claude (ingyenes OpenRouter, z-ai, stb.): jóval megbizhatatlanabbul
  // vegez ovatos git-munkat, ezert MINDEN Claude-szint ala kerul. A nevben
  // szereplo elso szam durva verzio-rangsor, hogy koztuk is a "legmagasabb
  // verzioju" nyerjen (Boss szabalya).
  const nums = m.match(/\d+/g)
  const ver = nums && nums.length ? Number(nums[0]) : 0
  return 100 + Math.min(ver, 99)
}

/**
 * Tud-e ez az agens MOST valos munkat vallalni? Fut, ES az 5 oras kerete nincs
 * kritikus szinten. Ismeretlen keret (nincs meres) => bizalom: egy sose merodott
 * agens valoszinubb, hogy friss, mint hogy kimerult. Elavult meres (30 percnel
 * regebbi) ugyanugy "ismeretlen"-nek szamit -- a tetlen agens statusline-ja
 * megfagy, es egy regi 96% kizarna egy reg helyreallt keretet.
 */
export function workerHasToken(c: WorkerCandidate, now: number = Date.now()): boolean {
  if (!c.running) return false
  if (c.fiveHourPct === null) return true
  if (c.usageAt !== null && now - c.usageAt > STALE_AFTER_MS) return true
  return tierForPct(c.fiveHourPct) !== 'critical'
}

/**
 * A legokosabb ELO, token-nel biro agens -- vagy null, ha egy sem tud most
 * dolgozni. Rendezes: (1) modell-okossag csokkeno, (2) tobb szabad keret
 * (kisebb 5h %) elore, (3) nev, hogy a valasztas determinisztikus legyen.
 */
export function pickSmartestWorker(cands: WorkerCandidate[], now: number = Date.now()): WorkerPick | null {
  const usable = cands.filter((c) => workerHasToken(c, now))
  if (!usable.length) return null
  usable.sort((a, b) => {
    const ta = rankModelTier(a.model)
    const tb = rankModelTier(b.model)
    if (ta !== tb) return tb - ta
    const ap = a.fiveHourPct === null ? -1 : a.fiveHourPct
    const bp = b.fiveHourPct === null ? -1 : b.fiveHourPct
    if (ap !== bp) return ap - bp
    return a.agent.localeCompare(b.agent)
  })
  return { agent: usable[0].agent, model: usable[0].model }
}
