// The values the setup wizard classifies, shared by the wizard route and the
// Overview self-check so the two can never give different answers.
//
// Mostly the .env file -- but a wizard item stored as a settings override
// (`store: 'override'`) is read from
// the override store, because that is where its owning screen writes it and an
// override wins over .env. Reading only .env would call a key saved on the
// Workbench page "missing".

import { readEnvFile } from '../env.js'
import { getOverrides } from '../settings-store.js'
import { buildSetupSummary, overrideStoredKeys, SETUP_ITEMS, type SetupItemState } from './setup-wizard-registry.js'

export function wizardValues(
  env: Record<string, string> = readEnvFile(),
  overrides: Record<string, string | number> = getOverrides(),
  keys: Set<string> = overrideStoredKeys(),
): Record<string, string> {
  const out = { ...env }
  for (const key of keys) {
    if (key in overrides) out[key] = String(overrides[key] ?? '')
  }
  return out
}

/**
 * The optional third-party integrations (group 'integrations') with this
 * install's state. Only env/secret items: their state is a pure function of the
 * values, so the self-check needs no login probe to answer "set or not".
 */
export function integrationStates(values: Record<string, string> = wizardValues()): SetupItemState[] {
  const ids = new Set(SETUP_ITEMS.filter(i => i.group === 'integrations').map(i => i.id))
  return buildSetupSummary(values, {}).items.filter(i => ids.has(i.id))
}
