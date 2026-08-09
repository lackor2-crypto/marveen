# =====================================================================
#  MIKROFON-VALASZTO  --  MELYIK mikrofon jobb 1 METER tavolsagbol?
# =====================================================================
#  MIERT: a Boss nem akarja a fejere tenni a headsetet -- ulve, kb. 1 meterrol
#  szeretne diktalni. A fejhallgato KARMIKROFONJA 2 cm-re van tervezve, a
#  webkamera mikrofonja viszont eppen szobai tavolsagra. Nem tippelunk: MERUNK.
#
#  A hardveres erosites mar a PLAFONON van (+30 dB, tartomany -16...+30), tehat
#  onnan nincs tovabb -- a tavolsagot ESZKOZVALASZTASSAL es SZOFTVERES
#  NORMALIZALASSAL kell kezelni.
#
#  Az eredmenyt a `mikrofon.txt`-be irja; a diktalas onnan olvassa, melyiket nyissa.
#  ***KODOLAS: 100% ASCII (PS 5.1 ANSI-kent olvassa a .ps1-et).
# =====================================================================
$ErrorActionPreference = 'Stop'
trap { Write-Host "`n  HIBA: $($_.Exception.Message)" -ForegroundColor Red; Write-Host "  (Enter = bezar)"; [void](Read-Host); exit 1 }

$Base = $PSScriptRoot
. (Join-Path $Base 'recorder.ps1')

$SECS = 6

function Get-WavLevel([string]$path) {
  # A WAV fejlecet RENDESEN kiolvassuk (nem feltetelezunk 44 bajtos fejlecet).
  $b = [System.IO.File]::ReadAllBytes($path)
  $fmt = -1; $data = -1; $dataLen = 0; $i = 12
  while ($i -lt $b.Length - 8) {
    $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4)
    $sz = [BitConverter]::ToInt32($b, $i + 4)
    if ($id -eq 'fmt ') { $fmt = $i + 8 }
    if ($id -eq 'data') { $data = $i + 8; $dataLen = $sz; break }
    $i += 8 + $sz + ($sz % 2)
  }
  if ($fmt -lt 0 -or $data -lt 0) { return [pscustomobject]@{ Peak=0.0; Rms=0.0; Dyn=0.0 } }
  $peak = 0.0; $sum = 0.0; $n = 0
  # ***A DINAMIKA a donto mutato (2026-08-09-en merve): a fejhallgato 9.6-11.8x-en
  # jol atirodott, a webkamera 2.8-3.5x-en rosszul -- HOLOTT ott a HANGERO otszoros
  # volt. Az AGC-s mikrofon felhuzza a csendet es lenyomja a csucsokat; a felismero
  # ebbol nehezebben olvas. Ezert keret-RMS-eket is gyujtunk, es a 90/10 percentilis
  # aranyat nezzuk -- ez mutatja, mennyire "hullamzik" a jel, azaz mennyire beszed.
  $FRAME = 800
  $frames = New-Object System.Collections.ArrayList
  $fsum = 0.0; $fn = 0
  $end = [Math]::Min($data + $dataLen - 1, $b.Length - 1)
  for ($k = $data; $k -lt $end; $k += 2) {
    $v = [Math]::Abs([int][BitConverter]::ToInt16($b, $k))
    if ($v -gt $peak) { $peak = $v }
    $sq = [double]$v * $v
    $sum += $sq; $n++; $fsum += $sq; $fn++
    if ($fn -ge $FRAME) { [void]$frames.Add([Math]::Sqrt($fsum/$fn)); $fsum = 0; $fn = 0 }
  }
  if ($fn -gt 0) { [void]$frames.Add([Math]::Sqrt($fsum/$fn)) }
  $rms = if ($n -gt 0) { [Math]::Sqrt($sum / $n) } else { 0 }
  $dyn = 0.0
  if ($frames.Count -ge 8) {
    $srt = @($frames | Sort-Object)
    $lo = $srt[[int]([Math]::Floor($srt.Count * 0.10))]
    $hi = $srt[[int]([Math]::Floor($srt.Count * 0.90))]
    if ($lo -gt 1) { $dyn = [Math]::Round($hi / $lo, 2) }
  }
  [pscustomobject]@{
    Peak = [Math]::Round($peak / 32768.0 * 100, 1)
    Rms  = [Math]::Round($rms  / 32768.0 * 100, 2)
    Dyn  = $dyn
  }
}

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    MIKROFON-VALASZTO -- melyik jobb 1 METERROL?" -ForegroundColor Cyan
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "    Ulj oda, AHONNAN diktalni szeretnel (kb. 1 meter)." -ForegroundColor Yellow
Write-Host "    Mindegyik mikrofonnal $SECS masodpercig beszelj NORMAL hangeron." -ForegroundColor Yellow
Write-Host "    Pl.: 'Egy ketto harom negy ot, ez a mikrofon proba.'" -ForegroundColor Yellow
Write-Host ""

