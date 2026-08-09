@echo off
cd /d "%~dp0"
REM 80%%: ez volt a webkamera legjobb mert allapota (2026-08-09 19:59, avg_logprob -0.185).
REM A 100%% NEM adott tobbet: a Windows hangero-csuszka ennel az eszkoznel nem hat
REM (merve: 80%% -> csucs 33.9%%, 100%% -> csucs 32.8%%).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mikrofon-mindenhol.ps1" -Nev Realtek -Szint 80
