/**
 * Things that can quietly rot, checked on every Áttekintés load.
 *
 * Boss, 2026-08-19: "nezz korul az egesz marveenban. barmi ami elromolhat arra
 * tegyunk ellenorzest. ami itt jelenik meg." The self-check card already
 * watches credential expiry; this is the rest of the same idea -- the failures
 * that produce NO error message at the time they happen, and are therefore only
 * discovered when it is too late to act on them.
 *
 * Each check earns its place by a failure that was MEASURED on this machine,
 * not by being cheap to write:
 *
 *  - BACKUP CONTENT. The 6-hourly archive carried the database and the
 *    dashboard token and nothing else from store/ (verified inside
 *    claudeclaw-20260819-125659.tar.gz). Ten connected Google accounts, both
 *    GitHub tokens, the OAuth client and the vault key were all outside it, so
 *    a restore would have looked like it worked and then failed at every
 *    integration. A backup is only a backup once its CONTENT is checked; the
 *    exit code says nothing about what went in.
 *  - BACKUP FRESHNESS. A timer that stops firing leaves the newest archive
 *    ageing in place, which looks identical to a healthy system from the
 *    outside.
 *  - SECRETS IN LOGS. The dashboard printed its own bearer token to stderr,
 *    which systemd redirects into a 0664 log file: 365 lines' worth. Fixed at
 *    the source (web.ts checks isTTY now), watched here so it cannot creep back
 *    in through some other writer.
 *  - UPSTREAM MEASUREMENT. The card's "63 new / 4 conflicting / 110 clean"
 *    was hand-typed on 2026-08-10 and NOTHING ever wrote it again; two of the
 *    three numbers were not reproducible from git. A number the interface
 *    states as fact needs a writer that is still running -- so this checks
 *    that the writer exists, that the file exists, and that its age is inside
 *    the weekly cadence. This is the check that would have caught the bug
 *    itself, nine days earlier and without the Boss noticing it first.
 *  - DISK. Everything above degrades silently when the disk fills; this is the
 *    cheap early word.
 *  - CLAUDE LOGIN. On 2026-08-20 at 10:54:06 the shared credentials file was
 *    rewritten with an EMPTY access token. The whole fleet went mute -- no
 *    Telegram, no scheduled task, no agent -- and the only thing that said so
 *    was a red badge on the Settings page, while the self-check card directly
 *    below it stayed green and promised "if anything breaks, it will show up
 *    here". Boss saw both at once and asked the obvious question. The login is
 *    the one credential without which NOTHING works, so it belongs in the card
 *    that claims to watch everything -- green when it is fine, so its silence
 *    is never mistaken for absence of a check.
 *
 * Design constraints, same as credential-expiry.ts: file-only, no network, no
 * shelling out, bounded work (a tar listing is read as a stream, logs are
 * sampled from the tail), so the overview endpoint stays fast.
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync, accessSync, constants } from 'node:fs'
import { statfsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { lastWakeAt } from '../wake-detect.js'
import { readUpstreamSyncStatus, STALE_AFTER_DAYS } from './upstream-sync-status-io.js'
import { claudeAuthState } from './claude-auth-presence.js'
import { defaultLoginDependents, unaffectedByDefaultLogin } from './default-login-dependents.js'
import type { UpstreamSyncStatus } from './upstream-sync-status-io.js'
import { homedir } from 'node:os'
import { GIT_PULL_TASK } from '../git-sync.js'
import { SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { depotRoot } from '../depot.js'
import { codeBridgeHealth, WORKER_STALE_MS } from './code-bridge-store.js'
import { expectedWorkerVersion } from './code-worker-version.js'
import { CODE_BRIDGE_ENABLED } from '../config.js'

export type HealthStatus = 'ok' | 'warn' | 'bad'

export interface HealthRow {
  /** Stable key the client maps to a translated label + advice. */
  id: string
  status: HealthStatus
  /** Numbers the translated text interpolates ({n}, {d}...). Never free text
   *  from disk: the client renders these into HTML without escaping. */
  params?: Record<string, string | number>
}

/** Files a restore cannot regenerate. Kept next to the check that enforces it
 *  so the two cannot drift apart -- the drift is exactly what went wrong. */
export const MUST_BACKUP = [
  'google-tokens.json',
  'google-oauth-client.json',
  '.github-tokens.json',
  '.vault-key',
  'vault.json',
] as const

const DAY_MS = 24 * 60 * 60 * 1000
/** The timer runs every ~6h; a day of silence is a real stall, not a hiccup. */
const BACKUP_STALE_MS = DAY_MS
const BACKUP_DEAD_MS = 3 * DAY_MS

function backupsDir(): string { return join(PROJECT_ROOT, 'backups') }

/** Newest claudeclaw-*.tar.gz, or null. */
function newestArchive(dir: string): { path: string; mtime: number } | null {
  if (!existsSync(dir)) return null
  let best: { path: string; mtime: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('claudeclaw-') || !name.endsWith('.tar.gz')) continue
    const p = join(dir, name)
    try {
      const m = statSync(p).mtimeMs
      if (!best || m > best.mtime) best = { path: p, mtime: m }
    } catch { /* raced away mid-prune; the next one will do */ }
  }
  return best
}

/**
 * Which of MUST_BACKUP are inside the archive.
 *
 * `tar -tzf` is the only outside command here, and it is worth it: reading the
 * member names is the only way to check the archive as it actually IS rather
 * than as the script's file list claims it should be -- and the file list being
 * right while the archive was wrong is the failure mode that hid for weeks. It
 * lists names only (no extraction), with a timeout, and a failure degrades to
 * "cannot tell" rather than to a false all-clear.
 */
/**
 * Memo for the tar listing, keyed by the archive's identity (path + mtime +
 * size), which is exactly what changes when a new backup lands.
 *
 * Measured 2026-08-19 after wiring this in: /api/connections/summary went to
 * 235 ms, of which `tar -tzf` on the 7 MB archive was 200 ms -- paid on every
 * single Overview load. An archive is immutable once written, so re-listing it
 * is pure waste; a new backup gets a new name and re-checks itself.
 */
let archiveMemo: { key: string; value: string[] | null } | null = null

function archiveKey(path: string): string {
  try {
    const s = statSync(path)
    return `${path}:${s.mtimeMs}:${s.size}`
  } catch {
    return `${path}:?`
  }
}

export function archiveMissing(archivePath: string): string[] | null {
  const key = archiveKey(archivePath)
  if (archiveMemo && archiveMemo.key === key) return archiveMemo.value
  const value = archiveMissingUncached(archivePath)
  archiveMemo = { key, value }
  return value
}

/** For tests: forget the memo so a rewritten fixture is re-read. */
export function _resetHealthCache(): void { archiveMemo = null; logMemo = null }

