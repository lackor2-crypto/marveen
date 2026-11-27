// Keeps the bridge's background services (lease reaper, /code Telegram poller) in step with the master switch,
// whichever way it was flipped: the card's Start/Stop, the Settings page, or the override file by hand (card #993).
import { codeBridgeEnabled } from './code-bridge-switch.js'
import { startCodeBridgeRunner, stopCodeBridgeRunner } from './code-bridge-runner.js'
import { startCodeBotPoller, stopCodeBotPoller } from './code-bridge-telegram.js'

export const CODE_BRIDGE_SYNC_MS = 2000

let timer: NodeJS.Timeout | null = null

/** Idempotent: starting a running service and stopping a stopped one are no-ops. */
export function syncCodeBridgeServices(): void {
  if (codeBridgeEnabled()) {
    startCodeBridgeRunner()
    startCodeBotPoller()
  } else {
    stopCodeBridgeRunner()
    stopCodeBotPoller()
  }
}

export function startCodeBridgeServices(): void {
  syncCodeBridgeServices()
  if (timer) return
  timer = setInterval(syncCodeBridgeServices, CODE_BRIDGE_SYNC_MS)
  timer.unref?.()
}

export function stopCodeBridgeServices(): void {
  if (timer) { clearInterval(timer); timer = null }
  stopCodeBridgeRunner()
  stopCodeBotPoller()
}
