// "Ujraindítás után lép életbe" as a STATE, not as a permanent label.
//
// Boss, 2026-08-16: "nem akarok latni ilyet hogy sargan oda van barhova is irva
// hogy ujrainditas utan lep eletbe. sokszor ujra lett mar inditva a marvin es
// megis itt vannak ezek a sarga betuk. itt valami bug van."
//
// He is right, and the bug is exactly what he describes. The badge was driven by
// `requiresRestart`, a field of the setting's DEFINITION -- so it was on screen
// forever, on nine keys, no matter what he did. Restarting could never clear it,
// because it never depended on a restart in the first place. A permanent warning
// in warning colours is worse than no warning: it teaches the owner that yellow
// means nothing.
//
// What actually answers the question "is there something pending here?" is a
// comparison: the value THIS process loaded at boot versus the value that is
// effective right now (config-overrides.json > .env > default, resolved live by
// getEffectiveSettingValue). Different -> the running process is working from a
// stale value and a restart is genuinely owed. Same -> nothing to say.
//
// The snapshot must be taken at process start, which is why this module has
// module-level initialisation and is imported from the boot path. Taking it
// lazily on the first request would snapshot values the owner had ALREADY
// changed, and the badge would then never appear -- the opposite bug, and a
// quieter one.

import { SETTINGS_REGISTRY } from './config-registry.js'
import { getEffectiveSettingValue } from './settings-store.js'

export type SettingValue = string | number

/** Keys whose value this process froze at boot (config.ts constants). */
export function restartRelevantKeys(): string[] {
  return SETTINGS_REGISTRY.filter(d => d.requiresRestart).map(d => d.key)
}

/**
 * Read the given keys through `read`, skipping any that throw.
 *
 * Fail-soft on purpose: one unreadable key must not cost the snapshot of the
 * other eight, because a missing snapshot entry silently means "never pending".
 */
export function snapshotValues(
  keys: string[],
  read: (key: string) => SettingValue,
): Record<string, SettingValue> {
  const out: Record<string, SettingValue> = {}
  for (const key of keys) {
    try {
      out[key] = read(key)
    } catch {
      // skip
    }
  }
  return out
}

/**
 * Which keys changed since boot, i.e. which ones actually owe a restart.
 *
 * Compared as strings: `.env` yields "1" where an override may yield 1, and a
 * type difference is not a change the owner made. A key missing from either
 * side is NOT reported -- there is no evidence of a change, and inventing one
 * would put the badge back on screen permanently, which is the bug being fixed.
 */
export function computeRestartPending(
  boot: Record<string, SettingValue>,
  current: Record<string, SettingValue>,
): string[] {
  const pending: string[] = []
  for (const [key, bootValue] of Object.entries(boot)) {
    if (!(key in current)) continue
    if (String(bootValue) !== String(current[key])) pending.push(key)
  }
  return pending
}

// Frozen at module load -- see the header for why this cannot be lazy.
const bootValues: Record<string, SettingValue> = snapshotValues(
  restartRelevantKeys(),
  getEffectiveSettingValue,
)

/** The boot snapshot, for tests and diagnostics. */
export function bootSnapshot(): Record<string, SettingValue> {
  return { ...bootValues }
}

/** Keys whose effective value has drifted from what this process is running. */
export function pendingRestartKeys(): string[] {
  return computeRestartPending(
    bootValues,
    snapshotValues(Object.keys(bootValues), getEffectiveSettingValue),
  )
}

export function isRestartPending(key: string): boolean {
  const boot = bootValues[key]
  if (boot === undefined) return false
  try {
    return String(getEffectiveSettingValue(key)) !== String(boot)
  } catch {
    return false
  }
}
