# =====================================================================
#  MIKROFON-EROSITES  --  minden bemeneti eszkoz hangereje MAXRA
# =====================================================================
#  MIERT: a Boss 1 METERROL szeretne diktalni, tehat minden dB szamit.
#  Eddig csak a fejhallgato endpointjat mertem; a webkamera mikrofonjaet nem.
#
#  !VTABLE-TANULSAG (ma egyszer mar elbuktam rajta): a PowerShell/C# COM-interface
#    metodusainak SORRENDJE a vtable. Ha elcsuszik, NEM hibat kapsz, hanem HAZUGSAGOT:
#    elsore 6 helykitolto metodust irtam oda, ahol 4 van, es igy a "GetMute" hivasom
#    valojaban VolumeStepUp-ot hivott -- a diagnosztika MEGEMELTE a hangerot, es
#    kozben hamis "nemitva" erteket irt ki. Az alabbi sorrend a HELYES:
#      1 Register 2 Unregister 3 GetChannelCount 4 SetMasterVolumeLevel
#      5 SetMasterVolumeLevelScalar 6 GetMasterVolumeLevel 7 GetMasterVolumeLevelScalar
#      8 SetChannelVolumeLevel 9 SetChannelVolumeLevelScalar
#      10 GetChannelVolumeLevel 11 GetChannelVolumeLevelScalar
#      12 SetMute 13 GetMute 14 GetVolumeStepInfo 15 VolumeStepUp 16 VolumeStepDown
#      17 QueryHardwareSupport 18 GetVolumeRange
#  ***KODOLAS: 100% ASCII.
# =====================================================================
$ErrorActionPreference = 'Stop'
trap { Write-Host "`n  HIBA: $($_.Exception.Message)" -ForegroundColor Red; Write-Host "  (Enter = bezar)"; [void](Read-Host); exit 1 }

# *2026-08-09: a COM-tipus mostantol a KOZOS `micgain.ps1`-ben el.
# Indok: ket kulon masolat volt belole, es egy vtable-javitas konnyen csak az
# egyikbe kerult volna be -- pont abbol a hibabol, ami ma mar egyszer megtevesztett.
. (Join-Path $PSScriptRoot 'micgain.ps1')

Write-Host ""
Write-Host "  ===== MIKROFON-EROSITES: minden bemenet MAXRA =====" -ForegroundColor Cyan
Write-Host ""
Write-Host ([MicGain]::MaxAllInputs($true))
Write-Host "  Kesz. A hardveres erosites ezzel a PLAFONON van." -ForegroundColor Green
Write-Host "  Ami ezen tul kell, azt a diktalas SZOFTVERESEN teszi hozza" -ForegroundColor DarkGray
Write-Host "  (normalizalas: a csucsot 85%-ra viszi, max 25x erositessel)." -ForegroundColor DarkGray
Write-Host ""
