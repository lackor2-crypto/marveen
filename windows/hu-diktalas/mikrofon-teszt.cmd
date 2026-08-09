@echo off
chcp 65001 >nul
title Mikrofon teszt
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mikrofon-teszt.ps1"
