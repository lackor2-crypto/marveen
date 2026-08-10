#!/usr/bin/env python3
"""Save and restore the Windows desktop's window layout from WSL, via
PersistentWindows (kangyu-california/PersistentWindows, installed by winget).

Why this is not a one-liner: moving or enumerating windows only works from
INSIDE the logged-in console session. A process started through WSL interop
lands in Windows Session 0 -- the isolated services session -- where it cannot
see the user's windows at all, and fails silently (the same trap documented in
the win-browser-control and windows-desktop-screenshot skills). So every call
goes through a Task Scheduler task registered with LogonType=Interactive, which
really does run in the user's session.

PersistentWindows' capture/restore command lines are one-shot: they do the work
and exit, so nothing is left running in the tray afterwards. Restore is issued
TWICE by design -- the project's own Help.md states that a second restore is
needed to place windows that were launched by the first one.

Usage:
  window_layout.py save [name]      capture the current layout under `name`
  window_layout.py restore [name]   put the windows back where `name` says
  window_layout.py list             list the layouts saved on disk

`name` defaults to "marvin". A layout name must be a plain word (letters,
digits, dash, underscore) -- it is passed to a Windows command line, and this
script refuses anything else rather than quoting its way around the problem.
"""
import json
import re
import subprocess
import sys
import time
from pathlib import Path

POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
TASK_NAME = "MarvinWindowLayout"
DEFAULT_NAME = "marvin"
NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
STATE_PATH = Path.home() / ".claude" / "skills" / "win-window-layout" / "state" / "last-action.json"

# Paths are resolved on the WINDOWS side (never interpolated from bash): this
# machine's user name contains accents, which do not survive the WSL -> Windows
# code-page hop (see the win-browser-control skill).
#
# The winget "Links" shim (WinGet\Links\PersistentWindows.exe) does NOT work for
# this: called through it, -capture_to_disk returned success and wrote nothing
# at all (measured 2026-08-10). The real executable under Packages\ does work,
# so the path is globbed rather than hardcoded to a version.
PS_RESOLVE_EXE = (
    r"$exe = (Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "
    r"'Microsoft\WinGet\Packages') -Filter 'PersistentWindows.exe' -Recurse "
    r"-ErrorAction SilentlyContinue | Select-Object -First 1).FullName"
)
# Captures live in a LiteDB database, not in per-capture files -- so the names
# cannot be listed by reading a directory (see list_layouts).
PS_DATA_DIR = r"$env:LOCALAPPDATA\PersistentWindows"
INDEX_PATH = Path.home() / ".claude" / "skills" / "win-window-layout" / "state" / "layouts.json"


def run_ps(script: str, timeout: int = 90) -> subprocess.CompletedProcess:
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, timeout=timeout,
    )


def run_in_session(inner_ps: str, timeout: int = 120) -> subprocess.CompletedProcess:
    """Runs `inner_ps` inside the interactive session via Task Scheduler.

    The script file is written on the Windows side and the task is started with
    a hidden window: a visible console would steal the foreground, which on this
    machine has already eaten a simulated click once (see windows-desktop-input).
    """
    script_path = "C:\\Users\\Public\\marvin_window_layout_inner.ps1"
    wsl_path = "/mnt/c/Users/Public/marvin_window_layout_inner.ps1"
    Path(wsl_path).write_text(inner_ps, encoding="utf-8")
    return run_ps(f"""
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File {script_path}'
$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive
Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName '{TASK_NAME}'
""", timeout=timeout)


def capture(name: str) -> None:
    inner = f"""
$ErrorActionPreference = 'Continue'
{PS_RESOLVE_EXE}
$p = Start-Process -FilePath $exe -ArgumentList '-capture_to_disk','{name}' -PassThru -WindowStyle Hidden
$p.WaitForExit(20000) | Out-Null
if (-not $p.HasExited) {{ Stop-Process -Id $p.Id -Force }}
"done" | Out-File -FilePath C:\\Users\\Public\\marvin_window_layout_status.txt -Force
"""
    run_in_session(inner)


