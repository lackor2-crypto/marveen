# marvin-code-worker -- the Windows half of the VS Code Claude Code bridge.
#
# WHAT IT DOES
#   1. Discovers the Claude Code sessions on this machine -- BOTH STORES: the
#      Windows one (%USERPROFILE%\.claude\projects\<encoded-cwd>\<session>.jsonl)
#      and every WSL distro's own one, reached over \\wsl.localhost. Reports
#      them to Marveen (project alias -> sessionId + workspace path).
#   2. Claims one queued task at a time from Marveen.
#   3. Runs the EXISTING session headless, in the store it came from:
#        claude.exe   -p --resume <sessionId> --output-format json
#        wsl.exe -d <distro> --cd <posix> -e claude  -p --resume ... (WSL side)
#      in the project's own folder, so the conversation history, the project
#      knowledge and the workspace context are all the ones that session already
#      has. No --fork-session, no --session-id: nothing new is created.
#   4. Posts the result back. Marveen sends the short Telegram ping from there,
#      programmatically -- no model is asked to summarise anything.
#
# WHY THE WORKER POLLS INSTEAD OF LISTENING
#   Marveen runs in WSL and cannot reach Windows: /mnt/c and /mnt/d return EIO on
#   this machine and there is no passwordless sudo to remount them. The reverse
#   works (Windows -> 127.0.0.1:<port> -> WSL, and \\wsl.localhost for files), so
#   all traffic is OUTBOUND from here. Nothing listens on Windows: no port, no
#   firewall rule, nothing reachable from the network.
#
# NO GUI AUTOMATION: no AutoHotKey, no mouse, no keystrokes, no clipboard, no
# window focus. This is a plain CLI child process.

[CmdletBinding()]
param(
  [string]$BaseUrl = 'http://127.0.0.1:3420',
  [string]$TokenPath = '\\wsl.localhost\Ubuntu\home\boss\marveen\store\.dashboard-token',
  [string]$Token = '',
  [int]$PollSeconds = 3,
  [int]$DiscoverSeconds = 60,
  [int]$TaskTimeoutSeconds = 3600,
  [switch]$Once,
  [switch]$DiscoverOnly
)

$ErrorActionPreference = 'Stop'
# A SAJAT verzioja. A szkript a felhasznalo gepen egy MASOLATBAN fut, es egy
# elavult masolat nem hibazik: nemaan regi adatot kuld. Ezert megy fel minden
# felderitesi korrel, es ezert veti ossze Marveen a repoban levo fajlbol
# kiolvasott vart verzioval (src/web/code-worker-version.ts). Ha itt valtozik
# valami, amit a szervernek is tudnia kell, EZT A SORT is emelni kell.
$script:WorkerVersion = '2026-09-12.4'
$script:HostId = $env:COMPUTERNAME
if (-not $script:HostId) { $script:HostId = 'windows' }

$script:StateDir = Join-Path $env:LOCALAPPDATA 'marvin-code-worker'
if (-not (Test-Path $script:StateDir)) { New-Item -ItemType Directory -Force -Path $script:StateDir | Out-Null }
$script:LogFile = Join-Path $script:StateDir 'worker.log'

function Write-Log {
  param([string]$Message, [string]$Level = 'INFO')
  $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, $Message
  Write-Host $line
  try {
    # Keep the log from growing without bound: past ~2 MB, start over.
    if ((Test-Path $script:LogFile) -and ((Get-Item $script:LogFile).Length -gt 2MB)) {
      Move-Item -Force $script:LogFile ($script:LogFile + '.1')
    }
    Add-Content -Path $script:LogFile -Value $line -Encoding UTF8
  } catch { }
}

# ---- auth ---------------------------------------------------------------

function Get-BridgeToken {
  if ($Token) { return $Token.Trim() }
  if ($env:MARVEEN_DASHBOARD_TOKEN) { return $env:MARVEEN_DASHBOARD_TOKEN.Trim() }
  if (Test-Path $TokenPath) { return ((Get-Content -Path $TokenPath -Raw).Trim()) }
  throw "No dashboard token: pass -Token, set MARVEEN_DASHBOARD_TOKEN, or make $TokenPath readable"
}

function Invoke-Bridge {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Method = 'GET',
    $Body = $null,
    [string]$RawBody = $null
  )
  $headers = @{ Authorization = 'Bearer ' + $script:BridgeToken }
  $uri = $BaseUrl.TrimEnd('/') + $Path
  if ($RawBody -or $null -ne $Body) {
    # RawBody is for shapes ConvertTo-Json cannot be trusted with (see
    # Publish-Sessions and the one-element array trap).
    $jsonBody = if ($RawBody) { $RawBody } else { $Body | ConvertTo-Json -Depth 12 -Compress }
    # PS 5.1 sends strings as ISO-8859-1 by default, which mangles every accented
    # character on the way in. Bytes + explicit charset keeps UTF-8 intact.
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonBody)
    return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 120
  }
  return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -TimeoutSec 120
}

# ---- session discovery ---------------------------------------------------
#
# KET TAR VAN EZEN A GEPEN, NEM EGY.
#
# A Windows-oldali Claude Code a `%USERPROFILE%\.claude\`-ba ir. A WSL-ben futo
# -- a Remote-WSL ablak Claude Code-ja es minden `claude`, amit a disztron belul
# inditanak -- a sajat Linux-home-jaba, amit innen a
# `\\wsl.localhost\<disztro>\...` UNC-uton erunk el.
#
# 2026-09-12-ig csak az elso letezett, es ennek a kovetkezmenye nem elmeleti
# volt: ezen a gepen a WSL-oldali `/home/boss/marveen` 525 naplot es ket EPPEN
# FUTO beszelgetest mutatott, es semmilyen modon nem lehetett cimezni. A
# felderites nem latta (rossz mappat olvasott), a vegrehajto pedig Windows-
# `claude.exe`-t inditott volna, ami egy Linux-oldali beszelgetes-azonositot nem
# tud folytatni -- a naploja nem a `%USERPROFILE%`-ban all.
#
# A WSL-oldali munkamappat UNC ALAKBAN jelentjuk (`\\wsl.localhost\Ubuntu\home\
# boss\marveen`), nem POSIX-ban. Harom oka van, es egyik sem izles kerdese:
#   * a szerver `toLocalWorkspacePath()`-e pontosan ezt az alakot ismeri fel es
#     forditja vissza `/home/boss/marveen`-re -- a naplo utjat is beleertve --,
#     vagyis a Marveen oldalan EGYETLEN SOR SEM valtozik;
#   * az alias a legutolso szegmensbol keszul (`aliasFromWorkspacePath`, ami
#     `/`-en es `\`-en egyarant vag), tehat igy is `marveen` lesz;
#   * az UNC-ben BENNE VAN a disztro neve, ezert a vegrehajto tudja, melyik
#     WSL-t kell inditania. A POSIX utbol ez hianyozna, es egy ket-disztros
#     gepen a feladat nemaan a rossz helyen futna le.

$script:WslProbeCache = @{}
$script:WslSeenProjects = @{}
# sessionId -> a tar, amibol szarmazik. A JELENTESBE NEM MEGY BELE: a szerver
# sema-ja valtozatlan marad, a lezaras es a vegrehajtas viszont tudni fogja,
# hogy egy PID Linux-PID-e, es melyik disztroe.
$script:SessionStores = @{}

function ConvertTo-QuotedArg {
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return '""' }
  if ($Value -match '[\s"]') { return '"' + ($Value -replace '"', '\"') + '"' }
  return $Value
}

