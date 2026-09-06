// Kanban #134. The "Generate vectors" button used to run the whole backfill
// INSIDE one HTTP request. Measured 2026-08-15: a SUCCESSFUL run over 138
// memories takes ~3.5 minutes, while the browser's request gives up after
// 2m29s -- so the owner saw an error at the end of a working operation, and
// the server kept going invisibly.
//
// The fix is not a longer timeout (that only moves the wall). The run lives
// here, outside any request, and the request only starts it and reads its
// state. One run at a time: asking again while it works returns the SAME run,
// it does not queue a second pass over the same rows.
import { runEmbeddingBackfill, embeddingTargetIsRemote, EMBED_MODEL, type BackfillReason } from './db.js'
import { OLLAMA_URL } from './config.js'
import { logger } from './logger.js'

export interface BackfillStatus {
  running: boolean
  /** null until the first run of this process. */
  startedAt: number | null
  finishedAt: number | null
  done: number
  failed: number
  candidates: number
  total: number
  /** null while a run is in flight AND before the first run ever started. */
  reason: BackfillReason | null
  detail?: string
  target: string
  /** Which model the run asks for -- the message names it from here, so no
   *  translation file re-types it. */
  model: string
  remote: boolean
  /** False when this process has never run a backfill -- NOT the same as "it found nothing". */
  everRan: boolean
}

let state: BackfillStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  done: 0,
  failed: 0,
  candidates: 0,
  total: 0,
  reason: null,
  target: OLLAMA_URL,
  model: EMBED_MODEL,
  remote: embeddingTargetIsRemote(OLLAMA_URL),
  everRan: false,
}

export function getEmbeddingBackfillStatus(): BackfillStatus {
  return { ...state }
}

/**
 * Start a backfill if none is running, and return the status either way.
 * Safe to call repeatedly: the second call during a run is a no-op that hands
 * back the running job's progress.
 */
export function startEmbeddingBackfill(): BackfillStatus {
  if (state.running) return getEmbeddingBackfillStatus()

  state = {
    running: true,
    startedAt: Date.now(),
    finishedAt: null,
    done: 0,
    failed: 0,
    candidates: 0,
    total: 0,
    reason: null,
    target: OLLAMA_URL,
    model: EMBED_MODEL,
    remote: embeddingTargetIsRemote(OLLAMA_URL),
    everRan: true,
  }

  void runEmbeddingBackfill((done, candidates) => {
    state.done = done
    state.candidates = candidates
  }).then(result => {
    state = {
      ...state,
      running: false,
      finishedAt: Date.now(),
      done: result.done,
      failed: result.failed,
      candidates: result.candidates,
      total: result.total,
      reason: result.reason,
      detail: result.detail,
      target: result.target,
      model: result.model,
      remote: result.remote,
    }
    logger.info({ ...result }, 'Embedding backfill finished')
  }).catch(err => {
    // An unexpected throw must not leave the job pinned at "running" forever:
    // the button would stay disabled with no way back short of a restart.
    state = {
      ...state,
      running: false,
      finishedAt: Date.now(),
      reason: 'error',
      detail: err instanceof Error ? err.message : String(err),
    }
    logger.error({ err }, 'Embedding backfill crashed')
  })

  return getEmbeddingBackfillStatus()
}

/** Test seam: forget the last run so a fresh assertion starts from zero. */
export function resetEmbeddingBackfillState(): void {
  state = {
    running: false, startedAt: null, finishedAt: null, done: 0, failed: 0,
    candidates: 0, total: 0, reason: null, target: OLLAMA_URL, model: EMBED_MODEL,
    remote: embeddingTargetIsRemote(OLLAMA_URL), everRan: false,
  }
}
