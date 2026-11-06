/**
 * ESZREVESZI, HA A GONDOZOTT MODELL-LISTA LEMARADT.
 *
 * A `claude-models.ts` lista embertol jon (cimke, sorrend, leiras). Ez a modul
 * a gepi fele: megnezi a TELEPITETT Claude programot, es kigyujti belole azokat
 * a modell-azonositokat, amik UJABBAK annal, amit a gondozott lista ismer.
 *
 * MIERT NEM a teljes listat gyujtjuk ki gepileg: a program a Haiku 3.5-ig
 * MINDEN regi modellt tartalmaz (2026-09-23-i meres, CLI 2.1.280: 27 kulonbozo
 * azonosito, koztuk `claude-opus-4-0`, `claude-sonnet-3-7`). Egy nyers
 * kigyujtes tehat nem frissebb listat adna, hanem hasznalhatatlanul hosszut.
 * Ezert csak az UJ darabokat keressuk, csaladon belul verzio szerint.
 *
 * A NULLA KET DOLGOT JELENTHET. Nulla talalat jelentheti azt, hogy nincs ujabb
 * modell (ez a jo eset), es azt is, hogy nem lattunk oda a programhoz. A ketto
 * NEM ugyanaz, ezert a valasz kulon `cliSeen` mezot visz, es a felulet mas
 * mondatot mutat rajuk. Kulon fogas: ha a fajlt EL tudtuk olvasni, de EGYETLEN
 * ismert csaladot sem talaltunk benne, az sem "nincs modell" -- az azt jelenti,
 * hogy nem ertettuk a fajlt (mas formatum, buritokszkript), tehat `cliSeen`
 * hamis. Egy valodi Claude-program mindig tartalmazza a sajat modelljeit.
 *
 * A meres NEM TEVEDHETETLEN, es ezt vallaljuk is. A 2026-09-23-i futasban a
 * `claude-haiku-3-55` is elojott -- ket egymas melle kerult szovegdarab, nem
 * valodi modell. Ezert az eredmeny SOSE valik automatikusan valasztassa: kulon
 * "Uj modellek" csoportban jelenik meg, a felhasznalo dontesere varva. Egy
 * ilyen rossz talalat legrosszabb esetben egy nem letezo modell felkinalasa
 * (a session azonnal hibaval indul), nem pedig egy csendes modell-csere.
 */
