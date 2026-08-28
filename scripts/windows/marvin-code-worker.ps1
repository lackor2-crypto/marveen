# marvin-code-worker -- the Windows half of the VS Code Claude Code bridge.
#
# WHAT IT DOES
#   1. Discovers the Claude Code sessions on this machine by reading
#      %USERPROFILE%\.claude\projects\<encoded-cwd>\<session>.jsonl and reports
#      them to Marveen (project alias -> sessionId + workspace path).
#   2. Claims one queued task at a time from Marveen.
#   3. Runs the EXISTING session headless:
#        claude.exe -p --resume <sessionId> --output-format json
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
$script:WorkerVersion = '2026-08-28.1'
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

function Get-ClaudeProjectsDir {
  $dir = Join-Path $env:USERPROFILE '.claude\projects'
  if (Test-Path $dir) { return $dir }
  return $null
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
  $out = @{ tokens = $null; model = $null }
  try {
    $lines = @(Get-Content -LiteralPath $Path -Tail $TailLines -Encoding UTF8 -ErrorAction Stop)
  } catch {
    return $out
  }
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    $line = $lines[$i]
    if (-not $line -or $line -notmatch '"usage"') { continue }
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
        return $out
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
function Get-OpenSessionIds {
  $dir = Join-Path $env:USERPROFILE '.claude\sessions'
  if (-not (Test-Path -LiteralPath $dir)) { return $null }
  $open = @{}
  $files = @(Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue)
  foreach ($f in $files) {
    try {
      $o = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json
    } catch { continue }
    if (-not $o.sessionId -or -not $o.pid) { continue }
    # A PID ujrahasznosulhat, ezert a folyamat nevet is nezzuk: a Claude Code
    # node.exe vagy claude.exe alatt fut. Ennel tobbet ez a fajl nem arul el.
    $p = Get-Process -Id ([int]$o.pid) -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    if ($p.ProcessName -notmatch '^(node|claude)$') { continue }
    # A PID-et is megjegyezzuk, nem csak azt, hogy nyitva van: enelkul a
    # feluletrol nem lehetne bezarni egy olyan beszelgetest, aminek a fulet a
    # VS Code-ban mar nem talalod (Boss, 2026-08-23).
    $open[[string]$o.sessionId] = [int]$o.pid
  }
  return $open
}

# MIT LAT A FELHASZNALO A VS CODE PANELEN.
#
# A `Get-OpenSessionIds` a FUTO FOLYAMATOT meri, es ez keveset mert. Boss,
# 2026-08-28 (Telegram 649): "latom hogy ott van a listaban a 47 es kanban
# kartya nevu chat, de nem tudom kijelolni! (...) egy ellenorzest kellene tenni
# a vscode nevu programban levo claude code chatre hogy ott mi van chat. amit a
# user lat. es azt megjeleniteni."
#
# Merve ugyanekkor: a "47-es kanban kartya" beszelgeteshez (sessionId
# 3d3f27b8-...) 22:45:09-ig nem futott claude.exe, kozben a VS Code panelen ott
# volt. A "nyitott ful" es a "futo folyamat" KET KULONBOZO dolog.
#
# A VS Code a sajat listajat a munkateruleti allapotaba irja:
#   %APPDATA%\<VS Code valtozat>\User\workspaceStorage\<hash>\state.vscdb
#   -> ItemTable['agentSessions.model.cache']
# JSON tomb, elemenkent `resource` = "agent-host-claude:/<sessionId>", `label`,
# `metadata.workingDirectoryPath`.
#
# A fajl SQLite, a worker meg PowerShell: a Windows sajat `winsqlite3.dll`-jet
# hasznaljuk (Windows 10 1803 ota resze a rendszernek). Ha nincs meg vagy nem
# betolheto, a valasz `$null` = NEM LATUNK ODA -- nem pedig "semmi nincs
# nyitva". A kettot osszemosni pontosan az a hiba, ami ezt a kort okozta.
$script:VSCodeSqliteReady = $null

function Initialize-VSCodeSqlite {
  if ($null -ne $script:VSCodeSqliteReady) { return $script:VSCodeSqliteReady }
  $script:VSCodeSqliteReady = $false
  $dll = Join-Path $env:SystemRoot 'System32\winsqlite3.dll'
  if (-not (Test-Path -LiteralPath $dll)) {
    Write-Log 'winsqlite3.dll nincs a rendszerben -- a VS Code listajat nem tudjuk elolvasni' 'WARN'
    return $false
  }
  if (([System.Management.Automation.PSTypeName]'MarveenSqlite').Type) {
    $script:VSCodeSqliteReady = $true
    return $true
  }
  # C# 5 nyelvi szint: a worker PowerShell 5.1-en is fut.
  $code = @'
using System;
using System.Runtime.InteropServices;

public static class MarveenSqlite {
  private const int SQLITE_OK = 0;
  private const int SQLITE_ROW = 100;

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_open16([MarshalAs(UnmanagedType.LPWStr)] string filename, out IntPtr db);

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_prepare16_v2(IntPtr db, [MarshalAs(UnmanagedType.LPWStr)] string sql, int nByte, out IntPtr stmt, IntPtr tail);

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_bind_text16(IntPtr stmt, int idx, [MarshalAs(UnmanagedType.LPWStr)] string value, int nByte, IntPtr destructor);

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_step(IntPtr stmt);

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern IntPtr sqlite3_column_text16(IntPtr stmt, int col);

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_finalize(IntPtr stmt);

  [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.Cdecl)]
  private static extern int sqlite3_close(IntPtr db);

  // Egy szoveges ertek egy kulcs alol. `null` = nem tudtuk elolvasni VAGY
  // nincs ilyen kulcs -- a hivo oldalan ez a ketto egyforman "nem latok oda",
  // mert egy hianyzo kulcs sem bizonyitja, hogy nincs nyitott beszelgetes.
  public static string ReadItemTableValue(string dbPath, string key) {
    IntPtr db = IntPtr.Zero;
    IntPtr stmt = IntPtr.Zero;
    try {
      if (sqlite3_open16(dbPath, out db) != SQLITE_OK) { return null; }
      if (sqlite3_prepare16_v2(db, "SELECT value FROM ItemTable WHERE key = ?", -1, out stmt, IntPtr.Zero) != SQLITE_OK) { return null; }
      // SQLITE_TRANSIENT (-1): az SQLite maga masolja le a kulcsot.
      if (sqlite3_bind_text16(stmt, 1, key, -1, new IntPtr(-1)) != SQLITE_OK) { return null; }
      if (sqlite3_step(stmt) != SQLITE_ROW) { return null; }
      IntPtr p = sqlite3_column_text16(stmt, 0);
      if (p == IntPtr.Zero) { return null; }
      return Marshal.PtrToStringUni(p);
    } catch (Exception) {
      return null;
    } finally {
      if (stmt != IntPtr.Zero) { sqlite3_finalize(stmt); }
      if (db != IntPtr.Zero) { sqlite3_close(db); }
    }
  }
}
'@
  try {
    Add-Type -TypeDefinition $code -ErrorAction Stop
    $script:VSCodeSqliteReady = $true
  } catch {
    Write-Log ('a VS Code allapotfajl olvasoja nem toltheto be: ' + $_.Exception.Message) 'WARN'
    $script:VSCodeSqliteReady = $false
  }
  return $script:VSCodeSqliteReady
}

