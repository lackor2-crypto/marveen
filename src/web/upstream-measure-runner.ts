/**
 * Az "Upstream szinkron" doboz KEZI meresenek inditasa a feluletrol.
 *
 * MIERT LETEZIK
 * -------------
 * A meres eddig CSAK a heti idozitobol futott. Aki latta a dobozban, hogy van
 * behuzando valtozas, nem tudott vele semmit kezdeni a feluletrol: a
 * `scripts/upstream-divergence-check.sh`-t terminalbol kellett elinditani. Ez
 * ket szabalyba is utkozott -- a funkcio nem volt vegigjarhato a feluletrol,
 * es egy elavult meres mellett nem volt mod frisset kerni.
 *
 * MIT CSINAL ES MIT NEM
 * ---------------------
 * Elinditja a mero szkriptet, ami `git fetch upstream`-et fut es UJRAMER.
 * A munkakonyvtarhoz NEM nyul: a szkript `git merge-tree --write-tree`-vel
 * dolgozik, ami csak objektumokat ir, checkoutot nem billent. Ezert akkor is
 * biztonsagos, ha epp egy ugynok dolgozik a repoban -- ez a gomb LETOLT es
 * MEGMER, nem huz be semmit.
 *
 * A meres halozatot hasznal (a fetch akar 180 mp is lehet), ezert nem a
 * HTTP-kereses vegen valaszolunk: a szkript hatterben indul, a felulet pedig
 * a GET-tel kerdezi, fut-e meg. A ket hivast egy pidfile zarja ossze, hogy egy
 * dupla kattintasbol ne induljon ket parhuzamos fetch ugyanabban a repoban.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

const PIDFILE = join(STORE_DIR, 'upstream-measure.pid')
const SCRIPT = join(PROJECT_ROOT, 'scripts', 'upstream-divergence-check.sh')

/**
 * A szkript sajat felso korlatja a fetchre 180 mp, plusz a git-muveletek.
 * Ezen tul a pidfile mar nem egy futo merest jelol, hanem egy ottfelejtett
 * fajlt -- kulonben egy megolt folyamat OROKRE letiltana a gombot.
 * A PID ujrafelhasznalasa miatt ez a masodik or a folyamat-eletben-let mellett.
 */
const MAX_RUN_MS = 15 * 60_000

export type MeasureState = {
  running: boolean
  /** Mikor indult a jelenleg futo meres (ms). Null, ha nem fut. */
  startedAt: number | null
}

function readPidfile(): { pid: number; startedAt: number } | null {
  try {
    const st = statSync(PIDFILE)
    if (!st.isFile() || st.size > 256) return null
    const [pidLine, tsLine] = readFileSync(PIDFILE, 'utf-8').split('\n')
    const pid = parseInt(pidLine, 10)
    const startedAt = parseInt(tsLine, 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    return { pid, startedAt: Number.isFinite(startedAt) ? startedAt : 0 }
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = letezik, csak nem a mienk. Az is "el".
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function clearPidfile(): void {
  try { unlinkSync(PIDFILE) } catch { /* mar nincs ott */ }
}

/**
 * Fut-e epp egy meres. Nem a pidfile LETEZESEBOL kovetkeztetunk -- magat a
 * folyamatot kerdezzuk meg. Egy ottfelejtett pidfile (kilott folyamat,
 * ujrainditott dashboard) kulonben orokre "fut" allapotban ragasztana a gombot.
 */
export function measureState(now: number = Date.now()): MeasureState {
  const pf = readPidfile()
  if (!pf) return { running: false, startedAt: null }
  const tooOld = pf.startedAt > 0 && now - pf.startedAt > MAX_RUN_MS
  if (tooOld || !isAlive(pf.pid)) {
    clearPidfile()
    return { running: false, startedAt: null }
  }
  return { running: true, startedAt: pf.startedAt || null }
}

export type StartFailReason = 'already-running' | 'script-missing' | 'store-unwritable' | 'spawn-failed'

export type StartResult =
  | { ok: true }
  | { ok: false; reason: StartFailReason; message: string; detail?: string }

/**
 * Elinditja a merest a hatterben.
 *
 * A hibat HAROM darabban adjuk vissza, mert mindharomra szukseg van:
 *   reason  -- gepi kod, EBBOL forditja a felulet a mondatot (minden kepernyore
 *              kerulo szoveg ketnyelvu; egy itt beegetett magyar mondat epp ezt
 *              a szabalyt kerulne meg)
 *   message -- ugyanaz angolul, tartaleknak, ha a felulet nem ismeri a kodot
 *   detail  -- a NYERS technikai reszlet (utvonal, kivetel-uzenet). Sose
 *              talalgatunk okot: ez a mezo a tenyleges uzenetet viszi.
 */
export function startMeasure(now: number = Date.now()): StartResult {
  if (measureState(now).running) {
    return {
      ok: false,
      reason: 'already-running',
      message: 'A measurement is already running. Wait for it to finish -- the result appears in the box on its own.',
    }
  }
  if (!existsSync(SCRIPT)) {
    // Nem talalgatjuk, miert nincs meg: kimondjuk, MELYIK fajl hianyzik.
    return {
      ok: false,
      reason: 'script-missing',
      message: 'The measurement script is missing. Update the installation, or clone the repository again.',
      detail: SCRIPT,
    }
  }
  let outFd: number
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    outFd = openSync(join(STORE_DIR, 'upstream-measure.log'), 'a', 0o600)
  } catch (err) {
    return {
      ok: false,
      reason: 'store-unwritable',
      message: 'store/ is not writable, so the measurement log could not be created either -- refusing to start it blind. '
        + 'Check the permissions on store/.',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
  try {
    const child = spawn('/bin/bash', [SCRIPT, 'manual'], {
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: ['ignore', outFd, outFd],
      // A szkript sajat GIT_TERMINAL_PROMPT=0-t allit; itt is kizarjuk, hogy
      // egy jelszot varo git orokre allo folyamatot hagyjon maga utan.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    if (typeof child.pid !== 'number') {
      try { closeSync(outFd) } catch { /* mar zarva */ }
      return {
        ok: false,
        reason: 'spawn-failed',
        message: 'The measurement could not be started.',
        detail: 'spawn returned no pid',
      }
    }
    // A pidfile a GYEREK pid-jet tarolja, nem a dashboardet: igy egy dashboard-
    // ujrainditas utan is a valodi merest kerdezzuk meg, nem magunkat.
    writeFileSync(PIDFILE, `${child.pid}\n${now}\n`, { mode: 0o600 })
    child.on('error', (err) => {
      logger.error({ err }, 'upstream divergence measure spawn failed')
      clearPidfile()
    })
    child.unref()
    try { closeSync(outFd) } catch { /* mar zarva */ }
    logger.info({ pid: child.pid }, 'upstream divergence measure started from the dashboard')
    return { ok: true }
  } catch (err) {
    try { closeSync(outFd) } catch { /* mar zarva */ }
    clearPidfile()
    return {
      ok: false,
      reason: 'spawn-failed',
      message: 'The measurement could not be started.',
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}
