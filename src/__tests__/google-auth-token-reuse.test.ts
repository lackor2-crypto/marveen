// google-auth.py token: reuse a still-valid access token (2026-08-14).
//
// MEASURED before the change: every `token` call posted a refresh_token grant
// to Google, even with fifty minutes left on the access token -- 0.53s per
// call. After: 0.11s from the store. The Drive page's "all accounts" view asks
// for one token per column per navigation, so with ten addresses that was ten
// avoidable round trips per click against an endpoint Google throttles.
//
// The margin matters as much as the reuse: a token that expires in ninety
// seconds must NOT be handed out, or a slow upload dies mid-flight.
//
// Subprocess against the real script, network stubbed on the imported module
// (the repo's idiom for python behaviour). No real token is read or written.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'google-auth.py')

// `_post` either returns a new access token or explodes -- "explodes" is how a
// test proves no network call was made at all.
const DRIVER = `
import importlib.util, sys

script, tokens, mode = sys.argv[1], sys.argv[2], sys.argv[3]
spec = importlib.util.spec_from_file_location('gauth', script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.TOKENS = tokens
mod.LEGACY_TOKEN = tokens + '.nincs-ilyen'
mod._load_client = lambda: {'client_id': 'teszt', 'client_secret': 'teszt'}

if mode == 'no-network':
    def _boom(url, data):
        raise AssertionError('HALOZAT: refresh-kerest inditott, pedig nem kellett volna')
    mod._post = _boom
else:
    mod._post = lambda url, data: {'access_token': 'frissitett-access', 'expires_in': 3599}

mod.cmd_token(sys.argv[4] if len(sys.argv) > 4 else None)
`

let dir: string
let TOKENS: string
let DRIVER_PATH: string
const NOW = () => Math.floor(Date.now() / 1000)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gauth-token-'))
  TOKENS = join(dir, 'google-tokens.json')
  DRIVER_PATH = join(dir, 'driver.py')
  writeFileSync(DRIVER_PATH, DRIVER)
})

afterEach(() => {
  if (existsSync(TOKENS)) rmSync(TOKENS)
})

function seed(record: Record<string, unknown>): void {
  writeFileSync(TOKENS, JSON.stringify({ _default: 'munka', munka: record }, null, 2))
}

function token(mode: 'no-network' | 'network'): string {
  return execFileSync('python3', [DRIVER_PATH, SCRIPT, TOKENS, mode, 'munka'], { encoding: 'utf-8' }).trim()
}

function stored(): Record<string, unknown> {
  return JSON.parse(readFileSync(TOKENS, 'utf-8')).munka
}

describe('google-auth.py token: no refresh while the token is good', () => {
  it('hands back the stored token without talking to Google', () => {
    seed({ refresh_token: 'rt', access_token: 'meg-jo-access', expires_in: 3600, saved_at: NOW() - 60 })
    // The stub throws on any network call, so this passing IS the assertion
    // that none happened.
    expect(token('no-network')).toBe('meg-jo-access')
  })

  it('refreshes once the token has expired', () => {
    seed({ refresh_token: 'rt', access_token: 'lejart-access', expires_in: 3600, saved_at: NOW() - 4000 })
    expect(token('network')).toBe('frissitett-access')
    expect(stored().access_token).toBe('frissitett-access')
    // saved_at must move with it, or the next call would think the FRESH token
    // is as old as the one it replaced.
    expect(Number(stored().saved_at)).toBeGreaterThanOrEqual(NOW() - 5)
  })

  it('refreshes inside the 2-minute margin, rather than handing out a token that dies mid-request', () => {
    seed({ refresh_token: 'rt', access_token: 'mindjart-lejar', expires_in: 3600, saved_at: NOW() - 3540 })
    expect(token('network')).toBe('frissitett-access')
  })

  it('keeps the margin: 3 minutes left is still served from the store', () => {
    seed({ refresh_token: 'rt', access_token: 'harom-perc', expires_in: 3600, saved_at: NOW() - 3420 })
    expect(token('no-network')).toBe('harom-perc')
  })

  it('a record from before this change (no expires_in) just refreshes', () => {
    // Every token saved until today looks like this. Treating "unknown" as
    // "valid" would hand out a dead token; treating it as expired costs one
    // refresh and then the record is complete.
    seed({ refresh_token: 'rt', saved_at: NOW() - 10 })
    expect(token('network')).toBe('frissitett-access')
    expect(stored().expires_in).toBe(3599)
  })

  it('garbage in the record never crashes the caller -- it refreshes', () => {
    seed({ refresh_token: 'rt', access_token: 'x', expires_in: 'nem-szam', saved_at: 'tegnap' })
    expect(token('network')).toBe('frissitett-access')
  })

  it('an empty access_token is not "still valid"', () => {
    seed({ refresh_token: 'rt', access_token: '', expires_in: 3600, saved_at: NOW() })
    expect(token('network')).toBe('frissitett-access')
  })
})