function ConvertTo-WslUncPath {
  param([string]$Distro, [string]$PosixPath)
  return ('\\wsl.localhost\' + $Distro + ($PosixPath -replace '/', '\'))
}

# Ugyanaz a minta, amit a szerver `toLocalWorkspacePath()`-e hasznal. A ket hely
# SZANDEKOSAN ugyanazt az alakot ismeri: amit mi kiadunk, azt ott vissza kell
# tudni olvasni, kulonben a napló megjelenitese nemaan uresen jonne.
function ConvertFrom-WslUncPath {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $m = [regex]::Match($Path.Trim(), '^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$')
  if (-not $m.Success) { return $null }
  $tail = $m.Groups[2].Value
  if (-not $tail) { $tail = '\' }
  return @{ distro = $m.Groups[1].Value; posix = ($tail -replace '\\', '/') }
}

# `wsl.exe` inditasa ES a kimenet BIZTOS beolvasasa.
#
# Ket buktatot kerul ki, mindkettot MERVE ezen a gepen 2026-09-12-en:
#   * A `wsl.exe -l -q` UTF-16LE-t ir. A PowerShell alapertelmezett olvasasaval
#     `U\0b\0u\0n\0t\0u\0` jon vissza, vagyis minden disztronev hasznalhatatlan
#     -- es nem hibaval, hanem NEMAAN. Ezert kap a hivo kimondott kodolast.
#   * Ket csovet szinkron olvasva a gyerek beragadhat, ha a masik megtelik;
#     ugyanaz a ReadToEndAsync-paros vedi, mint a feladat-futtatasnal.
# Az idokorlat azert kell, mert egy alvo vagy serult WSL indulasa percekig is
# elhuzodhat, es egy felderitesi kor nem allhat meg rajta.
function Invoke-WslCapture {
  param(
    [Parameter(Mandatory = $true)][string]$Arguments,
    [System.Text.Encoding]$Encoding = $null,
    [int]$TimeoutMs = 20000
  )
  if ($null -eq $Encoding) { $Encoding = [System.Text.Encoding]::UTF8 }
  $out = @{ ok = $false; stdout = ''; stderr = ''; error = $null }
  $proc = $null
  try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = $Arguments
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = $Encoding
    $psi.StandardErrorEncoding = $Encoding
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    $so = $proc.StandardOutput.ReadToEndAsync()
    $se = $proc.StandardError.ReadToEndAsync()
    if (-not $proc.WaitForExit($TimeoutMs)) {
      try { $proc.Kill() } catch { }
      $out.error = ('wsl.exe {0}: idotullepes ({1} mp)' -f $Arguments, [int]($TimeoutMs / 1000))
      return $out
    }
    try { $out.stdout = [string]$so.Result } catch { }
    try { $out.stderr = [string]$se.Result } catch { }
    if ($proc.ExitCode -eq 0) {
      $out.ok = $true
    } else {
      # A HIBA SZO SZERINT megy tovabb. Egy "nincs ilyen disztro" es egy
      # "a virtualis gep nem indul" ket kulonbozo teendo; kitalalt ok rosszabb
      # a semminel.
      $tail = $out.stderr
      if (-not $tail.Trim()) { $tail = $out.stdout }
      $out.error = ('wsl.exe {0}: exit {1} -- {2}' -f $Arguments, $proc.ExitCode, ($tail -replace '\s+', ' ').Trim())
    }
  } catch {
    $out.error = $_.Exception.Message
  } finally {
    if ($proc) { try { $proc.Dispose() } catch { } }
  }
  return $out
}

# MELYIK DISZTRO VAN A GEPEN.
#
# Ures tomb = MEGNEZTUK, es nincs mit jelenteni: nincs `wsl.exe`, tehat ezen a
# telepitesen nincs WSL. `$null` = NEM LATUNK ODA: van `wsl.exe`, de nem
# valaszolt. A ketto ket kulonbozo teendo, es nem szabad osszemosni oket -- az
# elsore a helyes valasz a csend, a masodikra egy naplosor.
function Get-WslDistros {
  if (-not (Get-Command 'wsl.exe' -ErrorAction SilentlyContinue)) { return @() }
  $r = Invoke-WslCapture -Arguments '-l -q' -Encoding ([System.Text.Encoding]::Unicode) -TimeoutMs 15000
  if (-not $r.ok) {
    Write-Log ('WSL: a disztro-lista nem olvashato -- ' + $r.error) 'WARN'
    return $null
  }
  $names = New-Object System.Collections.ArrayList
  foreach ($line in ($r.stdout -split "`n")) {
    $n = $line.Trim([char]0, ' ', "`t", "`r")
    if ($n) { [void]$names.Add($n) }
  }
  return $names.ToArray()
}

# EGY DISZTRO adatai: hol a Linux-home, hol a `claude`, es hova kell nyulni
# innen, Windows felol.
#
# EGYETLEN `wsl.exe`-hivas keri le mindkettot -- disztronkent egy
# folyamatinditas felderitesi koronkent, nem ketto. Login shell (`-lc`) kell
# hozza: a `claude` tipikusan a `~/.local/bin`-ben all, amit a profil tesz a
# PATH-ra (merve: `command -v claude` -> `/home/boss/.local/bin/claude`).
#
# A SIKERES probat eltesszuk (a home es a `claude` helye egy futas alatt nem
# valtozik), a SIKERTELENT nem -- igy egy kesobb elindulo vagy frissen telepitett
# WSL magatol bekerul a kovetkezo korben.
function Get-WslStore {
  param([Parameter(Mandatory = $true)][string]$Distro)
  if ($script:WslProbeCache.ContainsKey($Distro)) { return $script:WslProbeCache[$Distro] }

  $r = Invoke-WslCapture -TimeoutMs 60000 -Arguments (
    '-d ' + (ConvertTo-QuotedArg $Distro) + ' -e sh -lc "echo $HOME; command -v claude"')
  if (-not $r.ok) {
    Write-Log ('WSL/{0}: a disztro nem valaszolt -- {1}' -f $Distro, $r.error) 'WARN'
    return $null
  }
  $lines = @(($r.stdout -split "`n") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($lines.Count -lt 1 -or -not $lines[0].StartsWith('/')) {
    Write-Log ("WSL/{0}: a home-konyvtar nem olvashato ki (a valasz: '{1}')" -f $Distro, ($r.stdout -replace '\s+', ' ').Trim()) 'WARN'
    return $null
  }
  $linuxHome = $lines[0].TrimEnd('/')
  $claude = ''
  if ($lines.Count -ge 2 -and $lines[1].StartsWith('/')) { $claude = $lines[1] }

  $store = @{
    kind      = 'wsl'
    distro    = $Distro
    linuxHome = $linuxHome
    claude    = $claude
    projects  = (ConvertTo-WslUncPath -Distro $Distro -PosixPath ($linuxHome + '/.claude/projects'))
    sessions  = (ConvertTo-WslUncPath -Distro $Distro -PosixPath ($linuxHome + '/.claude/sessions'))
  }
  if (-not $claude) {
    # A beszelgetesei ettol meg LATSZANAK -- csak feladat nem futtathato
    # bennuk. Ezt itt mondjuk ki, a felderiteskor, nem majd az elso elbukott
    # feladatnal: addigra a hid mar harom probat elegetett volna el ra.
    Write-Log ('WSL/{0}: nincs `claude` a disztroban (sem a PATH-on, sem a ~/.local/bin-ben) -- a beszelgetesei latszani fognak, de feladat nem futtathato bennuk, amig nem telepited a Claude Code-ot a disztron belul' -f $Distro) 'WARN'
  }
  $script:WslProbeCache[$Distro] = $store
  return $store
}

# MINDEN TAR, amiben ezen a gepen Claude Code-beszelgetes lehet.
function Get-ClaudeStores {
  $stores = New-Object System.Collections.ArrayList

  $winProjects = Join-Path $env:USERPROFILE '.claude\projects'
  if (Test-Path -LiteralPath $winProjects) {
    [void]$stores.Add(@{
      kind      = 'windows'
      distro    = $null
      linuxHome = $null
      claude    = $null
      projects  = $winProjects
      sessions  = (Join-Path $env:USERPROFILE '.claude\sessions')
    })
  }

  $distros = Get-WslDistros
  if ($null -ne $distros) {
    foreach ($d in $distros) {
      $s = Get-WslStore -Distro $d
      if ($null -eq $s) { continue }
      if (Test-Path -LiteralPath $s.projects) {
        $script:WslSeenProjects[$d] = $true
        [void]$stores.Add($s)
      } elseif ($script:WslSeenProjects.ContainsKey($d)) {
        # ITT A KULONBSEG A KET NULLA KOZOTT. Ha a mappa MEG SOSEM latszott, az
        # annyit tesz, hogy abban a disztroban nem futott Claude Code -- nincs
        # mit jelenteni, es a csend a helyes valasz. Ha viszont KORABBAN MAR
        # latszott es most nem, akkor nem "nincs", hanem "nem latok oda": a
        # `\\wsl.localhost` csatorna szakadt le, es a disztro sessionjei
        # ebbol a korbol nemaan kimaradnanak.
        Write-Log ('WSL/{0}: a beszelgetes-tar ({1}) korabban meg latszott, most nem erheto el -- a disztro sessionjei kimaradnak ebbol a korbol' -f $d, $s.projects) 'WARN'
      }
    }
  }
  return $stores.ToArray()
}

# A NAPLO UTOLSO SORAI -- BAJT-FAROKBOL, nem `Get-Content -Tail`-lel.
#
# A `Get-Content -Tail N` visszafele, karakterenkent keresi a sorhatarokat, es
# az ara a farokban talalhato LEGHOSSZABB SOR hosszaval no, nem a fajl
# mereteevel. Merve 2026-09-12-en a WSL-oldali naplokon:
#
#   fajl     meret   leghosszabb sor   `-Tail 60`
#   f1e3af70  6,0 MB    217 704 kar      17,8 mp
#   e2cd5714  1,9 MB    217 721 kar      18,0 mp
#   f1df72a0  0,3 MB    176 397 kar       8,1 mp
#
# Egy 217 KB-os sor nem rendellenesseg: ennyi egy nagy eszkoz-eredmeny. A teljes
# felderites 60 masodpercebol 56,4 ment el ezen (a JSON-elemzes mindossze 0,1),
# es a kor maga 60 masodperces -- vagyis minden kor tulcsordult volna.
#
# Helyette ugyanaz az idiom, amit a farok-olvasas mar hasznal lentebb: egy
# `Seek` a vegtol, majd elorefele olvasas. 34 naplon merve BAJTRA UGYANAZT adta
# (tokens, model, lastActivity mind egyezett), 53,0 mp helyett 2,3 mp alatt.
#
# A seek utani ELSO sor csonka lehet -- azt eldobjuk. A `ReadWrite` megosztas
# kell: a Claude Code ugyanebbe a fajlba ir, mikozben olvassuk.
function Get-TranscriptTailLines {
  param([string]$Path, [int]$TailBytes = 1048576, [int]$MaxLines = 60)
  $fs = $null
  try {
    $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    $truncated = $fs.Length -gt $TailBytes
    if ($truncated) { [void]$fs.Seek(-$TailBytes, 'End') }
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    if ($truncated) { [void]$sr.ReadLine() }
    $buf = New-Object System.Collections.ArrayList
    while ($true) {
      $line = $sr.ReadLine()
      if ($null -eq $line) { break }
      [void]$buf.Add($line)
      if ($buf.Count -gt $MaxLines) { $buf.RemoveAt(0) }
    }
    return $buf.ToArray()
  } catch {
    # Nem tudtuk elolvasni. A hivo ezt ures listanak latja, es a `$null`
    # mezoivel ter vissza -- azaz "nem latunk oda", nem pedig "nincs adat".
    return @()
  } finally {
    if ($fs) { $fs.Dispose() }
  }
}

# The transcript's own `cwd` field is the authority on which folder a session
# belongs to -- the directory name is a lossy encoding (accents become dashes),
# so `d--T-zsde-...` and `d--Tozsde-...` can both exist for the same drive.
#
# The TITLE is read in the same pass, because a session id tells the owner
# nothing: picking between `3cfe9212` and `877ffe44` is not a choice a human
# can make. The transcript carries `{"type":"ai-title","aiTitle":"..."}` -- the
# very caption VS Code prints on the tab -- and the first user message is the
# fallback for a conversation too young to have been titled yet.
function Read-TranscriptInfo {
  param([string]$Path, [int]$MaxLines = 200)
  $info = @{ cwd = $null; title = $null }
  $reader = $null
  try {
    $reader = New-Object System.IO.StreamReader($Path, [System.Text.Encoding]::UTF8)
    $firstUser = $null
    for ($i = 0; $i -lt $MaxLines; $i++) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }
      if ($line.Length -lt 2) { continue }

      if (-not $info.cwd -and $line -match '"cwd"') {
        try {
          $obj = $line | ConvertFrom-Json
          if ($obj.cwd) { $info.cwd = [string]$obj.cwd }
        } catch { }
      }
      # A LEGUTOLSO cim nyer, nem az elso. Boss, 2026-08-23: "mellesleg a neve
      # sem egyezik! mert nezd meg a marvinban az van hogy ... a vscode ugynok
      # kartya tesztelese. es a vscode ban pedig csak vscode ugynok tesztelese."
      # Merve ugyanabban a transcriptben: a 12. sor "VS Code ugynok kartya
      # tesztelese", a 13. sortol vegig "VS Code ugynok tesztelese" -- a
      # beszelgetes ATNEVEZODOTT, es a regi kod az ELSO cimnel megallt.
      if ($line -match '"ai-title"') {
        try {
          $obj = $line | ConvertFrom-Json
          if ($obj.aiTitle) { $info.title = [string]$obj.aiTitle }
        } catch { }
      }
      if (-not $firstUser -and $line -match '"type":"user"') {
        try {
          $obj = $line | ConvertFrom-Json
          $content = $obj.message.content
          # The content is an array of typed blocks in the normal case and a
          # bare string in the oldest transcripts -- handle both.
          if ($content -is [array]) {
            $content = ($content | Where-Object { $_.type -eq 'text' } | Select-Object -First 1).text
          }
          if ($content -and ($content -is [string])) {
            $firstUser = ($content -replace '\s+', ' ').Trim()
          }
        } catch { }
      }
      # A cwd az elso sorokban megvan, a cim viszont KESOBB is valtozhat, ezert
      # itt mar nem lepunk ki -- a $MaxLines sor vegigolvasasa a hatar. Az
      # atnevezes tipikusan a beszelgetes elejen tortenik (a Claude Code az
      # elso valaszok utan cimez), a kesobbi atnevezest a farok-olvasas fogja.
      if ($info.cwd -and $info.title -and $i -ge 60) { break }
    }
    if (-not $info.title -and $firstUser) {
      $info.title = if ($firstUser.Length -gt 80) { $firstUser.Substring(0, 80).TrimEnd() + '...' } else { $firstUser }
    }
  } catch {
    return $info
  } finally {
    if ($reader) { $reader.Dispose() }
  }
  # A beszelgetes a KESOBBIEKBEN is atnevezodhet, azt pedig az elso par szaz sor
  # nem arulja el. A fajl VEGET olvassuk meg hozza -- egy 15 MB-os transcriptbol
  # az utolso 256 KB-ot, nem az egeszet: percenkent, minden fulre az egesz fajl
  # vegigolvasasa mar merheto terheles lenne.
  try {
    $fs = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
      $tailBytes = 262144
      if ($fs.Length -gt $tailBytes) { [void]$fs.Seek(-$tailBytes, 'End') }
      $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      # Az elso sor a seek utan csonka lehet -- eldobjuk.
      if ($fs.Length -gt $tailBytes) { [void]$sr.ReadLine() }
      while ($null -ne ($line = $sr.ReadLine())) {
        if ($line -match '"ai-title"') {
          try {
            $obj = $line | ConvertFrom-Json
            if ($obj.aiTitle) { $info.title = [string]$obj.aiTitle }
          } catch { }
        }
      }
    } finally { $fs.Dispose() }
  } catch { }
  return $info
}