function archiveMissingUncached(archivePath: string): string[] | null {
  let listing: string
  try {
    listing = execFileSync('tar', ['-tzf', archivePath], {
      encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
      // tar's own complaint about a corrupt archive is not the dashboard's
      // output; we report that case ourselves, in the operator's language.
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
  const names = new Set(listing.split('\n').map(l => l.trim()).filter(Boolean))
  const has = (f: string) => {
    for (const n of names) if (n.endsWith('/' + f) || n === f) return true
    return false
  }
  return MUST_BACKUP.filter(f => !has(f))
}

function backupRows(now: number): HealthRow[] {
  const newest = newestArchive(backupsDir())
  if (!newest) {
    return [{ id: 'backup_missing', status: 'bad' }]
  }
  const age = now - newest.mtime
  const rows: HealthRow[] = []
  const hours = Math.floor(age / (60 * 60 * 1000))
  if (age >= BACKUP_DEAD_MS) rows.push({ id: 'backup_stale', status: 'bad', params: { h: hours } })
  else if (age >= BACKUP_STALE_MS) rows.push({ id: 'backup_stale', status: 'warn', params: { h: hours } })

  const missing = archiveMissing(newest.path)
  if (missing === null) {
    rows.push({ id: 'backup_unreadable', status: 'warn' })
  } else if (missing.length > 0) {
    // Names of well-known files, not paths from disk -- safe to render.
    rows.push({ id: 'backup_incomplete', status: 'bad', params: { n: missing.length, files: missing.join(', ') } })
  } else if (rows.length === 0) {
    rows.push({ id: 'backup_ok', status: 'ok', params: { h: hours } })
  }
  return rows
}

/**
 * Credentials sitting in a log file.
 *
 * Only the tail of each log is sampled: the leak that matters is a CURRENT one,
 * a hit deep in a rotated-away past does not change what to do today, and
 * scanning multi-megabyte logs on every page load would.
 */
const SECRET_IN_LOG = /token=[a-f0-9]{24}|refresh_token"\s*:\s*"[^"]{10}|client_secret"\s*:\s*"[^"]{10}|Bearer\s+[A-Za-z0-9_-]{24}/
const TAIL_BYTES = 256 * 1024

function tail(path: string, bytes: number): string {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - bytes)
    const len = Math.min(bytes, size)
    if (len === 0) return ''
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(len)
    readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* already gone */ }
  }
}

/** Log scanning is cheap per file but not free across a growing store/, and the
 *  answer cannot change meaningfully between two page loads. */
let logMemo: { at: number; dir: string; value: string[] } | null = null
const LOG_SCAN_TTL_MS = 60_000

export function secretsInLogs(storeDir = STORE_DIR, now = Date.now()): string[] {
  if (logMemo && logMemo.dir === storeDir && now - logMemo.at < LOG_SCAN_TTL_MS) return logMemo.value
  const hits: string[] = []
  let names: string[]
  try { names = readdirSync(storeDir) } catch { return hits }
  for (const name of names) {
    if (!name.endsWith('.log')) continue
    if (SECRET_IN_LOG.test(tail(join(storeDir, name), TAIL_BYTES))) hits.push(name)
  }
  logMemo = { at: now, dir: storeDir, value: hits }
  return hits
}

function diskRow(): HealthRow | null {
  try {
    const s = statfsSync(PROJECT_ROOT)
    const freeGb = (s.bavail * s.bsize) / 1024 ** 3
    const totalGb = (s.blocks * s.bsize) / 1024 ** 3
    const pct = totalGb > 0 ? (freeGb / totalGb) * 100 : 100
    if (freeGb < 2 || pct < 3) return { id: 'disk_low', status: 'bad', params: { gb: freeGb.toFixed(1) } }
    if (freeGb < 10 || pct < 8) return { id: 'disk_low', status: 'warn', params: { gb: freeGb.toFixed(1) } }
    return null
  } catch {
    return null
  }
}

/** Everything at once, worst first. `ok` rows are included on purpose: the card
 *  has to be able to state the healthy case, not just fall silent. */
/** The script that measures the upstream numbers. Named here so a rename
 *  breaks a test instead of silently turning the check into a no-op. */
export const UPSTREAM_WRITER = 'scripts/upstream-divergence-check.sh'

/** A tetelas valtozas-lista. Ugyanabban a heti futasban keszul, mint a szamok,
 *  tehat kulon is el tud romlani: a szamok frissek maradnak, a lista megfagy.
 *  Az mtime eleg hozza -- egy 300 kB-os JSON-t nem parszolunk vegig minden
 *  Attekintes-betoltesnel csak azert, hogy a datumat megnezzuk. */
export const UPSTREAM_CHANGES_FILE = 'store/upstream-changes.json'

function mtimeOf(path: string): number | null {
  try { return statSync(path).mtimeMs } catch { return null }
}

/** Is the upstream number still a MEASUREMENT, or has it become a memory?
 *
 *  Three ways it stops being a measurement, in the order they bite:
 *  the writer is gone (rename, bad merge, lost file) -> nothing will ever
 *  update it again; the file is missing or undated -> there is nothing to
 *  trust; the file is old -> the weekly timer stopped firing. Only the last
 *  one is visible on the card itself, which is why the other two are `bad`. */
export function upstreamRows(
  now: number = Date.now(),
  // Injectable so the tests can drive every branch (missing / stale / dead
  // timer / offline) without a store/ file next to them -- the test worktree
  // has no store/, and a check that only runs where its data happens to sit
  // is not a check.
  status: UpstreamSyncStatus | null = readUpstreamSyncStatus(now),
  writerExists: boolean = existsSync(join(PROJECT_ROOT, UPSTREAM_WRITER)),
  changesMtime: number | null = mtimeOf(join(PROJECT_ROOT, UPSTREAM_CHANGES_FILE)),
): HealthRow[] {
  const rows: HealthRow[] = []
  if (!writerExists) {
    rows.push({ id: 'upstream_no_writer', status: 'bad', params: { f: UPSTREAM_WRITER } })
  }
  const st = status
  if (!st || st.ageDays === null) {
    rows.push({ id: 'upstream_unmeasured', status: 'warn' })
    return rows
  }
  if (st.ageDays > STALE_AFTER_DAYS) {
    // Two missed weekly runs is a stall; a month of silence is a dead timer.
    rows.push({
      id: 'upstream_stale',
      status: st.ageDays > 30 ? 'bad' : 'warn',
      params: { d: st.ageDays },
    })
  } else if (!st.fetchOk) {
    rows.push({ id: 'upstream_no_fetch', status: 'warn' })
  } else {
    rows.push({ id: 'upstream_ok', status: 'ok', params: { d: st.ageDays } })
  }
  // A lista kulon kerdes: a szam lehet mai, mikozben a "mi valtozott?" lista
  // hetek ota all -- olyankor a Boss regi tetelekbol dontene.
  if (changesMtime === null) {
    rows.push({ id: 'upstream_changes_missing', status: 'warn' })
  } else {
    const napja = Math.max(0, Math.floor((now - changesMtime) / 86_400_000))
    if (napja > STALE_AFTER_DAYS) {
      rows.push({ id: 'upstream_changes_stale', status: 'warn', params: { d: napja } })
    }
  }
  return rows
}

/**
 * A Claude-bejelentkezes. Ez az egyetlen hozzaferes, ami nelkul SEMMI nem
 * mukodik -- se agens, se utemezett feladat, se Telegram -- ezert kap sort a
 * zold allapotban is (Boss, 2026-08-20: "ha az alatta levo zoldek egyike sem
 * vonatkozik erre a hibara, akkor ez a hiba miert nincs megjelenitve zolden
 * hogy minden rendben ezzel is?").
 *
 * `bad`, nem `warn`: kijelentkezve a rendszer nem "kevesbe jo", hanem all.
 */
