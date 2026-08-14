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
import { readEnvFile } from '../../env.js'
import { atomicWriteFileSync } from '../atomic-write.js'
import { json, readBody } from '../http-helpers.js'
import { buildSetupSummary, writableEnvKeys } from '../setup-wizard-registry.js'
import { claudeAuthPresent, channelConfigured, paired } from './onboarding.js'
import { connectedGoogleAccountCount } from '../google-auth-runner.js'
import { existsSync } from 'node:fs'
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
  }
}

export async function tryHandleSetupWizard(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx

  // GET /api/setup-wizard -- the whole picture: every capability and its state.
  if (path === '/api/setup-wizard' && method === 'GET') {
    const env = readEnvFile()
    const ext = externalState()
    const summary = buildSetupSummary(env, ext)
    // The channel token is an env key AND provider state; if either says
    // configured, it is. Without this the wizard nags for a token that is
    // already working from the provider's own state dir.
    for (const item of summary.items) {
      if (item.id === 'telegram-token' && ext['telegram-token']) item.configured = true
    }
    summary.missingRequired = summary.items.filter(i => i.required && !i.configured).length
    summary.availableUnused = summary.items.filter(i => !i.required && !i.configured).length
    json(res, summary)
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
    const written: string[] = []
    const rejected: string[] = []
    for (const [key, raw] of Object.entries(values)) {
      if (!allowed.has(key)) { rejected.push(key); continue }
      if (typeof raw !== 'string') { rejected.push(key); continue }
      const value = raw.trim()
      // A newline or '=' would forge additional .env lines out of one field.
      if (/[\n\r\0]/.test(value)) { rejected.push(key); continue }
      if (!value) continue // empty = "leave it alone", not "erase it"
      setEnvKey(key, value)
      written.push(key)
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
    json(res, { written, rejected, restartRequired: written.length > 0 })
    return true
  }

  return false
}