# How much context this conversation is using RIGHT NOW, in tokens.
#
# Boss, 2026-08-23: "meg kiiratni hogy jelenleg mennyi a token amit hasznlal.
# kontextus." The number is not something we estimate: every assistant line in
# the transcript carries the API's own `usage`, and the context size is
# `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` on the
# LAST one -- the same arithmetic Claude Code puts in its own status line.
#
# Read from the END: the first 200 lines say what the conversation was at
# birth, not what it is now. `Get-Content -Tail` seeks backwards, so this stays
# cheap on a 7 MB transcript.
#
# Returns $null, never 0, when there is nothing to measure (no assistant reply
# yet, unreadable file, older format). A live conversation never has 0 tokens,
# so 0 would be a lie the dashboard could not tell apart from a real reading.
# Ugyanaz a sor a MODELLT is elarulja (`message.model`, pl. `claude-opus-5`),
# ezert egy olvasasbol adjuk vissza mindkettot. Boss, 2026-08-23: "alul a
# beallitasok felett latom hogy claude code, de oda nem azt kellene tenni hogy
# a claude code on belul milyen modelt hasznlalunk?" -- de igen, es nem kell
# talalgatni: a beszelgetes sajat naploja megmondja.
#
# Mindket mezo $null lehet: az azt jelenti, hogy NEM LATUNK ODA.
function Read-TranscriptUsage {
  param([string]$Path, [int]$TailLines = 60)
  # A `lastActivity` a naplo SAJAT utolso idobelyege -- NEM a fajl mtime-ja.
  #
  # Boss, 2026-08-30: "nem a friss chatet latom a marveenban." Merve ugyanekkor
  # a Fejlesztes mappajaban: OT naplo mtime-ja ezredmasodpercre azonos volt
  # (1788044767588 es ...600), mikozben a tenyleges utolso uzenetuk 08-28
  # 11:00-tol 08-29 19:48-ig szort. Valami tomegesen hozzajuk nyult, es ettol a
  # "melyik a frissebb" sorrend ezen a csoporton belul veletlenszeru lett.
  #
  # A fajl mtime-ja azt meri, mikor NYULTAK a fajlhoz; a naplo utolso
  # idobelyege azt, mikor DOLGOZTAK vele. A feluleten a masodik a kerdes.
  # `$null` = nem talaltunk idobelyeget = NEM LATUNK ODA; a szerver ilyenkor
  # esik vissza az mtime-ra, es ezt kulon agon kezeli.
  $out = @{ tokens = $null; model = $null; lastActivity = $null }
  # Bajt-farokbol, nem `Get-Content -Tail`-lel -- az indoklas es a meres a
  # `Get-TranscriptTailLines` folott all.
  $lines = @(Get-TranscriptTailLines -Path $Path -MaxLines $TailLines)
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = $lines[$i]
    if (-not $line) { continue }

    if ($null -eq $out.lastActivity -and $line -match '"timestamp"\s*:\s*"([^"]{10,40})"') {
      try {
        $ts = [DateTimeOffset]::Parse($Matches[1], [System.Globalization.CultureInfo]::InvariantCulture,
          [System.Globalization.DateTimeStyles]::RoundtripKind)
        $out.lastActivity = [int64]$ts.ToUnixTimeMilliseconds()
      } catch { }
    }

    if ($line -notmatch '"usage"') { continue }
    try {
      $obj = $line | ConvertFrom-Json
      $u = $obj.message.usage
      if (-not $u) { $u = $obj.usage }
      if (-not $u) { continue }
      $sum = 0
      foreach ($k in 'input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens') {
        $v = $u.$k
        if ($v -is [int] -or $v -is [long] -or $v -is [double]) { $sum += [int]$v }
      }
      if ($sum -gt 0) {
        $out.tokens = $sum
        if ($obj.message.model) { $out.model = [string]$obj.message.model }
        elseif ($obj.model) { $out.model = [string]$obj.model }
        # Nem lepunk ki azonnal: az idobelyeg meg hianyozhat, es ugyanezt a
        # tombot jarnank be ujra erte.
        if ($null -ne $out.lastActivity) { return $out }
      }
    } catch { }
  }
  return $out
}

# MELYIK BESZELGETES VAN TENYLEG NYITVA a VS Code-ban.
#
# Boss, 2026-08-23: "a vscode kartyan latok vagy 5 chat fulet. a vscode ban meg
# 2 van. (...) amit a vscode ban kitorolnek azt a maveen kartyaja se mutassa!"
#
# A transcript-fajlbol ez NEM derul ki: a bezart (es a feluleten torolt) ful
# `.jsonl`-je ott marad a lemezen (merve 2026-08-23: 20 fajl a Fejlesztes
# mappajaban, kozben 2 nyitott ful). A nyitott peldanyokat viszont a Claude Code
# maga nyilvantartja: `~/.claude/sessions/<pid>.json`, benne `sessionId`, `cwd`
# es `pid`.
#
# Ezek a fajlok TULELIK az osszeomlast, ezert a PID eleteben is meg kell
# gyozodni -- kulonben egy halott peldany orokre "nyitott fulnek" latszana.
# Ha a mappa nem letezik/nem olvashato, `$null` a valasz: olyankor NEM TUDJUK,
# mi van nyitva, es ezt a szerver mashogy kezeli, mint a "semmi nincs nyitva".
# MELYIK LINUX PID EL, es melyik alatt fut tenyleg Claude Code.
#
# EGY hivas az egesz disztrora, nem PID-enkent egy: ezen a gepen 188 fajl all a
# WSL-oldali `sessions` mappaban, azokat egyesevel megkerdezni 188
# folyamatinditas lenne percenkent.
#
# `$null` = nem tudtuk megnezni. Ez itt KULONOSEN fontos: ha ilyenkor "nem fut
# semmi"-t mondananank, a WSL-oldali beszelgetesek mind holtnak latszananak, es
# a felderites az eppen hasznalt fult sem talalna meg.
function Get-WslRunningPids {
  param([Parameter(Mandatory = $true)][string]$Distro)
  $r = Invoke-WslCapture -Arguments ('-d ' + (ConvertTo-QuotedArg $Distro) + ' -e ps -eo pid=,comm=') -TimeoutMs 20000
  if (-not $r.ok) {
    Write-Log ('WSL/{0}: a folyamatlista nem olvashato -- {1}' -f $Distro, $r.error) 'WARN'
    return $null
  }
  $procs = @{}
  foreach ($line in ($r.stdout -split "`n")) {
    $m = [regex]::Match($line.Trim(), '^(\d+)\s+(.+)$')
    if (-not $m.Success) { continue }
    $procs[[int]$m.Groups[1].Value] = $m.Groups[2].Value.Trim()
  }
  return $procs
}

