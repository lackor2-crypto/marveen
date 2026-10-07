// #503 -- a dictation aimed at a Telegram picture caption goes out as a plain
// message instead (windows/hu-diktalas/telegram-kepalairas.ps1).
//
// The measured failure (TG 2675 / 2680): the owner pastes a screenshot into
// Telegram Desktop and dictates into the caption of the send-files box. That
// field is capped at 1024 characters in Telegram Desktop itself
// (send_files_box.cpp: `_caption->setMaxLength(captionLengthCurrent())`), so
// whatever is pasted past the cap is dropped without a word -- 1254 dictated
// characters arrived as 1024. There is no Telegram setting that sends a long
// caption as a separate message, so the dictation tool does it: it sends the
// picture without text and puts the whole text into the plain message field.
//
// The behaviour test runs the REAL module under PowerShell against a fake
// Telegram that keeps the one rule that matters: the caption field drops what
// does not fit, the message field does not. CI (ubuntu-latest) ships `pwsh`;
// where there is none the test is skipped and says so. Set
// MARVEEN_PS_RUNNER=powershell.exe on a WSL box to run it under Windows
// PowerShell 5.1 -- the version the dictation tool actually runs on.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')
const DIR = join(ROOT, 'windows', 'hu-diktalas')
const MODULE = join(DIR, 'telegram-kepalairas.ps1')
const read = (p: string): string => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

describe('dictation scripts: the caption fix is wired and installable', () => {
  it('every .ps1 is pure ASCII (Windows PowerShell 5.1 reads them as ANSI)', () => {
    const bad = readdirSync(DIR)
      .filter((f) => f.endsWith('.ps1'))
      .filter((f) => /[^\x00-\x7f]/.test(readFileSync(join(DIR, f), 'utf8')))
    expect(bad).toEqual([])
  })

  it('the installer copies the new module (it is not on the skip list)', () => {
    const inst = read(join(DIR, 'telepit.ps1'))
    const skip = /\$_\.Name -notin @\(([^)]*)\)/.exec(inst)
    expect(skip).not.toBeNull()
    expect(skip![1]).not.toContain('telegram-kepalairas.ps1')
  })

  it('diktal-auto.ps1 moves the text only when the focus is in a caption', () => {
    const auto = read(join(DIR, 'diktal-auto.ps1'))
    expect(auto).toContain(". (Join-Path $Base 'telegram-kepalairas.ps1')")
    expect(auto).toMatch(/if \(\$tgField -eq 'caption' -and \$tgIo\) \{\n\s+try \{ \$tgMove = Move-TgCaptionToMessage /)
    // the old paste stays the path for everything else
    expect(auto).toMatch(/\} else \{\n[^\n]*kimaradt[^\n]*\n\s+Start-Sleep -Milliseconds 120\n[^\n]*\n\s+\[System\.Windows\.Forms\.SendKeys\]::SendWait\('\^v'\)/)
    // the plain message field has no 1024 cap: no counting, no beeping there
    expect(auto).toMatch(/if \(\$tgField -eq 'message'\) \{ Remove-Item \$capFile/)
  })

  it('the tool never presses Enter by itself outside the caption move', () => {
    // Measured 2026-10-07 02:26 (TG 2728 / 2730): a blind "split at 1000
    // characters + Enter" rule sent the first 995 characters of a PLAIN
    // message on its own; the owner saw only the last 197 in the field and
    // reported that "only the last few words were recorded". The plain message
    // field has no 1024 cap, so nothing there may be split or sent for him.
    const auto = read(join(DIR, 'diktal-auto.ps1'))
    expect(auto).not.toMatch(/SendWait\('(\^)?\{ENTER\}'\)/)
    expect(auto).not.toContain('telegram-darabolas')
  })

  it('the log line the agent-side hook looks for is the one the tool writes', () => {
    const ps = /\$TgMovedLogPrefix = '([^']+)'/.exec(read(MODULE))
    const py = /MOVED_PREFIX = "([^"]+)"/.exec(read(join(ROOT, 'scripts', 'hooks', 'telegram_caption_limit.py')))
    expect(ps && py).toBeTruthy()
    expect(ps![1]).toBe(py![1])
  })
})