function claudeAuthRow(): HealthRow {
  const st = claudeAuthState()
  const dependents = defaultLoginDependents().length
  const others = unaffectedByDefaultLogin().length
  const params = { n: dependents, others }
  if (st.present) return { id: 'claude_auth_ok', status: 'ok', params }
  // Ket kulon szoveg, mert ket kulon teendo: az "emptied" agon a bejelentkezes
  // MEGVOLT es elveszett (ilyenkor a /login ujra megoldja), a "none" agon meg
  // sose volt (ilyenkor a vegigvezeto valo).
  //
  // A SULY a MERT hatasbol jon, nem feltetelezesbol. Boss, 2026-08-21, a
  // korabbi szovegrol ("emiatt egyik ugynok sem tud dolgozni"): "ez hamis
  // allitas. mert most is tudok veled dolgozni!" -- igaza volt: sajat fiokos
  // es nem-Claude agensek ettol fuggetlenul mennek. Ha EGY agens sem fugg az
  // alapertelmezett bejelentkezestol, ez nem uzemszunet, csak hianyzo
  // beallitas -- pirosat arra kolteni ugyanaz a hiba, forditva.
  return {
    id: st.source === 'emptied' ? 'claude_auth_lost' : 'claude_auth_missing',
    status: dependents > 0 ? 'bad' : 'warn',
    params,
  }
}


// === Ami magatol elromlik, es addig NEM szol ==============================

/** A napi git-lehuzas allapota, ahogy a `syncAllRepos` hagyja maga utan. */
export const GIT_SYNC_FILE = 'git-sync.json'
/** A gepi (parancs-tipusu) kartyak eredmenye. */
export const COMMAND_HEALTH_FILE = 'command-task-health.json'
/** Ennyi nap utan a napi lehuzas mar nem "kesik", hanem all. */
export const GIT_PULL_STALE_DAYS = 3

/**
 * Meddig CSENDES a halozat-hiany, es mikortol hangos?
 *
 * Boss, 2026-08-26 dontese: ``csendben ujraprobal, 6 ora utan szol``. A ket
 * hatar ket kulonbozo allitast valaszt szet:
 *
 *  - 6 ora alatt: a gep valoszinuleg most ebredt, vagy a halozat percekre
 *    elment. A rendszer magatol ujraprobal, es a felulet ZOLD marad -- de a
 *    sor akkor is ott van, tehat nem hallgatunk, csak nem riasztunk.
 *  - 6 ora felett: ennyi ido alatt egy atmeneti zavar helyreallt volna. Ha
 *    meg mindig nincs halozat, a tarolok tenylegesen elavulnak.
 *  - 24 ora felett: egy egesz nap kimaradt. Ez mar piros.
 */
export const GIT_PULL_OFFLINE_LOUD_H = 6
export const GIT_PULL_OFFLINE_DEAD_H = 24

function olvasJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T } catch { return null }
}

/** A kartyak es a szerverek nevei a LEMEZROL jonnek, a kliens pedig escape
 *  nelkul rendereli a params-t. Ezert csak ez a szukitett keszlet mehet at. */
function tisztaNev(s: string): string {
  return String(s).replace(/[^A-Za-z0-9._ -]/g, '').trim().slice(0, 40)
}

interface GitSyncEredmeny {
  rel?: string
  state?: string
  message?: string
}

interface GitSyncAllapot {
  finishedAt?: string
  results?: unknown[]
  errors?: number
  /** Halozat hianyaban el nem ert tarolok szama -- NEM hiba. Regi
   *  allapotfajlban hianyzik, ezert opcionalis: ilyenkor 0-nak szamit. */
  offline?: number
  /** Mikor kezdodott a mostani halozat-hianyos idoszak (ISO). */
  offlineSince?: string | null
  rootError?: string
}

/**
 * Miert nem sikerult a lehuzas?
 *
 * Boss, 2026-08-23: az onellenorzes azt allitotta, "altalaban hianyzo vagy
 * rossz kulcs az ok" -- kozben mind az ot hiba `Could not resolve host` volt,
 * vagyis halozat. A tippelt ok rosszabb a semminel: kulcsot mentem volna
 * javitani egy DNS-kieses miatt. Ezert az okot a TENYLEGES hibauzenetekbol
 * olvassuk ki, es ha nem ismerjuk fel, nem talalunk ki semmit.
 */
export function hibaOka(uzenetek: string[]): 'net' | 'auth' | '' {
  const sz = uzenetek.join(' | ').toLowerCase()
  const halozat = /could not resolve host|connection timed out|connection refused|network is unreachable|operation timed out|temporary failure in name resolution/.test(sz)
  const kulcs = /authentication failed|could not read username|could not read password|permission denied|terminal prompts disabled|invalid username or (token|password)|http 40[13]/.test(sz)
  // Vegyes okoknal egyik cimke sem igaz az egesz halmazra -- inkabb ne
  // allitsunk okot, mint rosszat.
  if (halozat && !kulcs) return 'net'
  if (kulcs && !halozat) return 'auth'
  return ''
}

/** A fiokonkenti git-tokenek. Csak a KULCSAIT nezzuk -- az erteket soha. */
export const GIT_TOKENS_FILE = '.git-tokens.json'

/** A napi lehuzas kartyaja: letezik-e, es be van-e kapcsolva. */
function gitPullKartya(): { letezik: boolean; bekapcsolva: boolean } {
  const d = olvasJson<{ enabled?: boolean }>(join(SCHEDULED_TASKS_DIR, GIT_PULL_TASK, 'task-config.json'))
  if (!d) return { letezik: false, bekapcsolva: false }
  return { letezik: true, bekapcsolva: d.enabled !== false }
}

/**
 * Van-e egyaltalan git bekotve? Ket olcso, fajl-alapu jel:
 * talalt-e repot a legutobbi menet, illetve van-e beallitott fiok-token.
 * Nem jarjuk be a fat: a depo a `/mnt/f`-en ul, ott egy bejaras masodpercekig
 * tart -- ez a modul viszont MINDEN attekintes-betoltesnel lefut.
 */
function gitBekotve(run: GitSyncAllapot | null): boolean {
  if (run && Array.isArray(run.results) && run.results.length > 0) return true
  const t = olvasJson<Record<string, unknown>>(join(STORE_DIR, GIT_TOKENS_FILE))
  return !!t && Object.keys(t).length > 0
}

/**
 * A napi git-lehuzas.
 *
 * Ez a check a 2026-08-22-i hibabol szuletett: hat ceges tarolobol OT nem
 * frissult, mert rossz kulcsot kerestunk hozza. A `fetch` hibaval tert vissza,
 * a szam ott allt az allapotfajlban -- es soha senki nem nezte meg. A felulet
 * vegig azt mutatta, hogy minden rendben.
 *
 * Boss, 2026-08-22: "szoljon a rendszer ha van git bekotve es ez az utemezes
 * megsem tortenik meg!" Ezert a check nem a kartyat kerdezi, hanem az
 * EREDMENYT: mikor futott le utoljara, es hozott-e mindent.
 *
 * A legveszelyesebb eset a KIKAPCSOLT kartya. A `startGitSync()` csak azt
 * nezi, LETEZIK-e a kartya fajlja -- azt nem, hogy be van-e kapcsolva. Egy
 * kikapcsolt kartya tehat a rejtett hat-oras tartalek-idozitot is elnemitja,
 * es onnantol SEMMI nem huz le, teljesen csendben.
 */
