// A KOD-HID LASSA, MELYIK *WSL-BELI* BESZELGETES FUT.
//
// A MERT ESET (2026-09-13, kartya c795a495). A tulaj Opus 5-re allitotta a VS
// Code-menetet, a kartyan megis `claude-haiku-4-5` allt. Az ok nem a modell-
// valasztas volt: a kartya egy TEGNAPI, mar lezart beszelgetest (`cac9cc09`,
// haiku, utoljara 17:21) mutatott a MOSTANI, epp futo helyett (`09e202d8`,
// opus, 658k token, 04:24).
//
// A gyoker: a `Get-OpenSessionIds` csak a WINDOWS `%USERPROFILE%\.claude\
// sessions` mappat olvasta, es a PID-et `Get-Process`-szel ellenorizte. A
// tulaj beszelgetesei a WSL-ben futnak -- a windowsos `Get-Process` a linux
// PID-eket NEM latja (kulon PID-nevter) --, ezert MINDEN WSL-beli beszelgetes
// `live = false`-nak latszott. Emiatt a `repointStale` (elavult bekotes
// atallitasa) sosem teljesulhetett, es a "most itt dolgozik" jelzes sem
// gyulhatott ki. Amikor a felderitest kiterjesztettuk a WSL-re, ezt a merest
// nem vittuk at vele.
//
// A WSL-ben ugyanaz a nyilvantartas all: `~/.claude/sessions/<pid>.json`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const PS1 = readFileSync(join(ROOT, 'scripts', 'windows', 'marvin-code-worker.ps1'), 'utf8')

function fn(name: string): string {
  const i = PS1.indexOf(`function ${name} {`)
  expect(i, `a ${name} fuggveny eltunt a szkriptbol`).toBeGreaterThan(0)
  const next = PS1.indexOf('\nfunction ', i + 1)
  return PS1.slice(i, next === -1 ? PS1.length : next)
}

/** A VEGREHAJTHATO kod, kommentek nelkul. Enelkul egy magyarazo komment
 *  ("...ugyanaz a szandek, mint a Stop-Process...") ugy latszana, mintha a kod
 *  maga hivna azt -- es a teszt tevesen bukna el. A teljes sort dobjuk el, ha
 *  `#`-tel kezdodik; a sor kozepen allo `#`-hez nem nyulunk, mert az stringben
 *  is elofordulhat. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

describe('WSL-beli beszelgetesek elo-merese', () => {
  it('a Get-OpenSessionIds a WSL sessions mappait is bejarja', () => {
    const body = fn('Get-OpenSessionIds')
    expect(body).toContain('Get-WslDistros')
    expect(
      body.includes('.claude\\sessions'),
      'a WSL-oldali sessions mappa mintaja hianyzik',
    ).toBe(true)
    expect(body).toContain('wsl.localhost')
  })

  it('a linux PID-eket NEM Get-Process-szel ellenorzi', () => {
    // A windowsos Get-Process a linux PID-eket nem latja. A WSL-agnak sajat
    // ellenorzese van (Get-WslRunningPids), egyetlen `ps` hivasbol.
    const body = fn('Get-OpenSessionIds')
    expect(body).toContain('Get-WslRunningPids')
  })

  it('a PID-ellenorzes EGY ps hivas disztronkent, nem PID-enkent', () => {
    // PID-enkenti wsl.exe inditas percenkent tucatnyi uj folyamat lenne.
    const body = fn('Get-WslRunningPids')
    expect(body).toMatch(/ps -eo pid=,comm=/)
  })

  it('"nem lattam oda" != "nem fut": a nulla ket dolgot jelenthet', () => {
    const runner = fn('Get-WslRunningPids')
    // Ha a disztroba nem latunk bele, `$null`-t ad -- nem ures listat.
    expect(runner).toMatch(/return \$null/)
    const body = fn('Get-OpenSessionIds')
    // A hivo ezt kulon agon kezeli: nem allit semmit az ottani sorokrol.
    expect(body).toMatch(/if \(\$null -eq \$running\) \{ continue \}/)
  })

  it('a visszateres STRUKTURA: a PID mellett a disztro is megvan', () => {
    const body = fn('Get-OpenSessionIds')
    expect(body).toMatch(/@\{ Pid = .*Distro = /)
  })
})

describe('BIZTONSAG: egy WSL-PID nem olhet meg windowsos folyamatot', () => {
  // A ket rendszer PID-nevtere KULON: a linux 1234 es a windowsos 1234 ket
  // teljesen mas folyamat. Stop-Process egy WSL-PID-re egy VELETLEN idegen
  // folyamatot olne meg -- a nev-ellenorzes sem vedene, mert lehet eppen egy
  // windowsos node.exe azon a szamon.
  it('WSL-es sessiont a disztron BELUL allit le, nem Stop-Process-szel', () => {
    const body = code(fn('Close-RequestedSessions'))
    const i = body.indexOf('if ($row.wslDistro)')
    expect(i, 'nincs kulon ag a WSL-beli beszelgetesekhez').toBeGreaterThan(0)
    const branch = body.slice(i, body.indexOf('continue', i))
    expect(branch).toContain('wsl.exe')
    expect(branch).toContain('kill')
    expect(
      branch.includes('Stop-Process'),
      'a WSL-ag Stop-Process-t hasznal -- ez idegen windowsos folyamatot olhet meg',
    ).toBe(false)
  })

  it('a windowsos ag valtozatlanul Stop-Process + nev-ellenorzes', () => {
    const body = fn('Close-RequestedSessions')
    expect(body).toContain('Stop-Process')
    expect(body).toMatch(/ProcessName -notmatch/)
  })
})

describe('a jelentes elarulja, melyik disztroban fut', () => {
  it('a session-sor tartalmazza a wslDistro mezot', () => {
    expect(PS1).toMatch(/wslDistro\s*=\s*\$sidDistro/)
  })
})
