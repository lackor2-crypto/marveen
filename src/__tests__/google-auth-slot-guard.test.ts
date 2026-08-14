// google-auth.py must never overwrite one account's token with another
// address's (2026-08-14).
//
// The dashboard now has a per-row "sign in again" button, which posts the
// account KEY so the same slot is reused instead of growing a `munka_2`. That
// is right when the same address signs in again -- and quietly destructive when
// a different one does: the Google account chooser offers every address the
// browser is logged into, and one misclick used to replace munka's refresh
// token with somebody else's. The name stayed, the address changed, and the
// original access was gone with no message anywhere.
//
// So the script asks who actually signed in and, on a mismatch, saves a NEW
// account instead of overwriting. Tested as a subprocess against the real
// script (the repo's idiom for python behaviour, cf. compaction-validator):
// network calls are stubbed on the imported module, nothing here talks to
// Google and no real token is read or written.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, statSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'google-auth.py')

// Stubs `_load_client`, `_post` and `_get` on the imported module, then calls
// the real `_exchange_code`. Everything else -- the mismatch check, the key
// derivation, the file write -- is the production code path.
const DRIVER = `
import importlib.util, json, os, sys

script, tokens, email = sys.argv[1], sys.argv[2], sys.argv[3]
spec = importlib.util.spec_from_file_location('gauth', script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod.TOKENS = tokens
mod.LEGACY_TOKEN = tokens + '.nincs-ilyen'
mod.PENDING = tokens + '.pending'
mod._load_client = lambda: {'client_id': 'teszt', 'client_secret': 'teszt'}
mod._post = lambda url, data: {'refresh_token': 'uj-refresh', 'access_token': 'uj-access'}

if email == 'RAISE':
    def _boom(url, at):
        raise OSError('a profil-lekerdezes elbukott')
    mod._get = _boom
else:
    mod._get = lambda url, at: {'emailAddress': email}

mod._exchange_code('kod', sys.argv[4])

data = json.load(open(tokens))
out = {}
for k, v in data.items():
    out[k] = v if isinstance(v, str) else {'email': v.get('email'), 'refresh_token': v.get('refresh_token')}
print('RESULT ' + json.dumps(out))
`

let dir: string
let TOKENS: string
let DRIVER_PATH: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gauth-slot-'))
  TOKENS = join(dir, 'google-tokens.json')
  DRIVER_PATH = join(dir, 'driver.py')
  writeFileSync(DRIVER_PATH, DRIVER)
})

afterEach(() => {
  if (existsSync(TOKENS)) rmSync(TOKENS)
})

interface Rec { email: string | null; refresh_token: string | null }

function exchange(email: string, account: string): { store: Record<string, Rec | string> } {
  const stdout = execFileSync('python3', [DRIVER_PATH, SCRIPT, TOKENS, email, account], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const line = stdout.split('\n').find(l => l.startsWith('RESULT '))
  expect(line, `no RESULT line in: ${stdout}`).toBeTruthy()
  return { store: JSON.parse(line!.slice('RESULT '.length)) }
}

function seed(store: Record<string, unknown>): void {
  writeFileSync(TOKENS, JSON.stringify(store, null, 2))
}

describe('google-auth.py: one slot, one address', () => {
  it('a first account is saved under the name it was asked for', () => {
    const { store } = exchange('uj@gmail.com', 'munka')
    expect(Object.keys(store).sort()).toEqual(['_default', 'munka'])
    expect((store.munka as Rec).email).toBe('uj@gmail.com')
    // First account ever -> it becomes the default.
    expect(store._default).toBe('munka')
  })

  it('the SAME address signing in again replaces its own token, no second row', () => {
    seed({ _default: 'munka', munka: { email: 'munka@gmail.com', refresh_token: 'regi-refresh' } })
    const { store } = exchange('munka@gmail.com', 'munka')
    expect(Object.keys(store).sort()).toEqual(['_default', 'munka'])
    expect((store.munka as Rec).refresh_token).toBe('uj-refresh')
  })

  it('a DIFFERENT address becomes its own account instead of overwriting', () => {
    seed({ _default: 'munka', munka: { email: 'munka@gmail.com', refresh_token: 'regi-refresh' } })
    const { store } = exchange('maria@gmail.com', 'munka')
    // The original is untouched...
    expect((store.munka as Rec).email).toBe('munka@gmail.com')
    expect((store.munka as Rec).refresh_token).toBe('regi-refresh')
    // ...and the new address is keyed off its own name, the same way the
    // dashboard derives one (suggestAccountId).
    expect((store.maria as Rec).email).toBe('maria@gmail.com')
    expect((store.maria as Rec).refresh_token).toBe('uj-refresh')
    // The default pointer follows nobody: it is only set for the first account.
    expect(store._default).toBe('munka')
  })

  it('the fallback name is numbered when that one is taken too', () => {
    seed({
      _default: 'munka',
      munka: { email: 'munka@gmail.com', refresh_token: 'regi-refresh' },
      maria: { email: 'maria@ceg.hu', refresh_token: 'maria-refresh' },
    })
    const { store } = exchange('maria@gmail.com', 'munka')
    expect((store.munka as Rec).refresh_token).toBe('regi-refresh')
    expect((store.maria as Rec).refresh_token).toBe('maria-refresh')
    expect((store.maria_2 as Rec).email).toBe('maria@gmail.com')
  })

  it('an unreachable profile endpoint still saves the token -- the code is single-use', () => {
    // The worst possible answer here is "authorization failed" over a network
    // blip: the authorization code cannot be replayed, so the operator would
    // have to walk the whole consent flow again. Without an address to compare,
    // the old behaviour (save where asked) is the safe one.
    seed({ _default: 'munka', munka: { email: 'munka@gmail.com', refresh_token: 'regi-refresh' } })
    const { store } = exchange('RAISE', 'munka')
    expect(Object.keys(store).sort()).toEqual(['_default', 'munka'])
    expect((store.munka as Rec).refresh_token).toBe('uj-refresh')
    expect((store.munka as Rec).email).toBe('munka@gmail.com')
  })

  it('an account stored before this change (no email on file) is not treated as a mismatch', () => {
    // Nothing knew the address until now, so "unknown" must mean "carry on",
    // never "this must be somebody else".
    seed({ _default: 'munka', munka: { refresh_token: 'regi-refresh' } })
    const { store } = exchange('munka@gmail.com', 'munka')
    expect(Object.keys(store).sort()).toEqual(['_default', 'munka'])
    expect((store.munka as Rec).refresh_token).toBe('uj-refresh')
    expect((store.munka as Rec).email).toBe('munka@gmail.com')
  })

  it('the saved key is announced on stdout, which is what the dashboard reads', () => {
    seed({ _default: 'munka', munka: { email: 'munka@gmail.com', refresh_token: 'regi-refresh' } })
    const out = execFileSync('python3', [DRIVER_PATH, SCRIPT, TOKENS, 'maria@gmail.com', 'munka'], {
      encoding: 'utf-8',
    })
    // parseSavedAccountId (src/web/google-accounts.ts) matches exactly this.
    expect(out).toMatch(/\(fiok='maria'\)/)
  })

  it('the store file keeps its 0600 mode', () => {
    exchange('uj@gmail.com', 'munka')
    expect(statSync(TOKENS).mode & 0o777).toBe(0o600)
  })
})
