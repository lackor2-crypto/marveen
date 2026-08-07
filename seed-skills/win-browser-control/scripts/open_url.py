#!/usr/bin/env python3
"""Open a URL in a fresh Chrome window on the Windows host's REAL, logged-in
desktop -- from WSL, over Telegram, with no one touching the keyboard.

Boss controls Marvin over Telegram (phone), but the request is for the
actual physical screen on the PC Marvin runs on ("indits el egy videot a
gepemen", not "kuldd el a linket").

THE TRAP (found live, 2026-08-05, do not "simplify" this back to
Start-Process/cmd.exe): a process launched directly via WSL interop
(`/mnt/c/.../powershell.exe ...` or `cmd.exe /c start`) lands in Windows
**Session 0** on this machine -- confirmed by reading back
`[System.Diagnostics.Process]::GetCurrentProcess().SessionId` from such a
process: it printed 0, while the real interactive desktop (explorer.exe,
the logged-in user) is Session 2 (`Console`). Session 0 is the isolated
services session -- anything opened there is invisible and inaudible to
the person sitting at the PC. No error, no exception, just silent nothing
(Boss: "semmi nem tortent"). AppActivate/AllWindows enumeration from a
Session-0 process also can't see Session-2 windows, so you can't detect
this failure mode by probing after the fact -- you have to route around it
up front.

The fix: hand the launch to Windows' own Task Scheduler with
LogonType=Interactive. A task registered that way runs IN the target
user's actual interactive session when they're logged on -- this is the
same mechanism Windows services use to (rarely, deliberately) show UI to a
logged-in user. Verified by the same SessionId probe: a task launched this
way reports SessionId 2.

Usage: open_url.py 'https://www.youtube.com/watch?v=...'
"""
import base64
import subprocess
import sys

POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
CHROME_ARG = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TASK_NAME = "MarvinOpenUrl"


def main():
    if len(sys.argv) != 2:
        print("usage: open_url.py <url>", file=sys.stderr)
        sys.exit(1)
    url = sys.argv[1]
    if not (url.startswith("http://") or url.startswith("https://")):
        print("refusing to open non-http(s) url", file=sys.stderr)
        sys.exit(1)

    ps_url = url.replace("'", "''")  # PowerShell single-quoted string escaping
    ps_script = f"""
$action = New-ScheduledTaskAction -Execute '{CHROME_ARG}' -Argument '--new-window {ps_url}'
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive
Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName '{TASK_NAME}'
Start-Sleep -Seconds 2
(Get-ScheduledTaskInfo -TaskName '{TASK_NAME}').LastTaskResult
"""
    encoded = base64.b64encode(ps_script.encode("utf-16-le")).decode("ascii")

    result = subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"failed: rc={result.returncode} stderr={result.stderr[-300:]!r}", file=sys.stderr)
        sys.exit(result.returncode)
    # Stdout carries PowerShell's own CLIXML progress-stream noise plus the
    # task's LastTaskResult (0 == success) on its own line -- not worth a
    # strict parse, the exit code above already tells us the launch command
    # itself didn't error.
    print(f"opened (new Chrome window, interactive session): {url}")


if __name__ == "__main__":
    main()
