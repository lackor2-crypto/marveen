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

# HAROM valtozat UGYANAZON a felvetelen. A harmadik azert kell, mert felmerult a
# gyanu, hogy a SZOTAR (prompt) maga ront: a Whisper a promptot elozmenyszovegkent
# kapja, es a STILUSAT is atveszi -- egy puszta vesszos szolista arra biztatja, hogy
# "listat folytasson", darabos mondatokat gyartva. Ezt nem tippelni kell, hanem merni.
$variants = @(
  @{ nev = 'pontos + szotar';     model = 'whisper-large-v3';       prompt = $true  },
  @{ nev = 'pontos, szotar NELKUL'; model = 'whisper-large-v3';     prompt = $false },
  @{ nev = 'gyors (turbo) + szotar'; model = 'whisper-large-v3-turbo'; prompt = $true }
)

$results = @{}
foreach ($v in $variants) {
  $json = Join-Path $env:TEMP "hu_modell_teszt.json"
  Remove-Item $json -Force -ErrorAction SilentlyContinue
  $promptArg = @()
  if ($v.prompt -and (Test-Path $Szotar)) { $promptArg = @("-F", "prompt=<$Szotar") }

  $sw = [Diagnostics.Stopwatch]::StartNew()
  $http = & curl.exe -s --max-time 120 -o "$json" -w "%{http_code}" `
      https://api.groq.com/openai/v1/audio/transcriptions `
      -H "Authorization: Bearer $Key" `
      -F "file=@$Wav" -F "model=$($v.model)" -F "language=hu" -F "temperature=0" `
      -F "response_format=json" @promptArg
  $sw.Stop()

  if ("$http" -ne "200") {
    Write-Host "  $($v.nev) -> HTTP $http" -ForegroundColor Red
    $results[$v.nev] = "(hiba: HTTP $http)"
  } else {
    $t = ("" + (([System.IO.File]::ReadAllText($json,[Text.Encoding]::UTF8) | ConvertFrom-Json).text)).Trim()
    $results[$v.nev] = $t
    Write-Host "  --- $($v.nev)   ($([math]::Round($sw.Elapsed.TotalSeconds,1)) mp) ---" -ForegroundColor Cyan
    Write-Host "  $t" -ForegroundColor White
    Write-Host ""
  }
  Remove-Item $json -Force -ErrorAction SilentlyContinue
}
Remove-Item $Wav -Force -ErrorAction SilentlyContinue

Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    Melyik lett a legjobb?" -ForegroundColor Cyan
Write-Host "      [1] pontos + szotar          (ez a jelenlegi beallitas)" -ForegroundColor White
Write-Host "      [2] pontos, szotar NELKUL    -> a szotarat kikapcsolom" -ForegroundColor White
Write-Host "      [3] gyors (turbo) + szotar   -> a gyors modellre valtok" -ForegroundColor White
Write-Host "      [Enter] = hagyd ugy, ahogy van" -ForegroundColor DarkGray
$v = Read-Host "    Valassz"
if ($v -eq '2') {
  # A szotar kikapcsolasa = atnevezzuk. Igy nem vesz el, barmikor visszatehato.
  if (Test-Path $Szotar) { Move-Item $Szotar (Join-Path $Base 'szotar.txt.ki') -Force }
  'whisper-large-v3' | Set-Content (Join-Path $Base 'modell.txt') -Encoding ASCII -NoNewline
  Write-Host "    Szotar KIKAPCSOLVA (szotar.txt.ki nevre atnevezve), modell: pontos" -ForegroundColor Green
  Write-Host "    Visszakapcsolas: nevezd vissza szotar.txt-re." -ForegroundColor DarkGray
} elseif ($v -eq '3') {
  'whisper-large-v3-turbo' | Set-Content (Join-Path $Base 'modell.txt') -Encoding ASCII -NoNewline
  Write-Host "    Beallitva: whisper-large-v3-turbo (a szotar marad)" -ForegroundColor Green
} elseif ($v -eq '1') {
  if (Test-Path (Join-Path $Base 'szotar.txt.ki')) { Move-Item (Join-Path $Base 'szotar.txt.ki') $Szotar -Force }
  'whisper-large-v3' | Set-Content (Join-Path $Base 'modell.txt') -Encoding ASCII -NoNewline
  Write-Host "    Beallitva: pontos modell + szotar" -ForegroundColor Green
} else {
  Write-Host "    Valtozatlan." -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  (Enter = bezar)"
[void](Read-Host)
