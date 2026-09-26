// MEGA fiokok bekotese rclone-nal (kartya e67bf278).
//
// Miert rclone es nem sajat MEGA-kliens: a MEGA protokollja vegponttol-vegpontig
// titkositott, sajat kulcskezelessel -- egy hazi implementacio pont ott hibazna,
// ahol a legdragabb (adatvesztes). Az rclone ingyenes (MIT), Linuxon es macOS-en
// egyforman fut, es a MEGA backendje a legelterjedtebb nyilt forraskodu ut.
// A Drive a sajat, meglevo megoldasan marad (a tulajdonos, 2026-09-23).
//
// Amit a MEGA-rol tudni kell, es ami ezert a feluleten is ott all:
//   - a fiokot EGYSZER bongeszoben meg kell nyitni, kulonben az rclone nem lep be;
//   - ketlepcsos azonositassal (2FA) az rclone nem tud belepni;
//   - ingyenes fioknal a letoltesnek IP-nkenti atviteli kerete van -- ezert
//     keves parhuzamos atvitel (`MEGA_TRANSFERS`).
//
// Titok: a jelszo SOHA nem kerul parancssori argumentumba (a `ps` latna) es
// soha nem megy vissza a bongeszonek. Az `rclone obscure -` a standard
// bemenetrol olvassa, a konfig `0600`-as fajlban all a store/ alatt.
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { STORE_DIR } from './config.js'

/** Egyszerre ennyi atvitel -- az ingyenes fiok IP-kerete miatt keves. */
export const MEGA_TRANSFERS = 2

export interface MegaAccount {
  /** A fiok kulcsa (a mappa neve is ez): az email @ elotti resze, tisztitva. */
  name: string
  email: string
  /** Az rclone remote neve: `mega_<name>`. */
  remote: string
  addedAt: number
}

export interface MegaQuota {
  total: number | null
  used: number | null
  free: number | null
  measuredAt: number
  /** Ha a meres nem sikerult: a MEGA/rclone sajat hibauzenete. */
  error?: string
}

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (bin: string, args: string[], input?: string) => Promise<RunResult>

function megaDir(): string { return join(STORE_DIR, 'rclone') }
export function rcloneConfigPath(): string { return join(megaDir(), 'rclone.conf') }
function accountsFile(): string { return join(STORE_DIR, 'mega-accounts.json') }
function quotaFile(): string { return join(STORE_DIR, 'mega-quota.json') }

/**
 * Az rclone helye. Sorrend: `MARVEEN_RCLONE`, a telepito altal hasznalt
 * `~/.local/bin/rclone`, majd a PATH. `null` = nincs telepitve -- ezt a hivo
 * KULON mondja ki, nem "nincs MEGA fiok"-kent.
 */
export function rcloneBin(): string | null {
  const env = process.env.MARVEEN_RCLONE
  if (env) return existsSync(env) ? env : null
  const local = join(homedir(), '.local', 'bin', 'rclone')
  if (existsSync(local)) return local
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, 'rclone')
    if (existsSync(p)) return p
  }
  return null
}

/** Kilepokod, ha az rclone-t az idotullepes allitotta le (mint a `timeout` parancsnal). */
export const RCLONE_TIMEOUT_CODE = 124

/**
 * Runner adott idotullepessel. Ha a folyamatot az ido allitja le, a kod
 * `RCLONE_TIMEOUT_CODE` -- a hivo igy kulon tudja mondani, hogy "nem jott
 * valasz idoben", es nem kell a hibaszovegbol kitalalnia.
 */
export function makeRunner(timeoutMs: number): Runner {
  return (bin, args, input) =>
    new Promise((resolve) => {
      const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && (err as any).killed) {
          resolve({ code: RCLONE_TIMEOUT_CODE, stdout: String(stdout || ''), stderr: `rclone timeout after ${Math.round(timeoutMs / 1000)}s` })
          return
        }
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (err && !stdout ? err.message : '')) })
      })
      if (input !== undefined) { child.stdin?.end(input) }
    })
}

