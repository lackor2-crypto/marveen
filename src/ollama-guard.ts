// #776. A local CPU-only Ollama can wedge (measured 2026-10-24: 750 CLOSE-WAIT
// sockets, 5-6 cores burnt for 13 hours, dashboard frozen). This guard asks
// /api/version on a short interval and, when the server has not answered for
// OLLAMA_GUARD_DEAD_MS, restarts the configured systemd --user unit.
//
// Conservative on purpose: it only ever acts on a LOCAL server, only when the
// owner named the unit (OLLAMA_SERVICE_UNIT, nothing is hard-coded), and it
// gives up after OLLAMA_GUARD_MAX_RESTARTS per hour so a server that cannot be
// fixed by a restart does not get restarted forever. Without a unit name or
// without systemd it only logs.
//
// The in-process probe shares the dashboard's event loop. Measured 2026-10-25:
// with the loop stalling ("event loop stalled" warnings every few seconds) the
// 3 s probe timeout expired on OUR side while Ollama answered every request it
// got in microseconds -- the guard restarted a healthy server 13 times that
// day. So a restart is only done after a second probe from a separate process
// (its own event loop) also gets no answer.
import { execFile } from 'node:child_process'
import { OLLAMA_URL, OLLAMA_SERVICE_UNIT } from './config.js'
import { embeddingTargetIsRemote } from './db.js'
import { TOOL_TIMEOUTS } from './tool-timeouts.js'
import { logger } from './logger.js'

export const OLLAMA_GUARD_POLL_MS = 10_000
/** How long the server must stay silent before it counts as wedged. */
export const OLLAMA_GUARD_DEAD_MS = 30_000
/** After a restart, leave the server alone this long (a cold start loads slowly). */
export const OLLAMA_GUARD_COOLDOWN_MS = 120_000
export const OLLAMA_GUARD_MAX_RESTARTS = 3
/** Timeout of the out-of-process confirmation probe. */
export const OLLAMA_GUARD_CONFIRM_TIMEOUT_MS = 5_000
const HOUR_MS = 60 * 60 * 1000

export interface GuardState {
  /** Epoch ms of the last successful /api/version answer (or guard start). */
  lastOkAt: number
  /** Epoch ms of each restart in the last hour. */
  restarts: number[]
  /** Epoch ms until which no new restart is attempted. */
  quietUntil: number
  gaveUp: boolean
}

export type GuardDecision = 'ok' | 'wait' | 'restart' | 'give-up' | 'cooldown'

export function newGuardState(now: number): GuardState {
  return { lastOkAt: now, restarts: [], quietUntil: 0, gaveUp: false }
}

/** Pure decision step: records an answer or a silence and says what to do. */
export function guardStep(state: GuardState, answered: boolean, now: number): GuardDecision {
  if (answered) {
    state.lastOkAt = now
    state.gaveUp = false
    return 'ok'
  }
  state.restarts = state.restarts.filter((t) => now - t < HOUR_MS)
  if (now - state.lastOkAt < OLLAMA_GUARD_DEAD_MS) return 'wait'
  if (now < state.quietUntil) return 'cooldown'
  if (state.restarts.length >= OLLAMA_GUARD_MAX_RESTARTS) {
    // Say it once, not on every poll of the following hour.
    if (state.gaveUp) return 'cooldown'
    state.gaveUp = true
    return 'give-up'
  }
  state.gaveUp = false
  state.restarts.push(now)
  state.quietUntil = now + OLLAMA_GUARD_COOLDOWN_MS
  return 'restart'
}

/**
 * A 'restart' decision turned out to be a false alarm (the server answers):
 * take the restart back so it neither starts a cooldown nor counts toward the
 * hourly cap, and restart the silence clock.
 */
export function guardFalseAlarm(state: GuardState, now: number): void {
  state.restarts.pop()
  state.quietUntil = 0
  state.lastOkAt = now
}

