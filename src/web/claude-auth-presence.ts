/**
 * "Be van-e jelentkezve a Claude?" -- EGY forrasbol.
 *
 * Boss, 2026-08-20: a Beallitasok piros csikot mutatott ("Claude bejelentkezes
 * -- nincs beallitva"), kozvetlenul alatta az Attekintes Onellenorzese meg azt
 * irta, hogy minden rendben. Ket kulon igazsag ugyanarrol a gepallapotrol.
 *
 * Ez a modul azert all kulon a routes/onboarding.ts-tol, hogy a rendszer-
 * ellenorzes (system-health.ts) ugyanazt a fuggvenyt hivhassa, amit a
 * vegigvezeto -- import nelkul az egesz onboarding utvonalra (ami tmux-ot,
 * csatorna-monitort es agens-folyamatokat huzna be egy igen/nem kerdes miatt).
 *
 * Tervezesi korlat, mint a system-health.ts-ben: csak fajl, halozat nelkul,
 * korlatos munka. Az egyetlen kivetel a macOS Keychain-proba, ami eleve csak
 * darwinon fut es 3 masodperc utan felad.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { execFileSync } from 'node:child_process'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'

const ENV_FILE = join(PROJECT_ROOT, '.env')
const HOME_CREDENTIALS = join(homedir(), '.claude', '.credentials.json')
const FLEET_TOKEN_FILE = join(STORE_DIR, '.claude-oauth-token')

/** Csak a teszt adja meg -- elesben mindharom a fenti alapertelmezes. Igy a
 *  teszt valodi fajlokon fut, mock nelkul: a hiba is valodi fajlbol jott. */
export interface ClaudeAuthPaths {
  envFile?: string
  credentialsFile?: string
  fleetTokenFile?: string
}

function readEnvValue(envFile: string, key: string): string | null {
  try {
    for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
      if (line.startsWith(key + '=')) {
        const v = line.slice(key.length + 1).trim()
        return v.length > 0 ? v : null
      }
    }
  } catch { /* no .env yet */ }
  return null
}

// The Keychain leg matters: on macOS Claude Code stores the subscription login
// in the login Keychain and writes NO ~/.claude/.credentials.json, so a fully
// authenticated fleet looked logged-out to the wizard and the dashboard nagged
// for a token that would have created a second, drifting credential path.
// The probe is presence-only: no `-w`, so the credential secret itself never
// enters this process just to answer a yes/no question. It fails closed (false
// off macOS / on any lookup error), so a Keychain ACL that refused `security`
// just falls back to the previous behaviour.
function keychainHasClaudeCredentials(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', userInfo().username],
      { timeout: 3000, stdio: 'ignore' },
    )
    return true
  } catch { return false }
}

// The fleet setup-token leg (#654): the wizard's own auth step stores the
// token into FLEET_TOKEN_FILE, so an install authenticated ONLY via the fleet
// token has no env var, no ~/.claude/.credentials.json and no Keychain entry
// -- without this check the wizard re-nagged on every reload right after
// completing itself. Presence-only, non-empty, same spirit as the other legs.
function fleetTokenPresent(file: string): boolean {
  try {
    return readFileSync(file, 'utf-8').trim().length > 0
  } catch { return false }
}

/** Where the usable credential was found, or why there is none. */
export type ClaudeAuthSource =
  | 'env-oauth' | 'env-api-key' | 'credentials-file' | 'fleet-token' | 'keychain'
  | 'none' | 'emptied'

export interface ClaudeAuthState {
  present: boolean
  source: ClaudeAuthSource
}

/**
 * True auth presence -- an env OAuth token / API key, a real credentials.json
 * OAuth credential, the fleet setup token, or (macOS) the login Keychain
 * credential. NOT merely "the .env line exists" (it could be empty).
 *
 * The `emptied` source is the 2026-08-20 failure, and it is why an empty
 * accessToken can never be allowed to count as "present": at 10:54:06 the
 * credentials file was rewritten from 504 to 276 bytes with accessToken="",
 * refreshToken="" and expiresAt=0, while refreshTokenExpiresAt still pointed
 * at 2026-09-07. The file existed, parsed, and looked plausible; only the
 * emptiness of the token itself told the truth.
 */
export function claudeAuthState(paths: ClaudeAuthPaths = {}): ClaudeAuthState {
  const envFile = paths.envFile ?? ENV_FILE
  const credentialsFile = paths.credentialsFile ?? HOME_CREDENTIALS
  const fleetTokenFile = paths.fleetTokenFile ?? FLEET_TOKEN_FILE
  if (readEnvValue(envFile, 'CLAUDE_CODE_OAUTH_TOKEN')) return { present: true, source: 'env-oauth' }
  if (readEnvValue(envFile, 'ANTHROPIC_API_KEY')) return { present: true, source: 'env-api-key' }
  let emptied = false
  try {
    const d = JSON.parse(readFileSync(credentialsFile, 'utf-8')) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string }; apiKey?: string
    }
    if (d?.claudeAiOauth?.accessToken) return { present: true, source: 'credentials-file' }
    if (d?.apiKey) return { present: true, source: 'credentials-file' }
    // Parsed fine, carries the OAuth block, and the token inside it is empty:
    // this is a login that was WIPED, not one that never happened.
    if (d?.claudeAiOauth) emptied = true
  } catch { /* no / unreadable credentials.json */ }
  if (fleetTokenPresent(fleetTokenFile)) return { present: true, source: 'fleet-token' }
  if (keychainHasClaudeCredentials()) return { present: true, source: 'keychain' }
  return { present: false, source: emptied ? 'emptied' : 'none' }
}

export function claudeAuthPresent(): boolean {
  return claudeAuthState().present
}

