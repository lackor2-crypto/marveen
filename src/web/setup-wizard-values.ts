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
import { getSecret, vaultFileState } from './vault.js'
import { parseCloudinaryUrl } from '../workbench-social-host.js'

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
 * Which 'vault' items have their key in the Vault. Reading the Vault can fail in a way that looks exactly like
 * "nothing there" (a damaged vault.json reads as empty), so an unreadable Vault THROWS here: the caller says
 * "could not look", not "not set up".
 */
export function vaultConfigured(
  read: (id: string) => string | null = getSecret,
  fileState: () => 'missing' | 'ok' | 'unreadable' = vaultFileState,
): Record<string, boolean> {
  if (fileState() === 'unreadable') throw new Error('vault unreadable')
  const out: Record<string, boolean> = {}
  for (const item of SETUP_ITEMS) {
    if (item.kind !== 'vault' || !item.vaultIds?.[0]) continue
    const v = read(item.vaultIds[0])
    // A Cloudinary value that does not parse is not a working key: it counts as missing, so the wizard asks again.
    out[item.id] = item.vaultFormat === 'cloudinary-url' ? parseCloudinaryUrl(v) !== null : !!(v && v.trim())
  }
  return out
}

/**
 * The optional third-party integrations (group 'integrations') with this
 * install's state. Only env/secret items: their state is a pure function of the
 * values, so the self-check needs no login probe to answer "set or not".
 */
export function integrationStates(
  values: Record<string, string> = wizardValues(),
  vault: () => Record<string, boolean> = () => vaultConfigured(),
): SetupItemState[] {
  const ids = new Set(SETUP_ITEMS.filter(i => i.group === 'integrations').map(i => i.id))
  const needsVault = SETUP_ITEMS.some(i => ids.has(i.id) && i.kind === 'vault')
  return buildSetupSummary(values, needsVault ? vault() : {}).items.filter(i => ids.has(i.id))
}
