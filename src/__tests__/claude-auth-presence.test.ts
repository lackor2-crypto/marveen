/**
 * A Claude-bejelentkezes jelenlete -- egy MERT hiba orzese.
 *
 * 2026-08-20, 10:54:06: a megosztott ~/.claude/.credentials.json 504 bajtrol
 * 276-ra iródott ujra, accessToken="" es refreshToken="" tartalommal, mikozben
 * a refreshTokenExpiresAt tovabbra is 2026-09-07-re mutatott. A fajl LETEZETT,
 * ERVENYES JSON volt, es hihetonek latszott -- csak eppen a token volt ures.
 * Az egesz flotta elnemult (nincs Telegram, nincs utemezett feladat), es a
 * felulet ket kulonbozo dolgot allitott ugyanarrol: a Beallitasok pirosan azt,
 * hogy nincs bejelentkezes, az Attekintes Onellenorzese meg zolden azt, hogy
 * minden rendben.
 *
 * Ezert a teszt: ures token SOHA nem szamithat meglevo bejelentkezesnek, es a
 * "volt, de elveszett" allapot megkulonboztetheto a "sose volt"-tol, mert mas
 * a teendo a ketto eseten.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeAuthState } from '../web/claude-auth-presence.js'
import { systemHealth, worstHealthStatus } from '../web/system-health.js'
import {
  dependsOnDefaultLogin, defaultLoginDependents, unaffectedByDefaultLogin,
} from '../web/default-login-dependents.js'

let dir: string
let paths: { envFile: string; credentialsFile: string; fleetTokenFile: string }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-auth-'))
  paths = {
    envFile: join(dir, '.env'),
    credentialsFile: join(dir, '.credentials.json'),
    fleetTokenFile: join(dir, '.claude-oauth-token'),
  }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('claudeAuthState', () => {
  it('az URES tokent NEM veszi bejelentkezesnek -- ez volt a 08-20-i hiba', () => {
    // Bajtra az, ami a gepen allt: ervenyes JSON, ervenyes lejarat, ures token.
    writeFileSync(paths.credentialsFile, JSON.stringify({
      claudeAiOauth: {
        accessToken: '', refreshToken: '', expiresAt: 0,
        refreshTokenExpiresAt: 1788740462059,
        scopes: ['user:inference'], subscriptionType: 'max',
      },
    }))
    expect(claudeAuthState(paths)).toEqual({ present: false, source: 'emptied' })
  })

  it('megkulonbozteti a "sose volt"-ot az "elveszett"-tol -- mas a teendo', () => {
    expect(claudeAuthState(paths)).toEqual({ present: false, source: 'none' })
  })

  it('a valodi tokent elfogadja', () => {
    writeFileSync(paths.credentialsFile, JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat01-NEM-IGAZI', expiresAt: 1 },
    }))
    expect(claudeAuthState(paths)).toEqual({ present: true, source: 'credentials-file' })
  })

  it('az .env-beli tokent is elfogadja, a fajl elott', () => {
    writeFileSync(paths.envFile, 'OWNER_NAME=Valaki\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-NEM-IGAZI\n')
    expect(claudeAuthState(paths).source).toBe('env-oauth')
  })

  it('az URES .env-sor nem szamit tokennek', () => {
    writeFileSync(paths.envFile, 'CLAUDE_CODE_OAUTH_TOKEN=\n')
    expect(claudeAuthState(paths).present).toBe(false)
  })

  it('a flotta-token is eleg', () => {
    writeFileSync(paths.fleetTokenFile, 'sk-ant-NEM-IGAZI\n')
    expect(claudeAuthState(paths).source).toBe('fleet-token')
  })

  it('a serult credentials.json nem omlik ossze, csak nincs bejelentkezes', () => {
    writeFileSync(paths.credentialsFile, '{ ez nem json')
    expect(claudeAuthState(paths)).toEqual({ present: false, source: 'none' })
  })
})

describe('az Onellenorzes sora', () => {
  // Ez a lenyeg Boss panaszabol: a bejelentkezes MINDIG kap sort. Zolden is,
  // kulonben a hallgatasa nem kulonboztetheto meg attol, hogy nincs ellenorzes.
  it('mindig van pontosan egy claude_auth_* sor', () => {
    const ids = systemHealth().filter(r => r.id.startsWith('claude_auth_'))
    expect(ids).toHaveLength(1)
    expect(['claude_auth_ok', 'claude_auth_lost', 'claude_auth_missing']).toContain(ids[0].id)
  })

  it('ha nincs bejelentkezes, az a legsulyosabb allapot -- nem "warn"', () => {
    const worst = worstHealthStatus([{ id: 'claude_auth_lost', status: 'bad' }])
    expect(worst).toBe('bad')
  })

  it('mind a harom sorhoz van magyar ES angol szoveg, teendovel egyutt', async () => {
    const hu = await import('node:fs').then(m => m.readFileSync('web/lang/hu.js', 'utf-8'))
    const en = await import('node:fs').then(m => m.readFileSync('web/lang/en.js', 'utf-8'))
    for (const id of ['claude_auth_ok', 'claude_auth_lost', 'claude_auth_missing']) {
      for (const [name, src] of [['hu', hu], ['en', en]] as const) {
        expect(src, `${name}: health.${id}`).toContain(`'health.${id}':`)
        expect(src, `${name}: health.${id}_action`).toContain(`'health.${id}_action':`)
      }
    }
  })
})

/**
 * "Emiatt egyik ügynök sem tud dolgozni" -- hamis volt, és a felület mondta ki.
 *
 * Boss, 2026-08-21: "ez hamis allitas. mert most is tudok veled dolgozni! csak
 * a marvin nem dolgozik de attol mag a tobiek tudnak!" Igaza volt: ezen a
 * telepítésen 1 ágens függ a gép saját bejelentkezésétől és 14 nem.
 *
 * A magabiztos, hamis mondat a legrosszabb fajta hiba: pont úgy néz ki, mint a
 * helyes válasz. Ezért a szöveg mostantól SZÁMOL, nem állít -- ez a teszt a
 * számolás szabályát rögzíti.
 */
describe('ki függ a gép saját bejelentkezésétől', () => {
  it('a saját fiókos ágens NEM függ tőle -- ő dolgozik tovább', () => {
    expect(dependsOnDefaultLogin('/store/accounts/usalackor', 'shared', 'claude-opus-5')).toBe(false)
  })

  it('a nem-Claude modellt futtató ágens NEM függ tőle', () => {
    expect(dependsOnDefaultLogin(null, 'shared', 'google/gemma-4-31b-it:free')).toBe(false)
    expect(dependsOnDefaultLogin(null, 'shared', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')).toBe(false)
    expect(dependsOnDefaultLogin(null, 'shared', 'qwen3.6:27b')).toBe(false)
  })

  it('a saját API-kulccsal futó ágens NEM függ tőle', () => {
    expect(dependsOnDefaultLogin(null, 'api', 'claude-opus-5')).toBe(false)
  })

  it('a megosztott bejelentkezésen futó Claude-ágens IGEN', () => {
    expect(dependsOnDefaultLogin(null, 'shared', 'claude-sonnet-5')).toBe(true)
  })

  it('az érintettek és a nem érintettek együtt adják ki az egészet, átfedés nélkül', () => {
    const dep = defaultLoginDependents()
    const un = unaffectedByDefaultLogin()
    expect(dep.filter(n => un.includes(n))).toEqual([])
    expect(new Set([...dep, ...un]).size).toBe(dep.length + un.length)
  })
})
