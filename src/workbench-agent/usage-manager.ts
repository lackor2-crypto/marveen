/**
 * USAGE MANAGER -- a kozos 5 oras keret kapuja (kanban #336, 2. fazis, spec 0.2).
 *
 * A spec egy mondata: "A fleet es a Munkapad UGYANAZT a usage/rate-limit
 * rendszert hasznalja." Ezert ez a modul NEM uj meres: a szamot a MAR MEGLEVO
 * forrasokbol olvassa (a statusline-pillanatkepbol, `rate-limit-status-io`), es
 * ugyanazokkal a kuszobokkel dolgozik, mint a flotta (`rate-limit-status.ts`).
 * Amit hozzatesz, az a KAPU es a KONYVELES:
 *
 *   getUsage()      -- mennyi fogyott (0..100) es honnan tudjuk
 *   getWindow()     -- melyik 5 oras ablakban vagyunk, mikor all vissza
 *   getRemaining()  -- mennyi van meg, es szabad-e most inditani hivast
 *   reserve()       -- foglalas EGY hivas elott (a parhuzamos inditasok ellen)
 *   release()       -- a foglalas elengedese, ha a hivas nem indult el
 *   record()        -- a lefutott hivas konyvelese (mit vitt el)
 *
 * MIERT KELL A FOGLALAS, ha a szazalekot ugyis a Claude meri: a mert szazalek
 * KESVE jon (a statusline csak akkor ir, amikor az agens epp renderel). Ket
 * egyszerre inditott Munkapad-hivas ezert ugyanazt a "meg van hely" szamot
 * latna. A foglalas a sajat, MOSTANI inditasainkat szamolja -- ez az, amit a
 * kozos meres meg nem lat.
 *
 * CSAK AZ 5 ORAS ABLAK SZAMIT. A heti (sevenDay) keret NEM blokkol -- ez a
 * telepites kimondott szabalya (`rate-limit-gate-fivehour-only`), es a
 * `life-inbox-ai.ts` fiokvalasztasa is igy mukodik.
 *
 * A NULLA KET DOLGOT JELENTHET: ha nincs meres, az `unknown` -- NEM "0%".
 * Ilyenkor a kapu ENGED (a hianyzo meres nem tilthat le mindent), de a hivo
 * megkapja, hogy nem latunk oda, es ezt ki is irjuk a felhasznalonak.
 */
import { tierForPct, CAUTION_THRESHOLD_PCT, CRITICAL_THRESHOLD_PCT, STALE_AFTER_MS, type RateLimitTier } from '../rate-limit-status.js'
import { readRateLimitSnapshot } from '../web/rate-limit-status-io.js'
import { MAIN_AGENT_ID } from '../config.js'

/** Az 5 oras ablak hossza. A Claude sajat ablaka; csak a foglalasok
 *  elavulasahoz hasznaljuk, a szazalekot nem mi szamoljuk. */
export const WINDOW_MS = 5 * 60 * 60 * 1000

/**
 * Egy foglalas ennyi ido utan magatol elevul.
 *
 * Nem az 5 oras ablak: egy foglalas egyetlen modell-hivasra szol. Ha a hivo
 * osszeomlik a `release()`/`record()` elott, a foglalas nem ragadhat bent
 * orakig -- kulonben egy elszallt keres orokre elzarna a Munkapadot.
 */
export const RESERVATION_TTL_MS = 10 * 60 * 1000

/** Ennyi sajat hivas lehet egyszerre a levegoben. A Munkapad interaktiv:
 *  egy felhasznalo egy munkadarabon dolgozik, a parhuzamos inditas hiba. */
export const MAX_CONCURRENT = 3

export type UsageSource = 'snapshot' | 'none'

export interface UsageWindowInfo {
  /** 0..100, vagy null ha NINCS meres (nem 0!). */
  usedPct: number | null
  /** Epoch ms, mikor all vissza a keret. null = nem tudjuk. */
  resetsAt: number | null
  /** Mikor mertek ezt. null = nincs meres. */
  measuredAt: number | null
  /** Regebbi-e a meres, mint amit meg elfogadunk. */
  stale: boolean
  source: UsageSource
}

export interface UsageInfo extends UsageWindowInfo {
  tier: RateLimitTier
  /** Hany sajat hivas van eppen a levegoben (foglalva). */
  inFlight: number
}

export type BlockReason = 'limit_critical' | 'too_many_in_flight'

export interface RemainingInfo {
  /** Szabad-e MOST uj hivast inditani. */
  allowed: boolean
  /** Miert nem, ha nem. */
  reason: BlockReason | null
  /** Meg felhasznalhato szazalek a kritikus kuszobig; null ha nincs meres. */
  remainingPct: number | null
  usage: UsageInfo
}

export interface Reservation {
  id: string
  at: number
  agent: string
}

export interface RecordedCall {
  at: number
  agent: string
  model: string
  /** Sikerult-e a hivas. A 'limit' kulon: azt jelenti, a szolgaltato mondta ki. */
  outcome: 'ok' | 'error' | 'limit'
  durationMs: number
}

/** Melyik fiok kerete szamit. Alapbol a fo agense -- ugyanaz, amit a flotta
 *  keret-figyeloje is nez. Semmi beegetve: a nev a configbol jon. */
