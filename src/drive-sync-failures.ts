// Ami a Drive-szinkronban NEM sikerult -- NEVEN NEVEZVE, es lemezen.
//
// Boss, 2026-08-16: "honnan fogom tudni hogy milyen fileket nem szinkronizalt
// le es hogy melyik driv bol? kellene az eleresi utvonaluk mindegyiknek es a
// neve a filenek. mert hogy ha automatan nem ment, akor majd kezzel
// megprobalom a felhoben levo driv rol lementeni a szamitogepre."
//
// A regi valtozat harom kulon modon vesztette el pontosan ezt:
//   1. `if (job.errors.length < 20)` -- a 21. hiba mar sehova nem kerult.
//      "19 nem sikerult" allt a kepernyon, a 19 NEV nelkul.
//   2. Az uzenetben csak a fajl relativ utja volt, FIOK es PAROS nelkul: tobb
//      Drive mellett nem derult ki, melyikrol van szo.
//   3. A `job` egyetlen memoriabeli valtozo, amit a KOVETKEZO futas felulir.
//      Ujraindulas utan pedig nyomtalanul eltunt.
//
// Ezert: minden hiba AZONNAL a lemezre kerul, egy sor egy hiba (JSONL). Nem a
// futas vegen -- ez a #64 szabaly: ami tudhato a keletkezesekor, az akkor is
// irodjon ki, kulonben egy leallas elviszi. Egy sor serulese sem viheti el a
// tobbit: olvasaskor a hibas sort atlepjuk.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'

export const FAILURES_PATH = join(PROJECT_ROOT, 'store', 'drive-sync-failures.jsonl')

/**
 * Melyik szakaszon bukott el. A felhasznalonak ez donti el, MIT tegyen:
 *  - `letöltés`: a felhoben megvan, a gepen nincs -> kezzel le kell menteni.
 *  - `feltöltés`: a gepen megvan, a felhoben nincs -> kezzel fel kell tolteni.
 *  - `törlés`: a gepen mar nincs, fent megmaradt -> fent kell kidobni.
 *  - `mappa`: egy egesz mappat nem tudtunk kiolvasni -> AMI BENNE VAN, MIND
 *    kimaradt. Ez a legsulyosabb: egyetlen sor sok szaz fajlt takarhat.
 *  - `kihagyva`: nem hiba, hanem szandekos kihagyas (tul nagy fajl, nevutkozes,
 *    a Google nem veszi vissza) -- de attol meg NEM szinkronizalodott.
 */
export type SyncFailurePhase = 'letöltés' | 'feltöltés' | 'törlés' | 'mappa' | 'kihagyva'

export interface SyncFailure {
  /** Melyik futasban. Ebbol tudja a kepernyo, mi a LEGUTOBBI futas termese. */
  runId: string
  at: string
  account: string
  /** A paros ember-olvashato neve ("a teljes Drive" vagy a mappa neve). */
  pair: string
  pairId: string
  phase: SyncFailurePhase
  /**
   * A HELYI utvonal (teljes), ahova a fajl kerult volna. Ide kell kezzel
   * bemasolni -- ezert teljes ut, nem relativ.
   */
  localPath: string
  /** A fajl (vagy mappa) neve a Drive-on. */
  driveName: string
  /** A Drive-fajlazonosito -- ebbol kozvetlen link keszul a kepernyon. */
  driveId: string
  reason: string
}

/**
 * Felso hatar. Egy elszabadult futas nem toltheti tele a lemezt, de a hatar
 * NAGY: a lenyeg pont az, hogy a hosszu listak is megmaradjanak. Tullepeskor a
 * regi fajl `.1` neven felretevodik (nem torlodik) -- ami mar leirodott, azt
 * ez a mechanizmus sem viheti el.
 */
const MAX_BYTES = 8 * 1024 * 1024

/** Egy szal a lemezre, AZONNAL. Sose dob: a naplozas nem allithatja meg a szinkront. */
export function recordSyncFailure(f: SyncFailure): void {
  try {
    mkdirSync(dirname(FAILURES_PATH), { recursive: true })
    if (existsSync(FAILURES_PATH) && statSync(FAILURES_PATH).size > MAX_BYTES) {
      const regi = `${FAILURES_PATH}.1`
      rmSync(regi, { force: true })
      renameSync(FAILURES_PATH, regi)
    }
    appendFileSync(FAILURES_PATH, `${JSON.stringify(f)}\n`)
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-sync] a hibalista sorat nem tudtam kiirni')
  }
}

