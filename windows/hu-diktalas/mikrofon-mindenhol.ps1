# =====================================================================
#  MIKROFON MINDENHOL  --  egy parancs, es MINDEN program ugyanazt hasznalja
# =====================================================================
#  MIERT: a Boss webkonferencian (Zoom / Teams / Meet / bongeszo) is ugyanazt a
#  mikrofont akarja hasznalni, 1 meterrol. Azok a programok viszont NEM a mi
#  `mikrofon.txt`-unket nezik, hanem a WINDOWS ALAPERTELMEZETT felvevo eszkozet.
#  Ez a szkript mind a kettot egyszerre allitja be:
#     1. rendszer-alapertelmezett  MIND A HAROM szerepre (Console/Multimedia/
#        Communications) -- a konferencia-programok tobbnyire a Communications-t
#        hasznaljak, ezert nem eleg csak az egyiket atallitani
#     2. nemitas feloldasa + ertelmes szint (nem a maximum! ld. lentebb)
#     3. a mi diktalasunk `mikrofon.txt`-je -- hogy a ketto SOSE csusszon szet
#
#  *A SZINT NEM 100%: merve (2026-08-09) a webkamera mikrofonja 100%-on VAGOTT
#    (csucs 100%, RMS 16.7%), es a vagas rontja a beszedfelismerest. A cel a
#    vagas alatti legnagyobb szint. A diktalas ezt onmagatol tovabb hangolja.
#
#  Hasznalat:
#     mikrofon-mindenhol.ps1              -> a `mikrofon.txt`-ben allo eszkoz
#     mikrofon-mindenhol.ps1 Realtek      -> a webkamera mikrofonja (1 meter)
#     mikrofon-mindenhol.ps1 "High Definition"  -> a fejhallgato karmikrofonja
#  ***KODOLAS: 100% ASCII.
# =====================================================================
param([string]$Nev = '', [int]$Szint = 55)

$ErrorActionPreference = 'Stop'
trap { Write-Host "`n  HIBA: $($_.Exception.Message)" -ForegroundColor Red; Write-Host "  (Enter = bezar)"; [void](Read-Host); exit 1 }

$Base = $PSScriptRoot
. (Join-Path $Base 'micgain.ps1')
. (Join-Path $Base 'recorder.ps1')

$micFile = Join-Path $Base 'mikrofon.txt'
if (-not $Nev) {
  if (Test-Path $micFile) { $Nev = (Get-Content $micFile -Raw).Trim() }
  if (-not $Nev) { $Nev = 'Realtek' }
}

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    MIKROFON MINDENHOL  --  cel: '$Nev'" -ForegroundColor Cyan
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  ELOTTE -- a rendszer alapertelmezett bemenete:" -ForegroundColor DarkGray
Write-Host ([MicGain]::ReportDefaults())

# --- 1. rendszer-alapertelmezett mind a harom szerepre ---
$res = [MicGain]::SetDefault($Nev)
if ($res -like 'HIBA*') {
  Write-Host "  $res" -ForegroundColor Red
  Write-Host ""
  Write-Host "  Elerheto bemenetek: $([HuWaveRecorder]::ListDevices())" -ForegroundColor Yellow
  Write-Host "  (Enter = bezar)"; [void](Read-Host); exit 1
}
Write-Host "  [1/3] Rendszer-alapertelmezett beallitva: $res" -ForegroundColor Green

# --- 2. nemitas fel + szint ---
$vol = [MicGain]::SetVolume($Nev, $Szint)
Write-Host "  [2/3] Bemeneti szint: $vol%  (szandekosan NEM 100% -- a vagas rontja a felismerest)" -ForegroundColor Green

# --- 3. a diktalas is ugyanazt hasznalja ---
$Nev | Set-Content -Path $micFile -Encoding UTF8 -NoNewline
$idx = [HuWaveRecorder]::FindDevice($Nev)
Write-Host "  [3/3] A diktalas is ezt nyitja: [$idx] $([HuWaveRecorder]::DeviceName($idx))" -ForegroundColor Green

Write-Host ""
Write-Host "  UTANA -- a rendszer alapertelmezett bemenete:" -ForegroundColor DarkGray
Write-Host ([MicGain]::ReportDefaults())

Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    KESZ. Mostantol MINDEN program ezt a mikrofont hasznalja." -ForegroundColor Green
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  FIGYELEM a mar FUTO programokra:" -ForegroundColor Yellow
Write-Host "    A Zoom / Teams / Chrome sokszor a INDITASKORI eszkozt tartja meg." -ForegroundColor Yellow
Write-Host "    Ha kozben valtottal, a program sajat hang-beallitasaban valaszd ki" -ForegroundColor Yellow
Write-Host "    ujra a mikrofont, vagy inditsd ujra a programot." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Visszavaltas a fejhallgatora:" -ForegroundColor DarkGray
Write-Host "    mikrofon-mindenhol.ps1 'High Definition'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  (Enter = bezar)"
[void](Read-Host)
