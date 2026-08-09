@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mikrofon-mindenhol.ps1" -Nev 'High Definition' -Szint 100
