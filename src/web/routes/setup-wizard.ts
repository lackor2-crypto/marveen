// "Marveen teljes beallitasa varazsloval" -- the Settings-side setup wizard.
//
// The first-run overlay (routes/onboarding.ts) covers the three things without
// which nothing runs at all: identity, Claude auth, a launched fleet. It is
// deliberately narrow, and it disappears once the install works.
//
// This is the other half, and it exists because the portability sweep created
// the gap. Boss, 2026-08-11: "vajon a marveen rendszer szolni fog hogy ez nincs
// beallitva es hogy itt alitsd be? [...] mindent amit tud a marveen de meg
// nincs beallitva!" Moving a value out of the source and into .env stops it
// being wrong on other machines -- and leaves the feature silently inert, with
// nothing anywhere telling the operator it exists. A fresh install cannot guess
// that the Windows backup wants a repo URL.
//
// So: one screen listing every capability, what it does, whether THIS install
// has it, and a field to fill in the ones it does not.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../../config.js'
import { logger } from '../../logger.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { json, readBody } from '../http-helpers.js'
import { buildSetupSummary, overrideStoredKeys, writableEnvKeys, writableVaultItems, SETUP_ITEMS, type SetupItem } from '../setup-wizard-registry.js'
import { setOverride } from '../../settings-store.js'
import { wizardValues, vaultConfigured } from '../setup-wizard-values.js'
import { getSecret, setSecret, vaultFileState } from '../vault.js'
import { checkBuffer, checkCloudinary, checkOpenRouter, normalizeCloudinaryInput, normalizePlainKey, type CheckResult } from '../../video-requirements.js'
import { isVoiceInstalled } from './voice.js'
import { claudeAuthPresent, channelConfigured, paired } from './onboarding.js'
import { connectedGoogleAccountCount } from '../google-auth-runner.js'
import { existsSync } from 'node:fs'
import { measureSystemDeps, systemDepsSnapshot, installCommand, type DepsSnapshot } from '../../system-deps.js'
import { measureWslMemory } from '../../wsl-memory.js'
import { startVisionInstall, visionInstallStatus } from '../../vision-install.js'
import { saveOauthClient } from '../../google-oauth-client.js'
import type { RouteContext } from './types.js'

const ENV_FILE = join(PROJECT_ROOT, '.env')

/**
 * Atomic, idempotent .env update for one key: drop any prior line for the key,
 * keep every other line verbatim, append the new value, chmod 600. Never sed.
 *
 * Same contract as the onboarding step's writer -- .env holds the bot token and
 * API keys, so a partial write here is a credential-loss bug, not a typo.
 */
function setEnvKey(key: string, value: string): void {
  let lines: string[] = []
  try { lines = readFileSync(ENV_FILE, 'utf-8').split('\n') } catch { /* fresh .env */ }
  const kept = lines.filter(l => l.length > 0 && !l.startsWith(key + '='))
  kept.push(`${key}=${value}`)
  atomicWriteFileSync(ENV_FILE, kept.join('\n') + '\n', { mode: 0o600 })
}

/** Capabilities configured outside .env, answered by the same checks the first-run flow uses. */
function externalState(): Record<string, boolean> {
  return {
    'claude-auth': claudeAuthPresent(),
    'telegram-pairing': paired(),
    // The channel token may live in the provider's own state dir rather than
    // .env, so ask the provider-aware check instead of only reading the key.
    'telegram-token': channelConfigured(),
    'google-oauth': existsSync(join(STORE_DIR, 'google-oauth-client.json')),
    // Configured = at least one address is actually connected. The client file
    // above only makes the sign-in possible; on its own it delivers nothing.
    'google-accounts': connectedGoogleAccountCount() > 0,
    // Kulso programok (kanban d7acdd75): "beallitva" = minden ALAP es AJANLOTT
    // program megvan. Meres nelkul NEM mondjuk ra, hogy rendben van.
    'system-programs': systemProgramsComplete(systemDepsSnapshot()),
    // WSL memory limit (card #683): only a readable .wslconfig holding both limits counts.
    'wsl-memory': measureWslMemory().state === 'ok',
    // The voice toolkit (speech recognition + local voice) that automatic subtitles and voiceover use.
    'voice-toolkit': isVoiceInstalled(),
  }
}