# A VS Code valtozatai kulon mappaban tarolnak. Egyik sincs fixen beirva
# utkent: az `%APPDATA%` a rendszerbol jon, a valtozatok neve pedig az, amit a
# Microsoft/VSCodium hasznal -- nem gepfuggo azonosito.
$script:VSCodeAppDirs = @('Code', 'Code - Insiders', 'VSCodium')

function Get-VSCodeStateDbPaths {
  $roots = @()
  foreach ($name in $script:VSCodeAppDirs) {
    $dir = Join-Path $env:APPDATA (Join-Path $name 'User\workspaceStorage')
    if (Test-Path -LiteralPath $dir) { $roots += $dir }
  }
  $out = @()
  foreach ($root in $roots) {
    foreach ($d in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
      $db = Join-Path $d.FullName 'state.vscdb'
      if (Test-Path -LiteralPath $db) { $out += $db }
    }
  }
  return $out
}

# A VS Code altal LISTAZOTT Claude-beszelgetesek azonositoi.
#
# Visszateres:
#   hashtable : sessionId -> $true (akar ures is: TENYLEG egy sincs listazva)
#   $null     : nem tudtuk megnezni -- ez NEM ugyanaz, mint az ures halmaz
function Get-VSCodeListedSessionIds {
  $dbs = @(Get-VSCodeStateDbPaths)
  if ($dbs.Count -eq 0) { return $null }
  if (-not (Initialize-VSCodeSqlite)) { return $null }

  $listed = @{}
  $readOk = 0
  foreach ($db in $dbs) {
    # SOHA nem a VS Code sajat fajljat nyitjuk meg: masolatot olvasunk. Igy egy
    # futo VS Code zarolasa nem akaszt meg, es semmi esely arra, hogy a
    # felhasznalo allapotfajljaba beleirjunk.
    $tmp = Join-Path $env:TEMP ('marveen-vscode-state-' + [Guid]::NewGuid().ToString('N') + '.db')
    try {
      Copy-Item -LiteralPath $db -Destination $tmp -Force -ErrorAction Stop
    } catch {
      continue
    }
    try {
      $raw = [MarveenSqlite]::ReadItemTableValue($tmp, 'agentSessions.model.cache')
      # A megnyitas maga sikerult: ettol kezdve a "nincs kulcs" mar meres.
      $readOk++
      if ([string]::IsNullOrWhiteSpace($raw)) { continue }
      $items = $null
      try { $items = $raw | ConvertFrom-Json -ErrorAction Stop } catch { continue }
      foreach ($it in @($items)) {
        $resource = [string]$it.resource
        if ([string]::IsNullOrWhiteSpace($resource)) { continue }
        # "agent-host-claude:/<sessionId>" -- csak a Claude-szolgaltatoe erdekel,
        # egy Copilot-beszelgetes azonositoja nem a mi fulunk.
        if ($resource -notmatch '^agent-host-claude:/(.+)$') { continue }
        $sid = $Matches[1].Trim()
        if ($sid) { $listed[$sid] = $true }
        # Az `archived` mezot SZANDEKOSAN nem szurjuk: nem tudtuk megmerni, mit
        # jelent a panelen. A ket lehetseges tevedes nem egyforma sulyu -- egy
        # felesleges sor zavaro, egy eltunt elo beszelgetes viszont pontosan az
        # a hiba, amit ez a valtoztatas javit.
      }
    } finally {
      Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    }
  }
  # Egyetlen adatbazist sem sikerult megnyitni -> nem latunk oda.
  if ($readOk -eq 0) { return $null }
  return $listed
}

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

