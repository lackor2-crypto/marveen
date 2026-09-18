// AZ ENGEDELY-ABLAK GEPI LEZARASA NEM A TULAJDONOS "NEM"-JE.
//
// Boss, 2026-09-18 (kartya 184881de): "az utolso lepesemet leallitottad ...
// a marvin allitott le teged ... oldjatok meg. globalisan!"
//
// MERVE (store/dashboard.log, 13:29:47.589): nem Marvin volt, hanem a
// csatorna-figyelo: "Session parked in a blocking interactive menu -- sending
// Escape to recover". A panelen egy eszkoz-engedely ablak allt ("Do you want
// to proceed?"), amire a Telegramon ulo tulajdonos nem valaszolhatott. Az
// Escape ezen az ablakon "Nem", a Claude Code pedig azt irta az ugynoknek,
// hogy a felhasznalo nem engedi, alljon meg es varjon -- az ugynok a
// tulajdonosra vart, aki a kerdest sosem latta.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectsPermissionPrompt, detectsBlockingMenu } from '../pane-state.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const monitor = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf8')

const BASH_PROMPT = [
  '● Bash(rm -f /tmp/scratch/*.txt)',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Bash command                                                 │',
  '│                                                              │',
  '│   rm -f /tmp/scratch/*.txt                                   │',
  '│   Remove scratch files                                       │',
  '│                                                              │',
  '│ Do you want to proceed?                                      │',
  '│ ❯ 1. Yes                                                     │',
  "│   2. Yes, and don't ask again for rm commands in /home/boss  │",
  '│   3. No                                                      │',
  '╰──────────────────────────────────────────────────────────────╯',
  ' Esc to cancel',
].join('\n')

// A regebbi CLI-alak: a lablec helyett "(esc)" all a Nem-opcio vegen. A
// figyelo ezt menunek sem latja, de ha latna, engedely-ablaknak kell latszania.
const BASH_PROMPT_OLD = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently (esc)',
].join('\n')

const EDIT_PROMPT_NEW_FOOTER = [
  ' Edit file',
  ' src/web/app.ts',
  ' + const a = 1',
  '',
  ' Do you want to make this edit to app.ts?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits during this session (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to add additional instructions',
].join('\n')

const MCP_MENU = [
  ' Manage MCP servers',
  ' ❯ 1. telegram  ✔ connected',
  '   2. google    ✘ failed',
  '',
  ' ↑↓ to navigate · Enter to select · Esc to cancel',
].join('\n')

describe('az engedely-ablak kulon felismerheto', () => {
  it('a Bash engedely-ablak az (es a figyelo menunek latja, tehat eljut az aghoz)', () => {
    expect(detectsBlockingMenu(BASH_PROMPT)).toBe(true)
    expect(detectsPermissionPrompt(BASH_PROMPT)).toBe(true)
  })

  it('a regebbi alak is az', () => {
    expect(detectsPermissionPrompt(BASH_PROMPT_OLD)).toBe(true)
  })

  it('az uj lablecu szerkesztes-engedely is az', () => {
    expect(detectsPermissionPrompt(EDIT_PROMPT_NEW_FOOTER)).toBe(true)
  })

  it('a /mcp menu NEM engedely-ablak -- ott marad a sima Escape', () => {
    expect(detectsPermissionPrompt(MCP_MENU)).toBe(false)
  })

  it('a scrollbackben regen lezart ablak nem szamit, csak a panel alja', () => {
    const old = BASH_PROMPT + '\n' + Array.from({ length: 30 }, (_, i) => `sor ${i}`).join('\n') + '\n❯ \n? for shortcuts'
    expect(detectsPermissionPrompt(old)).toBe(false)
  })

  it('ures panel nem az', () => {
    expect(detectsPermissionPrompt('')).toBe(false)
  })
})

describe('a figyelo megmondja az ugynoknek, hogy a "nem" gepi volt', () => {
  const branch = monitor.slice(monitor.indexOf('} else if (detectsPermissionPrompt(paneNow))'))
  const body = branch.slice(0, branch.indexOf('} else {'))

  it('Escape UTAN kuldi a helyesbito sort, ugyanabba a munkamenetbe', () => {
    expect(body).toMatch(/'Escape'\][\s\S]*sendPromptToSession\(t\.session, PERMISSION_CANCELLED_NOTE\)/)
  })

  it('a sor kimondja: nem a tulajdonos dontese, ne varjon, folytassa', () => {
    const note = monitor.slice(monitor.indexOf('PERMISSION_CANCELLED_NOTE ='), monitor.indexOf('PERMISSION_CANCELLED_NOTE =') + 700)
    expect(note).toContain('NEM a tulajdonos döntése')
    expect(note).toContain('ne várj rá')
    expect(note).toContain('Telegramon')
  })

  it('a vak "Igen" tilos: a figyelo semmilyen opciot nem valaszt ki', () => {
    expect(body).not.toMatch(/send-keys[^\n]*'(?:1|2|Enter|y)'/)
  })

  it('a login- es modell-dialogus ellenorzese elotte fut (azokra nem jar Escape)', () => {
    const iLogin = monitor.indexOf('detectsLoginInProgress(paneNow)')
    const iConsent = monitor.indexOf('detectsModelConsentDialog(paneNow)')
    const iPerm = monitor.indexOf('detectsPermissionPrompt(paneNow)')
    expect(iLogin).toBeGreaterThan(0)
    expect(iConsent).toBeGreaterThan(iLogin)
    expect(iPerm).toBeGreaterThan(iConsent)
  })
})