export function gitPullRows(
  now: number = Date.now(),
  run: GitSyncAllapot | null = olvasJson<GitSyncAllapot>(join(STORE_DIR, GIT_SYNC_FILE)),
  kartya: { letezik: boolean; bekapcsolva: boolean } = gitPullKartya(),
  vanGit: boolean = gitBekotve(run),
): HealthRow[] {
  if (kartya.letezik && !kartya.bekapcsolva) {
    // Bekotott git mellett ez adatvesztes-kozeli allapot: a tavoli valtozasok
    // gyulnek, nalunk meg all az ido -- ezert `bad`, nem `warn`.
    return [{ id: 'git_pull_disabled', status: vanGit ? 'bad' : 'warn' }]
  }
  // A depo gyokeret nem lehetett bejarni. Ez a `!vanGit` ag ELE kell, mert
  // pont ugy latszik, mintha nem volna bekotve git: nulla repot talalt a
  // bejaras. Csak eppen nem azert, mert nincs -- hanem mert nem latott oda.
  if (run && run.rootError) return [{ id: 'git_pull_root_unreachable', status: 'bad' }]
  // Nincs bekotve git: nincs mit lehuzni, es nincs mirol szolni.
  if (!vanGit) return []

  const veg = run && run.finishedAt ? Date.parse(run.finishedAt) : NaN
  if (!Number.isFinite(veg)) return [{ id: 'git_pull_never', status: 'warn' }]

  const rows: HealthRow[] = []
  const napja = Math.max(0, Math.floor((now - veg) / 86_400_000))
  const hiba = Number(run && run.errors) || 0
  const db = run && Array.isArray(run.results) ? run.results.length : 0

  if (hiba > 0) {
    // A szam onmagaban nem teendo. Boss, 2026-08-23: "miert keres plusz 5 git
    // tarolot? hiszen nincsennek!" -- dehogynem voltak, csak a sor nem mondta
    // meg, MELYIK otrol beszel. Ezert a sor megnevezi oket, es a VALODI okot
    // mondja, nem egy tippet.
    const eredmenyek = run && Array.isArray(run.results) ? (run.results as GitSyncEredmeny[]) : []
    const rosszak = eredmenyek.filter((r) => r && typeof r === 'object' && r.state === 'error')
    const nevek = rosszak
      .map((r) => tisztaNev(String(r.rel || '').split('/').filter(Boolean).pop() || ''))
      .filter(Boolean)
    const ok = hibaOka(rosszak.map((r) => String(r.message || '')))
    const id = nevek.length === 0 ? 'git_pull_errors' : ok ? 'git_pull_errors_' + ok : 'git_pull_errors_named'
    // Hosszu listat nem irunk ki: a kartya ket sorra van meretezve.
    const lista = nevek.length > 4 ? nevek.slice(0, 4).join(', ') + ', +' + (nevek.length - 4) : nevek.join(', ')
    rows.push({ id, status: 'bad', params: { n: hiba, all: db, names: lista } })
  }
  // HALOZAT-HIANY. Kulon sor, kulon hangero -- nem a hibak kozott.
  //
  // Ez a sor a 2026-08-26-i reggel miatt letezik: het tarolo elhasalt
  // `Could not resolve host: github.com`-mal, mert a lehuzas ebredes utan
  // azonnal futott. Egy oraval kesobb minden mukodott, de a piros sor ott
  // maradt egesz napra, es azt sugallta, hogy a tarolok elromlottak.
  // Nem romlottak el: nem lattunk oda.
  const offline = Number(run && run.offline) || 0
  if (offline > 0) {
    const ota = run && run.offlineSince ? Date.parse(run.offlineSince) : NaN
    const oraja = Number.isFinite(ota) ? Math.max(0, Math.floor((now - ota) / 3_600_000)) : 0
    const status: HealthRow['status'] =
      oraja >= GIT_PULL_OFFLINE_DEAD_H ? 'bad' : oraja >= GIT_PULL_OFFLINE_LOUD_H ? 'warn' : 'ok'
    rows.push({ id: 'git_pull_offline', status, params: { n: offline, all: db, h: oraja } })
  }
  if (napja > GIT_PULL_STALE_DAYS) {
    // Nehany kihagyott nap keses; ket het mar allo utemezes.
    rows.push({ id: 'git_pull_stale', status: napja > 14 ? 'bad' : 'warn', params: { d: napja } })
  } else if (hiba === 0 && offline === 0) {
    rows.push({ id: 'git_pull_ok', status: 'ok', params: { n: db, d: napja } })
  }
  return rows
}

/**
 * A gepi kartyak (parancs-tipusu utemezesek).
 *
 * Ezek nem agenst inditanak, hanem egy parancsot -- tehat nincs beszelgetes,
 * amiben a hiba latszana. Az egyetlen nyoma egy szam a store-ban.
 */
export function commandTaskRows(
  health: Record<string, { lastStatus?: string }> | null =
    olvasJson<Record<string, { lastStatus?: string }>>(join(STORE_DIR, COMMAND_HEALTH_FILE)),
): HealthRow[] {
  if (!health) return []
  const bukott = Object.keys(health)
    .filter((k) => health[k] && health[k].lastStatus === 'fail')
    .map(tisztaNev)
    .filter(Boolean)
  if (bukott.length === 0) return []
  return [{ id: 'command_task_fail', status: 'warn', params: { n: bukott.length, names: bukott.join(', ') } }]
}

/**
 * MCP-kapcsolatok, amik hitelesitesre varnak.
 *
 * Boss, 2026-08-22: "ha ker az mcp hitelesitest, akkor az miert nem jelenik
 * meg az attekintes onellenorzesben?" -- jogos: egy hitelesitesre varo
 * kapcsolat ugy tunik el az agens keze alol, hogy az agens ettol meg
 * vidaman valaszol, csak eppen az adott eszkoze nincs meg.
 *
 * A Claude Code minden config-konyvtarban vezet egy `mcp-needs-auth-cache.json`-t:
 * `{ "<szerver>": { timestamp, id?, ttlMs? } }`. A bejegyzest TORLI, amint a
 * hitelesites sikerult -- tehat ami bent van, az tenyleg var valakire. A
 * `ttlMs`-es bejegyzes lejar; a lejartat nem szamoljuk.
 */
export const MCP_AUTH_CACHE = 'mcp-needs-auth-cache.json'

/** Hol laknak a config-konyvtarak: a kozos, plusz minden agens sajatja. */
export function mcpCacheHelyek(home: string = homedir()): string[] {
  const utak = [join(home, '.claude', MCP_AUTH_CACHE)]
  let nevek: string[] = []
  try { nevek = readdirSync(home) } catch { return utak }
  for (const n of nevek) {
    // A munkas-konyvtarak neve a bot nevet koveti (`.marveen-worker`,
    // `.lackor2-bot-worker-fast`, ...), ezert nem listat tartunk, hanem
    // megnezzuk, van-e benne `.claude-config`.
    if (!n.startsWith('.')) continue
    const p = join(home, n, '.claude-config', MCP_AUTH_CACHE)
    if (existsSync(p)) utak.push(p)
  }
  return utak
}