$devs = [HuWaveRecorder]::ListDevices()
Write-Host "    Talalt eszkozok: $devs" -ForegroundColor DarkGray
Write-Host ""

$results = @()
$n = 0
while ($true) {
  $nm = [HuWaveRecorder]::DeviceName($n)
  if ($nm -eq '(nem olvashato)') { break }

  Write-Host "  --- [$n] $nm ---" -ForegroundColor White
  Write-Host "      Enter = INDUL a $SECS masodperces felvetel..." -NoNewline
  [void](Read-Host)

  $rec = New-Object HuWaveRecorder
  if (-not $rec.Start($n)) {
    Write-Host "      NEM INDULT (waveIn hiba: $($rec.LastError)) -- kihagyva" -ForegroundColor Red
    $n++; continue
  }
  [console]::Beep(880, 120)
  Write-Host "      BESZELJ..." -ForegroundColor Red -NoNewline
  while ($rec.CompletedChunks() -lt $SECS) { Start-Sleep -Milliseconds 200 }
  $wav = Join-Path $env:TEMP ("mic_test_$n.wav")
  [void]$rec.StopAndSave($wav)
  [console]::Beep(440, 120)

  $lv = Get-WavLevel $wav
  Remove-Item $wav -Force -ErrorAction SilentlyContinue
  Write-Host ("`r      csucs {0,5}%   RMS {1,5}%   DINAMIKA {2,5}x        " -f $lv.Peak, $lv.Rms, $lv.Dyn) -ForegroundColor Green
  $results += [pscustomobject]@{ Index=$n; Name=$nm; Peak=$lv.Peak; Rms=$lv.Rms; Dyn=$lv.Dyn }
  Write-Host ""
  $n++
}

Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    EREDMENY" -ForegroundColor Cyan
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host ("    {0,-36} {1,8} {2,8} {3,10}" -f "eszkoz", "csucs%", "RMS%", "dinamika") -ForegroundColor White
foreach ($r in $results) {
  Write-Host ("    [{0}] {1,-32} {2,8} {3,8} {4,10}" -f $r.Index, $r.Name, $r.Peak, $r.Rms, $r.Dyn)
}
Write-Host ""

# ***A DONTES ALAPJA A DINAMIKA (2026-08-09-i meres alapjan javitva).
# Eredetileg az RMS-t neztem -- TEVESEN. Eles adat: a fejhallgato RMS 2.4% /
# dinamika 9.6-11.8x mellett JOL irodott at, a webkamera RMS 15-18% / dinamika
# 2.8-3.5x mellett ROSSZUL, holott ott a hangero OTSZOROS volt. Az AGC-s mikrofon
# felhuzza a csendet es lenyomja a csucsokat; a felismero ebbol nehezebben olvas.
# Tehat a dinamika josolja a minoseget, nem a hangero. Az RMS csak akkor dont,
# ha a dinamika gyakorlatilag egyforma (a jel egyaltalan meglegyen).
$best = $results | Sort-Object -Property @{E='Dyn';Descending=$true}, @{E='Rms';Descending=$true} | Select-Object -First 1
if (-not $best -or $best.Rms -le 0) {
  Write-Host "    EGYIK MIKROFON SEM ADOTT JELET. Nezd meg a hangbemenetet." -ForegroundColor Red
} else {
  Write-Host "    >>> NYERTES: [$($best.Index)] $($best.Name)" -ForegroundColor Green
  Write-Host "        dinamika $($best.Dyn)x   RMS $($best.Rms)%   csucs $($best.Peak)%" -ForegroundColor Green
  Write-Host ""
  if ($best.Dyn -lt 5) {
    Write-Host "    FIGYELEM: a nyertes dinamikaja is alacsony ($($best.Dyn)x)." -ForegroundColor Yellow
    Write-Host "    Ez jellemzoen a mikrofon sajat automatikus erositese (AGC), ami" -ForegroundColor Yellow
    Write-Host "    osszenyomja a hangot. Ez a felismeres pontossaganak a plafonja." -ForegroundColor Yellow
    Write-Host ""
  }
  if ($best.Rms -lt 0.8) {
    Write-Host "    FIGYELEM: a nyertes is HALK (RMS < 0.8%). A szoftveres eroesites" -ForegroundColor Yellow
    Write-Host "    felhozza, de zajosabb lesz. Erdemes kozelebb ulni vagy" -ForegroundColor Yellow
    Write-Host "    egy asztali mikrofont beszerezni." -ForegroundColor Yellow
    Write-Host ""
  }
  $best.Name | Set-Content -Path (Join-Path $Base 'mikrofon.txt') -Encoding UTF8
  Write-Host "    Elmentve ide: mikrofon.txt -- a diktalas mostantol EZT nyitja meg." -ForegroundColor Cyan
}
Write-Host ""
Write-Host "  (Enter = bezar)"
[void](Read-Host)
