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
import { reapExpiredCodeLeases, failOrphanedCodeTasks } from './code-bridge-store.js'
import { notifyCodeTaskFinished } from './code-bridge-notify.js'

const TICK_MS = 60 * 1000

let timer: NodeJS.Timeout | null = null

export function codeBridgeTick(): void {
  try {
    const { requeued, failed } = reapExpiredCodeLeases()
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