// Runs in a child process, so a stalled dashboard event loop cannot make a
// healthy server look silent. Exit 0 = answered, 1 = no answer.
const CONFIRM_SCRIPT =
  'fetch(process.argv[1] + "/api/version", { signal: AbortSignal.timeout(Number(process.argv[2])) })' +
  '.then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'

/** 'answered' | 'silent', or 'unknown' when the probe process itself could not run. */
export function confirmOutOfProcess(url: string, timeoutMs = OLLAMA_GUARD_CONFIRM_TIMEOUT_MS): Promise<'answered' | 'silent' | 'unknown'> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['-e', CONFIRM_SCRIPT, url, String(timeoutMs)], { timeout: timeoutMs + 10_000 }, (err) => {
      if (!err) return resolve('answered')
      // A non-zero exit puts the NUMERIC exit code here (the typings say string).
      const code: unknown = (err as { code?: unknown }).code
      resolve(code === 1 ? 'silent' : 'unknown')
    })
  })
}

async function answers(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(TOOL_TIMEOUTS['ollama-probe']) })
    return r.ok
  } catch {
    return false
  }
}

function restartUnit(unit: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    execFile('systemctl', ['--user', 'restart', unit], { timeout: 30_000 }, (err, _out, stderr) => {
      if (err) resolve({ ok: false, detail: (stderr || err.message).toString().trim().slice(0, 300) })
      else resolve({ ok: true, detail: 'systemctl --user restart ' + unit })
    })
  })
}

let timer: NodeJS.Timeout | null = null

export function startOllamaGuard(): void {
  if (timer) return
  if (embeddingTargetIsRemote(OLLAMA_URL)) {
    logger.debug('Ollama-orzo kihagyva: tavoli embedding szerver')
    return
  }
  const state = newGuardState(Date.now())
  let busy = false
  timer = setInterval(() => {
    if (busy) return
    busy = true
    void (async () => {
      try {
        const now = Date.now()
        const decision = guardStep(state, await answers(OLLAMA_URL), now)
        if (decision === 'give-up') {
          logger.error({ restarts: state.restarts.length }, 'Ollama-orzo: tobbszori ujrainditas sem segitett, feladom (a kovetkezo valasz ujra beindit)')
        } else if (decision === 'restart') {
          const silentMs = now - state.lastOkAt
          const confirm = await confirmOutOfProcess(OLLAMA_URL)
          if (confirm !== 'silent') {
            guardFalseAlarm(state, Date.now())
            if (confirm === 'answered') logger.info({ silentMs }, 'Ollama-orzo: kulon folyamatbol az Ollama valaszol, nem inditom ujra (a dashboard sajat esemenyhurka akadt)')
            else logger.warn({ silentMs }, 'Ollama-orzo: a kulon folyamatbol futo proba nem indult el, ujrainditas nelkul varok')
            return
          }
          if (!OLLAMA_SERVICE_UNIT) {
            logger.warn({ silentMs }, 'Ollama nem valaszol, de nincs OLLAMA_SERVICE_UNIT megadva: nem inditom ujra')
            return
          }
          const res = await restartUnit(OLLAMA_SERVICE_UNIT)
          if (res.ok) logger.warn({ unit: OLLAMA_SERVICE_UNIT, silentMs }, 'Ollama nem valaszolt: ujrainditottam')
          else logger.error({ unit: OLLAMA_SERVICE_UNIT, detail: res.detail }, 'Ollama ujrainditas sikertelen')
        }
      } catch (err) {
        logger.warn({ err }, 'Ollama-orzo hiba')
      } finally {
        busy = false
      }
    })()
  }, OLLAMA_GUARD_POLL_MS)
  timer.unref()
  logger.info({ unit: OLLAMA_SERVICE_UNIT || null }, 'Ollama-orzo elindult')
}

export function stopOllamaGuard(): void {
  if (timer) clearInterval(timer)
  timer = null
}
