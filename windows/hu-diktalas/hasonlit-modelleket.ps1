# =====================================================================
#  MODELL-OSSZEHASONLITAS  --  EGY felvetel, KET modell, egymas mellett
# =====================================================================
#  MIERT: a Groq Cloud ket atirasi modellt kinal, es tippelni nem akarunk.
#     whisper-large-v3-turbo  - gyorsabb
#     whisper-large-v3        - pontosabb (kulonosen tulajdonneveken)
#  Ez a szkript EGYETLEN felvetelt kuld fel MINDKETTONEK, es kiirja a ket
#  eredmenyt egymas alatt -- igy sajat fuleddel/szemeddel dontheted el, melyik jobb
#  A TE hangodon es A TE szavaidon. A nyertest beirja a `modell.txt`-be.
#
#  A szotarat (szotar.txt) MINDKET hivas megkapja, kulonben nem lenne fair az osszevetes.
#  ***KODOLAS: 100% ASCII.
# =====================================================================
$ErrorActionPreference = 'Stop'
trap { Write-Host "`n  HIBA: $($_.Exception.Message)" -ForegroundColor Red; Write-Host "  (Enter = bezar)"; [void](Read-Host); exit 1 }

$Base = $PSScriptRoot
. (Join-Path $Base 'recorder.ps1')

$KeyFile = Join-Path $Base 'groq.key'
if (-not (Test-Path $KeyFile)) { throw "Hianyzik a kulcs: $KeyFile" }
$Key = (Get-Content $KeyFile -Raw).Trim()

$Wav    = Join-Path $env:TEMP 'hu_modell_teszt.wav'
$Szotar = Join-Path $Base 'szotar.txt'
$SECS   = 12

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    MODELL-OSSZEHASONLITAS -- egy felvetel, ket modell" -ForegroundColor Cyan
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "    Mondj bele olyan szavakat, amiket eddig ELRONTOTT:" -ForegroundColor Yellow
Write-Host "      'A Marveent felpusholom a lackor2-crypto GitHub fiokra.'" -ForegroundColor DarkGray
Write-Host ""
Write-Host "    Enter = INDUL a $SECS masodperces felvetel..." -NoNewline
[void](Read-Host)

# --- mikrofon: ugyanaz, amit a diktalas hasznal ---
$devIdx = -1
$micFile = Join-Path $Base 'mikrofon.txt'
if (Test-Path $micFile) {
  $want = (Get-Content $micFile -Raw).Trim()
  if ($want) { $devIdx = [HuWaveRecorder]::FindDevice($want) }
}
$rec = New-Object HuWaveRecorder
if (-not $rec.Start($devIdx)) { throw "A felvetel nem indult (waveIn hiba: $($rec.LastError))" }
[console]::Beep(880,120)
Write-Host "      BESZELJ..." -ForegroundColor Red -NoNewline
while ($rec.CompletedChunks() -lt $SECS) { Start-Sleep -Milliseconds 200 }
[void]$rec.StopAndSave($Wav)
[console]::Beep(440,120)
Write-Host "`r      felvetel kesz, atiras mindket modellel...            " -ForegroundColor Green
Write-Host ""

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$results = @{}
foreach ($mdl in @('whisper-large-v3-turbo','whisper-large-v3')) {
  $json = Join-Path $env:TEMP "hu_modell_$mdl.json"
  Remove-Item $json -Force -ErrorAction SilentlyContinue
  $promptArg = @()
  if (Test-Path $Szotar) { $promptArg = @("-F", "prompt=<$Szotar") }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $http = & curl.exe -s --max-time 120 -o "$json" -w "%{http_code}" `
      https://api.groq.com/openai/v1/audio/transcriptions `
      -H "Authorization: Bearer $Key" `
      -F "file=@$Wav" -F "model=$mdl" -F "language=hu" -F "response_format=json" @promptArg
  $sw.Stop()

  if ("$http" -ne "200") {
    Write-Host "  $mdl -> HTTP $http" -ForegroundColor Red
    $results[$mdl] = "(hiba: HTTP $http)"
  } else {
    $t = ("" + (([System.IO.File]::ReadAllText($json,[Text.Encoding]::UTF8) | ConvertFrom-Json).text)).Trim()
    $results[$mdl] = $t
    Write-Host "  --- $mdl   ($([math]::Round($sw.Elapsed.TotalSeconds,1)) mp) ---" -ForegroundColor Cyan
    Write-Host "  $t" -ForegroundColor White
    Write-Host ""
  }
  Remove-Item $json -Force -ErrorAction SilentlyContinue
}
Remove-Item $Wav -Force -ErrorAction SilentlyContinue

Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    Melyik lett a jobb?" -ForegroundColor Cyan
Write-Host "      [1] whisper-large-v3-turbo   (gyorsabb)" -ForegroundColor White
Write-Host "      [2] whisper-large-v3         (pontosabb, ez a jelenlegi alap)" -ForegroundColor White
Write-Host "      [Enter] = hagyd ugy, ahogy van" -ForegroundColor DarkGray
$v = Read-Host "    Valassz"
if ($v -eq '1') {
  'whisper-large-v3-turbo' | Set-Content (Join-Path $Base 'modell.txt') -Encoding ASCII -NoNewline
  Write-Host "    Beallitva: whisper-large-v3-turbo" -ForegroundColor Green
} elseif ($v -eq '2') {
  'whisper-large-v3' | Set-Content (Join-Path $Base 'modell.txt') -Encoding ASCII -NoNewline
  Write-Host "    Beallitva: whisper-large-v3" -ForegroundColor Green
} else {
  Write-Host "    Valtozatlan." -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  (Enter = bezar)"
[void](Read-Host)
