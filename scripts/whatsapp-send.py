#!/usr/bin/env python3
"""
WhatsApp message delivery to a configured contact via Windows Desktop
automation, executed through Task Scheduler (LogonType Interactive) from WSL.

Usage:
  python3 whatsapp-send.py "Message text"
  python3 whatsapp-send.py "Message" --retries 3
  python3 whatsapp-send.py --dry-run "Message"      # no keystrokes, checks only

Flow:
1. Resolve powershell.exe (WSL PATH often has no /mnt/c entries).
2. Ensure WhatsApp is running (optional, --skip-launch to bypass).
3. Write a .ps1 to C:\\Users\\Public and run it via Task Scheduler Interactive.
4. Wait for the script's own result file -- this is the ONLY success signal.
5. Email fallback if WhatsApp failed every attempt. The mail is SENT, not
   drafted -- Boss 2026-08-16: "nem kuldod el hanem piszkozatba teszed? mert ha
   errol akkor nem, azt azonnal el kell kuldeni a cimzettnek." That is the
   explicit instruction gmail-send.py's level2 rule was waiting for. A draft is
   now only a last resort: if SENDING itself fails, we still park a draft so the
   text is not lost, and the exit code stays non-zero because nobody received it.

Exit code means DELIVERY, not "WhatsApp worked":
  0 = the recipient has the message (WhatsApp, or the fallback mail was sent)
  1 = the recipient has nothing (both paths failed; look for the draft)

Host-specific values come from the environment, never hardcoded:
  WHATSAPP_CONTACT        contact name typed into WhatsApp search (default: below)
  WHATSAPP_PACKAGE_FAMILY Store package family name used to launch the app
  WHATSAPP_FALLBACK_EMAIL address used by the email fallback -- the SAME person
                          the WhatsApp message was for. No default: an address
                          guessed wrong would mail a stranger.
"""
import argparse
import base64
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

PUBLIC_WSL = "/mnt/c/Users/Public"
PUBLIC_WIN = "C:\\Users\\Public"

# Deliberately more than a surname: "Kiss" alone matches several contacts and
# would rely on WhatsApp's recency ordering to pick the right one. No accented
# characters -- SendKeys types these literally.
DEFAULT_CONTACT = "Kiss Zolt"
DEFAULT_PACKAGE_FAMILY = "5319275A.WhatsAppDesktop_cv1g1gvanyjgm"


def _dotenv_value(name: str) -> str:
    """
    Read one key from the project .env. The scheduled task starts this script
    from a skill, i.e. a plain shell that never sourced .env -- setting the
    variable there alone would look configured and still arrive empty here.
    Reading the file directly closes that gap whatever the launcher does.
    Values are never printed, only used.
    """
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                if key.strip() == name:
                    return val.strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def contact_name() -> str:
    return os.environ.get("WHATSAPP_CONTACT") or _dotenv_value("WHATSAPP_CONTACT") or DEFAULT_CONTACT


def package_family() -> str:
    return (os.environ.get("WHATSAPP_PACKAGE_FAMILY")
            or _dotenv_value("WHATSAPP_PACKAGE_FAMILY") or DEFAULT_PACKAGE_FAMILY)


def fallback_email() -> str:
    return os.environ.get("WHATSAPP_FALLBACK_EMAIL") or _dotenv_value("WHATSAPP_FALLBACK_EMAIL")