export function mcpAuthRows(
  now: number = Date.now(),
  helyek: string[] = mcpCacheHelyek(),
): HealthRow[] {
  const varo = new Set<string>()
  for (const p of helyek) {
    const d = olvasJson<Record<string, { timestamp?: number; ttlMs?: number }>>(p)
    if (!d) continue
    for (const nev of Object.keys(d)) {
      const e = d[nev] || {}
      if (e.ttlMs && e.timestamp && e.timestamp + e.ttlMs < now) continue
      const t = tisztaNev(nev)
      if (t) varo.add(t)
    }
  }
  if (varo.size === 0) return []
  const nevek = [...varo].sort()
  return [{ id: 'mcp_needs_auth', status: 'warn', params: { n: nevek.length, names: nevek.join(', ') } }]
}

/**
 * A Google-hozzaferes, ahogy a GOOGLE latja MOST -- nem ahogy az ora szerint
 * lennie kellene.
 *
 * A 2026-08-22-i kiesesbol: mind a 10 fiok `invalid_grant`-ot adott, es egyik
 * figyelo sem szolt. A lejarat-figyelo (credential-expiry.ts) idoalapu, es
 * ezert szerkezetileg VAK a visszavonasra: egy visszavont token az ora szerint
 * meg boven el. Az elo probe latta volna, de csak akkor fut, ha valaki
 * megnyitja a Fiokok oldalt. A ketto kozott volt a lyuk, amin at egy teljes
 * kieses hangtalanul elfert.
 *
 * Ez a sor a lyuk. A merest a `google-live-check.ts` vegzi oranként a hatterben
 * es lemezre irja; itt CSAK a fajlt olvassuk -- tehat halozat nelkul, gyorsan,
 * ugyanugy, ahogy a tobbi check.
 *
 * Harom kulon hibamod, harom kulon sor. Ha osszevonnank oket, a legrosszabb
 * eset (az ELLENORZO all) pont ugy nezne ki, mint a legjobb (nincs mit
 * jelenteni) -- ez a fajta osszemosas okozta az egesz mai hibat.
 */
export const GOOGLE_LIVE_FILE = '.google-live-check.json'
/** Oranként fut; harom kihagyott kor mar allo ellenorzo, nem zaj. */
export const GOOGLE_LIVE_STALE_MS = 3 * 60 * 60 * 1000

/**
 * Ebredes utan ennyi ideig nem panaszkodunk az elavult meresre.
 *
 * Tiz perc: a potlo kor ket perccel az ebredes utan indul, tiz fiok
 * vegigkerdezese percekig tarthat, es a halozat is most all a labara. Ha
 * tiz perc alatt sem lett friss meres, akkor mar tenyleg van valami baj --
 * es akkor a sor megjelenik.
 */
export const WAKE_GRACE_MS = 10 * 60 * 1000
const GOOGLE_LIVE_DEAD_MS = 24 * 60 * 60 * 1000

interface GoogleLiveAllapot {
  checkedAt?: number
  accounts?: { id?: string; ok?: boolean; kind?: string | null }[]
}

/** Hany Google-fiok van bekotve. Fajlbol, mint a credential-expiry.ts:
 *  fiok nelkuli telepitesen NINCS mit ellenorizni, es nincs mirol szolni. */
export function googleAccountCount(storeDir: string = STORE_DIR): number {
  const d = olvasJson<Record<string, unknown>>(join(storeDir, 'google-tokens.json'))
  if (!d || typeof d !== 'object') return 0
  return Object.keys(d).filter(k => !k.startsWith('_')).length
}

/**
 * Ket fiok UGYANARRA a cimre -- a nema hiba, ami 2026-08-22-en 10 fiokbol 17-et
 * csinalt.
 *
 * Miert nem eleg megjavitani az okat: a duplikatum utolag is keletkezhet (regi
 * telepites, kezi szerkesztes, egy jovobeli ut, amire nem gondoltunk), es
 * ONMAGATOL sosem tunik el. Kozben valodi kart okoz: a beallitasok (Drive-
 * szinkron, naptar, levelkuldes) a REGI kulcsra hivatkoznak, es az a slot
 * halott tokent tart -- a felulet viszont ket zold fiokot mutat.
 *
 * Boss: "hogy amikor uj marveen t telepitenek akkor ne jojjon elo ez a hiba."
 * A megelozes a szkriptben van (login_hint + cim szerinti slot-valasztas); ez
 * itt az or, ami szol, ha megis eloall.
 */
export function googleDuplicateRows(storeDir: string = STORE_DIR): HealthRow[] {
  const d = olvasJson<Record<string, unknown>>(join(storeDir, 'google-tokens.json'))
  if (!d || typeof d !== 'object') return []
  const cimek = new Map<string, string[]>()
  for (const [kulcs, ertek] of Object.entries(d)) {
    if (kulcs.startsWith('_') || !ertek || typeof ertek !== 'object') continue
    const cim = String((ertek as Record<string, unknown>).email ?? '').trim().toLowerCase()
    // Cim nelkuli rekordrol nem allithatjuk, hogy duplikatum: az vagy meg nem
    // volt sikeres bejelentkezesen, vagy a cim-lekerdezes bukott el halozati
    // hiban. Talalgatasbol nem szolalunk meg.
    if (!cim) continue
    const lista = cimek.get(cim)
    if (lista) lista.push(kulcs)
    else cimek.set(cim, [kulcs])
  }
  // A KULCSOKAT nevezzuk meg, nem a cimet: azokat kell osszevonni, es a
  // `tisztaNev` a @-ot ugyis levagna. A nev lemezrol jon -> tisztitva megy a
  // felulet fele (a params escape nelkul rendereodik).
  const parok = [...cimek.values()]
    .filter(k => k.length > 1)
    .map(k => k.map(tisztaNev).filter(Boolean).join(' + '))
    .filter(Boolean)
  if (parok.length === 0) return []
  // A cimke a kartya egyik dobozaba kerul, es a doboz NEM nyulhat lefele (a
  // negy dobozos racs merev). Het par tizennegy nevvel felrugna a magassagot,
  // ezert harom utan levagjuk -- a darabszam (`n`) akkor is teljes, es a
  // Fiokok oldalon ugyis mind ott van egymas mellett.
  const MUTATOTT = 3
  const names = parok.slice(0, MUTATOTT).join(' · ') + (parok.length > MUTATOTT ? ' …' : '')
  return [{ id: 'google_dup', status: 'warn', params: { n: parok.length, names } }]
}

