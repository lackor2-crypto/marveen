@echo off
REM ---------------------------------------------------------------------------
REM Launcher for the Marvin code-bridge worker.
REM
REM Put this next to marvin-code-worker.ps1 and start it from shell:startup or a
REM scheduled task (see docs/code-bridge.md). It only starts the PowerShell
REM worker minimized and exits; the worker keeps running with its own singleton
REM mutex, so a double start is harmless.
REM
REM ASCII ONLY, DELIBERATELY: cmd.exe reads a batch file in the OEM codepage,
REM not UTF-8. A single accented character in a path or comment here corrupts
REM the rest of the line and the failure is silent -- that exact bug once made
REM a dispatched task hang with zero output. Never put a user name, an accented
REM path or a non-ASCII comment in this file; %~dp0 and %USERPROFILE% carry
REM whatever the real path is without spelling it out.
REM ---------------------------------------------------------------------------
setlocal
set "WORKER=%~dp0marvin-code-worker.ps1"
if not exist "%WORKER%" (
  echo marvin-code-worker.ps1 not found next to this launcher: "%WORKER%"
  exit /b 1
)
start "MarvinCodeWorker" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%WORKER%" %*
endlocal