/** Vault-key items' state. An unreadable Vault is reported as such, never as "nothing set". */
function vaultState(): { state: Record<string, boolean>; unreadable: boolean } {
  try { return { state: vaultConfigured(), unreadable: false } } catch { return { state: {}, unreadable: true } }
}

/** A value typed for a 'vault' item, cleaned by the item's rule; the refusal is a code the page can word. */
function cleanVaultValue(item: SetupItem, raw: string): { ok: true; value: string } | { ok: false; code: string } {
  return item.vaultFormat === 'cloudinary-url' ? normalizeCloudinaryInput(raw) : normalizePlainKey(raw)
}

/** Items that do not apply here: the WSL memory limit on an install that is not WSL. */
function hiddenItemIds(): Set<string> {
  return new Set(measureWslMemory().state === 'not_applicable' ? ['wsl-memory'] : [])
}

export function systemProgramsComplete(snap: DepsSnapshot | null): boolean {
  if (!snap) return false
  return snap.items.every(i => i.tier === 'extra' || i.state === 'ok')
}

export async function tryHandleSetupWizard(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/setup-wizard -- the whole picture: every capability and its state.
  if (path === '/api/setup-wizard' && method === 'GET') {
    const env = wizardValues()
    const vault = vaultState()
    const ext = { ...externalState(), ...vault.state }
    const summary = buildSetupSummary(env, ext, hiddenItemIds())
    // The channel token is an env key AND provider state; if either says
    // configured, it is. Without this the wizard nags for a token that is
    // already working from the provider's own state dir.
    for (const item of summary.items) {
      if (item.id === 'telegram-token' && ext['telegram-token']) item.configured = true
    }
    summary.missingRequired = summary.items.filter(i => i.required && !i.configured).length
    summary.availableUnused = summary.items.filter(i => !i.required && !i.configured).length
    json(res, { ...summary, vaultUnreadable: vault.unreadable })
    return true
  }

  // POST /api/setup-wizard/check {id, value?} -- "Try it": ask the service itself whether the key works. With
  // `value` it tries what was just typed (nothing is saved here); without it, the key already in the Vault.
  // The answer is a code and plain numbers, never the key.
  if (path === '/api/setup-wizard/check' && method === 'POST') {
    let body: { id?: unknown; value?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString()) as typeof body
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const item = SETUP_ITEMS.find(i => i.id === body.id && i.kind === 'vault' && i.checkId)
    if (!item) { json(res, { error: 'unknown_check' }, 404); return true }
    let key: string | null = null
    if (typeof body.value === 'string' && body.value.trim()) {
      const clean = cleanVaultValue(item, body.value)
      if (!clean.ok) { json(res, { tone: 'bad', code: clean.code } satisfies CheckResult); return true }
      key = clean.value
    } else {
      if (vaultFileState() === 'unreadable') { json(res, { tone: 'unknown', code: 'vault_unreadable' } satisfies CheckResult); return true }
      try { key = getSecret(item.vaultIds![0]!) } catch { key = null }
    }
    const result: CheckResult = item.checkId === 'openrouter' ? await checkOpenRouter({ key })
      : item.checkId === 'cloudinary' ? await checkCloudinary({ url: key })
        : await checkBuffer({ key })
    json(res, result)
    return true
  }

  // GET /api/system-deps -- a gepre telepitendo kulso programok, mindegyik
  // allapotaval, es egy bemasolhato telepito-sorral. `?force=1` ujramer (a
  // felulet "Ellenorzes most" gombja, telepites utan).
  if (path === '/api/system-deps' && method === 'GET') {
    const force = ctx.url.searchParams.get('force') === '1'
    const cached = systemDepsSnapshot()
    const snap = force || !cached ? await measureSystemDeps(force) : cached
    json(res, { ...snap, install_cmd: installCommand(snap.items, snap.pkg_manager) })
    return true
  }

  // A helyi arcfelismero telepitese a feluletrol (kanban f97acc32, audit C).
  // GET: all-e, fut-e, es hiba eseten a VALODI napló vege.
  if (path === '/api/vision/status' && method === 'GET') {
    json(res, visionInstallStatus())
    return true
  }
  // POST: hianyzo forditoeszkoz -> a bemasolando sor (root innen soha);
  // kulonben a telepito a hatterben indul, a felulet a statuszt kerdezi.
  if (path === '/api/vision/install' && method === 'POST') {
    json(res, startVisionInstall())
    return true
  }

  // POST /api/google-oauth-client -- the Google OAuth client file, uploaded from
  // the wizard instead of copied into store/ by hand (kanban f97acc32). The
  // file holds client_secret: never logged, never echoed back.
  if (path === '/api/google-oauth-client' && method === 'POST') {
    let body: { text?: unknown; replace?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString()) as typeof body
    } catch {
      json(res, { ok: false, error: 'not_json' }, 400)
      return true
    }
    const r = saveOauthClient(typeof body.text === 'string' ? body.text : '', { replace: body.replace === true })
    if (!r.ok) {
      json(res, r, r.error === 'exists' ? 409 : 400)
      return true
    }
    logger.info({ replaced: r.replaced }, 'google oauth client file saved from the setup wizard')
    json(res, r)
    return true
  }

  // POST /api/setup-wizard -- write the values the operator filled in.
  if (path === '/api/setup-wizard' && method === 'POST') {
    let body: { values?: Record<string, unknown> }
    try {
      body = JSON.parse((await readBody(req)).toString()) as typeof body
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    const values = body.values
    if (!values || typeof values !== 'object') {
      json(res, { error: 'values object is required' }, 400)
      return true
    }

    // Allowlist, not denylist: only keys the registry declares are writable.
    // This endpoint edits the file holding every credential the install owns,
    // so an unknown key is refused rather than passed through.
    const allowed = writableEnvKeys()
    const overrideKeys = overrideStoredKeys()
    const vaultItems = writableVaultItems()
    let envWritten = 0
    const written: string[] = []
    const rejected: string[] = []
    // Why a Vault value was refused, so the page can say it in words (a key is never echoed).
    const invalid: Array<{ key: string; code: string }> = []
    for (const [key, raw] of Object.entries(values)) {
      const vaultItem = vaultItems.get(key)
      if (vaultItem) {
        if (typeof raw !== 'string') { rejected.push(key); continue }
        if (!raw.trim()) continue // empty = "leave it alone"
        // A damaged vault.json reads as empty; saving into it would overwrite every key the install owns.
        if (vaultFileState() === 'unreadable') { invalid.push({ key, code: 'vault_unreadable' }); continue }
        const clean = cleanVaultValue(vaultItem, raw)
        if (!clean.ok) { invalid.push({ key, code: clean.code }); continue }
        try {
          setSecret(key, vaultItem.vaultLabel ?? key, clean.value, { category: 'api' })
          written.push(key)
        } catch (err) {
          logger.warn({ key, err: err instanceof Error ? err.message : String(err) }, 'Setup wizard could not write a Vault key')
          invalid.push({ key, code: 'vault_write_failed' })
        }
        continue
      }
      if (!allowed.has(key)) { rejected.push(key); continue }
      if (typeof raw !== 'string') { rejected.push(key); continue }
      const value = raw.trim()
      // A newline or '=' would forge additional .env lines out of one field.
      if (/[\n\r\0]/.test(value)) { rejected.push(key); continue }
      if (!value) continue // empty = "leave it alone", not "erase it"
      if (overrideKeys.has(key)) {
        // Same store the owning screen writes; live at once, no restart.
        const out = setOverride(key, value)
        if (!out.ok) { rejected.push(key); continue }
        written.push(key)
        continue
      }
      setEnvKey(key, value)
      written.push(key)
      envWritten++
    }

    if (rejected.length > 0) {
      logger.warn({ rejected }, 'Setup wizard rejected keys outside the registry')
    }
    if (written.length > 0) {
      logger.info({ written }, 'Setup wizard wrote .env keys')
    }

    // Nothing re-reads .env in place: a running process captured its config at
    // start. Say so plainly instead of letting the operator wonder why the
    // setting "did not take".
    json(res, { written, rejected, invalid, restartRequired: envWritten > 0 })
    return true
  }

  return false
}