export const defaultRunner: Runner = makeRunner(60_000)

export async function rcloneStatus(run: Runner = defaultRunner): Promise<{ installed: boolean; path: string | null; version: string | null }> {
  const bin = rcloneBin()
  if (!bin) return { installed: false, path: null, version: null }
  const r = await run(bin, ['version'])
  const m = /rclone\s+v?([\d.]+[^\s]*)/.exec(r.stdout)
  return { installed: true, path: bin, version: m ? m[1] : null }
}

/** Fiok-kulcs az emailbol: kisbetu, csak [a-z0-9_-]. */
export function megaAccountName(email: string): string {
  const local = String(email || '').split('@')[0].toLowerCase()
  return local.replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40)
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())
}

export function readMegaAccounts(): MegaAccount[] {
  try {
    const j = JSON.parse(readFileSync(accountsFile(), 'utf8'))
    return Array.isArray(j?.accounts) ? j.accounts.filter((a: any) => a && typeof a.name === 'string') : []
  } catch {
    return []
  }
}

function writeAtomic(path: string, body: string, mode?: number): void {
  const tmp = path + '.new'
  writeFileSync(tmp, body, { encoding: 'utf8', mode: mode ?? 0o644 })
  renameSync(tmp, path)
  if (mode !== undefined) { try { chmodSync(path, mode) } catch { /* best effort */ } }
}

function writeMegaAccounts(list: MegaAccount[]): void {
  mkdirSync(STORE_DIR, { recursive: true })
  writeAtomic(accountsFile(), JSON.stringify({ accounts: list }, null, 2) + '\n')
}

