@echo off
chcp 65001 >nul
title Magyar diktalas
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diktal.ps1"
if errorlevel 1 (
  echo.
  echo [HIBA] A szkript hibaval allt le. A fenti uzenet mondja meg, miert.
  pause
)
