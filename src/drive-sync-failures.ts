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
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PROJECT_ROOT } from './config.js'
import { logger } from './logger.js'
import { yieldToLoop } from './yield-loop.js'

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

// #390: a lista tobb MB (2026-09-25: 6,7 MB), es az Attekintes onellenorzese
// egy betoltesen haromszor is vegigbontotta -- ~0,3 mp, amig az egesz
// dashboard allt. A felbontott sorokat a fajl meret+ido alairasaig megtartjuk;
// barmilyen iras (hozzafuzes, forgatas, torles) uj alairast ad.
//
// #988: even one full parse (6.9 MB, 11273 lines: 232-369 ms measured) froze
// the dashboard, and a running sync appends all the time. An appended file is
// now continued from where the last parse stopped, and the request handlers do
// the full parse beforehand in slices (primeSyncFailures).
interface ParsedMemo {
  sig: string
  rows: SyncFailure[]
  ino: number
  /** How many bytes `rows` covers; 0 = the file did not end on a line break, do not continue it. */
  bytes: number
  /** The last bytes before `bytes`: they prove the file was appended to, not rewritten. */
  tail: Buffer
}
let parsedMemo: ParsedMemo | null = null

/** Csak teszthez: a felbontott lista elfelejtese. */
export function _resetSyncFailuresMemoForTest(): void { parsedMemo = null }

const TAIL_PROOF_BYTES = 128
const PARSE_SLICE_LINES = 500

interface FileState { sig: string; ino: number; size: number }

function currentState(): FileState | null {
  if (!existsSync(FAILURES_PATH)) return null
  const st = statSync(FAILURES_PATH)
  return { sig: `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`, ino: st.ino, size: st.size }
}

/** `buf` is the end of the file; `end` is how long the file was when it was read. */
function memoOf(st: FileState, buf: Buffer, end: number, rows: SyncFailure[]): ParsedMemo {
  const whole = buf.length > 0 && buf[buf.length - 1] === 0x0a
  return {
    sig: st.sig, ino: st.ino, rows,
    bytes: whole ? end : 0,
    tail: Buffer.from(buf.subarray(Math.max(0, buf.length - TAIL_PROOF_BYTES))),
  }
}

function parseInto(rows: SyncFailure[], lines: string[], from = 0, to = lines.length): void {
  for (let i = from; i < to; i++) {
    const f = parseFailureLine(lines[i])
    if (f) rows.push(f)
  }
}

/** Parses only the appended lines; `null` when this was not a plain append. */
function continueMemo(memo: ParsedMemo, st: FileState): ParsedMemo | null {
  if (memo.ino !== st.ino || memo.bytes === 0 || st.size <= memo.bytes) return null
  const start = memo.bytes - memo.tail.length
  const buf = Buffer.alloc(st.size - start)
  const fd = openSync(FAILURES_PATH, 'r')
  let got = 0
  try {
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got)
      if (n <= 0) break
      got += n
    }
  } finally { closeSync(fd) }
  const read = buf.subarray(0, got)
  if (!read.subarray(0, memo.tail.length).equals(memo.tail)) return null
  const added = read.subarray(memo.tail.length)
  if (!added.length || added[added.length - 1] !== 0x0a) return null
  const rows = memo.rows.slice()
  parseInto(rows, added.toString('utf8').split('\n'))
  return memoOf(st, read, start + got, rows)
}

function parsedFailures(): SyncFailure[] {
  try {
    const st = currentState()
    if (!st) { parsedMemo = null; return [] }
    if (parsedMemo && parsedMemo.sig === st.sig) return parsedMemo.rows
    const continued = parsedMemo ? continueMemo(parsedMemo, st) : null
    if (continued) { parsedMemo = continued; return continued.rows }
    const buf = readFileSync(FAILURES_PATH)
    const rows: SyncFailure[] = []
    parseInto(rows, buf.toString('utf8').split('\n'))
    parsedMemo = memoOf(st, buf, buf.length, rows)
    return rows
  } catch (err: any) {
    logger.warn({ err: err?.message }, '[drive-sync] a hibalistat nem tudtam beolvasni')
    return []
  }
}

let priming: Promise<void> | null = null

/**
 * Brings the parsed list up to date without holding the main thread: the file is
 * read asynchronously and parsed in slices. Call it right before the
 * synchronous readers in a request handler. Never throws.
 */
export function primeSyncFailures(): Promise<void> {
  if (priming) return priming
  priming = (async () => {
    const st = currentState()
    if (!st || parsedMemo?.sig === st.sig) return
    const continued = parsedMemo ? continueMemo(parsedMemo, st) : null
    if (continued) { parsedMemo = continued; return }
    const buf = await readFile(FAILURES_PATH)
    const lines = buf.toString('utf8').split('\n')
    const rows: SyncFailure[] = []
    for (let i = 0; i < lines.length; i += PARSE_SLICE_LINES) {
      await yieldToLoop()
      parseInto(rows, lines, i, Math.min(lines.length, i + PARSE_SLICE_LINES))
    }
    parsedMemo = memoOf(st, buf, buf.length, rows)
  })()
    .catch((err: any) => { logger.warn({ err: err?.message }, '[drive-sync] a hibalistat nem tudtam beolvasni') })
    .finally(() => { priming = null })
  return priming
}

/**
 * A feljegyzett hibak, LEGUJABB ELOL.
 *
 * `runId`-val szurve csak egy futase. A `limit` a visszaadott sorokra vonatkozik.
 */
export function loadSyncFailures(opts: { runId?: string; limit?: number } = {}): SyncFailure[] {
  const rows = parsedFailures()
  const out: SyncFailure[] = []
  // Legujabb elol; a hivo sajat masolatot kap, a memot nem valtoztathatja meg.
  for (let i = rows.length - 1; i >= 0; i--) {
    const f = rows[i]
    if (opts.runId && f.runId !== opts.runId) continue
    out.push({ ...f })
    if (opts.limit && out.length >= opts.limit) break
  }
  return out
}

/** Az OSSZES feljegyzett futas azonositoja, legujabb elol. */
export function syncFailureRuns(): Array<{ runId: string; at: string; count: number }> {
  const byRun = new Map<string, { runId: string; at: string; count: number }>()
  const rows = parsedFailures()
  for (let i = rows.length - 1; i >= 0; i--) {
    const f = rows[i]
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