function Get-OpenSessionIds {
  param([Parameter(Mandatory = $true)]$Store)
  $dir = $Store.sessions
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  $open = @{}
  $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { return $open }

  # A WSL-agon a fajlban allo PID egy LINUX PID. A Windows `Get-Process`-e errol
  # semmit nem tud -- es ami sokkal rosszabb: ugyanaz a szam letezhet itt is,
  # egy TELJESEN MAS, artatlan folyamatkent. (Merve: a WSL-oldali
  # session-fajlok kozott van olyan PID, ami a disztroban `snapd`.) Ezert a
  # WSL-agon sosem a Windows folyamatlistat kerdezzuk.
  $wslProcs = $null
  if ($Store.kind -eq 'wsl') {
    $wslProcs = Get-WslRunningPids -Distro $Store.distro
    if ($null -eq $wslProcs) { return $null }
  }

  foreach ($f in $files) {
    try {
      $o = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    } catch { continue }
    if (-not $o.sessionId -or -not $o.pid) { continue }
    # A PID ujrahasznosulhat, ezert a folyamat nevet is nezzuk: a Claude Code
    # node.exe vagy claude.exe alatt fut. Ennel tobbet ez a fajl nem arul el.
    # A WSL-oldalon ugyanez a ket nev all a `comm`-ban (merve 2026-09-12: 11
    # elo beszelgetes, mind `claude`).
    if ($Store.kind -eq 'wsl') {
      if (-not $wslProcs.ContainsKey([int]$o.pid)) { continue }
      if ($wslProcs[[int]$o.pid] -notmatch '^(node|claude)$') { continue }
    } else {
      $p = Get-Process -Id ([int]$o.pid) -ErrorAction SilentlyContinue
      if (-not $p) { continue }
      if ($p.ProcessName -notmatch '^(node|claude)$') { continue }
    }
    # A PID-et is megjegyezzuk, nem csak azt, hogy nyitva van: enelkul a
    # feluletrol nem lehetne bezarni egy olyan beszelgetest, aminek a fulet a
    # VS Code-ban mar nem talalod (Boss, 2026-08-23).
    $open[[string]$o.sessionId] = [int]$o.pid
  }
  return $open
}

# ============================================================================
# NE OLVASD UJRA A VS CODE `state.vscdb`-JET. EZ AZ UT ZSAKUTCA.
#
# 2026-08-30-ig itt allt egy ~170 soros blokk, ami a
#   %APPDATA%\<VS Code>\User\workspaceStorage\<hash>\state.vscdb
#   -> ItemTable['agentSessions.model.cache']
# kulcsot olvasta winsqlite3-mal, es abbol adta a `vscodeOpen` mezot. A szerver
# ezt tekintette DONTONEK ("A VS CODE LISTAJA A DONTO", 2026-08-29).
#
# EZ A KULCS NEM ERRE VALO. Az Anthropic sajat hibajegye, claude-code#74894:
#   "agentSessions.model.cache in state.vscdb: Contains entries exclusively
#    from a different provider (openai-codex), with no Claude Code entries.
#    This is NOT a reliable source."
#   "the actual session index appears to live in extension-host memory and does
#    not get correctly rebuilt/rehydrated on reopen"
# A `memento/webviewView.claudeVSCodeSessionsList` kulcs sem session-lista,
# csak UI-allapot (ossze van-e csukva a panel).
#
# MERVE ITT, 2026-08-30 12:02-kor: a kulcs pontosan ket azonositot tartalmazott
# (be83a34f, 635961c4), mindketto utoljara 08-29-en dolgozott, es a KET EPPEN
# FUTO beszelgetes (pid 8664 es 16548) egyiket sem tartalmazta. A kartya ezert
# mutatott elavult sort, es ezert hianyzott rola az, amiben a tulajdonos eppen
# irt. Ugyanez a hiba jott vissza 12 koron at, valtakozva "tul keves" es "tul
# sok" alakban -- mert a forras volt rossz, nem a szuro.
#
# AMIT A FELHASZNALO LAT A PANELEN, AZT KIVULROL NEM LEHET MEGMERNI. Ezert a
# worker mostantol csak azt jelenti, ami TENYLEG merheto:
#   * `live` + `pid`      -- fut-e a folyamat (Get-OpenSessionIds);
#   * `lastActivity`      -- mikor dolgoztak vele utoljara (a naplo idobelyege).
# A "nyitott ful" fogalma szandekosan nincs tobbe. Ha valaki megis vissza
# akarja hozni: a tamogatott ut a Claude Code SessionStart/SessionEnd hookja
# (push, hivatalos), NEM a VS Code belso allapotfajlja.
# ============================================================================