def restore(name: str) -> None:
    # Twice on purpose: Help.md documents that a second restore is required to
    # position windows that the first restore launched.
    inner = f"""
$ErrorActionPreference = 'Continue'
{PS_RESOLVE_EXE}
foreach ($i in 1..2) {{
  $p = Start-Process -FilePath $exe -ArgumentList '-restore_disk_capture','{name}' -PassThru -WindowStyle Hidden
  $p.WaitForExit(30000) | Out-Null
  if (-not $p.HasExited) {{ Stop-Process -Id $p.Id -Force }}
  Start-Sleep -Seconds 3
}}
"done" | Out-File -FilePath C:\\Users\\Public\\marvin_window_layout_status.txt -Force
"""
    run_in_session(inner, timeout=180)


def db_mtime() -> str:
    """Last time PersistentWindows' capture database changed -- the only
    file-level evidence that a capture actually landed."""
    res = run_ps(f"""
$dir = "{PS_DATA_DIR}"
if (Test-Path $dir) {{
  Get-ChildItem -Path $dir -Filter '*.db' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 |
    ForEach-Object {{ $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss') }}
}}
""")
    return res.stdout.strip()


def list_layouts() -> list:
    """PersistentWindows keeps every capture inside ONE LiteDB database, so the
    names are not readable from the filesystem. This lists what THIS tool saved
    (a layout captured by hand from the tray app will not appear here) -- said
    plainly rather than pretending the list is authoritative."""
    try:
        return json.loads(INDEX_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []


def remember_layout(name: str) -> None:
    layouts = [l for l in list_layouts() if l.get("name") != name]
    layouts.append({"name": name, "saved_at": time.strftime("%Y-%m-%d %H:%M")})
    layouts.sort(key=lambda l: l["name"])
    try:
        INDEX_PATH.parent.mkdir(parents=True, exist_ok=True)
        INDEX_PATH.write_text(json.dumps(layouts, indent=2), encoding="utf-8")
    except OSError:
        pass


def wait_for_status(before: float, seconds: int) -> bool:
    """The inner script writes a status file when it finishes. Task Scheduler
    returns as soon as the task is STARTED, so the file is the only honest
    signal that the work actually ran."""
    status = Path("/mnt/c/Users/Public/marvin_window_layout_status.txt")
    for _ in range(seconds * 2):
        try:
            if status.exists() and status.stat().st_mtime > before:
                return True
        except OSError:
            pass
        time.sleep(0.5)
    return False


def write_state(action: str, name: str, ok: bool) -> None:
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps({
            "action": action, "name": name, "ok": ok, "at": int(time.time()),
        }, indent=2), encoding="utf-8")
    except OSError:
        pass  # a record, not a dependency


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] not in {"save", "restore", "list"}:
        print("usage: window_layout.py save|restore [name] | list", file=sys.stderr)
        sys.exit(1)
    action = args[0]

    if action == "list":
        layouts = list_layouts()
        if not layouts:
            print("no saved layouts yet")
            return
        for l in layouts:
            print(f"{l['name']:<20} {l['saved_at']}")
        print(f"(capture database last changed: {db_mtime() or 'unknown'})")
        return

    name = args[1] if len(args) > 1 else DEFAULT_NAME
    if not NAME_RE.match(name):
        print(f"invalid layout name {name!r}: use letters, digits, dash, underscore", file=sys.stderr)
        sys.exit(1)

    started = time.time()
    if action == "save":
        capture(name)
        ok = wait_for_status(started, 30)
    else:
        restore(name)
        ok = wait_for_status(started, 60)

    write_state(action, name, ok)
    if not ok:
        print(f"{action} '{name}': the task did not report completion in time", file=sys.stderr)
        sys.exit(2)
    if action == "save":
        # PersistentWindows exits 0 whether or not it captured anything, so the
        # database file's timestamp is the real check.
        touched = db_mtime()
        if not touched:
            print(f"save '{name}': command ran but no capture database appeared", file=sys.stderr)
            sys.exit(3)
        remember_layout(name)
        print(f"saved window layout '{name}' (capture db updated {touched})")
    else:
        print(f"restored window layout '{name}'")


if __name__ == "__main__":
    main()
