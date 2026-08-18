// "A beallitasban sonett 5 van beallitva Marvinnak, akkor miert meg mindig a
// haiku?" -- a masodik fele ugyanannak a napnak (Boss, 2026-08-16).
//
// A d80c50f6 kartya elso fele az OLVASAST javitotta (a vezerlopult "unknown"-t
// irt). Ez a fele az IRAST: Marvin sajat modelljet sehol nem lehetett a
// Beallitasok oldalrol atallitani. Ott egyetlen modell-legordulo volt, a
// DEFAULT_AGENT_MODEL -- ami az UJ ugynokoke --, a fo ugynok modelljet pedig
// csak a telepito varazslo .env-mezoje ismerte. Aki a Beallitasoknal allitotta
// at, olyan kapcsolot mozgatott, ami rá sosem vonatkozott: semmilyen
// ujrainditas nem segitett volna.
//
// Ket dolog kell hozza, es kulon-kulon egyik sem eleg:
//   1. legyen a kulcs a Beallitasok registryjeben (kulonben nincs hol allitani)
//   2. a mentett erteket OLVASSA is valaki (kulonben a mentes csak latszik)
// A (2) a lenyeg: a Beallitasok oldal kizarolag a store/config-overrides.json-be
// ir, es korabban sem a vezerlopult, sem az indito nem nezte azt a fajlt.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SETTINGS_REGISTRY, validateSettingValue } from '../config-registry.js'
import { readConfiguredMainModel } from '../web/main-agent-model.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'main-model-setting-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeOverrides(obj: unknown): void {
  mkdirSync(join(root, 'store'), { recursive: true })
  writeFileSync(join(root, 'store', 'config-overrides.json'), JSON.stringify(obj))
}

function writeEnv(model: string): void {
  writeFileSync(join(root, '.env'), `OTHER=1\nMAIN_AGENT_MODEL=${model}\nTAIL=2\n`)
}

function writeClaudeSettings(model: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true })
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ model }))
}

describe('a Beallitasok oldalon allithato-e Marvin modellje', () => {
  it('a MAIN_AGENT_MODEL benne van a registryben', () => {
    const def = SETTINGS_REGISTRY.find(d => d.key === 'MAIN_AGENT_MODEL')
    expect(def, 'MAIN_AGENT_MODEL hianyzik a Beallitasok registrybol').toBeTruthy()
  })

  it('a fo ugynok ujrainditasat keri, nem a vezerlopultet', () => {
    // A modellt a channels session olvassa induláskor: a vezerlopult
    // ujrainditasa nem valtoztatna rajta semmit, es a sarga jelzes sosem
    // tunne el.
    const def = SETTINGS_REGISTRY.find(d => d.key === 'MAIN_AGENT_MODEL')!
    expect(def.requiresRestart).toBe(true)
    expect(def.restartTarget).toBe('main-agent')
  })

  it('elfogadja az ures erteket (= maradjon a .claude/settings.json)', () => {
    const def = SETTINGS_REGISTRY.find(d => d.key === 'MAIN_AGENT_MODEL')!
    expect(validateSettingValue(def, '').ok).toBe(true)
  })

  it('a leirasa megkulonbozteti magat az al-ugynokok modelljetol', () => {
    // Ez a ket kulcs egymas mellett all a Beallitasokban; ha egyik sem mondja
    // ki, melyik kire vonatkozik, pontosan ugyanaz a felreertes all elo.
    const main = SETTINGS_REGISTRY.find(d => d.key === 'MAIN_AGENT_MODEL')!
    const sub = SETTINGS_REGISTRY.find(d => d.key === 'DEFAULT_AGENT_MODEL')!
    expect(main.description).toMatch(/al-ügynök|alügynök/i)
    expect(sub.description).toMatch(/MAIN_AGENT_MODEL/)
  })
})

describe('readConfiguredMainModel -- a mentett ertek el is jut valakihez', () => {
  it('a Beallitasok oldal mentese veri a .env-et', () => {
    writeEnv('claude-haiku-4-5-20251001')
    writeOverrides({ MAIN_AGENT_MODEL: 'claude-sonnet-5' })
    expect(readConfiguredMainModel(root)).toBe('claude-sonnet-5')
  })

  it('a .env marad ervenyben, ha a Beallitasokban nincs mentve semmi', () => {
    writeEnv('claude-haiku-4-5-20251001')
    writeOverrides({ SOMETHING_ELSE: '1' })
    expect(readConfiguredMainModel(root)).toBe('claude-haiku-4-5-20251001')
  })

  it('az URESEN mentett ertek nem nemitja el a .env-et', () => {
    // Az ures ertek a registryben azt jelenti: "nincs beallitva". Ha ez
    // felulirna a .env-et, egy visszaallitas nemán modellt valtana.
    writeEnv('claude-haiku-4-5-20251001')
    writeOverrides({ MAIN_AGENT_MODEL: '' })
    expect(readConfiguredMainModel(root)).toBe('claude-haiku-4-5-20251001')
  })

  it('a .claude/settings.json az utolso szo, nem az elso', () => {
    writeClaudeSettings('claude-opus-5')
    writeOverrides({ MAIN_AGENT_MODEL: 'claude-sonnet-5' })
    expect(readConfiguredMainModel(root)).toBe('claude-sonnet-5')
  })

  it('serult override-fajl eseten a .env-hez esik vissza, nem urul ki', () => {
    mkdirSync(join(root, 'store'), { recursive: true })
    writeFileSync(join(root, 'store', 'config-overrides.json'), '{ ez nem json')
    writeEnv('claude-haiku-4-5-20251001')
    expect(readConfiguredMainModel(root)).toBe('claude-haiku-4-5-20251001')
  })

  it('semmi sincs beallitva -> ures string, nem talalgatas', () => {
    expect(readConfiguredMainModel(root)).toBe('')
  })
})

describe('az inditó ugyanazt olvassa, mint a vezerlopult', () => {
  const ROOT = join(__dirname, '..', '..')

  it('a channels.sh a kozos fuggvenyen at kerdezi meg a modellt', () => {
    // Ha az indito sajat shell-logikaval olvasna az override-fajlt, a ket
    // sorrend elobb-utobb szetcsuszna, es a vezerlopult mast irna ki, mint
    // amin a bot elindul.
    const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf8')
    const fn = sh.slice(sh.indexOf('resolve_main_model() {'))
    expect(fn).toContain('scripts/main-agent-model.mjs')
    // A helper a .env-olvasas ELOTT fut: a mentett beallitas veri a .env-et.
    expect(fn.indexOf('main-agent-model.mjs')).toBeLessThan(fn.indexOf('MAIN_AGENT_MODEL:-'))
  })

  it('a helper a lefordított kozos fuggvenyt hivja, nem sajat masolatot', () => {
    const mjs = readFileSync(join(ROOT, 'scripts', 'main-agent-model.mjs'), 'utf8')
    expect(mjs).toContain('readConfiguredMainModel')
    expect(mjs).toContain('dist')
  })

  it('a channels.sh dist nelkul is elindul (nem-epitett telepites)', () => {
    const sh = readFileSync(join(ROOT, 'scripts', 'channels.sh'), 'utf8')
    const fn = sh.slice(sh.indexOf('resolve_main_model() {'))
    expect(fn).toContain('dist/web/main-agent-model.js')
    expect(fn).toContain('command -v node')
  })
})
