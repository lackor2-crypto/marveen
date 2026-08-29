import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isLoopbackCallback, pickBrowserAuthUrl, extractAuthUrl } from '../claude-auth.js'

// Both fixtures come from ONE real login (CLI 2.1.251, 2026-08-29), run with an
// isolated CLAUDE_CONFIG_DIR and $BROWSER pointed at a script that recorded its
// argument. That is the point of this file: the CLI offers two endings to the
// same login, and only one of them was ever visible on the pane.
//
// Note the shared code_challenge and state -- one flow, two redirect targets.
const COMMON =
  '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference' +
  '&code_challenge=S4t_hf-sg1YOGIB_9LFlN8JgbMbIAn-jpljPGwMJUD8' +
  '&code_challenge_method=S256&state=VmhWt6dzKG7U3WOWvluHyGeOBxtWA5egKvkkzkDLbn0'

/** What the CLI handed to $BROWSER: comes back to a port it listens on itself. */
const AUTO_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A36237%2Fcallback' + COMMON

/** What the same run printed on the pane: a hosted page that shows a code. */
const MANUAL_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' + COMMON

describe('isLoopbackCallback', () => {
  it('elfogadja a CLI sajat kapujat', () => {
    expect(isLoopbackCallback('http://localhost:36237/callback')).toBe(true)
    expect(isLoopbackCallback('http://127.0.0.1:41111/callback')).toBe(true)
  })

  it('elutasitja a hosztolt oldalt -- az kodot ir ki, nem ter vissza ide', () => {
    expect(isLoopbackCallback('https://platform.claude.com/oauth/code/callback')).toBe(false)
  })

  // A felulet ebbol igeri meg, hogy "magatol befejezodik". Egy laza egyezes itt
  // egy hazug mondatot jelentene a kepernyon, ezert szuk a kapu.
  it('elutasit mindent, ami csak hasonlit ra', () => {
    expect(isLoopbackCallback('https://localhost:36237/callback')).toBe(false)   // https
    expect(isLoopbackCallback('http://localhost/callback')).toBe(false)          // port nelkul
    expect(isLoopbackCallback('http://localhost:36237/callback/extra')).toBe(false)
    expect(isLoopbackCallback('http://example.com:36237/callback')).toBe(false)
    expect(isLoopbackCallback('http://localhost.evil.test:80/callback')).toBe(false)
    expect(isLoopbackCallback('')).toBe(false)
    expect(isLoopbackCallback('nem is url')).toBe(false)
  })
})

describe('pickBrowserAuthUrl', () => {
  it('kiszedi a bongeszonek szant cimet a naplobol', () => {
    expect(pickBrowserAuthUrl(`${AUTO_URL}\n`)).toBe(AUTO_URL)
  })

  it('a kezi cimet NEM adja vissza automatakent', () => {
    expect(pickBrowserAuthUrl(`${MANUAL_URL}\n`)).toBeNull()
  })

  // A napló hozzafuz: egy megszakitott kiserlet cime ott marad. A regi challenge
  // mar halott, tehat a legutolso hasznalhato sor nyer, nem az elso.
  it('tobb sorbol az utolso ervenyeset valasztja', () => {
    const older = AUTO_URL.replace('36237', '40001').replace('state=Vmh', 'state=OLD')
    expect(pickBrowserAuthUrl(`${older}\n${MANUAL_URL}\n${AUTO_URL}\n`)).toBe(AUTO_URL)
  })

  it('atlepi a szemetet es a felig kiirt sort', () => {
    const half = AUTO_URL.slice(0, AUTO_URL.indexOf('&state='))
    expect(pickBrowserAuthUrl(`valami zaj\n\n${half}\n`)).toBeNull()
    expect(pickBrowserAuthUrl('')).toBeNull()
    expect(pickBrowserAuthUrl('http://localhost:36237/callback\n')).toBeNull()
  })

  it('elviseli, ha a bongeszo-burkolo kapcsolokat is atadott', () => {
    expect(pickBrowserAuthUrl(`--new-window\n${AUTO_URL}\n`)).toBe(AUTO_URL)
  })
})

// A ket forras KULON marad: ami a panelen van, az a kezi ut, es ez nem valtozott.
// Ha valaki egyszer a panelrol probalna automata cimet olvasni, itt bukik el.
describe('a panel es a bongeszo-naplo ket kulonbozo cimet ad', () => {
  const pane =
    'Opening browser to sign in…\r\n' +
    `If the browser didn't open, visit: ${MANUAL_URL}\r\n` +
    'Paste code here if prompted > '

  it('a panelrol a kezi cim jon, es abbol nem lesz automata', () => {
    expect(extractAuthUrl(pane)).toBe(MANUAL_URL)
    expect(pickBrowserAuthUrl(pane)).toBeNull()
  })
})

// A shim maga harom sor shell, es pontosan ez a harom sor volt az, amit elo
// meressel kiprobaltam. Ha valaki atirja, itt derul ki, hogy elveszett-e a
// kulcsdarab: a "$@" (a cim maga) vagy a naplofajl neve.
describe('a bongeszo-helyettesito szkript', () => {
  const src = readFileSync(new URL('../web/claude-auth-runner.ts', import.meta.url), 'utf-8')

  it('a kapott argumentumot irja ki, es a naplo helyet kornyezeti valtozobol veszi', () => {
    const m = src.match(/writeFileSync\(shim, ('(?:[^'\\]|\\.)*'), \{ mode: 0o700 \}\)/)
    expect(m, 'a shim-et iro sor nem talalhato').not.toBeNull()
    // eslint-disable-next-line no-eval
    const script = eval(m![1]) as string
    expect(script.startsWith('#!/bin/sh')).toBe(true)
    expect(script).toContain('"$@"')
    expect(script).toContain('$MARVEEN_LOGIN_URL_LOG')
    expect(script).toContain('exit 0')
  })

  it('a tmux ablak megkapja a shim-et ES a naplo utvonalat', () => {
    expect(src).toContain('`BROWSER=${shim.shim}`')
    expect(src).toContain('`MARVEEN_LOGIN_URL_LOG=${shim.log}`')
  })
})