export function googleLiveRows(
  now: number = Date.now(),
  data: GoogleLiveAllapot | null = olvasJson<GoogleLiveAllapot>(join(STORE_DIR, GOOGLE_LIVE_FILE)),
  bekotott: number = googleAccountCount(),
  /**
   * Mikor ebredt utoljara a gep (vagy indult a folyamat).
   *
   * Azert PARAMETER es nem globalis olvasas, mert enelkul a turelmi ido
   * nem tesztelheto: minden teszt a sajat folyamat-inditasat latna
   * ebredesnek, es a turelem MINDIG aktiv lenne. Egy nem tesztelheto
   * elnemitas ugyanolyan nema hiba, mint amit ez a modul kiszur.
   */
  ebredt: number = lastWakeAt(),
): HealthRow[] {
  if (bekotott === 0) return []
  if (!data || typeof data.checkedAt !== 'number' || !Array.isArray(data.accounts)) {
    // Van fiok, de meresi eredmeny nincs. Ez NEM "minden rendben" -- eppen ez
    // az allapot allt fenn egesz nap, amig a hozzaferes halott volt.
    return [{ id: 'google_live_never', status: 'warn' }]
  }
  const rows: HealthRow[] = []
  const kora = Math.max(0, now - data.checkedAt)
  const oraja = Math.floor(kora / (60 * 60 * 1000))
  // EBREDES-TURES.
  //
  // Ha a gep az imént ebredt, az ``N oraja nem futott`` NEM hiba: az ora allt,
  // mert a folyamat nem futott. A potlo kor mar uton van (lasd
  // `google-live-check.ts` onWake-bekotese), es ket percen belul lefut.
  // Amig ez tart, nem riasztunk -- kulonben minden reggel sargat kapnank
  // egy ejszakai alvasert. Ha a potlas megsem sikerul, a turelmi ido
  // lejarta utan a sor ugyanugy megjelenik: nem nemitunk el semmit.
  const ebredesOta = Math.max(0, now - ebredt)
  const eppenPotol = ebredesOta < WAKE_GRACE_MS
  if (kora > GOOGLE_LIVE_STALE_MS && !eppenPotol) {
    // Az allo ellenorzo a legalattomosabb eset: a lenti sorok ilyenkor egy REGI
    // pillanatrol szolnanak, magabiztosan.
    rows.push({ id: 'google_live_stale', status: kora > GOOGLE_LIVE_DEAD_MS ? 'bad' : 'warn', params: { h: oraja } })
  }
  const rossz = data.accounts
    .filter(a => a && a.ok === false)
    .map(a => tisztaNev(String(a.id ?? '')))
    .filter(Boolean)
  if (rossz.length > 0) {
    rows.push({
      id: 'google_live_bad',
      status: 'bad',
      params: { n: rossz.length, all: data.accounts.length, names: rossz.join(', ') },
    })
  } else if (kora <= GOOGLE_LIVE_STALE_MS || eppenPotol) {
    // Zold sor is kell: a Boss szabalya szerint a "minden rendben"-t is ki kell
    // mondani, kulonben a hallgatas nem megkulonboztetheto a nem-futo
    // ellenorzestol -- pontosan ez volt a mai hiba alakja.
    rows.push({ id: 'google_live_ok', status: 'ok', params: { n: data.accounts.length, h: oraja } })
  }
  return rows
}

/** A kod-hid EGYETLEN nema hibamodja: a Windows-vegrehajto megall. A feladatok
 *  ilyenkor szepen sorba allnak, a hid "be van kapcsolva", minden lap zolden
 *  mutat -- es egyetlen sor sincs sehol arrol, hogy semmi nem fut le. (Merve
 *  2026-08-22: a vegrehajto 08-20 19:47 ota allt, es az egyetlen nyoma egy ures
 *  projekt-lista volt, amit senki nem nezett.)
 *
 *  Amirol HALLGAT: ha a hid ki van kapcsolva, es ha soha senki nem allitotta be
 *  (nincs vegrehajto, nincs projekt, nincs feladat). Egy be nem uzemelt funkcio
 *  nem hiba, es egy friss telepitesen nem szabad, hogy pirosan alljon valami,
 *  amit a tulajdonos el sem inditott. */
export function codeBridgeRows(
  now: number = Date.now(),
  h: ReturnType<typeof codeBridgeHealth> | null = null,
): HealthRow[] {
  if (!CODE_BRIDGE_ENABLED) return []
  let d
  try {
    d = h ?? codeBridgeHealth(now)
  } catch {
    // A tabla meg nem letezik (regi adatbazis, elso indulas). Nem hiba.
    return []
  }
  const soha = d.lastSeenAt === null
  if (soha && d.sessions === 0 && d.queued === 0 && d.running === 0) return []
  if (soha) {
    // Van mit csinalnia, de nincs mivel: ez a legrosszabb allapot, mert a
    // feladat elmegy es semmi nem szol.
    return [{ id: 'code_bridge_never', status: 'bad', params: { n: d.queued + d.running } }]
  }
  const kora = Math.max(0, now - (d.lastSeenAt ?? 0))
  if (kora > WORKER_STALE_MS) {
    return [{
      id: 'code_bridge_dead',
      status: 'bad',
      params: { p: Math.floor(kora / 60000), n: d.queued + d.running },
    }]
  }
  // A TELEPITETT Windows-peldany elavulhat anelkul, hogy barmi szolna: a
  // szkript a sajat gepen egy masolatban fut, es egy regi masolat nem hibazik,
  // csak nemaan regi adatot kuld. (2026-08-23: a rossz beszelgetes-cimek.)
  const varhato = expectedWorkerVersion()
  const jelentett = d.workers[0]?.version ?? null
  if (varhato === null) {
    // NEM LATUNK ODA: nincs meg a szkript ebben a telepitesben, vagy nincs
    // benne verziojeloles. Ez nem ugyanaz, mint hogy elavult.
    return [{ id: 'code_bridge_worker_unknown', status: 'warn', params: { n: d.sessions } }]
  }
  if (jelentett === null && (d.workers[0]?.sessionsReported ?? null) === null) {
    // A verziot a FELDERITESI kor hozza (merve 2026-08-23: a claim 3
    // masodpercenkent fut, a felderites percenkent). Amig az elso felderites
    // le nem futott, nem tudjuk, hanyadik peldany fut -- ez "nem latok oda",
    // nem "elavult". Enelkul minden friss telepites egy percig hamis
    // figyelmeztetessel indulna.
    return [{ id: 'code_bridge_worker_unknown', status: 'warn', params: { n: d.sessions } }]
  }
  if (jelentett === null) {
    // A FELDERITES megjott, csak verzio nelkul -> a telepitett peldany regebbi
    // annal, mint amikor a verziojeloles bekerult.
    return [{ id: 'code_bridge_worker_unversioned', status: 'warn', params: { e: varhato } }]
  }
  if (jelentett !== varhato) {
    return [{ id: 'code_bridge_worker_stale', status: 'warn', params: { r: jelentett, e: varhato } }]
  }
  // Zold sor is kell: a hallgatas nem megkulonboztetheto a nem-futo
  // ellenorzestol -- pontosan ez a csapda vitte el az elozo ket hetet.
  return [{ id: 'code_bridge_ok', status: 'ok', params: { n: d.sessions, p: Math.floor(kora / 60000) } }]
}

/**
 * Elerheto-e a depo? Olcso valasz: letezik-e a mappa.
 *
 * SZANDEKOSAN nem a `depotHealth()`-et hivjuk: az ir egy probafajlt a lemezre,
 * ez a modul pedig minden Attekintes-betoltesnel lefut. A kulonbseg, ami itt
 * szamit -- "van depo, de nem latok oda" -- ebbol is kiderul.
 *
 * `null`, ha nincs beallitva depo: ilyenkor nem a depo a kerdes.
 */
function depotIrhato(): boolean | null {
  const root = depotRoot()
  if (!root) return null
  try { return statSync(root).isDirectory() } catch { return false }
}