export function readMegaQuota(): Record<string, MegaQuota> {
  try {
    const j = JSON.parse(readFileSync(quotaFile(), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function writeMegaQuota(name: string, q: MegaQuota | null): void {
  const all = readMegaQuota()
  if (q) all[name] = q
  else delete all[name]
  mkdirSync(STORE_DIR, { recursive: true })
  writeAtomic(quotaFile(), JSON.stringify(all, null, 2) + '\n')
}

// --- rclone.conf: egyszeru INI, csak a sajat [mega_*] szakaszainkhoz nyulunk.

function readConf(): string {
  try { return readFileSync(rcloneConfigPath(), 'utf8') } catch { return '' }
}

/** A konf szovege a megadott szakasz NELKUL. Mas szakaszokhoz nem nyul. */
export function confWithout(conf: string, remote: string): string {
  const out: string[] = []
  let skip = false
  for (const line of conf.split('\n')) {
    const h = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (h) skip = h[1] === remote
    if (!skip) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

function writeConf(body: string): void {
  mkdirSync(megaDir(), { recursive: true, mode: 0o700 })
  writeAtomic(rcloneConfigPath(), body.trim() ? body.trimEnd() + '\n' : '', 0o600)
}

/**
 * Az rclone hibaszovegebol a felhasznalonak szolo mondat. A MEGA sajat
 * uzenetet mindig melle tesszuk -- nem talalgatunk okot.
 */
export function explainMegaError(stderr: string): { code: string; raw: string } {
  const raw = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ').slice(0, 400)
  const s = raw.toLowerCase()
  if (/enoent|wrong password|login failed|invalid argument|object \(typically, node or user\) not found/.test(s)) return { code: 'login_failed', raw }
  if (/multi-factor|2fa|mfa/.test(s)) return { code: 'twofa', raw }
  if (/eblocked|blocked|not verified|confirm/.test(s)) return { code: 'not_activated', raw }
  if (/no such host|timeout|network|connection refused|dial tcp/.test(s)) return { code: 'network', raw }
  if (/over ?quota|eoverquota|bandwidth|transfer quota/.test(s)) return { code: 'transfer_quota', raw }
  return { code: 'unknown', raw }
}

function parseAbout(stdout: string): { total: number | null; used: number | null; free: number | null } | null {
  try {
    const j = JSON.parse(stdout)
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return { total: num(j.total), used: num(j.used), free: num(j.free) }
  } catch {
    return null
  }
}

async function about(bin: string, remote: string, run: Runner): Promise<RunResult> {
  return run(bin, ['about', `${remote}:`, '--json', '--config', rcloneConfigPath()])
}

export type AddResult =
  | { ok: true; account: MegaAccount; quota: MegaQuota }
  | { ok: false; error: string; detail?: string }

/**
 * Uj MEGA fiok. Csak akkor marad meg, ha az rclone TENYLEG be tudott lepni
 * (`about` sikeres) -- egy rossz jelszoval felvett fiok zold sornak latszana,
 * mikozben semmi nem mukodik mogotte.
 */
export async function addMegaAccount(
  input: { email: string; password: string },
  run: Runner = defaultRunner,
): Promise<AddResult> {
  const email = String(input.email || '').trim()
  const password = String(input.password || '')
  if (!isValidEmail(email)) return { ok: false, error: 'bad_email' }
  if (!password) return { ok: false, error: 'no_password' }
  const bin = rcloneBin()
  if (!bin) return { ok: false, error: 'rclone_missing' }
  const name = megaAccountName(email)
  if (!name) return { ok: false, error: 'bad_email' }
  const existing = readMegaAccounts()
  if (existing.some((a) => a.name === name || a.email.toLowerCase() === email.toLowerCase())) {
    return { ok: false, error: 'exists' }
  }

  const ob = await run(bin, ['obscure', '-'], password)
  const obscured = ob.stdout.trim()
  if (ob.code !== 0 || !obscured) return { ok: false, error: 'obscure_failed', detail: explainMegaError(ob.stderr).raw }

  const remote = `mega_${name}`
  const prev = readConf()
  const section = `[${remote}]\ntype = mega\nuser = ${email}\npass = ${obscured}\n`
  writeConf(confWithout(prev, remote).trimEnd() + (prev.trim() ? '\n\n' : '') + section)

  const r = await about(bin, remote, run)
  const parsed = r.code === 0 ? parseAbout(r.stdout) : null
  if (!parsed) {
    // Visszaallitjuk: a sikertelen fiok nem maradhat a konfigban.
    writeConf(confWithout(readConf(), remote))
    const e = explainMegaError(r.stderr || r.stdout)
    return { ok: false, error: e.code, detail: e.raw }
  }
  const account: MegaAccount = { name, email, remote, addedAt: Date.now() }
  writeMegaAccounts([...existing, account])
  const quota: MegaQuota = { ...parsed, measuredAt: Date.now() }
  writeMegaQuota(name, quota)
  return { ok: true, account, quota }
}

/**
 * A fiok LEVETELE a Marveenrol. A MEGA-n levo fajlokhoz es a helyi mappahoz
 * NEM nyul -- csak a belepesi adat es a nyilvantartas sora megy.
 */
export function removeMegaAccount(name: string): boolean {
  const list = readMegaAccounts()
  const acc = list.find((a) => a.name === name)
  if (!acc) return false
  writeConf(confWithout(readConf(), acc.remote))
  writeMegaAccounts(list.filter((a) => a.name !== name))
  writeMegaQuota(name, null)
  return true
}

/** Tarhely-meres egy fiokra. Hibanal is ir: a hiba idobelyeget kap. */
export async function measureMegaQuota(name: string, run: Runner = defaultRunner): Promise<MegaQuota | null> {
  const acc = readMegaAccounts().find((a) => a.name === name)
  if (!acc) return null
  const bin = rcloneBin()
  if (!bin) {
    const q: MegaQuota = { total: null, used: null, free: null, measuredAt: Date.now(), error: 'rclone_missing' }
    writeMegaQuota(name, q)
    return q
  }
  const r = await about(bin, acc.remote, run)
  const parsed = r.code === 0 ? parseAbout(r.stdout) : null
  const q: MegaQuota = parsed
    ? { ...parsed, measuredAt: Date.now() }
    : { total: null, used: null, free: null, measuredAt: Date.now(), error: explainMegaError(r.stderr || r.stdout).raw || 'unknown' }
  writeMegaQuota(name, q)
  return q
}

export function megaAccountNames(): string[] {
  return readMegaAccounts().map((a) => a.name)
}

// --- Fiok tartalmanak bongeszese (#398) --------------------------------------
// A Raktar -> MEGA oldal a fiok tartalmat helyben mutatja, mint a Drive. Csak
// OLVAS (`rclone lsjson`, egy szint): fajlhoz nem nyul, es nem tolt le semmit.

/** Egy mappa listazasanak felso hatara. Ennyi utan "nem jott valasz". */
export const MEGA_LIST_TIMEOUT_MS = 45_000

export interface MegaEntry {
  name: string
  /** A fiok gyokerehez viszonyitott ut, `/` elvalasztassal. */
  path: string
  isDir: boolean
  /** Bajt; mappanal `null` (az rclone -1-et ad). */
  size: number | null
  modTime: string | null
}

export type MegaListResult =
  | { ok: true; path: string; items: MegaEntry[] }
  | { ok: false; error: string; detail?: string }

/**
 * A kert ut a fiokon belul, tisztitva. `null` = elutasitva: `..`/`.` szakasz,
 * vezerlokarakter, tul hosszu -- a bongeszo sose lephessen ki a fiok
 * gyokerebol, es ne csempeszhessen rclone-kapcsolot az argumentumba (az ut
 * mindig a `remote:` utan all, sosem kezdodik `-`-szal az argumentum).
 */
export function normalizeMegaPath(raw: unknown): string | null {
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') return null
  if (raw.length > 1024 || /[\u0000-\u001f\u007f]/.test(raw)) return null
  const parts = raw.split('/').filter((p) => p !== '')
  if (parts.some((p) => p === '.' || p === '..')) return null
  return parts.join('/')
}

function parseLsjson(stdout: string, base: string): MegaEntry[] | null {
  let j: unknown
  try { j = JSON.parse(stdout) } catch { return null }
  if (!Array.isArray(j)) return null
  const items: MegaEntry[] = []
  for (const e of j as any[]) {
    if (!e || typeof e.Name !== 'string') continue
    const isDir = e.IsDir === true
    items.push({
      name: e.Name,
      path: base ? `${base}/${e.Name}` : e.Name,
      isDir,
      size: !isDir && typeof e.Size === 'number' && e.Size >= 0 ? e.Size : null,
      modTime: typeof e.ModTime === 'string' ? e.ModTime : null,
    })
  }
  // Mappak elol, utana nev szerint -- mint a Drive-lista.
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) : a.isDir ? -1 : 1))
  return items
}

/**
 * Egy mappa tartalma a MEGA fiokon. Az ures lista CSAK sikeres listazasbol
 * johet: minden mas (nincs rclone, belepes elbukott, idotullepes, nincs ilyen
 * mappa) kulon hibakodot kap, a MEGA/rclone sajat szovegevel.
 */
export async function listMegaDir(
  name: string,
  rawPath: unknown,
  run: Runner = makeRunner(MEGA_LIST_TIMEOUT_MS),
): Promise<MegaListResult> {
  const acc = readMegaAccounts().find((a) => a.name === name)
  if (!acc) return { ok: false, error: 'not_found' }
  const path = normalizeMegaPath(rawPath)
  if (path === null) return { ok: false, error: 'bad_path' }
  const bin = rcloneBin()
  if (!bin) return { ok: false, error: 'rclone_missing' }
  const r = await run(bin, ['lsjson', `${acc.remote}:${path}`, '--config', rcloneConfigPath()])
  if (r.code === RCLONE_TIMEOUT_CODE) return { ok: false, error: 'timeout', detail: r.stderr }
  if (r.code !== 0) {
    const e = explainMegaError(r.stderr || r.stdout)
    if (/directory not found/i.test(e.raw)) return { ok: false, error: 'dir_not_found', detail: e.raw }
    return { ok: false, error: e.code, detail: e.raw }
  }
  const items = parseLsjson(r.stdout, path)
  if (!items) return { ok: false, error: 'bad_output', detail: r.stdout.slice(0, 200) }
  return { ok: true, path, items }
}
