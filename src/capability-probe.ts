/**
 * PARANCS-MERES: van-e ez a program ezen a gepen? (kanban #336, 8. fazis)
 *
 * Ezt a 7. fazis a LibreOffice-hoz irta meg; a 8. fazisban ugyanez kell az
 * FFmpeg-hez is -- ezert egy helyen all, nem ketszer. Aki uj kulso programot
 * kot be, IDE ad egy leirast, es a Kepessegek lap magatol tudja merni.
 *
 * A LEGFONTOSABB, amit oriz: A NULLA KET DOLGOT JELENTHET.
 *   `not_installed`  -- egyik jelolt sem letezik: nincs telepitve. Csendes,
 *                       varhato allapot egy friss telepitesen.
 *   `check_failed`   -- LETEZIK, de nem tudtuk megkerdezni (jogosultsag, hibas
 *                       ut, idotullepes). Ez NEM ugyanaz, es SOHA nem szabad
 *                       "nincs telepitve"-nek mutatni: mas a teendo.
 * A `detail` mindig a VALODI hibauzenet -- sosem talalgatott ok.
 */
import { spawn } from 'node:child_process'

export type ProbeReason = 'ok' | 'not_installed' | 'check_failed'

export interface CommandProbe {
  available: boolean
  /** A mukodo parancs (ut vagy nev), ha van. */
  path: string | null
  /** A verzio-lekerdezes elso sora, ha meg tudtuk kerdezni. */
  version: string | null
  reason: ProbeReason
  /** A VALODI hibauzenet, ha nem sikerult -- sosem talalgatott ok. */
  detail: string | null
  /** Mikor mertuk (epoch ms). A felulet igy ki tudja irni, mikori az allitas. */
  checked_at: number
}

/** A felhasznalo altal MEGADOTT ut: a `source` azert kell, hogy a hibauzenet
 *  meg tudja nevezni, MELYIK beallitast kell javitani. */
export interface ConfiguredPath {
  path: string
  /** A beallitas neve, ahogy a felhasznalo latja (`WORKBENCH_FFMPEG_PATH`). */
  source: string
}

export interface ProbeSpec {
  /** Gyorsitotar-kulcs (`soffice`, `ffmpeg`). */
  id: string
  /** Ha a felhasznalo megmondta, hol van: akkor CSAK ott keressuk. */
  configured: ConfiguredPath | null
  /** Hol keressuk kulonben. NEM ennek a gepnek az azonositoi, hanem a
   *  program sajat, szokasos telepitesi helyei. */
  candidates: string[]
  /** Mivel kerdezzuk meg, hogy el-e (`['--version']`). */
  versionArgs: string[]
  timeoutMs?: number
}

export interface ProbeOptions {
  force?: boolean
  /** Csak teszthez: a jeloltek felulirasa (igy a teszt nem a gep sajat
   *  telepiteset meri, tehat ugyanazt mondja minden gepen). */
  candidates?: string[]
  timeoutMs?: number
}

/**
 * Egy program futtatasa idokorlattal.
 *
 * Idotullepeskor a TELJES folyamatcsoportot lojuk le, nem csak a kozvetlen
 * gyereket: a `soffice` egy burkolo szkript, ami a `soffice.bin`-t inditja --
 * a gyerek megolese utan az unoka arvakent tovabb futott, fogta a kozos
 * LibreOffice-profilt, es minden kovetkezo atalakitas is elakadt rajta.
 */
export function runVersion(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; code: 'not_found' | 'timeout' | 'failed'; detail: string }> {
  return new Promise((resolve) => {
    // `spawn`, nem `execFile`: az utobbi a `detached` kapcsolot csendben
    // eldobja, igy nem lenne sajat folyamatcsoport, amit egyben lelohetunk.
    const group = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { windowsHide: true, detached: group, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      return resolve({ ok: false, code: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'failed', detail })
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const cap = 1024 * 1024
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < cap) stdout += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < cap) stderr += d.toString('utf8') })
    const finish = (r: Parameters<typeof resolve>[0]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const killAll = (): void => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* mar kilepett */ }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killAll()
      // Ha egy unoka megis nyitva tartana a csovet, akkor se varjunk orokke.
      setTimeout(() => finish({ ok: false, code: 'timeout', detail: stderr.trim() || `timed out after ${timeoutMs} ms` }), 2000).unref?.()
    }, timeoutMs)
    child.on('error', (e: NodeJS.ErrnoException) => {
      const detail = stderr.trim() || e.message
      finish({ ok: false, code: e.code === 'ENOENT' ? 'not_found' : 'failed', detail })
    })
    child.on('close', (code, signal) => {
      if (timedOut) return finish({ ok: false, code: 'timeout', detail: stderr.trim() || `timed out after ${timeoutMs} ms` })
      if (code === 0) return finish({ ok: true, stdout, stderr })
      finish({ ok: false, code: 'failed', detail: stderr.trim() || `exited with ${code ?? signal}` })
    })
  })
}

