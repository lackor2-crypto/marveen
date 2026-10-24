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
    state.gaveUp = true
    return 'give-up'
  }
  state.restarts.push(now)
  state.quietUntil = now + OLLAMA_GUARD_COOLDOWN_MS
  return 'restart'
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
          if (!OLLAMA_SERVICE_UNIT) {
            logger.warn({ silentMs: now - state.lastOkAt }, 'Ollama nem valaszol, de nincs OLLAMA_SERVICE_UNIT megadva: nem inditom ujra')
            return
          }
          const res = await restartUnit(OLLAMA_SERVICE_UNIT)
          if (res.ok) logger.warn({ unit: OLLAMA_SERVICE_UNIT, silentMs: now - state.lastOkAt }, 'Ollama nem valaszolt: ujrainditottam')
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
