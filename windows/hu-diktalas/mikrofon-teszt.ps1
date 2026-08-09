# =====================================================================
#  MIKROFON-TESZT  --  megmeri, megerkezik-e a hangod
# =====================================================================
#  Nem hiv API-t, nem kerul semmibe. Azt meri meg, ami a diktalas
#  szempontjabol egyedul szamit: milyen ERos a jel, amit a mikrofon ad.
#  ***CSAK ASCII karakterek! (a PowerShell 5.1 ANSI-kent olvassa a .ps1-et)
# =====================================================================
$ErrorActionPreference = 'Stop'
trap { Write-Host "`n  HIBA: $($_.Exception.Message)" -ForegroundColor Red; Write-Host "  (Enter = bezar)"; [void](Read-Host); exit 1 }

. (Join-Path $PSScriptRoot 'recorder.ps1')
$Wav = Join-Path $env:TEMP 'mikrofon_teszt.wav'
Remove-Item $Wav -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "   MIKROFON-TESZT" -ForegroundColor Cyan
Write-Host "   ==============" -ForegroundColor Cyan
Write-Host ""
Write-Host "   5 masodpercig beszelj NORMAL hangeron, ahogy diktalni szoktal." -ForegroundColor Yellow
Write-Host "   Pl.: 'Egy ket harom negy ot, ez itt a mikrofon teszt.'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "   Enter = inditas"
[void](Read-Host)

$rec = New-Object HuWaveRecorder
if (-not $rec.Start()) { throw "A felvetel nem indult el (waveIn hibakod: $($rec.LastError))." }
[console]::Beep(880,120)
Write-Host "   BESZELJ MOST..." -ForegroundColor Red
Start-Sleep -Seconds 5
[void]$rec.StopAndSave($Wav)
[console]::Beep(440,120)

$b = [System.IO.File]::ReadAllBytes($Wav)
$rate = [BitConverter]::ToInt32($b,24); $bits = [BitConverter]::ToInt16($b,34)
$peak = 0; [double]$sum = 0; $n = 0
for ($k = 44; $k -lt $b.Length - 1; $k += 2) {
  $s = [BitConverter]::ToInt16($b,$k); $a = [Math]::Abs([int]$s)
  if ($a -gt $peak) { $peak = $a }; $sum += [double]$s * $s; $n++
}
$rms = if ($n) { [Math]::Sqrt($sum/$n) } else { 0 }
$pk  = [math]::Round($peak/32768*100, 1)
$rm  = [math]::Round($rms/32768*100, 2)
Remove-Item $Wav -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "   formatum : $rate Hz, $bits bit" -ForegroundColor DarkGray
Write-Host "   csucs    : $pk %" -ForegroundColor White
Write-Host "   atlag    : $rm %" -ForegroundColor White
Write-Host ""
# A csucs onmagaban felrevezet (egy koppanas is felviszi). A beszedet az ATLAG
# (RMS) mutatja meg: ez az, amibol a Whisper dolgozik.
if ($pk -lt 2) {
  Write-Host "   NINCS JEL. A mikrofon nem ad hangot." -ForegroundColor Red
  Write-Host "   -> Be van dugva a fejhallgato MIKROFON-aga is (rozsaszin jack)?" -ForegroundColor Cyan
  Write-Host "   -> Hangbeallitasok > Bemenet: a Microphone (High Definition Audio" -ForegroundColor Cyan
  Write-Host "      Device) legyen kivalasztva, ne a webkamerae (Realtek USB2.0 MIC)." -ForegroundColor Cyan
} elseif ($rm -lt 1) {
  Write-Host "   TUL HALK. Van jel, de a diktalashoz keves." -ForegroundColor Yellow
  Write-Host "   -> Hangbeallitasok > Bemenet > a mikrofon tulajdonsagai > Szintek:" -ForegroundColor Cyan
  Write-Host "      kapcsold be / emeld meg a 'Mikrofonerosites' (Microphone Boost)" -ForegroundColor Cyan
  Write-Host "      erteket +20 vagy +30 dB-re." -ForegroundColor Cyan
  Write-Host "   -> Vagy told kozelebb a mikrofont a szadhoz." -ForegroundColor Cyan
} elseif ($pk -gt 98) {
  Write-Host "   TUL HANGOS -- torzul (vagas). Ez is rontja a felismerest." -ForegroundColor Yellow
  Write-Host "   -> Vedd lejjebb a mikrofon hangerejet vagy a Mikrofonerositest." -ForegroundColor Cyan
} else {
  Write-Host "   JO SZINT. A diktalasnak mukodnie kell." -ForegroundColor Green
}
Write-Host ""
Write-Host "   (Enter = bezar)"
[void](Read-Host)