// ---- behaviour, under a real PowerShell -------------------------------------

function pickRunner(): string | null {
  const forced = process.env.MARVEEN_PS_RUNNER?.trim()
  if (forced) return forced
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' })
  return r.status === 0 ? 'pwsh' : null
}
const RUNNER = pickRunner()
const windowsRunner = !!RUNNER && /\.exe$/i.test(RUNNER)
const toRunnerPath = (p: string): string =>
  windowsRunner ? execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim() : p

const OLD = 'Elso diktalas a kepernyokeprol.'
const LONG = 'Masodik diktalas, ' + 'x'.repeat(1180) + ' VEGE.'
const PREFILLED = 'Elozoleg az uzenetmezobe diktalt szoveg, ' + 'y'.repeat(1260) + ' VEGE.'

// A fake Telegram Desktop. `focus`: where the cursor is; `submit`: which key
// sends from the caption ('Enter' default, 'CtrlEnter' setting, 'None' = the
// send never happens); `after`: where the focus lands once the box closed.
const SCRIPT = (modulePath: string): string => `
$ErrorActionPreference = 'Stop'
. '${modulePath.replace(/'/g, "''")}'

function New-FakeTg {
  param([string]$Caption = '', [string]$Focus = 'caption', [string]$Submit = 'Enter',
        [string]$After = 'message', [bool]$Readable = $true, [bool]$KeysWork = $true)
  return @{ box = ($Focus -eq 'caption'); caption = $Caption; message = ''; focus = $Focus
            submit = $Submit; after = $After; readable = $Readable; keysWork = $KeysWork; sel = $false
            sent = (New-Object System.Collections.ArrayList); ev = (New-Object System.Collections.ArrayList) }
}
function Fake-Focus {
  $t = $null
  if ($script:TG.focus -eq 'caption') { if ($script:TG.readable) { $t = [string]$script:TG.caption } }
  elseif ($script:TG.focus -eq 'message') { $t = [string]$script:TG.message }
  return @{ Kind = $script:TG.focus; Text = $t }
}
function Fake-Send {
  [void]$script:TG.sent.Add([string]$script:TG.caption)
  $script:TG.caption = ''; $script:TG.box = $false; $script:TG.focus = $script:TG.after
}
function Fake-Keys($k) {
  [void]$script:TG.ev.Add('key:' + $k)
  if (-not $script:TG.keysWork) { return }
  switch ($k) {
    '^a'       { $script:TG.sel = $true }
    '{DEL}'    { if ($script:TG.sel -and $script:TG.focus -eq 'caption') { $script:TG.caption = '' }; $script:TG.sel = $false }
    '{ENTER}'  { if ($script:TG.focus -eq 'caption') { if ($script:TG.submit -eq 'Enter') { Fake-Send } else { $script:TG.caption += [string][char]10 } } }
    '^{ENTER}' { if ($script:TG.focus -eq 'caption' -and $script:TG.submit -eq 'CtrlEnter') { Fake-Send } }
  }
}
function Fake-Paste($t) {
  [void]$script:TG.ev.Add('paste')
  if ($script:TG.focus -eq 'caption') {
    # Telegram Desktop: setMaxLength(1024) -- what does not fit is dropped.
    $room = [math]::Max(0, 1024 - $script:TG.caption.Length)
    $script:TG.caption += $t.Substring(0, [math]::Min($room, $t.Length))
  } elseif ($script:TG.focus -eq 'message') { $script:TG.message += $t }
}
function Fake-FocusMessage { if (-not $script:TG.box) { $script:TG.focus = 'message'; return $true }; return $false }

$all = @{}
function Run-Case {
  param([string]$Name, [string]$Text, [hashtable]$Tg, [bool]$Helper = $true)
  $script:TG = New-FakeTg @Tg
  $io = @{
    Focus = { Fake-Focus }
    Keys  = { param($k) Fake-Keys $k }
    Paste = { param($t) Fake-Paste $t }
    Sleep = { param($ms) [void]$script:TG.ev.Add('sleep') }
    Log   = { param($m) [void]$script:TG.ev.Add('log:' + $m) }
  }
  if ($Helper) { $io.FocusMessage = { Fake-FocusMessage } }
  $r = Move-TgCaptionToMessage -Text $Text -Io $io -WaitMs 300 -StepMs 100
  $all[$Name] = @{
    done = [bool]$r.Done; touched = [bool]$r.Touched; reason = [string]$r.Reason; clipboard = [string]$r.Clipboard
    sent = @($script:TG.sent); caption = [string]$script:TG.caption; message = [string]$script:TG.message
    focus = [string]$script:TG.focus; ev = @($script:TG.ev | Where-Object { $_ -ne 'sleep' })
  }
}

Run-Case 'long'      '${LONG}' @{ Caption = '${OLD}' }
Run-Case 'empty'     'Rovid szoveg.' @{ Caption = '' }
Run-Case 'prefilled' 'tovabb.' @{ Caption = '${PREFILLED}' }
Run-Case 'ctrlenter' 'uj' @{ Caption = 'regi'; Submit = 'CtrlEnter' }
Run-Case 'nosend'    'uj' @{ Caption = 'regi'; Submit = 'None' }
Run-Case 'refocus'   'uj' @{ Caption = 'regi'; After = 'other' }
Run-Case 'lost'      'uj' @{ Caption = 'regi'; After = 'other' } $false
Run-Case 'deadkeys'  'uj' @{ Caption = 'regi'; KeysWork = $false }
Run-Case 'message'   'uj' @{ Focus = 'message' }
Run-Case 'other'     'uj' @{ Focus = 'other' }
Run-Case 'unread'    'uj' @{ Caption = 'regi'; Readable = $false }

# the fake keeps Telegram's rule: pasted straight into the caption, 1254 -> 1024
$script:TG = New-FakeTg -Caption ''
Fake-Paste ('${OLD} ' + '${LONG}')
$all['oldway'] = @{ caption = $script:TG.caption.Length }

$all['kinds'] = @{
  measured = Get-TgFieldKind -Classes @('class Ui::InputField::Inner', 'class Ui::InputField', 'class HistoryWidget', 'class MainWidget', 'class Ui::RpWidget', 'class Ui::RpWidget', 'class MainWindow', '#32769')
  caption  = Get-TgFieldKind -Classes @('class Ui::InputField::Inner', 'class Ui::InputField', 'class SendFilesBox', 'class Ui::BoxLayerWidget', 'class MainWindow')
  button   = Get-TgFieldKind -Classes @('class Ui::IconButton', 'class HistoryWidget', 'class MainWidget')
  search   = Get-TgFieldKind -Classes @('class Ui::InputField::Inner', 'class Ui::InputField', 'class Dialogs::Widget', 'class MainWidget')
  none     = Get-TgFieldKind -Classes @()
}
$all['join'] = @((Join-TgText '' 'b'), (Join-TgText ' a ' 'b '), (Join-TgText 'a' ''))
$all['warn'] = @((Get-TgMoveWarning 'uzenetmezo-nem-fokuszban'), (Get-TgMoveWarning 'kep-nem-ment-el'), (Get-TgMoveWarning 'kepalairas-nem-urult'))
[Console]::Out.Write(($all | ConvertTo-Json -Depth 6 -Compress))
`