def find_powershell() -> str | None:
    """
    Locate powershell.exe. Under WSL the Windows directories are frequently
    absent from PATH (interop still works), so a bare "powershell.exe" raises
    FileNotFoundError -- the failure this script used to die on silently.
    """
    found = shutil.which("powershell.exe")
    if found:
        return found

    candidates = [
        "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
        "/mnt/c/Windows/SysWOW64/WindowsPowerShell/v1.0/powershell.exe",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


PS_EXE = find_powershell()


def run_ps1_task(
    script_name: str,
    ps1_content: str,
    task_name: str = None,
    result_file: str = None,
    wait_seconds: int = 45,
) -> tuple[int, str, str]:
    """
    Run a PowerShell script through Task Scheduler Interactive.

    Returns (rc, powershell_output, result_text).

    result_file is the WSL path of the file the .ps1 writes when it finishes.
    It is deleted before the run, so a stale file from an earlier attempt can
    never be mistaken for success, and it is polled afterwards -- the previous
    version slept a fixed 2s and then reported success regardless.
    """
    if task_name is None:
        task_name = script_name

    if PS_EXE is None:
        return 1, "powershell.exe not found (checked PATH and /mnt/c/Windows)", ""

    try:
        if result_file and os.path.exists(result_file):
            os.remove(result_file)

        ps1_path = f"{PUBLIC_WSL}/marvin_{script_name}.ps1"
        ps1_path_win = f"{PUBLIC_WIN}\\marvin_{script_name}.ps1"

        with open(ps1_path, "w", encoding="utf-8-sig") as f:
            f.write(ps1_content.replace("\n", "\r\n"))

        wrapper = f'''
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File {ps1_path_win}"
$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "{task_name}" -Action $action -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName "{task_name}" -ErrorAction Stop
'''

        result = subprocess.run(
            [PS_EXE, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", wrapper],
            capture_output=True,
            text=True,
            timeout=60,
        )

        result_text = ""
        if result_file:
            deadline = time.time() + wait_seconds
            while time.time() < deadline:
                if os.path.exists(result_file):
                    time.sleep(0.3)  # let the writer finish flushing
                    try:
                        result_text = Path(result_file).read_text(
                            encoding="utf-8-sig", errors="replace"
                        ).strip()
                    except OSError:
                        result_text = ""
                    break
                time.sleep(0.5)

        try:
            subprocess.run(
                [PS_EXE, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                 f"Unregister-ScheduledTask -TaskName '{task_name}' -Confirm:$false -ErrorAction SilentlyContinue"],
                capture_output=True,
                timeout=15,
            )
        except Exception:
            pass

        return result.returncode, (result.stdout or "") + (result.stderr or ""), result_text
    except Exception as e:
        return 1, f"PowerShell error: {e}", ""


def whatsapp_is_running() -> bool:
    """True only if the scheduled task actually reported RUNNING."""
    result_wsl = f"{PUBLIC_WSL}/marvin_ws_state.txt"
    result_win = f"{PUBLIC_WIN}\\marvin_ws_state.txt"
    # The desktop app's process is called WhatsApp.Root (not WhatsApp), so an
    # exact -Name WhatsApp match never finds it -- the wildcard is required.
    check_script = f'''
$running = Get-Process -Name 'WhatsApp*' -ErrorAction SilentlyContinue
if ($running) {{ $s = "RUNNING" }} else {{ $s = "NOT_RUNNING" }}
$s | Out-File -FilePath {result_win} -Encoding utf8 -Force
'''
    _, _, state = run_ps1_task("check", check_script, "ws_check",
                               result_file=result_wsl, wait_seconds=30)
    return "NOT_RUNNING" not in state and "RUNNING" in state


def ensure_whatsapp_running() -> bool:
    if whatsapp_is_running():
        print("✓ WhatsApp already running")
        return True

    print("→ Launching WhatsApp...")
    result_wsl = f"{PUBLIC_WSL}/marvin_ws_launch.txt"
    result_win = f"{PUBLIC_WIN}\\marvin_ws_launch.txt"
    launch_script = f'''
$ErrorActionPreference = 'SilentlyContinue'
Start-Process "explorer.exe" -ArgumentList "shell:AppsFolder\\{package_family()}!App"
# Wait for a real window, not just a process: the background process can be
# alive for hours with the UI closed.
$s = "LAUNCH_FAILED"
for ($i = 0; $i -lt 20; $i++) {{
  Start-Sleep -Seconds 1
  $p = Get-Process -Name 'WhatsApp*' -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowHandle -ne [IntPtr]::Zero }}
  if ($p) {{ $s = "LAUNCHED"; break }}
}}
$s | Out-File -FilePath {result_win} -Encoding utf8 -Force
'''
    _, out, state = run_ps1_task("launch", launch_script, "ws_launch",
                                 result_file=result_wsl, wait_seconds=45)

    if "LAUNCHED" in state:
        print("  ✓ WhatsApp started")
        return True

    print(f"✗ Could not start WhatsApp ({state or out.strip()[:120] or 'no response'})")
    return False


def send_whatsapp_message(message: str, dry_run: bool = False,
                          select_only: bool = False) -> bool:
    """
    Deliver the message. Returns True ONLY when the Windows-side script wrote
    SENT into its result file -- never on a bare exit code.

    dry_run stops once WhatsApp is focused, before any keystroke.
    select_only goes one step further: it opens the contact's chat and takes a
    screenshot, then stops before pasting. That proves the search term lands on
    the intended chat without a message reaching anyone.
    """
    result_wsl = f"{PUBLIC_WSL}/marvin_send_status.txt"
    result_win = f"{PUBLIC_WIN}\\marvin_send_status.txt"

    # The message travels as base64 so quotes, $ signs and newlines in the
    # analysis text cannot break out of the PowerShell literal or be
    # interpolated as variables.
    encoded = base64.b64encode(message.encode("utf-8")).decode("ascii")

    send_script = f'''
$ErrorActionPreference = 'SilentlyContinue'
$dryRun = ${'true' if dry_run else 'false'}
$selectOnly = ${'true' if select_only else 'false'}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32X {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}}
"@
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-Result($text) {{
  $text | Out-File -FilePath {result_win} -Encoding utf8 -Force
}}

# 'WhatsApp*' matches WhatsApp.Root, the real process name of the desktop app.
$proc = Get-Process -Name 'WhatsApp*' -ErrorAction SilentlyContinue | Where-Object {{ $_.MainWindowHandle -ne [IntPtr]::Zero }} | Select-Object -First 1
if (-not $proc) {{
  Write-Result "NO_WINDOW"
  exit
}}

[Win32X]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
[Win32X]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 1200

# Never type blind: if WhatsApp is not the foreground window the keystrokes
# would land in whatever app is focused, pasting the message somewhere else.
$fg = [Win32X]::GetForegroundWindow()
if ($fg -ne $proc.MainWindowHandle) {{
  Write-Result "NOT_FOREGROUND"
  exit
}}

if ($dryRun) {{
  Write-Result "DRYRUN_OK"
  exit
}}

# Escape alone does NOT empty the search box -- a previous run's term stays
# and the new one is appended to it ("KissKiss Zolt" -> no results), so the
# field has to be selected and deleted explicitly.
[System.Windows.Forms.SendKeys]::SendWait("{{ESC}}")
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait("^f")
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait("{{DEL}}")
Start-Sleep -Milliseconds 400
[System.Windows.Forms.SendKeys]::SendWait("{contact_name()}")
Start-Sleep -Milliseconds 900
[System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
Start-Sleep -Milliseconds 900

function Save-Screen($path) {{
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}}

if ($selectOnly) {{
  Save-Screen("{PUBLIC_WIN}\\whatsapp_target.png")
  Write-Result "SELECTED"
  exit
}}

$message = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("{encoded}"))
Set-Clipboard -Value $message
Start-Sleep -Milliseconds 400

# Confirm the clipboard really holds our text before pressing Enter.
$clip = Get-Clipboard -Raw
if ($clip -ne $message) {{
  Write-Result "CLIPBOARD_MISMATCH"
  exit
}}

[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 800
[System.Windows.Forms.SendKeys]::SendWait("{{ENTER}}")
Start-Sleep -Milliseconds 2000

Save-Screen("{PUBLIC_WIN}\\whatsapp_verify.png")
Write-Result "SENT"
'''

    print("  → running WhatsApp automation...")
    rc, out, state = run_ps1_task("send", send_script, "ws_send",
                                  result_file=result_wsl, wait_seconds=60)

    if state.startswith("SENT"):
        print(f"  ✓ message delivered (screenshot: {PUBLIC_WIN}\\whatsapp_verify.png)")
        return True
    if state.startswith("SELECTED"):
        print(f"  ✓ chat opened, nothing sent -- check {PUBLIC_WIN}\\whatsapp_target.png "
              f"that '{contact_name()}' selected the intended conversation")
        return True
    if state.startswith("DRYRUN_OK"):
        print("  ✓ dry run: WhatsApp focused, no keystrokes sent")
        return True

    reasons = {
        "NO_WINDOW": "WhatsApp has no open window",
        "NOT_FOREGROUND": "could not bring WhatsApp to the foreground -- aborted before typing",
        "CLIPBOARD_MISMATCH": "clipboard did not contain the message",
    }
    detail = reasons.get(state.strip(), state.strip() or f"no response from the Windows script (rc={rc}) {out.strip()[:160]}")
    print(f"  ✗ send failed: {detail}")
    return False


def send_email_fallback(message: str, recipient: str = None) -> bool:
    """
    Email fallback. SENDS the mail (Boss: "azt azonnal el kell kuldeni a
    cimzettnek"), so True here means the recipient really has it.

    If sending fails we drop back to a draft -- not as a success, only so the
    text survives somewhere instead of evaporating with the process. That case
    returns False, because a draft is not a delivery.

    The gmail.send OAuth scope is already granted (scripts/google-auth.py:52),
    so this needs no new authorisation.
    """
    recipient = recipient or fallback_email()
    if not recipient:
        print("✗ no fallback address configured (WHATSAPP_FALLBACK_EMAIL)")
        return False

    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "gmail-send.py")
    if not os.path.exists(helper):
        print(f"✗ helper not found: {helper}")
        return False

    try:
        msg_file = "/tmp/whatsapp_fallback_msg.txt"
        with open(msg_file, "w", encoding="utf-8") as f:
            f.write(message)
    except OSError as e:
        print(f"✗ email fallback error: cannot stage the message: {e}")
        return False

    def _gmail(mode: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, helper, mode, recipient, "Arany technikai elemzés", msg_file],
            capture_output=True, text=True, timeout=30,
        )

    print(f"\n📧 email fallback -> {recipient} (sending)...")
    try:
        result = _gmail("send")
        if result.returncode == 0:
            print(f"✓ email SENT to {recipient}")
            return True

        err = (result.stderr or "").lower()
        if "insufficient" in err or "permission" in err:
            print("✗ send refused: OAuth scope problem -- the owner needs to re-authorise")
        else:
            print(f"✗ send failed: {(result.stderr or '')[:200]}")
    except Exception as e:
        print(f"✗ email fallback error: {e}")

    # Last resort: keep the text somewhere retrievable. Still not a delivery.
    try:
        if _gmail("draft").returncode == 0:
            print(f"↳ a draft was parked for {recipient} -- it still has to be sent by hand")
        else:
            print("↳ could not even park a draft; the text is in /tmp/whatsapp_fallback_msg.txt")
    except Exception:
        print("↳ could not even park a draft; the text is in /tmp/whatsapp_fallback_msg.txt")
    return False


