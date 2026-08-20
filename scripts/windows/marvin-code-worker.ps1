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
function Read-TranscriptCwd {
  param([string]$Path, [int]$MaxLines = 60)
  $reader = $null
  try {
    $reader = New-Object System.IO.StreamReader($Path, [System.Text.Encoding]::UTF8)
    for ($i = 0; $i -lt $MaxLines; $i++) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }
      if ($line.Length -lt 2) { continue }
      if ($line -notmatch '"cwd"') { continue }
      try {
        $obj = $line | ConvertFrom-Json
        if ($obj.cwd) { return [string]$obj.cwd }
      } catch { }
    }
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
  }
  return $null
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

  # Subtree skips: nothing under Windows or under a temp dir is a project.
  $subtrees = @($env:WINDIR, [System.IO.Path]::GetTempPath())
  foreach ($t in $subtrees) {
    if (-not $t) { continue }
    $tf = ''
    try { $tf = [System.IO.Path]::GetFullPath($t).TrimEnd('\') } catch { continue }
    if (-not $tf) { continue }
    if ($full.StartsWith(($tf + '\'), [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  }
  return $true
}

function Get-LocalSessions {
  $projectsDir = Get-ClaudeProjectsDir
  if (-not $projectsDir) { return @() }
  $out = New-Object System.Collections.ArrayList
  foreach ($dir in (Get-ChildItem -Path $projectsDir -Directory -ErrorAction SilentlyContinue)) {
    $files = Get-ChildItem -Path $dir.FullName -Filter '*.jsonl' -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTimeUtc -Descending
    if (-not $files) { continue }
    # A transcript under ~2 KB is an aborted/empty session -- registering it as
    # "the project's session" would throw away the real conversation history.
    $chosen = $null
    foreach ($f in $files) {
      if ($f.Length -ge 2KB) { $chosen = $f; break }
    }
    if (-not $chosen) { continue }
    $cwd = Read-TranscriptCwd -Path $chosen.FullName
    if (-not $cwd) { continue }
    if (-not (Test-DispatchableWorkspace -Path $cwd)) { continue }
    $mtime = [int64]([DateTimeOffset]$chosen.LastWriteTimeUtc).ToUnixTimeMilliseconds()
    [void]$out.Add(@{
      workspacePath = $cwd
      sessionId     = [System.IO.Path]::GetFileNameWithoutExtension($chosen.Name)
      mtime         = $mtime
    })
  }
  return $out.ToArray()
}

function Publish-Sessions {
  $sessions = @(Get-LocalSessions)
  if (-not $sessions -or $sessions.Count -eq 0) {
    Write-Log 'no local Claude Code sessions found' 'WARN'
    return
  }
  # ConvertTo-Json in PS 5.1 FLATTENS a one-element array into a bare object, so
  # a machine with exactly one project used to post `"sessions": {...}` and the
  # API answered 400. Building that one line by hand keeps it an array whatever
  # the count is. (The server tolerates both now, but the client should not be
  # the one relying on that.)
  $sessionsJson = '[' + (($sessions | ForEach-Object { $_ | ConvertTo-Json -Depth 6 -Compress }) -join ',') + ']'
  $body = '{"host":' + ($script:HostId | ConvertTo-Json -Compress) + ',"sessions":' + $sessionsJson + '}'
  $resp = Invoke-Bridge -Path '/api/code/sessions' -Method 'POST' -RawBody $body
  Write-Log ('sessions reported: ' + ($resp.registered -join ', '))
}

# ---- executing one task --------------------------------------------------

function Resolve-ClaudeExe {
  $cmd = Get-Command claude.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidate = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path $candidate) { return $candidate }
  throw 'claude.exe not found (not on PATH, not in %USERPROFILE%\.local\bin)'
}

function Invoke-CodeTask {
  param([Parameter(Mandatory = $true)]$Task, [string]$PermissionMode = 'acceptEdits')

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
$mutex = New-Object System.Threading.Mutex($false, 'Global\MarvinCodeWorker')
if (-not $mutex.WaitOne(0)) {
  Write-Log 'another worker instance is already running -- exiting' 'WARN'
  return
}
try {
  Start-WorkerLoop
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