interface Case {
  done: boolean; touched: boolean; reason: string; clipboard: string
  sent: string[]; caption: string; message: string; focus: string; ev: string[]
}

describe.skipIf(!RUNNER)(`caption -> plain message under ${RUNNER ?? 'PowerShell (not installed -- skipped)'}`, () => {
  let dir = ''
  let out: Record<string, any> = {}
  const c = (name: string): Case => out[name] as Case

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hu-diktalas-503-'))
    const script = join(dir, 'run.ps1')
    writeFileSync(script, SCRIPT(toRunnerPath(MODULE)))
    const args = ['-NoProfile', '-NonInteractive', ...(windowsRunner ? ['-ExecutionPolicy', 'Bypass'] : []), '-File', toRunnerPath(script)]
    const raw = execFileSync(RUNNER!, args, { encoding: 'utf8', timeout: 90_000, cwd: dir })
    out = JSON.parse(raw.trim())
  }, 120_000)

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

  it('measured case: 1254 characters would be cut to 1024 in the caption', () => {
    expect(out.oldway.caption).toBe(1024)
  })

  it('long dictation into a caption: picture sent without text, ALL text in the message field', () => {
    const r = c('long')
    expect(r.done).toBe(true)
    expect(r.sent).toEqual([''])
    expect(r.message).toBe(`${OLD} ${LONG}`)
    expect(r.message.length).toBeGreaterThan(1024)
    expect(r.focus).toBe('message')
    // cleared, logged, THEN sent: the agent-side hook finds the line first
    expect(r.ev.slice(0, 2)).toEqual(['key:^a', 'key:{DEL}'])
    const log = r.ev.findIndex((e) => e.startsWith('log:kepalairas -> sima uzenet:'))
    expect(log).toBeGreaterThan(-1)
    expect(log).toBeLessThan(r.ev.indexOf('key:{ENTER}'))
    expect(r.ev[r.ev.length - 1]).toBe('paste')
  })

  it('first dictation into an empty caption: nothing to clear, picture goes, text in the message field', () => {
    const r = c('empty')
    expect(r.done).toBe(true)
    expect(r.ev.filter((e) => e.startsWith('key:'))).toEqual(['key:{ENTER}'])
    expect(r.sent).toEqual([''])
    expect(r.message).toBe('Rovid szoveg.')
  })

  it('a caption prefilled past the cap (text typed first, picture pasted after) is moved whole', () => {
    const r = c('prefilled')
    expect(r.done).toBe(true)
    expect(r.message).toBe(`${PREFILLED} tovabb.`)
    expect(r.sent).toEqual([''])
  })

  it('"Ctrl+Enter sends" setting: the stray new line is cleared and Ctrl+Enter sends', () => {
    const r = c('ctrlenter')
    expect(r.done).toBe(true)
    expect(r.sent).toEqual([''])
    expect(r.message).toBe('regi uj')
  })

  it('the picture cannot be sent: the caption is put back, the new text waits on the clipboard', () => {
    const r = c('nosend')
    expect(r.done).toBe(false)
    expect(r.touched).toBe(true)
    expect(r.reason).toBe('kep-nem-ment-el')
    expect(r.sent).toEqual([])
    expect(r.caption).toBe('regi')
    expect(r.clipboard).toBe('uj')
  })

  it('focus does not come back to the message field: it is looked up; without that the text is on the clipboard', () => {
    expect(c('refocus').done).toBe(true)
    expect(c('refocus').message).toBe('regi uj')
    const r = c('lost')
    expect(r.done).toBe(false)
    expect(r.reason).toBe('uzenetmezo-nem-fokuszban')
    expect(r.sent).toEqual([''])
    expect(r.clipboard).toBe('regi uj')
  })

  it('the caption does not clear: nothing is sent, the whole text is on the clipboard', () => {
    const r = c('deadkeys')
    expect(r.reason).toBe('kepalairas-nem-urult')
    expect(r.sent).toEqual([])
    expect(r.caption).toBe('regi')
    expect(r.clipboard).toBe('regi uj')
  })

  it('not a caption, or an unreadable one: untouched, the old paste path runs', () => {
    for (const name of ['message', 'other', 'unread']) {
      const r = c(name)
      expect(r.touched).toBe(false)
      expect(r.ev).toEqual([])
      expect(r.sent).toEqual([])
    }
    expect(c('unread').caption).toBe('regi')
  })

  it('field kinds come from the class chain, not from the (localised) field name', () => {
    expect(out.kinds).toEqual({ measured: 'message', caption: 'caption', button: 'other', search: 'other', none: 'other' })
  })

  it('texts are joined with one space; every failure has a warning', () => {
    expect(out.join).toEqual(['b', 'a b', 'a'])
    expect(out.warn.every((w: string) => /Ctrl\+V/.test(w))).toBe(true)
  })
})