def main() -> bool:
    parser = argparse.ArgumentParser(description="Send a WhatsApp message to the configured contact")
    parser.add_argument("message", help="message text")
    parser.add_argument("--retries", type=int, default=3, help="attempts (default: 3)")
    parser.add_argument("--no-fallback", action="store_true", help="disable the email fallback")
    parser.add_argument("--skip-launch", action="store_true", help="assume WhatsApp is already open")
    parser.add_argument("--dry-run", action="store_true",
                        help="check reachability and focus, send no keystrokes")
    parser.add_argument("--select-only", action="store_true",
                        help="open the contact's chat and screenshot it, then stop "
                             "before pasting -- proves the search hits the right chat")

    args = parser.parse_args()

    def _wa_ut_halott(reason: str) -> bool:
        """The WhatsApp path cannot be used at all -- fall back to email.

        Boss, 2026-08-16: the message must reach the recipient. Until now these
        cases (no powershell, app not running) returned False on the spot and
        never tried the fallback, so a broken WhatsApp meant nobody got
        anything. Measured on 2026-08-19: powershell.exe was unreachable from
        WSL, which is exactly this path.

        The probes (--dry-run, --select-only) never send: they exist to report
        what is broken, and mailing the recipient during a diagnostic would be
        a surprise.
        """
        print(f"✗ WhatsApp path unusable: {reason}")
        if args.dry_run or args.select_only:
            return False
        if args.no_fallback:
            print("✗ NOT DELIVERED: WhatsApp is unusable and the email fallback is switched off")
            return False
        if send_email_fallback(args.message):
            print(f"⚠ WhatsApp is BROKEN -- delivered by email instead, to {fallback_email()}")
            return True
        print("✗ NOT DELIVERED: neither WhatsApp nor email reached the recipient")
        return False

    if PS_EXE is None:
        return _wa_ut_halott("powershell.exe not found (Windows automation is "
                             "unavailable from this shell)")

    print(f"🔔 WhatsApp send -> contact '{contact_name()}'")
    print(f"   {args.message[:60]}{'...' if len(args.message) > 60 else ''}")
    if args.dry_run:
        print("   (dry run -- nothing will be sent)")
    elif args.select_only:
        print("   (select-only -- the chat is opened, nothing is sent)")

    if not args.skip_launch:
        if not ensure_whatsapp_running():
            return _wa_ut_halott("WhatsApp is not running and could not be started")
    elif not whatsapp_is_running():
        return _wa_ut_halott("--skip-launch was given but WhatsApp is not running")

    for attempt in range(1, args.retries + 1):
        print(f"\n📨 attempt {attempt}/{args.retries}...")

        if send_whatsapp_message(args.message, dry_run=args.dry_run,
                                 select_only=args.select_only):
            print("✓ WhatsApp OK")
            return True

        if attempt < args.retries:
            wait_time = 5 * attempt
            print(f"  retrying in {wait_time}s...")
            time.sleep(wait_time)

    # The fallback SENDS (Boss 2026-08-16), so a True from here means the
    # recipient genuinely has the message -- by email, not WhatsApp, and that
    # difference stays visible in the output, or a permanently broken WhatsApp
    # would never be noticed.
    return _wa_ut_halott(f"the send failed {args.retries}x")


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
