#!/usr/bin/env python3
"""Open a URL in a fresh Chrome window on the Windows host's REAL, logged-in
desktop -- from WSL, over Telegram, with no one touching the keyboard -- and
close the window this script opened last time first.

Boss controls Marvin over Telegram (phone), but the request is for the
actual physical screen on the PC Marvin runs on ("indits el egy videot a
gepemen", not "kuldd el a linket").

THE TRAP (found live, 2026-08-05, do not "simplify" this back to
Start-Process/cmd.exe): a process launched directly via WSL interop
(`/mnt/c/.../powershell.exe ...` or `cmd.exe /c start`) lands in Windows
**Session 0** on this machine -- confirmed by reading back
`[System.Diagnostics.Process]::GetCurrentProcess().SessionId` from such a
process: it printed 0, while the real interactive desktop (explorer.exe,
the logged-in user) is the Console session. Session 0 is the isolated
services session -- anything opened there is invisible and inaudible to
the person sitting at the PC. No error, no exception, just silent nothing
(Boss: "semmi nem tortent"). AppActivate/AllWindows enumeration from a
Session-0 process also can't see the console session's windows, so you
can't detect this failure mode by probing after the fact -- you have to
route around it up front.

The fix: hand the launch to Windows' own Task Scheduler with
LogonType=Interactive. A task registered that way runs IN the target
user's actual interactive session when they're logged on -- this is the
same mechanism Windows services use to (rarely, deliberately) show UI to a
logged-in user. Verified by the same SessionId probe: a task launched this
way reports the console session, not 0.

CLOSING THE PREVIOUS WINDOW (2026-08-06 card, implemented 2026-08-10).
Boss: "ket hang egyszerre nem szabad hogy beszeljen... automatikusan
kellene ezt csinalni, hogyha kerlek egy masik videot inditani". Two things
make that hard, and both are handled here:

1. Chrome is single-instance PER PROFILE. Launched against Boss's normal
   profile while his Chrome is already running (it always is -- 20+ tabs),
   `chrome.exe --new-window` just hands the URL to the EXISTING browser
   process and exits. There is then no process of ours to close, and
   killing "chrome.exe" would take Boss's own tabs with it. So Marvin's
   windows run in their OWN user-data-dir (MARKER below). That gives this
   script a process tree it owns, and makes the kill filter exact: only a
   chrome.exe whose command line carries the marker is ever touched, so
   Boss's own browser cannot be hit even by accident.
2. Closing needs the window, not just the PID -- but WM_CLOSE across
   sessions is exactly what Session 0 cannot do. CloseMainWindow() is
   attempted first anyway (it works when the caller can reach the window
   station) and a forced stop is the fallback; since the profile is
   disposable, a hard stop costs nothing. The crash-restore bubble that
   would otherwise appear on the next launch is suppressed by flag.

State (which PIDs we opened, for which URL, when) is written to
~/.claude/skills/win-browser-control/state/last-window.json. It is a
record for humans and for debugging -- the kill filter does NOT depend on
it, so a lost or stale state file cannot leak a window or endanger another
process.

Usage:
  open_url.py 'https://www.youtube.com/watch?v=...'   open (closing the previous)
  open_url.py --close                                 just close Marvin's window
                                                      ("allitsd le a videot")
"""
import base64
import json
import os
import subprocess
import sys
import time
from pathlib import Path

POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
CHROME_ARG = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TASK_NAME = "MarvinOpenUrl"
# Directory name under %LOCALAPPDATA% for Marvin's own Chrome profile. It is
# also the string the close step matches on, so it must be distinctive.
MARKER = "MarvinChromeProfile"
STATE_PATH = Path.home() / ".claude" / "skills" / "win-browser-control" / "state" / "last-window.json"