const PROBE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, CommandProbe>()
const inFlight = new Map<string, Promise<CommandProbe>>()

/** Megmeri, elerheto-e a program. Az eredmenyt 5 percig megjegyzi (a valasz
 *  ritkan valtozik, a kerdes viszont draga), de a `force` MINDIG ujra meri --
 *  telepites utan azonnal a friss allapot kell, nem a regi meresbol valaszolunk. */
export async function probeCommand(spec: ProbeSpec, opts: ProbeOptions = {}): Promise<CommandProbe> {
  const timeoutMs = opts.timeoutMs ?? spec.timeoutMs ?? 20_000
  // A MEGADOTT ut resze a kulcsnak: ha a felhasznalo kozben atallitotta (akar
  // a Beallitasok lapjan, nem is a Munkapadon), a regi meres NEM valaszolhat
  // helyette -- az pont az elavult adat esete volna, amit a szabaly tilt.
  const cacheKey = `${spec.id}|${spec.configured?.path ?? ''}`
  if (!opts.force) {
    const hit = cache.get(cacheKey)
    if (hit && Date.now() - hit.checked_at < PROBE_TTL_MS) return hit
    const running = inFlight.get(cacheKey)
    if (running) return running
  }
  const task = (async (): Promise<CommandProbe> => {
    // A MEGADOTT ut kulon eset: ha az nem jo, az nem "nincs telepitve", hanem
    // "amit megadtal, nem mukodik" -- mas a teendo, es csendben MAS peldanyt
    // hasznalni helyette rosszabb volna, mint szolni rola.
    if (!opts.candidates && spec.configured && spec.configured.path) {
      const c = spec.configured
      const r = await runVersion(c.path, spec.versionArgs, timeoutMs)
      if (r.ok) return ok(c.path, r.stdout, r.stderr)
      return {
        available: false, path: null, version: null, reason: 'check_failed',
        detail: `${c.source}=${c.path}: ${r.detail}`, checked_at: Date.now(),
      }
    }
    let lastFailure: { detail: string; cmd: string } | null = null
    for (const cmd of (opts.candidates || spec.candidates)) {
      const r = await runVersion(cmd, spec.versionArgs, timeoutMs)
      if (r.ok) return ok(cmd, r.stdout, r.stderr)
      // A "nincs ilyen parancs" nem hiba: megyunk a kovetkezo jeloltre.
      if (r.code !== 'not_found') lastFailure = { detail: r.detail, cmd }
    }
    if (lastFailure) {
      return {
        available: false, path: null, version: null, reason: 'check_failed',
        detail: `${lastFailure.cmd}: ${lastFailure.detail}`, checked_at: Date.now(),
      }
    }
    return { available: false, path: null, version: null, reason: 'not_installed', detail: null, checked_at: Date.now() }
  })()
  inFlight.set(cacheKey, task)
  try {
    const out = await task
    cache.set(cacheKey, out)
    return out
  } finally {
    if (inFlight.get(cacheKey) === task) inFlight.delete(cacheKey)
  }
}

// Nehany program (lsof -v, pdftotext -v) a verziojat a hibakimenetre irja,
// sikeres kilepessel: ilyenkor onnan olvassuk, kulonben ures maradna.
function ok(path: string, stdout: string, stderr = ''): CommandProbe {
  // Az elso szamot tartalmazo sor ("lsof version information:" utan jon a
  // "revision: 4.95.0"); ha egyik sorban sincs szam, az elso nem ures sor.
  const firstLine = (s: string): string => {
    const lines = s.split('\n').map(l => l.trim()).filter(Boolean)
    return lines.find(l => /\d/.test(l)) ?? lines[0] ?? ''
  }
  return {
    available: true, path,
    version: firstLine(stdout) || firstLine(stderr) || null,
    reason: 'ok', detail: null, checked_at: Date.now(),
  }
}

/** Csak tesztnek / „allitottal rajta" esetre: felejtse el a mert allapotot. */
export function resetProbeCache(id?: string): void {
  if (id) {
    // Az `id` egy CSALADOT jelol (`soffice`), a kulcs viszont a megadott utat
    // is tartalmazza -- ezert a csalad OSSZES bejegyzeset dobjuk.
    for (const key of [...cache.keys()]) if (key === id || key.startsWith(id + '|')) cache.delete(key)
    for (const key of [...inFlight.keys()]) if (key === id || key.startsWith(id + '|')) inFlight.delete(key)
    return
  }
  cache.clear()
  inFlight.clear()
}