// --- RAKTAR (a depo gyokere) ----------------------------------------------
//
// MIERT VAN EZ A SOR. 2026-08-27-en meresbol derult ki, hogy a raktar
// elerhetoseget CSAK a Drive-mentesen keresztul neztuk. A `driveSyncRows`
// viszont ures listaval kilep, ha nincs bekotott Drive-mappa -- vagyis akinek
// raktara van, de Drive-ja nincs (vagy epp most kotott be egyet), annal a lemez
// leszakadasa NEMA maradt. Pedig a raktar alatt van a Fotok, az Eletfa es az
// Intezo is, es a leszakadas ezen a gepen MERT esemeny: 2026-08-26-an a WSL 9p
// csatornaja szakadt el, es a `/mnt/f` egesz nap elerhetetlen volt.
//
// A NULLA KET DOLGOT JELENTHET -- itt nem kettot, hanem otot, mert MIND MAS
// kovetkezo lepest kivan:
//   * nincs beallitva raktar             -> CSEND. Ez a friss telepites, nem hiba.
//   * odalatunk es irhato                -> ZOLD sor. Enelkul a hallgatas nem
//                                           lenne megkulonboztetheto attol, hogy
//                                           az ellenorzes el sem indult.
//   * a gyoker hianyzik, a SZULO ott van -> csak a mappa nincs meg: letrehozhato
//   * a szulot sem latjuk                -> a lemez vagy a csatolas a kerdes
//   * ott van, de nem irhato             -> jogosultsag vagy elhalt csatolas
//
// A kulonbseget nem a talalatok szamabol talaljuk ki, hanem magatol a
// forrastol kerdezzuk meg: KULON a gyokeret, KULON a szulojet, KULON az
// irasjogot. Es egyik szoveg sem talalgatja a hiba OKAT -- azt a Raktar oldal
// meri meg (`depotHealth`, `depotRemountPlan`), a sor csak odakuld.
//
// MIERT NEM `depotHealth()`: az egy probafajlt IR a lemezre, ez a modul pedig
// minden Attekintes-betoltesnel lefut. Itt csak olvasunk (`statSync`,
// `accessSync`).
//
// A `drive_sync_depot_unreachable` sorral valo atfedes SZANDEKOS: az a
// kovetkezmenyt mondja ki szammal ("{n} mappat nem tud hova menteni"), ez az
// alapot. Ket hangos sor egy okrol olcsobb, mint a csend -- a csend volt a hiba.

/** Amit a raktar gyokererol MERUNK -- irasproba nelkul. */
export interface RaktarMeres {
  /** Be van-e egyaltalan allitva raktar. Ha nincs, nem a raktar a kerdes. */
  configured: boolean
  root: string | null
  /** Latszik-e barmi az utvonalon. */
  letezik: boolean
  /** ... es mappa-e. Egy fajl ugyanott egeszen mas teendo. */
  mappa: boolean
  /** Latszik-e a folotte levo mappa. EZ valasztja szet a "hianyzik a mappa"-t
   *  a "nem latok a lemezre"-tol. */
  szuloLatszik: boolean
  irhato: boolean
}

/**
 * Egy MEGHAJTO-GYOKER (`/mnt/f`) hianyzo mappaja SOSEM "csak letrehozhato".
 *
 * A `dirname('/mnt/f')` a `/mnt`, ami mindig ott van -- a naiv szulo-vizsgalat
 * tehat azt mondana, hogy a mappa nyugodtan letrehozhato. Egy `mkdir` viszont
 * ilyenkor egy kozonseges linux-mappat csinalna a WSL gyokeren, es a Marveen
 * boldogan irna oda: nem a lemezre, hanem a semmibe. (Ugyanez a csapda all a
 * `depot.ts` `ensureDepotSkeleton`-jenel is.)
 */
const MEGHAJTO_GYOKER = /^\/mnt\/[a-z]\/?$/i

export function raktarMeres(root: string | null = depotRoot()): RaktarMeres {
  if (!root) {
    return { configured: false, root: null, letezik: false, mappa: false, szuloLatszik: false, irhato: false }
  }
  let letezik = false
  let mappa = false
  try {
    mappa = statSync(root).isDirectory()
    letezik = true
  } catch {
    letezik = false
  }
  let szuloLatszik = false
  if (MEGHAJTO_GYOKER.test(root)) {
    // A csatolasi pont maga hianyzik: a `/mnt` letezese itt nem bizonyit semmit.
    szuloLatszik = false
  } else {
    try { szuloLatszik = statSync(dirname(root)).isDirectory() } catch { szuloLatszik = false }
  }
  let irhato = false
  if (mappa) {
    try {
      accessSync(root, constants.W_OK)
      irhato = true
    } catch {
      irhato = false
    }
  }
  return { configured: true, root, letezik, mappa, szuloLatszik, irhato }
}

export function raktarRows(m: RaktarMeres = raktarMeres()): HealthRow[] {
  if (!m.configured || !m.root) return []
  const params = { p: m.root }
  if (!m.letezik) {
    return m.szuloLatszik
      ? [{ id: 'depot_missing_dir', status: 'warn', params }]
      : [{ id: 'depot_unreachable', status: 'bad', params }]
  }
  if (!m.mappa) return [{ id: 'depot_not_dir', status: 'bad', params }]
  if (!m.irhato) return [{ id: 'depot_readonly', status: 'bad', params }]
  return [{ id: 'depot_ok', status: 'ok', params }]
}


// --- DRIVE-MENTES ---------------------------------------------------------
//
// Miert van ez a sor: 2026-08-27-en a #47 kartya vizsgalatakor derult ki, hogy
// a Drive-mentes UTOLJARA 11 NAPPAL KORABBAN futott, es a fo fiok masolata
// "reszleges" volt (elertuk a bejarasi korlatot, a tobbi kimaradt). Egyik sem
// latszott sehol: a Depo oldalon egy szurke sorban allt, az Attekintesen semmi.
// Egy biztonsagi mentes, amirol senki nem szol, hogy all -- nem mentes.
//
// A NULLA KET DOLGOT JELENTHET. Nulla bekotott mappa lehet friss telepites
// (ilyenkor CSEND a helyes valasz), es lehet olvashatatlan beallitas-fajl
// (ilyenkor a leghangosabb sor kell). A kettot NEM a szambol dontjuk el, hanem
// magatol a forrastol kerdezzuk meg: letezik-e a fajl, es ertelmezheto-e.

/** A mentes beallitas-fajlja a store-ban. */
export const DRIVE_SYNC_FILE = 'drive-sync.json'
/** Az utemezett kartya neve -- enelkul a mentes csak kezi gombnyomasra fut. */
export const DRIVE_SYNC_TASK = 'drive-mentes'
/** Ennyi nap utan a napi mentes mar nem "kesik", hanem all. */
export const DRIVE_SYNC_STALE_DAYS = 3

interface DriveSyncParos {
  account?: string
  lastRunAt?: string
  lastResult?: string
  /** Hany fajl varakozott meg feltoltesre a legutobbi futas vegen. */
  lastPending?: number
}

/**
 * A beallitas-fajl allapota -- HAROM eset, nem ketto.
 *
 * `hianyzik`: meg soha nem kotott be senki Drive-mappat. Friss telepites: csend.
 * `olvashatatlan`: ott a fajl, de nem ertelmezheto. Ilyenkor a mentes NEM fut,
 *   es errol hangosan szolni kell -- kulonben pont ugy nezne ki, mint a csend.
 * `rendben`: van ertelmezheto lista (akar ures is).
 */
function driveSyncAllapot(path: string): { fajta: 'hianyzik' | 'olvashatatlan' | 'rendben'; parok: DriveSyncParos[] } {
  let nyers: string
  try {
    nyers = readFileSync(path, 'utf-8')
  } catch {
    return { fajta: 'hianyzik', parok: [] }
  }
  try {
    const d = JSON.parse(nyers) as { pairs?: DriveSyncParos[] }
    return { fajta: 'rendben', parok: Array.isArray(d.pairs) ? d.pairs : [] }
  } catch {
    return { fajta: 'olvashatatlan', parok: [] }
  }
}