import { execFile } from 'node:child_process'
import { existsSync, openSync, readSync, closeSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { open as openAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { STORE_DIR } from './config.js'
import { CLAUDE_MODEL_IDS, claudeVersionRank, newestKnownInFamily, parseClaudeModelId, type ClaudeFamily } from './claude-models.js'

const execFileAsync = promisify(execFile)

export const CLAUDE_MODEL_SCAN_PATH = join(STORE_DIR, 'claude-model-scan.json')

export interface DiscoveredModel {
  id: string
  family: ClaudeFamily
  name: string
}

export interface ClaudeModelScan {
  /** Lattunk-e egyaltalan a telepitett programhoz? HA HAMIS, a lista semmit nem bizonyit. */
  cliSeen: boolean
  /** Miert nem lattunk oda (ures, ha lattunk). Emberi mondat, nem hibakod. */
  reason: string
  /** A program utvonala, ha megtalaltuk. */
  cliPath: string
  /** A program verzioja, ha le tudtuk kerdezni. */
  cliVersion: string
  /** Az UJABB, nalunk nem szereplo modellek. */
  models: DiscoveredModel[]
  scannedAt: string
}

/** `claude-opus-5-5` -> `Opus 5.5`. Gepi nev, amig ember jobbat nem ad neki. */
export function prettyName(id: string): string {
  const v = parseClaudeModelId(id)
  if (!v) return id
  const csalad = v.family.charAt(0).toUpperCase() + v.family.slice(1)
  return v.minor ? `${csalad} ${v.major}.${v.minor}` : `${csalad} ${v.major}`
}

/** Hol a telepitett Claude program? `null`, ha nem talaljuk. */
export async function findClaudeBinary(): Promise<string | null> {
  const parancs = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(parancs, ['claude'], { timeout: 5000 })
    const elso = String(stdout || '').split('\n')[0].trim()
    if (!elso || !existsSync(elso)) return null
    // A `which` gyakran egy inditot ad vissza, ami a valodi (nagy) programra
    // mutat. A `realpath` ezt feloldja; ha nem megy, marad az eredeti ut.
    try {
      const { stdout: valodi } = await execFileAsync('realpath', [elso], { timeout: 5000 })
      const p = String(valodi || '').trim()
      if (p && existsSync(p)) return p
    } catch { /* realpath nincs (pl. Windows): marad az eredeti */ }
    return elso
  } catch {
    return null
  }
}

/**
 * Vegigolvassa a fajlt, es kigyujti a benne talalhato modell-azonositokat.
 *
 * Darabokban olvas, mert a program tobb szaz MB is lehet. A darabok kozott
 * ATFEDES van, kulonben egy pont a hataron kettevagott azonosito elveszne.
 */
const MODEL_ID_RE = /^claude-(fable|opus|sonnet|haiku)-\d+(?:-\d+)?/
const MODEL_PREFIX = Buffer.from('claude-', 'latin1')
const SCAN_CHUNK = 4 * 1024 * 1024
const SCAN_OVERLAP = 64

/**
 * One chunk: find the literal `claude-` with Buffer.indexOf (native memchr-speed,
 * no 8 MB string is built) and run the regex only on a short window per hit.
 * The 340 MB binary used to be decoded to latin1 strings and regex-scanned in
 * one synchronous loop, which froze the dashboard for 3.4-4.7 s (stall samples
 * 2026-11-06 14:00 and 22:00).
 */
function collectIds(buf: Buffer, n: number, into: Set<string>): void {
  let i = buf.indexOf(MODEL_PREFIX)
  while (i !== -1 && i < n) {
    const m = MODEL_ID_RE.exec(buf.toString('latin1', i, Math.min(n, i + 48)))
    if (m) into.add(m[0])
    i = buf.indexOf(MODEL_PREFIX, i + 1)
  }
}

/** Same result as the async scan, blocking. Kept for callers and tests that need a sync answer. */
export function scanBinaryForModelIds(path: string): Set<string> {
  const talalt = new Set<string>()
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const meret = statSync(path).size
    const buf = Buffer.alloc(SCAN_CHUNK + SCAN_OVERLAP)
    let pos = 0
    while (pos < meret) {
      const kezdet = pos === 0 ? 0 : pos - SCAN_OVERLAP
      const n = readSync(fd, buf, 0, SCAN_CHUNK + SCAN_OVERLAP, kezdet)
      if (n <= 0) break
      collectIds(buf.subarray(0, n), n, talalt)
      pos = kezdet + n
    }
  } catch {
    return new Set()
  } finally {
    if (fd !== null) { try { closeSync(fd) } catch { /* mar zarva */ } }
  }
  return talalt
}

/**
 * Non-blocking scan: file reads go through the thread pool and the loop is given
 * back (setImmediate) after every chunk, so one slice of work never holds the
 * event loop longer than a few milliseconds.
 */
export async function scanBinaryForModelIdsAsync(path: string): Promise<Set<string>> {
  const talalt = new Set<string>()
  let fh: Awaited<ReturnType<typeof openAsync>> | null = null
  try {
    fh = await openAsync(path, 'r')
    const meret = (await fh.stat()).size
    const buf = Buffer.alloc(SCAN_CHUNK + SCAN_OVERLAP)
    let pos = 0
    while (pos < meret) {
      const kezdet = pos === 0 ? 0 : pos - SCAN_OVERLAP
      const { bytesRead: n } = await fh.read(buf, 0, SCAN_CHUNK + SCAN_OVERLAP, kezdet)
      if (n <= 0) break
      collectIds(buf.subarray(0, n), n, talalt)
      pos = kezdet + n
      await new Promise<void>((r) => setImmediate(r))
    }
  } catch {
    return new Set()
  } finally {
    if (fh) { try { await fh.close() } catch { /* mar zarva */ } }
  }
  return talalt
}