function defaultAgent(): string {
  return MAIN_AGENT_ID
}

type SnapshotReader = (agent: string) => { fiveHour?: { usedPct: number | null; resetsAt: number | null } | null; measuredAt?: number; updatedAt?: number } | null

let readSnapshot: SnapshotReader = readRateLimitSnapshot

/** Csak teszthez: a meres forrasanak cserelese. `null` visszaallitja a valodit. */
export function setUsageSnapshotReader(r: SnapshotReader | null): void {
  readSnapshot = r || readRateLimitSnapshot
}

const reservations = new Map<string, Reservation>()
const recent: RecordedCall[] = []
/** Ennyi legutobbi hivast tartunk meg a konyvelesben (diagnosztika). */
export const RECENT_KEEP = 50

/** A lejart foglalasok kitakaritasa. Minden lekerdezes elott lefut. */
function sweep(now: number): void {
  for (const [id, r] of reservations) {
    if (now - r.at > RESERVATION_TTL_MS) reservations.delete(id)
  }
}

/** Az 5 oras ablak allapota. `getWindow()` a spec szerinti nev. */
export function getWindow(agent = defaultAgent(), now = Date.now()): UsageWindowInfo {
  let snap: ReturnType<SnapshotReader> = null
  try { snap = readSnapshot(agent) } catch { snap = null }
  const five = snap?.fiveHour
  if (!snap || !five || five.usedPct === null || five.usedPct === undefined) {
    // NEM 0%: nincs meres. A kulonbseg a hivo dolga kimondani.
    return { usedPct: null, resetsAt: five?.resetsAt ?? null, measuredAt: null, stale: false, source: 'none' }
  }
  const measuredAt = snap.measuredAt || snap.updatedAt || null
  return {
    usedPct: five.usedPct,
    resetsAt: five.resetsAt ?? null,
    measuredAt,
    stale: measuredAt !== null && now - measuredAt > STALE_AFTER_MS,
    source: 'snapshot',
  }
}

export function getUsage(agent = defaultAgent(), now = Date.now()): UsageInfo {
  sweep(now)
  const w = getWindow(agent, now)
  return { ...w, tier: tierForPct(w.usedPct), inFlight: reservations.size }
}

/**
 * Szabad-e most hivast inditani.
 *
 * Blokkol, ha (1) az 5 oras keret KRITIKUS (a flotta sajat kuszobe), vagy
 * (2) mar tul sok sajat hivas van a levegoben. Elavult meres NEM blokkol --
 * egy regi szam nem bizonyitek arra, hogy most is tele van.
 */
export function getRemaining(agent = defaultAgent(), now = Date.now()): RemainingInfo {
  const usage = getUsage(agent, now)
  const remainingPct = usage.usedPct === null ? null : Math.max(0, CRITICAL_THRESHOLD_PCT - usage.usedPct)
  if (usage.usedPct !== null && !usage.stale && usage.tier === 'critical') {
    return { allowed: false, reason: 'limit_critical', remainingPct, usage }
  }
  if (usage.inFlight >= MAX_CONCURRENT) {
    return { allowed: false, reason: 'too_many_in_flight', remainingPct, usage }
  }
  return { allowed: true, reason: null, remainingPct, usage }
}

export type ReserveResult =
  | { ok: true; reservation: Reservation; usage: UsageInfo }
  | { ok: false; reason: BlockReason; usage: UsageInfo }

/**
 * Foglalas EGY hivas elott. A hivo KOTELES `release()`-elni vagy `record()`-olni.
 * A `makeId` csak a tesztek miatt injektalhato.
 */
export function reserve(agent = defaultAgent(), now = Date.now(), makeId?: () => string): ReserveResult {
  const r = getRemaining(agent, now)
  if (!r.allowed) return { ok: false, reason: r.reason as BlockReason, usage: r.usage }
  const id = makeId ? makeId() : `wb-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const reservation: Reservation = { id, at: now, agent }
  reservations.set(id, reservation)
  return { ok: true, reservation, usage: { ...r.usage, inFlight: reservations.size } }
}

/** A foglalas elengedese anelkul, hogy hivas tortent volna. */
export function release(id: string): boolean {
  return reservations.delete(id)
}

/** A lefutott hivas konyvelese. A foglalast is elengedi. */
export function record(id: string | null, call: Omit<RecordedCall, 'at'> & { at?: number }): RecordedCall {
  if (id) reservations.delete(id)
  const entry: RecordedCall = { at: call.at ?? Date.now(), agent: call.agent, model: call.model, outcome: call.outcome, durationMs: call.durationMs }
  recent.push(entry)
  while (recent.length > RECENT_KEEP) recent.shift()
  return entry
}

/** A legutobbi konyvelt hivasok (diagnosztika, teszt). */
export function recentCalls(): RecordedCall[] {
  return [...recent]
}

/** Csak teszthez: a foglalasok es a konyveles nullazasa. */
export function resetUsageManagerForTest(): void {
  reservations.clear()
  recent.length = 0
}

export { CAUTION_THRESHOLD_PCT, CRITICAL_THRESHOLD_PCT }
