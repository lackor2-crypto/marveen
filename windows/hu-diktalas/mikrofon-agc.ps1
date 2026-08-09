# =====================================================================
#  MIKROFON AGC  --  vizsgalat / kikapcsolas (burkolo)
# =====================================================================
#  A tenyleges COM-kod a KOZOS `micgain.ps1`-ben el ([MicGain]::AgcScan).
#  !MIERT: eloszor itt volt egy sajat Add-Type blokk, ami ujra definialta a
#  COM-tipusokat. Ha mindket fajl betoltodott egy folyamatba, a CLR ket
#  kulonbozo tipusnak latta oket, es a cast elhasalt:
#     "Unable to cast object of type 'MMDeviceEnumerator' to type 'MMDeviceEnumerator'"
#  Tanulsag: COM-tipusbol EGY definicio letezhet.
#
#  Hasznalat:  mikrofon-agc.ps1              (csak megmutatja)
#              mikrofon-agc.ps1 -Kikapcsol   (ki is kapcsolja)
#  ***KODOLAS: 100% ASCII.
# =====================================================================
param([switch]$Kikapcsol, [string]$Nev = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'micgain.ps1')
Write-Host ""
Write-Host "  ===== MIKROFON AGC-VIZSGALAT =====" -ForegroundColor Cyan
Write-Host ""
Write-Host ([MicGain]::AgcScan($Nev, $Kikapcsol.IsPresent))
if (-not $Kikapcsol) {
  Write-Host "  (csak vizsgalat. Kikapcsolas:  mikrofon-agc.ps1 -Kikapcsol)" -ForegroundColor DarkGray
}
Write-Host ""