# Not every transcript belongs to a project. A `claude` started in the home
# root, in C:\Windows\system32 (the default cwd of a shortcut) or in a temp
# folder leaves one behind just the same, and publishing those puts junk
# aliases like `lszl` or `system32` into /projects -- dispatchable, meaningless,
# and impossible to get rid of, because the next discovery pass re-adds them.
# A workspace that no longer exists is dropped for a harder reason: claude.exe
# cannot start there, so every task addressed to it would burn all 3 attempts
# before failing.
function Test-DispatchableWorkspace {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }

  $full = ''
  try { $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\') } catch { return $false }

  # Exact-match roots: a project may live UNDER the home dir, but the home dir
  # itself is not a project.
  foreach ($root in @($env:USERPROFILE, $env:WINDIR, $env:SystemDrive)) {
    if ($root) {
      $r = ''
      try { $r = [System.IO.Path]::GetFullPath($root).TrimEnd('\') } catch { continue }
      if ($r -and ($full -ieq $r)) { return $false }
    }
  }

  # Skip the temp/Windows trees AND their own roots. The root check is not
  # theoretical: a headless `claude -p` started from %TEMP% itself lands its
  # cwd exactly ON the temp root, and a subtree-only test ("starts with
  # <temp>\") answers False for it -- which is how a bogus `temp` project
  # reached /projects on 2026-08-23. Measured, not guessed.
  $subtrees = @($env:WINDIR, $env:TEMP, $env:TMP, [System.IO.Path]::GetTempPath())
  foreach ($t in $subtrees) {
    if (-not $t) { continue }
    $tf = ''
    try { $tf = [System.IO.Path]::GetFullPath($t).TrimEnd('\') } catch { continue }
    if (-not $tf) { continue }
    if ($full -ieq $tf) { return $false }
    if ($full.StartsWith(($tf + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
}

# UGYANAZ A KERDES A WSL-OLDALON: melyik `cwd`-bol lesz projekt.
#
# Amit kizarunk, es miert -- mind MERVE 2026-09-12-en, ezen a gep WSL-tarjanak
# mind a 18 munkamappajan:
#   * `/` es maga a Linux-home -- ugyanaz az elv, mint a Windows-agon: projekt
#     lehet ALATTA, de o maga nem az;
#   * `/proc`, `/sys`, `/dev`, `/run` -- nem is valodi konyvtarak;
#   * `/tmp`, `/var/tmp` -- eldobhato munkamappak. Itt egy
#     `/tmp/marveen-193/boots-...` all, ami percekig elt;
#   * barmely REJTETT szegmens (itt: `/home/boss/.lackor2-bot-worker`) --
#     futtato-kornyezetek, nem projektek. A Unixban a pont pontosan ezt jelenti.
#
#   * `/mnt/<betu>/...` es a tobbi DrvFs-ut -- EZ A LEGFONTOSABB, es nem
#     kenyelmi kerdes. A `/mnt/f/Marveen/.../Fejlesztes` es az
#     `F:\Marveen\...\Fejlesztes` UGYANAZ A MAPPA, ket helyesirassal; a
#     Windows-ag mar jelenti. Ha innen is felmenne, a ket sorbol UGYANAZ az
#     alias lenne (`aliasFromWorkspacePath` a legutolso szegmenst veszi), a tar
#     pedig a masodikat SZO NELKUL eldobja:
#       registerCodeSession(): if (existing.workspacePath.toLowerCase()
#                                  !== input.workspacePath.toLowerCase()) return existing
#     Vagyis nem hibat kapnank, hanem egy nemaan figyelmen kivul hagyott
#     projektet -- pont az a fajta csend, ami ellen az egesz hid epult. Es a
#     veszteseg sem volna szimmetrikus: a Windows-agon a feladat LEFUT, a
#     WSL-agon ugyanaz a mappa csak egy nem valaszolo sor lenne.
function Test-DispatchableWslPath {
  param([string]$PosixPath, [string]$LinuxHome)
  if ([string]::IsNullOrWhiteSpace($PosixPath)) { return $false }
  if (-not $PosixPath.StartsWith('/')) { return $false }

  $full = $PosixPath.TrimEnd('/')
  if ($full -eq '') { return $false }
  if ($LinuxHome -and ($full -eq $LinuxHome.TrimEnd('/'))) { return $false }

  $segments = @($full.Split('/') | Where-Object { $_ -ne '' })
  if ($segments.Count -eq 0) { return $false }
  foreach ($seg in $segments) { if ($seg.StartsWith('.')) { return $false } }

  $first = $segments[0]
  if (@('proc', 'sys', 'dev', 'run', 'tmp', 'mnt', 'lost+found') -contains $first) { return $false }
  if ($first -eq 'var' -and $segments.Count -ge 2 -and $segments[1] -eq 'tmp') { return $false }
  # A WSL alapbol `/mnt/c`-t hasznal, de az `automount.root` atallithato
  # (`/c`, `/drives/c`, ...). Az egybetus elso szegmens ezert szinten
  # meghajto-gyanus -- es minden ilyen utat a Windows-ag mar jelent.
  if ($first.Length -eq 1) { return $false }
  if ($first -eq 'drives' -and $segments.Count -ge 2) { return $false }
  return $true
}

# One VS Code window can hold several Claude Code chat tabs, and each tab is a
# SEPARATE transcript in the same project folder. Reporting only the newest one
# (what this did until 2026-08-23) meant the owner could not even SEE the other
# conversations, let alone address one -- and "I see one tab" silently looked
# identical to "there is one tab".
#
# So: the newest usable transcript is still the PRIMARY one (it alone is
# registered as the project's session, so nothing about existing dispatch
# changes), and the rest ride along as addressable tabs.
$script:MaxTabsPerWorkspace = 10
$script:TabMaxAgeDays = 21

function Get-StoreSessions {
  param([Parameter(Mandatory = $true)]$Store)
  # EGYETLEN nyitottsag-meres marad: fut-e a folyamat. Amit a felhasznalo a
  # panelen lat, azt kivulrol nem lehet megmerni -- lasd a `state.vscdb`
  # sirkovet fentebb. `$null` = nem tudtuk megnezni (nincs sessions mappa).
  $open = Get-OpenSessionIds -Store $Store
  $out = New-Object System.Collections.ArrayList
  $cutoff = (Get-Date).ToUniversalTime().AddDays(-$script:TabMaxAgeDays)
  foreach ($dir in (Get-ChildItem -LiteralPath $Store.projects -Directory -ErrorAction SilentlyContinue)) {
    # A transcript under ~2 KB is an aborted/empty session -- registering it as
    # "the project's session" would throw away the real conversation history.
    $files = @(Get-ChildItem -LiteralPath $dir.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -ge 2KB } |
      Sort-Object LastWriteTimeUtc -Descending)
    if ($files.Count -eq 0) { continue }

    # A projekt ELSODLEGES sessionje az legyen, amelyik tenyleg dolgozik: egy
    # tegnap befejezett beszelgetes lehet a legfrissebb FAJL, de a feladat nem
    # oda valo. Ket csoport, ebben a sorrendben:
    #   1. FUT a folyamata -- ide mehet feladat azonnal;
    #   2. minden mas.
    #
    # A csoportokon BELUL a fajl mtime-ja rendez. Ez szandekosan csak
    # eloszures: a mtime tomegesen atirodhat (lasd `Read-TranscriptUsage`),
    # ezert a MEGJELENITES sorrendjet nem ez adja, hanem a szerver a
    # `lastActivity` alapjan. Itt a mtime csak azt donti el, melyik 10 fajlt
    # nezzuk meg egyaltalan -- egy nagyvonalu meritest, nem a vegso sorrendet.
    if ($null -ne $open) {
      $g1 = @($files | Where-Object { $open.ContainsKey([System.IO.Path]::GetFileNameWithoutExtension($_.Name)) })
      $g2 = @($files | Where-Object { -not $open.ContainsKey([System.IO.Path]::GetFileNameWithoutExtension($_.Name)) })
      if ($g1.Count -gt 0) { $files = @($g1) + @($g2) }
    }

    $isPrimary = $true
    $kept = 0
    foreach ($f in $files) {
      # Age cap applies to the EXTRA tabs only: the primary session stays
      # reportable however old it is, or a project untouched for a month would
      # drop out of /projects and every task addressed to it would fail.
      # A DARAB- ES KORHATAR A FUTO BESZELGETESEKRE NEM VONATKOZIK.
      #
      # Enelkul egy honapja elindult, de MA IS FUTO beszelgetes kiesne a jelentesbol, es
      # a kartyan pont az hianyozna, amit a felhasznalo eppen nez -- ugyanaz a
      # hiba masik okbol. A korlatok celja a lemezen felgyult REGI naplok
      # levagasa volt, nem az elo munkae.
      $sidName = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
      $isRunning = ($null -ne $open) -and $open.ContainsKey($sidName)
      if (-not $isPrimary -and -not $isRunning) {
        if ($kept -ge $script:MaxTabsPerWorkspace) { break }
        if ($f.LastWriteTimeUtc -lt $cutoff) { break }
      }
      $info = Read-TranscriptInfo -Path $f.FullName
      if (-not $info.cwd) { continue }
      # A MUNKAMAPPA ALAKJA A TARTOL FUGG, es a ket agat sosem szabad
      # osszekeverni. Egy POSIX utat (`/home/boss/marveen`) a Windows
      # `Test-Path`-e az AKTUALIS MEGHAJTO gyokerehez merne (`C:\home\boss\...`)
      # -- egy veletlenul letezo `C:\home` mellett hamis igent adna, es a
      # feladat egy nem letezo helyre indulna.
      if ($Store.kind -eq 'wsl') {
        if (-not (Test-DispatchableWslPath -PosixPath $info.cwd -LinuxHome $Store.linuxHome)) { continue }
        $workspacePath = ConvertTo-WslUncPath -Distro $Store.distro -PosixPath $info.cwd
        # A letezest is UGYANAZON az UNC-uton nezzuk meg, amit a szerver is
        # hasznalni fog. Ha ide nem latunk be, a feladat sem tudna elindulni.
        if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { continue }
      } else {
        if (-not (Test-DispatchableWorkspace -Path $info.cwd)) { continue }
        $workspacePath = $info.cwd
      }
      $sid = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
      # $null = nem tudtuk megnezni (nincs sessions mappa). A `$false` ezzel
      # szemben MERES: a beszelgetes folyamata NEM fut.
      $live = $null
      $sidPid = $null
      if ($null -ne $open) {
        $live = [bool]$open.ContainsKey($sid)
        if ($live) { $sidPid = [int]$open[$sid] }
      }
      $usage = Read-TranscriptUsage -Path $f.FullName
      # MELYIK TARBOL JON. A jelentesbe NEM megy bele (a szerver semaja
      # valtozatlan), de a lezarasnak es a vegrehajtasnak tudnia kell: egy
      # Linux-PID-et a Windows nem ertelmezhet, es egy WSL-beszelgetest nem a
      # `claude.exe` folytat.
      $script:SessionStores[$sid] = $Store
      [void]$out.Add(@{
        workspacePath = $workspacePath
        sessionId     = $sid
        live          = $live
        # A naplo SAJAT utolso idobelyege. `$null` = nem talaltunk ilyet (vagy
        # regi worker jelent) -- ilyenkor a szerver a mtime-ra esik vissza, es
        # NEM tesz ugy, mintha tudna a valodi idot.
        lastActivity  = $usage.lastActivity
        mtime         = [int64]([DateTimeOffset]$f.LastWriteTimeUtc).ToUnixTimeMilliseconds()
        title         = $info.title
        primary       = $isPrimary
        contextTokens = $usage.tokens
        model         = $usage.model
        pid           = $sidPid
        # A NAPLO TELJES UTJA. Enelkul a vezerlopult nem tudna megmutatni a
        # beszelgetes TARTALMAT: Marveen a WSL-ben fut, a `.jsonl` a Windowson
        # van, es a projekt-mappa neve egy slug, amit kitalalni tippeles volna
        # (Boss, 2026-08-28: "miert csk mondja hogy megvan de nem mutatja
        # meg?"). Amit a gep MAR TUD, azt ne kelljen kikovetkeztetni.
        transcriptPath = $f.FullName
      })
      $kept++
      $isPrimary = $false
    }
  }
  return $out.ToArray()
}

# MINDEN TAR beszelgetesei, egy listaban.
#
# A `$script:SessionStores` itt -- es csak itt -- keszul ujra: minden felderitesi
# kor a SAJAT merese alapjan mondja meg, melyik beszelgetes melyik tarban lakik.
# Egy megorzott, elavult bejegyzes pont azt a hibat adna vissza, ami ellen ez a
# terkep vedeni akar: egy Linux-PID-re kiadott Windows-`Stop-Process`-t.
function Get-LocalSessions {
  $out = New-Object System.Collections.ArrayList
  $script:SessionStores = @{}
  foreach ($store in (Get-ClaudeStores)) {
    foreach ($s in (Get-StoreSessions -Store $store)) { [void]$out.Add($s) }
  }
  return $out.ToArray()
}

function Publish-Sessions {
  $sessions = @(Get-LocalSessions)
  if (-not $sessions -or $sessions.Count -eq 0) {
    # Report the EMPTY list instead of staying silent. A worker that runs but
    # finds nothing is a completely different diagnosis from a worker that is
    # gone -- and returning here left the server's presence row holding the
    # session count of the last successful pass (COALESCE keeps it), so the
    # page would still claim "3 projects" while the executor found none.
    Write-Log 'no local Claude Code sessions found -- reporting empty list' 'WARN'
    $emptyBody = '{"host":' + ($script:HostId | ConvertTo-Json -Compress) + ',"workerVersion":' + ($script:WorkerVersion | ConvertTo-Json -Compress) + ',"sessions":[]}'
    try {
      Invoke-Bridge -Path '/api/code/sessions' -Method 'POST' -RawBody $emptyBody | Out-Null
    } catch {
      Write-Log ('empty session report failed: ' + $_.Exception.Message) 'WARN'
    }
    return
  }
  # ConvertTo-Json in PS 5.1 FLATTENS a one-element array into a bare object, so
  # a machine with exactly one project used to post `"sessions": {...}` and the
  # API answered 400. Building that one line by hand keeps it an array whatever
  # the count is. (The server tolerates both now, but the client should not be
  # the one relying on that.)
  $sessionsJson = '[' + (($sessions | ForEach-Object { $_ | ConvertTo-Json -Depth 6 -Compress }) -join ',') + ']'
  $body = '{"host":' + ($script:HostId | ConvertTo-Json -Compress) + ',"workerVersion":' + ($script:WorkerVersion | ConvertTo-Json -Compress) + ',"sessions":' + $sessionsJson + '}'
  $resp = Invoke-Bridge -Path '/api/code/sessions' -Method 'POST' -RawBody $body
  Write-Log ('sessions reported: ' + ($resp.registered -join ', '))
  Close-RequestedSessions -Requested $resp.closeSessions -Sessions $sessions
  Invoke-BrowseRequests -Requested $resp.browseRequests
}

# EGY BESZELGETES BEZARASA a vezerlopultrol.
#
# Boss, 2026-08-23: "a vscode ban nem tudom bezarni. mert nem latok ott semmit.
# tehat bezarni sem tudok semmit mar. valamiert az a rendszerben maradt."
#
# A szerver nem tud minket hivni (nincs nyitott portunk), ezert a kerest a
# jelentes VALASZA hozza. Amit leallitunk, azt a PID alapjan azonositjuk, es
# elotte MEGGYOZODUNK rola, hogy tenyleg az a beszelgetes fut alatta -- a PID
# ujrahasznosul, es egy tevedesbol kilott idegen folyamat sokkal rosszabb, mint
# egy vegre nem hajtott kattintas.
# MAPPA-TALLOZAS A VEZERLOPULT SZAMARA.
#
# Boss, 2026-09-12: "a gyokermappat kivalasztani kitallozva lehessen."
#
# A Marveen a WSL-ben fut, es ezen a gepen a `/mnt/c` bejarasa EIO-val all le --
# a szerver tehat NEM tudja maga felsorolni a Windows-mappakat. Mi itt futunk,
# ahol a mappak vannak, ezert a felsorolas a mi dolgunk. A kerest a jelentes
# valasza hozza (nincs nyitott portunk), az eredmenyt kulon POST viszi vissza.
#
# CSAK MAPPAKAT adunk vissza: munkamappat valasztunk, nem fajlt.
#
# A HIBAT SZO SZERINT kuldjuk el. Egy "nincs jogosultsag" es egy "nincs ilyen
# mappa" ket kulonbozo teendo; kitalalt ok rosszabb a semminel.
function Invoke-BrowseRequests {
  param($Requested)
  if (-not $Requested) { return }
  foreach ($r in @($Requested)) {
    if (-not $r -or -not $r.id) { continue }
    $reqPath = ''
    if ($r.path) { $reqPath = [string]$r.path }
    $entries = New-Object System.Collections.ArrayList
    $ok = $false
    $errText = $null
    $parent = $null
    try {
      if ([string]::IsNullOrWhiteSpace($reqPath)) {
        # KIINDULOPONT: a gep meghajtoi. Ezt sem gepelheti be senki, es a
        # `Get-PSDrive` csak a valoban letezoket adja vissza.
        foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction Stop)) {
          $root = [string]$d.Root
          if ([string]::IsNullOrWhiteSpace($root)) { continue }
          [void]$entries.Add(@{ name = $root; path = $root; isRepo = $false })
        }
        $ok = $true
      } else {
        if (-not (Test-Path -LiteralPath $reqPath -PathType Container)) {
          throw ('Nincs ilyen mappa a vegrehajto gepen / No such folder on the executor machine: ' + $reqPath)
        }
        $parentItem = (Get-Item -LiteralPath $reqPath -ErrorAction Stop).Parent
        if ($parentItem) { $parent = [string]$parentItem.FullName }
        foreach ($d in (Get-ChildItem -LiteralPath $reqPath -Directory -Force -ErrorAction Stop)) {
          # A rejtett/rendszer-mappak csak zajt adnanak a valasztashoz -- a
          # `.git` maga nem munkamappa. A `.`-tal kezdodoeket ezert kihagyjuk,
          # de a `.git` LETET jelezzuk: ebbol latszik, melyik a projekt gyokere.
          if ($d.Name.StartsWith('.')) { continue }
          $isRepo = $false
          try { $isRepo = Test-Path -LiteralPath (Join-Path $d.FullName '.git') } catch { $isRepo = $false }
          [void]$entries.Add(@{ name = $d.Name; path = $d.FullName; isRepo = $isRepo })
        }
        $ok = $true
      }
    } catch {
      $ok = $false
      $errText = $_.Exception.Message
    }
    # A PS 5.1 EGY elemu tombot csupasz objektumma lapit -- a szerver ilyenkor
    # nem listat kapna. Ezert a tombot kezzel epitjuk fel, barhany elemmel.
    $entriesJson = '[' + ((@($entries) | ForEach-Object { $_ | ConvertTo-Json -Depth 4 -Compress }) -join ',') + ']'
    $body = '{"ok":' + $(if ($ok) { 'true' } else { 'false' }) +
      ',"entries":' + $entriesJson +
      ',"parent":' + $(if ($parent) { ($parent | ConvertTo-Json -Compress) } else { 'null' }) +
      ',"error":' + $(if ($errText) { ($errText | ConvertTo-Json -Compress) } else { 'null' }) + '}'
    try {
      Invoke-Bridge -Path ('/api/code/browse-result/' + $r.id) -Method 'POST' -RawBody $body | Out-Null
      Write-Log ('browse answered: ' + $reqPath + ' (ok=' + $ok + ', n=' + $entries.Count + ')')
    } catch {
      Write-Log ('browse result POST failed: ' + $_.Exception.Message) 'WARN'
    }
  }
}

function Close-RequestedSessions {
  param($Requested, $Sessions)
  if (-not $Requested) { return }
  foreach ($sid in @($Requested)) {
    $sid = [string]$sid
    if (-not $sid) { continue }
    $row = @($Sessions | Where-Object { $_.sessionId -eq $sid }) | Select-Object -First 1
    if (-not $row -or -not $row.pid) {
      Write-Log ('close requested for ' + $sid + ' but no live pid is known') 'WARN'
      continue
    }
    # MELYIK GEPEN ERTELMES EGYALTALAN EZ A SZAM.
    #
    # Egy WSL-beszelgetes PID-je LINUX-PID. Ugyanaz a szam a Windowson is
    # letezhet, egy teljesen artatlan folyamatkent -- es a `Stop-Process` azt
    # loné ki. Ha tehat nem tudjuk biztosan, melyik tarbol valo a beszelgetes,
    # NEM TIPPELUNK: egy vegre nem hajtott kattintas sokkal olcsobb, mint egy
    # tevedesbol megolt idegen folyamat.
    $store = $null
    if ($script:SessionStores.ContainsKey($sid)) { $store = $script:SessionStores[$sid] }
    if ($null -eq $store) {
      Write-Log ('close requested for ' + $sid + ' but its store is unknown -- refusing (a PID ertelmezese tar nelkul talalgatas volna)') 'WARN'
      continue
    }
    if ($store.kind -eq 'wsl') {
      $wslProcs = Get-WslRunningPids -Distro $store.distro
      if ($null -eq $wslProcs) {
        Write-Log ('close requested for ' + $sid + ': a(z) ' + $store.distro + ' folyamatlistaja nem olvashato, ezert nem zarok be semmit') 'WARN'
        continue
      }
      if (-not $wslProcs.ContainsKey([int]$row.pid)) {
        Write-Log ('close requested for ' + $sid + ': a ' + $row.pid + ' linux-folyamat mar nem fut')
        continue
      }
      $comm = $wslProcs[[int]$row.pid]
      if ($comm -notmatch '^(node|claude)$') {
        Write-Log ('close requested for ' + $sid + ' but ' + $store.distro + ' pid ' + $row.pid + ' is ' + $comm + ' -- refusing') 'WARN'
        continue
      }
      $r = Invoke-WslCapture -Arguments ('-d ' + (ConvertTo-QuotedArg $store.distro) + ' -e kill ' + [int]$row.pid) -TimeoutMs 15000
      if ($r.ok) {
        Write-Log ('closed session ' + $sid + ' (' + $store.distro + ' pid ' + $row.pid + ')')
      } else {
        Write-Log ('closing ' + $sid + ' failed: ' + $r.error) 'WARN'
      }
      continue
    }

    $p = Get-Process -Id ([int]$row.pid) -ErrorAction SilentlyContinue
    if (-not $p) {
      Write-Log ('close requested for ' + $sid + ': process ' + $row.pid + ' already gone')
      continue
    }
    if ($p.ProcessName -notmatch '^(node|claude)$') {
      Write-Log ('close requested for ' + $sid + ' but pid ' + $row.pid + ' is ' + $p.ProcessName + ' -- refusing') 'WARN'
      continue
    }
    try {
      Stop-Process -Id $p.Id -ErrorAction Stop
      Write-Log ('closed session ' + $sid + ' (pid ' + $p.Id + ')')
    } catch {
      Write-Log ('closing ' + $sid + ' failed: ' + $_.Exception.Message) 'WARN'
    }
  }
}

# ---- executing one task --------------------------------------------------

function Resolve-ClaudeExe {
  $cmd = Get-Command claude.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path $candidate) { return $candidate }
  throw 'claude.exe not found (not on PATH, not in %USERPROFILE%\.local\bin)'
}

# The permission mode arrives from the other side of the machine boundary and
# goes straight onto a command line. CODE_PERMISSION_MODE is validated when it
# is set from the dashboard, but a hand-edited .env is not checked anywhere --
# and 'acceptEdits --dangerously-skip-permissions' would be two arguments, not
# one. The executor validates what it is about to execute.
$script:ALLOWED_MODES = @('acceptEdits', 'bypassPermissions', 'default', 'plan')

function Invoke-CodeTask {
  param([Parameter(Mandatory = $true)]$Task, [string]$PermissionMode = 'acceptEdits')

  if ($script:ALLOWED_MODES -notcontains $PermissionMode) {
    Write-Log ("unknown permission mode '{0}' -- falling back to acceptEdits" -f $PermissionMode) 'WARN'
    $PermissionMode = 'acceptEdits'
  }

  $workspace = [string]$Task.workspacePath
  $sessionId = [string]$Task.sessionId
  if (-not (Test-Path -LiteralPath $workspace)) { throw "workspace not found: $workspace" }

  # A CLI ARGUMENTUMAI MINDKET AGON UGYANAZOK; csak az kulonbozik, MELYIK
  # binarisnak adjuk at oket. Igy a `startFresh` szabalya (hogy nincs benne
  # `--resume`) EGY helyen all, es nem tud a Windows- es a WSL-ag kozott
  # szetcsuszni -- pont az a fajta ketteagazas, amibol a 032aa826 szuletett.
  #
  # Every argument here is ASCII by construction (a uuid and two keywords).
  # Kartya 032aa826: startFresh = true azt jelenti, hogy a claim NEM talalt
  # bizonyitottan Marvin-sajat (korabban maga altal nyitott) beszelgetest a
  # projekthez, tehat NEM resume-elunk a felderites altal latott -- akar a
  # tulaj altal eppen kezzel hasznalt -- fulbe, hanem uj, ures beszelgetest
  # indit a CLI (`-p` --resume nelkul), pont ugy, mint a bizonyitottan mukodo
  # "/clear" ut a #48-as (Torles) gombnal.
  if ($Task.startFresh) {
    $claudeArgs = '-p --output-format json --permission-mode ' + $PermissionMode
  } else {
    $claudeArgs = '-p --resume ' + $sessionId + ' --output-format json --permission-mode ' + $PermissionMode
  }

  # The child is started DIRECTLY -- no cmd.exe, no .bat in between.
  # A batch file is read in the OEM codepage, so a user folder with an accented
  # letter (Laszlo with the accents) arrives mangled and the `cd` silently fails.
  # Measured: the run then hung forever with no output at all. Going straight to
  # the process API also keeps the prompt off the command line entirely -- it is
  # written to the child's stdin as UTF-8 bytes, so there is no quoting to get
  # wrong, no shell metacharacter to escape, and no command-line length limit.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  # MELYIK GEPEN LAKIK EZ A BESZELGETES.
  #
  # A munkamappa UNC alakja (`\\wsl.localhost\<disztro>\...`) nem csak egy ut:
  # ez az EGYETLEN dolog, ami elarulja, hogy a beszelgetes a WSL-ben szuletett,
  # es azt is, MELYIK disztroban. A Windows-`claude.exe` egy ilyen
  # beszelgetes-azonositot nem tudna folytatni -- a naploja a disztro
  # `~/.claude/projects`-eben all, nem a `%USERPROFILE%`-ban --, es a `--resume`
  # csendben uj, ures beszelgetest adna vissza a regi helyett.
  $wsl = ConvertFrom-WslUncPath -Path $workspace
  $launchedAs = 'claude.exe'
  if ($null -ne $wsl) {
    $wslStore = Get-WslStore -Distro $wsl.distro
    if ($null -eq $wslStore) {
      throw ("a(z) '" + $wsl.distro + "' WSL-disztro nem valaszol, ezert a feladat nem futtathato benne -- inditsd el (wsl -d " + $wsl.distro + "), es a hid a kovetkezo korben ujraprobalja")
    }
    if (-not $wslStore.claude) {
      throw ("nincs Claude Code a(z) '" + $wsl.distro + "' WSL-disztroban (a `claude` sem a PATH-on, sem a ~/.local/bin-ben nincs meg) -- telepitsd a disztron BELUL, utana ez a beszelgetes cimezheto lesz")
    }
    # A `--cd` a WSL sajat megoldasa a munkakonyvtarra, es POSIX utat var. A
    # Windows-oldali `WorkingDirectory` ezt nem tudna helyettesiteni: az
    # `wsl.exe`-nek adott UNC-konyvtarra a CreateProcess figyelmeztet, es
    # nemaan a rendszerkonyvtarra vált -- vagyis a feladat a rossz mappaban
    # indulna el.
    $psi.FileName = 'wsl.exe'
    $psi.Arguments = '-d ' + (ConvertTo-QuotedArg $wsl.distro) `
      + ' --cd ' + (ConvertTo-QuotedArg $wsl.posix) `
      + ' -e ' + (ConvertTo-QuotedArg $wslStore.claude) `
      + ' ' + $claudeArgs
    $psi.WorkingDirectory = $env:USERPROFILE
    $launchedAs = ('wsl -d ' + $wsl.distro + ' claude')
  } else {
    $psi.FileName = Resolve-ClaudeExe
    $psi.Arguments = $claudeArgs
    $psi.WorkingDirectory = $workspace
  }
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  # A VEGREHAJTO IS BEKERUL A NAPLOBA. Ket tar van, es egy "miert nem folytatta
  # a beszelgetest" kerdesnel az elso kerdes az, hogy melyik gepen indult el --
  # ezt utolag kitalalni nem lehetne.
  Write-Log ("running task {0} project={1} session={2} via {3}" -f $Task.id, $Task.project, $sessionId, $launchedAs)
  $started = Get-Date
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()

  # Drain both pipes ASYNCHRONOUSLY. A synchronous ReadToEnd on one pipe while
  # the other fills up deadlocks the child, and a long Claude Code run produces
  # plenty on both.
  $stdoutTask = $proc.StandardOutput.ReadToEndAsync()
  $stderrTask = $proc.StandardError.ReadToEndAsync()

  $promptBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$Task.prompt)
  $proc.StandardInput.BaseStream.Write($promptBytes, 0, $promptBytes.Length)
  $proc.StandardInput.BaseStream.Flush()
  $proc.StandardInput.Close()

  $lastBeat = Get-Date
  $timedOut = $false
  while (-not $proc.HasExited) {
    Start-Sleep -Seconds 2
    if (((Get-Date) - $lastBeat).TotalSeconds -ge 60) {
      $lastBeat = Get-Date
      try {
        Invoke-Bridge -Path ('/api/code/tasks/' + $Task.id + '/heartbeat') -Method 'POST' -Body @{ host = $script:HostId } | Out-Null
      } catch {
        Write-Log ('heartbeat failed: ' + $_.Exception.Message) 'WARN'
      }
    }
    if (((Get-Date) - $started).TotalSeconds -gt $TaskTimeoutSeconds) {
      $timedOut = $true
      Write-Log ("task {0} timed out after {1}s -- killing" -f $Task.id, $TaskTimeoutSeconds) 'ERROR'
      try { $proc.Kill() } catch { }
      break
    }
  }
  try { $proc.WaitForExit(15000) | Out-Null } catch { }

  $durationMs = [int]((Get-Date) - $started).TotalMilliseconds
  $stdout = ''
  $stderr = ''
  try { $stdout = $stdoutTask.Result } catch { }
  try { $stderr = $stderrTask.Result } catch { }
  $exitCode = -1
  try { $exitCode = $proc.ExitCode } catch { }
  $proc.Dispose()

  $payload = @{ ok = $true; durationMs = $durationMs }
  $parsed = $null
  if ($stdout -and $stdout.Trim()) {
    try { $parsed = $stdout | ConvertFrom-Json } catch { $parsed = $null }
  }

  if ($parsed -and ($parsed.PSObject.Properties.Name -contains 'result')) {
    $payload.result = [string]$parsed.result
    if (($parsed.PSObject.Properties.Name -contains 'is_error') -and $parsed.is_error) {
      $payload.ok = $false
      $payload.error = 'Claude Code reported an error'
    }
    if ($parsed.PSObject.Properties.Name -contains 'total_cost_usd') { $payload.costUsd = [double]$parsed.total_cost_usd }
    if ($parsed.PSObject.Properties.Name -contains 'num_turns') { $payload.numTurns = [int]$parsed.num_turns }
    # MELYIK BESZELGETESBEN VEGZODOTT A FUTAS.
    #
    # Merve 2026-08-26-an, ket futassal ugyanabban a mappaban:
    #   `-p --resume <id> "Mondd: korte"` -> session_id UGYANAZ (folytatas)
    #   `-p --resume <id> "/clear"`       -> session_id UJ      (uj, ures beszelgetes)
    # A kimenet session_id-je pontosan akkor valtozik, amikor a beszelgetes
    # tenylegesen atvaltott -- ez nem kovetkeztetes, hanem a CLI sajat jelentese.
    #
    # Enelkul a Torles gomb SEMMIT nem ert el: uj, ures beszelgetest nyitott,
    # de arrol csak a mappa-bejarasbol lehetett tudni, azt viszont a 2 KB-os also
    # hatar (lasd fentebb) kiszurte -- egy frissen kiuritett beszelgetes ~1,8 KB.
    # Igy a projekt a REGI beszelgetesen maradt, a kovetkezo feladat is oda ment,
    # a felulet kozben sikert jelentett.
    if ($parsed.PSObject.Properties.Name -contains 'session_id') { $payload.resultSessionId = [string]$parsed.session_id }
  } else {
    # No parsable JSON: report the raw tail so the failure is diagnosable from
    # Telegram instead of silently coming back empty.
    $payload.ok = $false
    $tail = $stderr
    if (-not $tail) { $tail = $stdout }
    if (-not $tail) {
      if ($timedOut) { $tail = "timed out after $TaskTimeoutSeconds s" }
      else { $tail = "$launchedAs produced no output (exit $exitCode)" }
    }
    if ($tail.Length -gt 1500) { $tail = $tail.Substring($tail.Length - 1500) }
    $payload.error = $tail
  }
  return $payload
}

# ---- onfrissites ---------------------------------------------------------
#
# Boss, 2026-08-26: "miert kell ezt a usernek eljatszania? miert nem lehet ezt
# automatan megcsinalni?"
#
# A PowerShell az INDULASKOR beolvasott kodot futtatja: a fajl felulirasa egy
# mar futo peldanyra nincs semmilyen hatassal. Ezert volt eddig ket kezi lepes
# egy frissites (letoltes + ujrainditas), es amig a masodik el nem hangzott, a
# regi peldany nemaan regi adatot kuldott -- 2026-08-23-an pontosan ez adta a
# rossz beszelgetes-cimeket. A rendszer TUDTA a hibat es ki is irta, csak a
# javitas egyetlen szereploje a tulajdonos volt.
#
# Amit ez a fuggveny NEM tesz meg, szandekosan:
#  - nem cserel futo feladat kozben: a hivo csak akkor hivja, ha nem kapott
#    taskot, tehat a csere soha nem szakit felbe egy futo Claude-hivast;
#  - nem hisz el barmit: a szkriptet a sajat Marveenjetol tolti (loopback +
#    token), es CSAK akkor cserel, ha a letoltott szovegben allo verziojeloles
#    pontosan az, amit a szerver vart. Egy csonka vagy felresiklott letoltes
#    igy nem tudja lecserelni a mukodo peldanyt.
#
# A visszateres $true = "lecsereltem a fajlt, ki kell lepni". Maga a kilepes es
# az ujrainditas NEM itt tortenik: a mutexet eloszor el kell engedni, kulonben
# az uj peldany azonnal masodiknak latszik es kilep. Ezert csak jelzunk.
function Invoke-SelfUpdate {
  param([string]$Expected)

  # Ures/hianyzo vart verzio = "nem latok oda" (ebben a telepitesben nincs meg
  # a szkript, amibol a szerver olvasna). Ez NEM ugyanaz, mint "elavult", es
  # nem szabad frissitesnek olvasni: abbol vegtelen kor lenne.
  if ([string]::IsNullOrWhiteSpace($Expected)) { return $false }
  if ($Expected -eq $script:WorkerVersion) { return $false }

  $self = $PSCommandPath
  if ([string]::IsNullOrWhiteSpace($self)) {
    Write-Log 'self-update: nem tudom, melyik fajlbol futok, ezert nem cserelek' 'ERROR'
    return $false
  }

  Write-Log ("self-update: a futo peldany {0}, a hid {1}-t var -- frissitek" -f $script:WorkerVersion, $Expected) 'WARN'

  try {
    $fresh = [string](Invoke-Bridge -Path '/api/code/worker-script?file=ps1')
  } catch {
    # A halo: ha a letoltes nem megy, MARADUNK a regin. Egy elavult, de futo
    # worker tobbet er egy nem letezonel -- es a dashboard sora tovabbra is
    # szol rola.
    Write-Log ('self-update: a letoltes nem sikerult, maradok a regin: ' + $_.Exception.Message) 'ERROR'
    return $false
  }

  # Ket fuggetlen ellenorzes, mert a ketto mas hibat fog meg: a hossz a csonka
  # valaszt (proxy, megszakadt kapcsolat), a verziojeloles pedig azt, hogy
  # tenyleg AZT kaptuk, amit a szerver igert.
  if ($fresh.Length -lt 5000) {
    Write-Log ('self-update: a letoltott szkript gyanusan rovid ({0} karakter), nem cserelek' -f $fresh.Length) 'ERROR'
    return $false
  }
  $pattern = 'WorkerVersion\s*=\s*''([^'']{1,40})'''
  $m = [regex]::Match($fresh, $pattern)
  if (-not $m.Success -or $m.Groups[1].Value -ne $Expected) {
    $got = if ($m.Success) { $m.Groups[1].Value } else { '(nincs benne verziojeloles)' }
    Write-Log ("self-update: a letoltott szkript {0}, de {1}-t vartam -- nem cserelek" -f $got, $Expected) 'ERROR'
    return $false
  }

  try {
    # A regi peldany megmarad egy masolatban. Nem a visszaallashoz kell (azt az
    # ujratoltes elvegzi), hanem ahhoz, hogy egy elrontott frissites utan
    # legyen mit MEGNEZNI -- mi ment el.
    Copy-Item -Force -LiteralPath $self -Destination ($self + '.bak-selfupdate')
    # Eloszor melle irunk, aztan egy lepesben a helyere mozgatunk: ha az iras
    # kozben all meg a gep, a MUKODO fajl marad a helyen, nem egy fel szkript.
    $tmp = $self + '.new'
    [System.IO.File]::WriteAllText($tmp, $fresh, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -Force -LiteralPath $tmp -Destination $self
  } catch {
    Write-Log ('self-update: a fajlcsere nem sikerult, maradok a regin: ' + $_.Exception.Message) 'ERROR'
    return $false
  }

  Write-Log ("self-update: {0} kiirva, kilepek es ujraindulok" -f $Expected) 'WARN'
  return $true
}

# ---- main loop -----------------------------------------------------------

function Start-WorkerLoop {
  $lastDiscover = [DateTime]::MinValue
  while ($true) {
    try {
      if (((Get-Date) - $lastDiscover).TotalSeconds -ge $DiscoverSeconds) {
        $lastDiscover = Get-Date
        Publish-Sessions
      }

      $claim = Invoke-Bridge -Path '/api/code/tasks/claim' -Method 'POST' -Body @{ host = $script:HostId }
      # A csere pillanata: van kapcsolat a hiddal, es epp NINCS futo feladat.
      # Ha most cserelunk, semmi nem szakad felbe. Ha van task, a frissites var
      # a kovetkezo ures korre -- harom masodperc mulva ujra itt vagyunk.
      if ($claim -and -not $claim.task) {
        if (Invoke-SelfUpdate -Expected ([string]$claim.expectedWorkerVersion)) {
          $script:RestartAfterExit = $true
          return
        }
      }
      # A TALLOZAS A GYORS CSATORNAN.
      #
      # Eddig a keres csak a percenkenti session-jelentes valaszan fert fel,
      # tehat egy mappara kattintas utan a felulet akar 60 masodpercig pergett
      # (eles meres 2026-09-12, `worker.log`). Ez a ciklus 3 masodpercenkent
      # fut, tehat a valasz is ennyi. A ketszeres kiszolgalas artalmatlan: a
      # szerver az elso valasz utan `answeredAt`-et allit.
      #
      # A jelentes agan SZANDEKOSAN benne marad ugyanez: ha a claim-hivas
      # barmiert elakad, a tallozas akkor sem hal meg -- csak lassabb lesz.
      if ($claim -and $claim.browseRequests) {
        Invoke-BrowseRequests -Requested $claim.browseRequests
      }
      if ($claim -and $claim.task) {
        $mode = 'acceptEdits'
        if ($claim.permissionMode) { $mode = [string]$claim.permissionMode }
        $result = $null
        try {
          $result = Invoke-CodeTask -Task $claim.task -PermissionMode $mode
        } catch {
          $result = @{ ok = $false; error = ('worker error: ' + $_.Exception.Message) }
          Write-Log ('task failed: ' + $_.Exception.Message) 'ERROR'
        }
        # Name ourselves in the result too. It is what lets the server stamp
        # worker presence on a completed job, and what lets it refuse a result
        # from a worker whose lease was already handed to someone else.
        $result['host'] = $script:HostId
        try {
          Invoke-Bridge -Path ('/api/code/tasks/' + $claim.task.id + '/result') -Method 'POST' -Body $result | Out-Null
          Write-Log ("task {0} reported back (ok={1})" -f $claim.task.id, $result.ok)
        } catch {
          # The lease reaper re-queues it; losing the result is better than
          # losing the task.
          Write-Log ('result POST failed: ' + $_.Exception.Message) 'ERROR'
        }
        if ($Once) { return }
        continue
      }
      if ($Once) { Write-Log 'no queued task'; return }
    } catch {
      Write-Log ('loop error: ' + $_.Exception.Message) 'WARN'
      Start-Sleep -Seconds 5
    }
    Start-Sleep -Seconds $PollSeconds
  }
}

# ---- entry ---------------------------------------------------------------

$script:BridgeToken = Get-BridgeToken
Write-Log ("worker starting host={0} base={1}" -f $script:HostId, $BaseUrl)

if ($DiscoverOnly) {
  Publish-Sessions
  return
}

# One worker per machine: two would both claim tasks and run two CLIs against
# the same session at once.
#
# A MASODIK PELDANY KILEPESE NEM HIBA -- ES 2026-08-26 OTA NEM IS RITKASAG.
# Az utemezett feladat mostantol otpercenkent ujraindit (`/sc minute /mo 5`),
# hogy egy elhalt worker magatol visszajojjon; a mutex teszi artalmatlanna.
# Vagyis a TIPIKUS nap ugy nez ki, hogy 287 inditas azonnal kilep itt, es egy
# fut. WARN-kent naplozva ez naponta 287 riasztonak latszo sor lenne, ami
# pontosan azt fedne el, amiert a naplo van. Ezert ez az ag NEMA.
#
# Amit ezzel nem vesztunk el: hogy fut-e worker, nem ebbol tudjuk, hanem a
# szivverésbol -- a dashboard `code_bridge_dead` jelzese a WORKER_STALE_MS
# alapjan meri. A csend itt tehat "minden rendben", nem "nem latok oda".
$mutex = New-Object System.Threading.Mutex($false, 'Global\MarvinCodeWorker')
if (-not $mutex.WaitOne(0)) {
  return
}
$script:RestartAfterExit = $false
try {
  Start-WorkerLoop
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}

# Az uj peldany indulasa CSAK a mutex elengedese utan johet: elotte azonnal
# masodiknak latszana, es szo nelkul kilepne -- pont az a nema ag, ami fentebb
# artalmatlan, itt viszont ott hagyna a gepet worker nelkul.
#
# Ha az inditas barmiert nem sikerul, nem maradunk worker nelkul: a
# `MarvinCodeWorker` utemezett feladat otpercenkent ujraindit (merve
# 2026-08-26: LastRun 16:38:38 -> NextRun 16:43:43), es akkor mar a FRISS
# fajlt inditja el. Az azonnali inditas tehat csak azert van, hogy ne kelljen
# ot percet varni ra.
if ($script:RestartAfterExit) {
  try {
    Start-Process -FilePath 'powershell.exe' -WindowStyle Minimized -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
    )
    Write-Log 'self-update: az uj peldany elindult' 'WARN'
  } catch {
    Write-Log ('self-update: az azonnali ujrainditas nem sikerult, az utemezett feladat ot percen belul visszahoz: ' + $_.Exception.Message) 'ERROR'
  }
}
