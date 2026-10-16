// Background tick of the code bridge: nothing here talks to a model.
//
// One job -- make sure a task cannot get stuck. The worker heartbeats every 60s
// while `claude.exe` runs; if the Windows box reboots, the worker is killed or
// the network drops mid-task, the lease expires and the task goes back to the
// queue (or, after MAX_ATTEMPTS, fails LOUDLY with a Telegram ping). Without
// this a dispatched task would sit in 'running' forever and the owner would
// simply never hear back.

import { logger } from '../logger.js'
import { CODE_BRIDGE_ENABLED } from '../config.js'
import { reapExpiredCodeLeases, extendRunningCodeLeases, failOrphanedCodeTasks } from './code-bridge-store.js'
import { notifyCodeTaskFinished } from './code-bridge-notify.js'

const TICK_MS = 60 * 1000

/** A tick this much later than scheduled means the SERVER stood still (#550): the workers' heartbeats
 *  could not land meanwhile, so the leases say nothing about the workers. */
export const STALL_GAP_MS = 2 * TICK_MS

let timer: NodeJS.Timeout | null = null
// null = this process has not ticked yet (a restart is a stall too: the downtime is unknown).
let lastTickAt: number | null = null

/** Test seam. */
export function resetCodeBridgeTickForTests(): void {
  lastTickAt = null
}

export function codeBridgeTick(now = Date.now()): void {
  try {
    const stalled = lastTickAt === null || now - lastTickAt > STALL_GAP_MS
    lastTickAt = now
    if (stalled) {
      // Do not count the stall against the workers: every running task gets a fresh lease window; a worker
      // that really died misses it and is re-queued one window later.
      const extended = extendRunningCodeLeases(now)
      if (extended) logger.warn({ extended }, 'code-bridge: the server was not ticking, running leases extended instead of re-queued')
    }
    const { requeued, failed } = reapExpiredCodeLeases(now)
    if (requeued.length) logger.warn({ tasks: requeued }, 'code-bridge: lease expired, task re-queued')
    for (const task of failed) {
      logger.error({ task: task.id, project: task.project }, 'code-bridge: task abandoned after max attempts')
      void notifyCodeTaskFinished(task)
    }
    // The other way a task could rot silently: it is addressed to a project
    // whose session mapping is gone, so no worker will ever claim it.
    for (const task of failOrphanedCodeTasks()) {
      logger.error({ task: task.id, project: task.project }, 'code-bridge: task has no session mapping, failed')
      void notifyCodeTaskFinished(task)
    }
  } catch (err) {
    logger.warn({ err }, 'code-bridge: reaper tick failed')
  }
}

export function startCodeBridgeRunner(): boolean {
  if (!CODE_BRIDGE_ENABLED || timer) return false
  timer = setInterval(codeBridgeTick, TICK_MS)
  timer.unref?.()
  return true
}

export function stopCodeBridgeRunner(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
