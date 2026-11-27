// The code bridge's master switch, read LIVE (card #993).
//
// It used to be a boot-time constant: pressing "Start" on the dashboard only saved the setting, while the running
// process kept the old value -- no Telegram poller, every task endpoint answering 503 -- until some later restart
// happened to pick it up. The card looked alive, the owner's message just sat at Telegram.
import { getEffectiveSettingValue } from '../settings-store.js'

export function codeBridgeEnabled(): boolean {
  const raw = String(getEffectiveSettingValue('CODE_BRIDGE_ENABLED')).trim().toLowerCase()
  return !['0', 'false', 'no', 'off'].includes(raw)
}