def build_ps_script(url: str | None) -> str:
    """PowerShell for one run: close what we opened before, then (unless this is
    a close-only run) open `url`. One process launch keeps the close and the
    open in a fixed order -- the requirement is that the old sound stops BEFORE
    the new one starts, not merely that both happen."""
    ps_url = url.replace("'", "''") if url else ""  # PowerShell single-quote escaping
    open_block = f"""
# 2) Open the new window in the INTERACTIVE session (see the Session 0 note).
$chromeArgs = '--user-data-dir="' + $profileDir + '" --no-first-run --no-default-browser-check --disable-session-crashed-bubble --new-window ' + '{ps_url}'
$action = New-ScheduledTaskAction -Execute '{CHROME_ARG}' -Argument $chromeArgs
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive
Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName '{TASK_NAME}'
Start-Sleep -Seconds 3
""" if url else ""
    return f"""
$ErrorActionPreference = 'Continue'
$marker = '{MARKER}'
$profileDir = Join-Path $env:LOCALAPPDATA $marker

# Only ever touches chrome.exe processes started with OUR profile directory.
function Get-MarvinChrome {{
  Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object {{ $_.CommandLine -and $_.CommandLine -like "*$marker*" }}
}}

# 1) Close what we opened last time, BEFORE the new window starts -- the whole
#    point is that two videos never play at once.
$closed = @()
foreach ($p in Get-MarvinChrome) {{
  $closed += $p.ProcessId
  try {{
    $proc = Get-Process -Id $p.ProcessId -ErrorAction Stop
    if (-not $proc.CloseMainWindow()) {{ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }}
  }} catch {{ }}
}}
if ($closed.Count -gt 0) {{
  Start-Sleep -Milliseconds 900
  foreach ($p in Get-MarvinChrome) {{
    try {{ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }} catch {{ }}
  }}
  Start-Sleep -Milliseconds 300
}}

{open_block}
# 3) Report back in a form the caller can parse.
'MARVIN_CLOSED=' + ($closed -join ',')
'MARVIN_OPENED=' + ((Get-MarvinChrome | Select-Object -ExpandProperty ProcessId) -join ',')
'MARVIN_TASKRESULT=' + (Get-ScheduledTaskInfo -TaskName '{TASK_NAME}').LastTaskResult
"""


def parse_marked(stdout: str, key: str) -> list:
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith(key + "="):
            raw = line[len(key) + 1:].strip()
            return [p for p in raw.split(",") if p]
    return []


def main():
    if len(sys.argv) != 2:
        print("usage: open_url.py <url> | open_url.py --close", file=sys.stderr)
        sys.exit(1)
    arg = sys.argv[1]
    close_only = arg == "--close"
    url = None if close_only else arg
    if url is not None and not (url.startswith("http://") or url.startswith("https://")):
        print("refusing to open non-http(s) url", file=sys.stderr)
        sys.exit(1)

    encoded = base64.b64encode(build_ps_script(url).encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"failed: rc={result.returncode} stderr={result.stderr[-300:]!r}", file=sys.stderr)
        sys.exit(result.returncode)

    closed = parse_marked(result.stdout, "MARVIN_CLOSED")
    opened = parse_marked(result.stdout, "MARVIN_OPENED")

    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps({
            "url": url,
            "closed_only": close_only,
            "pids": opened,
            "closed_pids": closed,
            "opened_at": int(time.time()),
        }, indent=2), encoding="utf-8")
    except OSError as err:
        # The state file is a record, not a dependency: the close step filters on
        # the profile marker, so failing to write it must not fail the open.
        print(f"note: could not write state file ({err})", file=sys.stderr)

    closed_note = f", closed previous window (pid {', '.join(closed)})" if closed else ""
    if close_only:
        print(f"closed Marvin's Chrome window (pid {', '.join(closed)})" if closed
              else "nothing to close -- no Marvin Chrome window was open")
        return
    if not opened:
        # The task returned but no process of ours is alive: the launch did not
        # take. Say so instead of reporting a success nobody can see.
        print(f"WARNING: launched but no Marvin Chrome process found afterwards{closed_note}: {url}", file=sys.stderr)
        sys.exit(2)
    print(f"opened (new Chrome window, interactive session){closed_note}: {url}")


if __name__ == "__main__":
    main()