/** Egy sor ertelmezese. `null`, ha nem hasznalhato -- a tobbi sor attol meg jo. */
export function parseFailureLine(line: string): SyncFailure | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t)
    if (!o || typeof o !== 'object') return null
    // A `phase` es a `runId` nelkul a sor meg mindig hasznalhato: a fajl NEVE
    // es UTJA a lenyeg. Hianyzo mezot inkabb potolunk, mint hogy eldobjuk a sort.
    return {
      runId: String(o.runId || ''),
      at: String(o.at || ''),
      account: String(o.account || ''),
      pair: String(o.pair || ''),
      pairId: String(o.pairId || ''),
      phase: (o.phase || 'letöltés') as SyncFailurePhase,
      localPath: String(o.localPath || ''),
      driveName: String(o.driveName || ''),
      driveId: String(o.driveId || ''),
      reason: String(o.reason || ''),
    }
  } catch {
    return null
  }
}

/**
 * A feljegyzett hibak, LEGUJABB ELOL.
 *
 * `runId`-val szurve csak egy futase. A `limit` a visszaadott sorokra vonatkozik.
 */
export function loadSyncFailures(opts: { runId?: string; limit?: number } = {}): SyncFailure[] {
  let raw = ''
  try {
    if (!existsSync(FAILURES_PATH)) return []
    raw = readFileSync(FAILURES_PATH, 'utf8')
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-sync] a hibalistat nem tudtam beolvasni')
    return []
  }
  const out: SyncFailure[] = []
  for (const line of raw.split('\n')) {
    const f = parseFailureLine(line)
    if (!f) continue
    if (opts.runId && f.runId !== opts.runId) continue
    out.push(f)
  }
  out.reverse()
  return opts.limit ? out.slice(0, opts.limit) : out
}

/** Az OSSZES feljegyzett futas azonositoja, legujabb elol. */
export function syncFailureRuns(): Array<{ runId: string; at: string; count: number }> {
  const byRun = new Map<string, { runId: string; at: string; count: number }>()
  for (const f of loadSyncFailures()) {
    const e = byRun.get(f.runId)
    if (e) { e.count++; if (f.at > e.at) e.at = f.at }
    else byRun.set(f.runId, { runId: f.runId, at: f.at, count: 1 })
  }
  return [...byRun.values()].sort((a, b) => (a.at < b.at ? 1 : -1))
}

/**
 * A lista kiuritese -- de NEM nyomtalanul: a regi fajl `.torolt-<ido>` neven
 * megmarad. Egy felreertett kattintas nem viheti el azt a listat, amirol a
 * felhasznalo meg kezzel akarta lementeni a fajljait.
 */
export function clearSyncFailures(): void {
  try {
    if (!existsSync(FAILURES_PATH)) return
    renameSync(FAILURES_PATH, `${FAILURES_PATH}.torolt-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-sync] a hibalistat nem tudtam felretenni')
  }
}

/**
 * A lista SZOVEGKENT, hogy a felhasznalo egy gombbal kimasolhassa.
 *
 * Boss szandeka egyertelmu: "majd kezzel megprobalom a felhoben levo driv rol
 * lementeni a szamitogepre" -- ehhez egy KIMASOLHATO lista kell, nem egy szep
 * tablazat, amit ujra kell gepelni.
 */
export function failuresAsText(list: SyncFailure[]): string {
  if (!list.length) return 'Nincs feljegyzett hiba.'
  const sorok = list.map((f) => [
    `[${f.phase}] ${f.account} – ${f.pair}`,
    `  fájl:  ${f.driveName || '(névtelen)'}`,
    `  hely:  ${f.localPath || '(nincs helyi útvonal)'}`,
    f.driveId ? `  Drive: https://drive.google.com/open?id=${f.driveId}` : '',
    `  ok:    ${f.reason}`,
  ].filter(Boolean).join('\n'))
  return `${list.length} elem nem szinkronizálódott:\n\n${sorok.join('\n\n')}\n`
}