/** Utemezve van-e egyaltalan a mentes? (Ugyanaz a minta, mint a git-lehuzasnal.) */
function driveSyncKartya(): { letezik: boolean; bekapcsolva: boolean } {
  const d = olvasJson<{ enabled?: boolean }>(join(SCHEDULED_TASKS_DIR, DRIVE_SYNC_TASK, 'task-config.json'))
  if (!d) return { letezik: false, bekapcsolva: false }
  return { letezik: true, bekapcsolva: d.enabled !== false }
}

/**
 * "Reszleges" -e egy futas eredmenye?
 *
 * A szoveget a szinkron irja (`csonkoltSzoveg`), es mindig ezzel a szoval
 * kezdodik. Nem a hiba OKAT talalgatjuk belole -- azt a sor a fajl sajat
 * szovegebol sem mondja meg; itt csak azt allapitjuk meg, hogy CSONKA-e.
 */
export function reszlegesEredmeny(s: string | undefined): boolean {
  return typeof s === 'string' && s.toLowerCase().startsWith('részleges')
}

/**
 * Hany fajl var meg feltoltesre ennel a parosnal?
 *
 * A raktar-mentes elso feltoltese TOBB EJSZAKA: futasonkent 2000 fajl megy fel
 * (MERVE 2026-08-28: a mentendo ag 9356 fajl), a tobbi a kovetkezo futasra
 * marad. Ez nem hiba -- de "rendben" sem: amig var fajl, a mentes NINCS kesz,
 * es aki ilyenkor zold sort lat, az azt hiszi, biztonsagban van.
 *
 * A szamot a paros sajat mezojebol vesszuk, NEM a kepernyore szant mondatbol:
 * egy szoveg-mintabol visszafejtett szam az elso atfogalmazasnal elnemulna.
 */
export function varakozoFajlok(p: DriveSyncParos): number {
  const n = Number(p.lastPending)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * A Drive-mentes allapota az Attekintesen.
 *
 * @param depoIrhato a depo elerheto-e. Elerhetetlen depoval a mentes nem tud
 *   futni, es ez FONTOSABB, mint a "hany napja" -- ezert all elol.
 */
export function driveSyncRows(
  now: number = Date.now(),
  allapot = driveSyncAllapot(join(STORE_DIR, DRIVE_SYNC_FILE)),
  kartya: { letezik: boolean; bekapcsolva: boolean } = driveSyncKartya(),
  depoIrhato: boolean | null = null,
): HealthRow[] {
  // Olvashatatlan beallitas: a mentes ilyenkor NEM fut. A leghangosabb sor.
  if (allapot.fajta === 'olvashatatlan') return [{ id: 'drive_sync_unreadable', status: 'bad' }]
  // Nincs bekotve egyetlen Drive-mappa sem: nincs mit menteni, nincs mirol
  // szolni. Ez a friss telepites csendje.
  if (allapot.fajta === 'hianyzik' || allapot.parok.length === 0) return []

  const db = allapot.parok.length

  // A depo elerhetetlen: a mentesnek nincs hova irnia. Ez elozi a tobbit.
  if (depoIrhato === false) return [{ id: 'drive_sync_depot_unreachable', status: 'bad', params: { n: db } }]

  const rows: HealthRow[] = []

  // Utemezes: bekotott mappak mellett a kikapcsolt kartya adatvesztes-kozeli.
  // A hianyzo kartya ugyanaz, mas okbol -- egy regi telepitesen egyszeruen
  // nincs meg. Mindketto ugyanazt jelenti: csak kezzel fut.
  if (!kartya.letezik) rows.push({ id: 'drive_sync_no_task', status: 'warn', params: { n: db } })
  else if (!kartya.bekapcsolva) rows.push({ id: 'drive_sync_task_disabled', status: 'bad', params: { n: db } })

  // CSONKA MASOLAT. Ez a legalattomosabb allapot: a lista "lefutott"-at mutat,
  // a masolat viszont hianyos. Ezert `bad`, nem `warn` -- es megnevezi, melyik
  // fiokrol van szo, kulonben tiz paros kozott nem talalhato meg.
  const csonkak = allapot.parok.filter((p) => reszlegesEredmeny(p.lastResult))
  if (csonkak.length) {
    const nevek = csonkak.map((p) => String(p.account || '')).filter(Boolean)
    const lista = nevek.length > 4 ? nevek.slice(0, 4).join(', ') + ', +' + (nevek.length - 4) : nevek.join(', ')
    rows.push({ id: 'drive_sync_partial', status: 'bad', params: { n: csonkak.length, all: db, names: lista } })
  }

  // MEG NEM ERT A VEGERE. Nem csonka masolat (a kep teljes volt), csak a
  // feltoltes fer bele reszletekben -- de ettol meg nem szabad zold sort
  // mutatni. `warn`: magatol halad, teendo csak akkor van, ha nem fogy.
  const varakozok = allapot.parok.filter((p) => varakozoFajlok(p) > 0)
  if (varakozok.length) {
    const fajlok = varakozok.reduce((sum, p) => sum + varakozoFajlok(p), 0)
    rows.push({ id: 'drive_sync_incomplete', status: 'warn', params: { n: varakozok.length, f: fajlok } })
  }

  // Mikor futott utoljara BARMELYIK paros?
  const idok = allapot.parok
    .map((p) => (p.lastRunAt ? Date.parse(p.lastRunAt) : NaN))
    .filter((t) => Number.isFinite(t))
  if (idok.length === 0) {
    rows.push({ id: 'drive_sync_never', status: 'warn', params: { n: db } })
    return rows
  }
  const napja = Math.max(0, Math.floor((now - Math.max(...idok)) / 86_400_000))
  if (napja > DRIVE_SYNC_STALE_DAYS) {
    rows.push({ id: 'drive_sync_stale', status: napja > 14 ? 'bad' : 'warn', params: { d: napja, n: db } })
  } else if (rows.length === 0) {
    // Zold sor is kell: a hallgatas nem megkulonboztetheto a nem-futo
    // ellenorzestol.
    rows.push({ id: 'drive_sync_ok', status: 'ok', params: { n: db, d: napja } })
  }
  return rows
}

export function systemHealth(now: number = Date.now()): HealthRow[] {
  const rows: HealthRow[] = [
    claudeAuthRow(),
    ...backupRows(now),
    ...upstreamRows(now),
    ...gitPullRows(now),
    ...raktarRows(),
    ...driveSyncRows(now, undefined, undefined, depotIrhato()),
    ...commandTaskRows(),
    ...mcpAuthRows(now),
    ...googleLiveRows(now),
    ...googleDuplicateRows(),
    ...codeBridgeRows(now),
  ]
  const leaks = secretsInLogs()
  if (leaks.length > 0) {
    rows.push({ id: 'secret_in_log', status: 'warn', params: { n: leaks.length, files: leaks.join(', ') } })
  }
  const disk = diskRow()
  if (disk) rows.push(disk)
  const order: Record<HealthStatus, number> = { bad: 0, warn: 1, ok: 2 }
  return rows.sort((a, b) => order[a.status] - order[b.status])
}

export function worstHealthStatus(rows: HealthRow[]): HealthStatus {
  if (rows.some(r => r.status === 'bad')) return 'bad'
  if (rows.some(r => r.status === 'warn')) return 'warn'
  return 'ok'
}