/** Melyik talalt azonosito UJABB annal, amit a gondozott lista ismer? */
export function newerThanKnown(ids: Iterable<string>): DiscoveredModel[] {
  const ki: DiscoveredModel[] = []
  for (const id of ids) {
    if (CLAUDE_MODEL_IDS.includes(id)) continue
    const v = parseClaudeModelId(id)
    if (!v) continue
    const legujabb = newestKnownInFamily(v.family)
    // Ismeretlen csalad (meg egy sincs belole a listankban) is UJ: azt is
    // fel kell kinalni, kulonben egy teljesen uj modellcsalad nem latszana.
    if (legujabb >= 0 && claudeVersionRank(id) <= legujabb) continue
    ki.push({ id, family: v.family, name: prettyName(id) })
  }
  return ki.sort((a, b) => claudeVersionRank(b.id) - claudeVersionRank(a.id))
}

/** A telepitett program verzioja (`claude --version`), vagy ures sztring. */
async function cliVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10000 })
    return String(stdout || '').trim().split('\n')[0] || ''
  } catch {
    return ''
  }
}

function loadCache(): (ClaudeModelScan & { cacheKey?: string }) | null {
  try {
    const o = JSON.parse(readFileSync(CLAUDE_MODEL_SCAN_PATH, 'utf-8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null
  } catch {
    return null
  }
}

/**
 * A telepitett program modell-kinalata, gyorsitotarazva.
 *
 * A gyorsitotar kulcsa a program UTVONALA + VERZIOJA + MERETE. Ha a Claude
 * frissul, mind a harom valtozhat, tehat a meres MAGATOL megujul -- nem kell
 * hozza sem idozito, sem kezi gomb. Pontosan ez hianyzott eddig: a lista azert
 * nem frissult, mert semmi nem merte ujra.
 */
let memo: { at: number; ertek: ClaudeModelScan } | null = null
const MEMO_MS = 10 * 60 * 1000

export async function scanInstalledClaude(force = false): Promise<ClaudeModelScan> {
  // Folyamaton beluli memo. A `/api/models/available` minden legordulo-nyitasnal
  // hivja, a program megkeresese pedig ket alfolyamatot inditana (`which`,
  // `claude --version`) -- azt nem szabad percenkent tobbszor megfizetni.
  if (!force && memo && Date.now() - memo.at < MEMO_MS) return memo.ertek
  const path = await findClaudeBinary()
  if (!path) {
    return valaszol({
      cliSeen: false,
      reason: 'A telepített Claude programot nem találtam meg a gépen (a „claude" parancs nincs az elérési úton), ezért nem tudom, ismer-e újabb modellt.',
      cliPath: '', cliVersion: '', models: [], scannedAt: new Date().toISOString(),
    })
  }
  let meret = 0
  try { meret = statSync(path).size } catch { /* marad 0 */ }
  const verzio = await cliVersion()
  const kulcs = `${path}|${verzio}|${meret}`
  if (!force) {
    const cache = loadCache()
    if (cache && cache.cacheKey === kulcs && Array.isArray(cache.models)) {
      return valaszol({ ...cache, models: cache.models })
    }
  }

  const talalt = await scanBinaryForModelIdsAsync(path)
  if (talalt.size === 0) {
    // NEM "nincs modell": egy valodi Claude-program mindig tartalmazza a
    // sajatjait. Ha egyet sem latunk, a fajlt nem ertettuk meg.
    return valaszol({
      cliSeen: false,
      reason: `A Claude programot megtaláltam (${path}), de egyetlen modell-azonosítót sem tudtam kiolvasni belőle, ezért nem állítom, hogy nincs újabb modell. Lehet, hogy indítóprogram, nem maga a program.`,
      cliPath: path, cliVersion: verzio, models: [], scannedAt: new Date().toISOString(),
    })
  }

  const eredmeny: ClaudeModelScan = {
    cliSeen: true, reason: '', cliPath: path, cliVersion: verzio,
    models: newerThanKnown(talalt), scannedAt: new Date().toISOString(),
  }
  try {
    writeFileSync(CLAUDE_MODEL_SCAN_PATH, JSON.stringify({ ...eredmeny, cacheKey: kulcs }, null, 2) + '\n')
  } catch { /* a gyorsitotar irasa SOSE bukhat el ugy, hogy a meres elvesszen */ }
  return valaszol(eredmeny)
}

function valaszol(r: ClaudeModelScan): ClaudeModelScan {
  memo = { at: Date.now(), ertek: r }
  return r
}

/** Csak teszthez: eldobja a folyamaton beluli memot. */
export function resetClaudeScanMemo(): void {
  memo = null
}