function Get-LocalSessions {
  $projectsDir = Get-ClaudeProjectsDir
  if (-not $projectsDir) { return @() }
  $open = Get-OpenSessionIds
  # AMIT A FELHASZNALO LAT a VS Code panelen. Kulon meres a `$open` mellett:
  # az a folyamatot meri, ez a fulet (Boss, 2026-08-28 -- Telegram 649).
  $vscodeListed = Get-VSCodeListedSessionIds
  # A ketto UNIOJA az, ami "nyitottnak" szamit. `$null` = egyik forrast sem
  # tudtuk megnezni; olyankor a regi viselkedes marad, mert a "nem latok oda"
  # nem ugyanaz, mint a "semmi nincs nyitva".
  $openOrListed = $null
  if ($null -ne $open -or $null -ne $vscodeListed) {
    $openOrListed = @{}
    if ($null -ne $open) { foreach ($k in $open.Keys) { $openOrListed[[string]$k] = $true } }
    if ($null -ne $vscodeListed) { foreach ($k in $vscodeListed.Keys) { $openOrListed[[string]$k] = $true } }
  }
  $out = New-Object System.Collections.ArrayList
  $cutoff = (Get-Date).ToUniversalTime().AddDays(-$script:TabMaxAgeDays)
  foreach ($dir in (Get-ChildItem -Path $projectsDir -Directory -ErrorAction SilentlyContinue)) {
    # A transcript under ~2 KB is an aborted/empty session -- registering it as
    # "the project's session" would throw away the real conversation history.
    $files = @(Get-ChildItem -Path $dir.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Length -ge 2KB } |
      Sort-Object LastWriteTimeUtc -Descending)
    if ($files.Count -eq 0) { continue }

    # Ha latjuk, mi van NYITVA, akkor az elsodleges (a projekt sessionje) egy
    # nyitott ful legyen: egy tegnap bezart beszelgetes lehet a legfrissebb
    # fajl, de a feladat nem oda valo. Ha egyik sem nyitott (vagy nem latunk
    # oda), marad a regi sorrend: a legfrissebb fajl.
    # Harom csoport, ebben a sorrendben:
    #   1. FUT a folyamata  -- ide mehet feladat azonnal, ez legyen az elsodleges;
    #   2. a VS Code LISTAZZA -- a felhasznalo latja a panelen, tehat nyitott ful,
    #      csak eppen nem fut most (Boss, 2026-08-28: "az elo, az nincs bezarva");
    #   3. minden mas.
    # A futo elozi meg a listazottat: a projekt sessionje maradjon az, amelyik
    # tenyleg dolgozik -- ezen a valtoztatas szandekosan nem modosit.
    if ($null -ne $open -or $null -ne $vscodeListed) {
      $g1 = @($files | Where-Object { $null -ne $open -and $open.ContainsKey([System.IO.Path]::GetFileNameWithoutExtension($_.Name)) })
      $g2 = @($files | Where-Object {
        $sidName = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
        (-not ($null -ne $open -and $open.ContainsKey($sidName))) -and ($null -ne $vscodeListed -and $vscodeListed.ContainsKey($sidName))
      })
      $g3 = @($files | Where-Object {
        $sidName = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
        -not ($null -ne $openOrListed -and $openOrListed.ContainsKey($sidName))
      })
      if ($g1.Count -gt 0 -or $g2.Count -gt 0) { $files = @($g1) + @($g2) + @($g3) }
    }

    $isPrimary = $true
    $kept = 0
    foreach ($f in $files) {
      # Age cap applies to the EXTRA tabs only: the primary session stays
      # reportable however old it is, or a project untouched for a month would
      # drop out of /projects and every task addressed to it would fail.
      # A DARAB- ES KORHATAR A NYITOTT FULEKRE NEM VONATKOZIK.
      #
      # Enelkul egy honapja nyitva hagyott beszelgetes kiesne a jelentesbol, es
      # a kartyan pont az hianyozna, amit a felhasznalo eppen nez -- ugyanaz a
      # hiba masik okbol. A korlatok celja a lemezen felgyult REGI naplok
      # levagasa volt, nem a nyitott fuleke.
      $sidName = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
      $isOpenOrListed = ($null -ne $openOrListed) -and $openOrListed.ContainsKey($sidName)
      if (-not $isPrimary -and -not $isOpenOrListed) {
        if ($kept -ge $script:MaxTabsPerWorkspace) { break }
        if ($f.LastWriteTimeUtc -lt $cutoff) { break }
      }
      $info = Read-TranscriptInfo -Path $f.FullName
      if (-not $info.cwd) { continue }
      if (-not (Test-DispatchableWorkspace -Path $info.cwd)) { continue }
      $sid = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
      # $null = nem tudtuk megnezni (nincs sessions mappa). A `$false` ezzel
      # szemben MERES: a ful nincs nyitva a VS Code-ban.
      $live = $null
      $sidPid = $null
      if ($null -ne $open) {
        $live = [bool]$open.ContainsKey($sid)
        if ($live) { $sidPid = [int]$open[$sid] }
      }
      # `$null` = nem tudtuk megnezni a VS Code listajat. A `$false` ezzel
      # szemben MERES: a beszelgetes nincs ott a panelen.
      $vscodeOpen = $null
      if ($null -ne $vscodeListed) { $vscodeOpen = [bool]$vscodeListed.ContainsKey($sid) }
      $usage = Read-TranscriptUsage -Path $f.FullName
      [void]$out.Add(@{
        workspacePath = $info.cwd
        sessionId     = $sid
        live          = $live
        vscodeOpen    = $vscodeOpen
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
  if (-not (Test-Path $workspace)) { throw "workspace not found: $workspace" }

  $claude = Resolve-ClaudeExe

  # The child is started DIRECTLY -- no cmd.exe, no .bat in between.
  # A batch file is read in the OEM codepage, so a user folder with an accented
  # letter (Laszlo with the accents) arrives mangled and the `cd` silently fails.
  # Measured: the run then hung forever with no output at all. Going straight to
  # the process API also keeps the prompt off the command line entirely -- it is
  # written to the child's stdin as UTF-8 bytes, so there is no quoting to get
  # wrong, no shell metacharacter to escape, and no command-line length limit.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $claude
  # Every argument here is ASCII by construction (a uuid and two keywords).
  $psi.Arguments = '-p --resume ' + $sessionId + ' --output-format json --permission-mode ' + $PermissionMode
  $psi.WorkingDirectory = $workspace
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8

  Write-Log ("running task {0} project={1} session={2}" -f $Task.id, $Task.project, $sessionId)
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
      else { $tail = "claude.exe produced no output (exit $exitCode)" }
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
