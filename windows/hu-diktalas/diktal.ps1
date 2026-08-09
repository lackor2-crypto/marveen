# =====================================================================
#  MAGYAR DIKTALAS  --  hang -> szoveg -> vagolap
# =====================================================================
#  MIERT: a Claude Code beepitett mikrofonja nem tud magyarul, es a motorja
#  nem cserelheto (a bovitmeny resze, szerveroldali felismeres). Ez megkeruli:
#  barhova bemasolhato szoveget ad -- a Claude Code mezojebe is.
#
#  MOTOR: Groq  whisper-large-v3-turbo,  language=hu  (kozel valos ideju)
#  TELEPITES NEM KELL: felvetel = Windows beepitett winmm/waveIn, HTTPS = rendszer curl.exe
#
#  ***KODOLAS: ebben a fajlban SEMMI EKEZETES KARAKTER nincs. A PowerShell 5.1 a .ps1-et
#    ANSI-kent olvassa, es a BOM nelkuli UTF-8 ekezetek elromlanak -- pontosan ez
#    buktatta meg az elso valtozatot (a beegetett 'C:\Users\Laszlo\...' utbol
#    'L****szl****' lett, es a szkript nem talalta a kulcsot).
#    Ezert: az utvonal $PSScriptRoot-bol jon, nem beegetve.
#
#  === 2026-08-08 JAVITAS: "nem mukodik" -> most megmondja, MIERT ===
#  Harom dolog derult ki meressel:
#   1. Az MCI 'set' parancs hibakodjat a regi valtozat eldobta (Out-Null), ezert
#      eszrevetlen maradt, hogy a 'bitspersample 16' ezen a gepen MINDEN
#      sorrendben elutasitva (RC=282) -> a felvetel 8 bites. A mintavetel viszont
#      allithato, ezert most legalabb 16 kHz-en veszunk fel, es a hibakodot latjuk.
#   2. A regi "ures felvetel" ellenorzes csak a FAJLMERETET nezte. Egy nema
#      mikrofon (rossz alapertelmezett eszkoz, elnemitas, vagy egy kozbeekelodo
#      virtualis eszkoz mint a Krisp) TELE meretu, de CSENDES fajlt ad -- az
#      atment a regi ellenorzesen, es a Whisper a csendre hallucinal ("NAMASTE",
#      "Koszonom a figyelmet" stb.). Innen jott a "rossz szoveget ad" erzes.
#      Most a tenyleges JELSZINTET merjuk, es csend eseten megmondjuk mit tegyen.
#   3. A Groq-lanc (kulcs, feltoltes, valasz) meresileg HIBATLAN volt.
# =====================================================================
$ErrorActionPreference = 'Stop'
trap { Write-Host "`n  HIBA: $($_.Exception.Message)" -ForegroundColor Red; Write-Host "  (Enter = bezar)"; [void](Read-Host); exit 1 }

$Base    = $PSScriptRoot
$KeyFile = Join-Path $Base 'groq.key'
$Wav     = Join-Path $env:TEMP 'hu_diktalas.wav'
$Model   = 'whisper-large-v3-turbo'

if (-not (Test-Path $KeyFile)) { throw "Hianyzik a kulcs-fajl: $KeyFile" }
$Key = (Get-Content $KeyFile -Raw).Trim()

# A felvevo mar NEM az MCI: az ezen a gepen nem hajlando 16 bitre valtani
# (set bitspersample 16 -> RC=282 minden sorrendben), es a 8 bites felvetel
# halk mikrofonnal hasznalhatatlan. A recorder.ps1 a waveIn API-t hasznalja,
# ami pontosan 16 kHz / mono / 16 bitet ad. Reszletek ott, a fejlecben.
. (Join-Path $Base 'recorder.ps1')

# --- FELVETEL AZONNAL INDUL (kattintasra nem kell semmit megnyomni) ---
if (Test-Path $Wav) { Remove-Item $Wav -Force }
$rec = New-Object HuWaveRecorder
if (-not $rec.Start()) {
  throw "A felvetel nem indult el (waveIn hibakod: $($rec.LastError)). Van bekapcsolt mikrofon, es nem foglalta le mas program?"
}

[console]::Beep(880, 120)
Write-Host ""
Write-Host "   ==========================================" -ForegroundColor Red
Write-Host "     FELVETEL MEGY -- beszelj magyarul" -ForegroundColor Red
Write-Host "     ENTER = keszen vagyok   (max 60 mp)" -ForegroundColor Yellow
Write-Host "   ==========================================" -ForegroundColor Red
[void](Read-Host)

[void]$rec.StopAndSave($Wav)
[console]::Beep(440, 120)

if (-not (Test-Path $Wav)) { throw "Nem keszult hangfelvetel. Ellenorizd: Beallitasok > Rendszer > Hang > Bemenet (mikrofon)." }
$kb = [math]::Round((Get-Item $Wav).Length / 1KB, 1)
if ($kb -lt 3) { throw "A felvetel ures ($kb KB). A mikrofon nem vett fel semmit -- nezd meg a hangbemenetet." }

# --- JELSZINT-MERES. Ez a lenyegi uj lepes: a fajlmeret NEM arulja el, hogy a
# mikrofon tenylegesen felvett-e valamit. A WAV fejlecet rendesen kiolvassuk
# (nem feltetelezunk 44 bajtos fejlecet es 16 bites mintat), mert a felvetel itt
# 8 bites -- azt elojel nelkuli, 128-koruli mintakent kell ertelmezni.
$b = [System.IO.File]::ReadAllBytes($Wav)
$fmt = -1; $data = -1; $dataLen = 0; $i = 12
while ($i -lt $b.Length - 8) {
  $id = [System.Text.Encoding]::ASCII.GetString($b, $i, 4)
  $sz = [BitConverter]::ToInt32($b, $i + 4)
  if ($id -eq 'fmt ') { $fmt = $i + 8 }
  if ($id -eq 'data') { $data = $i + 8; $dataLen = $sz; break }
  $i += 8 + $sz + ($sz % 2)
}
$peakPct = 100.0
if ($fmt -ge 0 -and $data -ge 0) {
  $bits = [BitConverter]::ToInt16($b, $fmt + 14)
  $peak = 0
  if ($bits -eq 8) {
    $full = 128
    for ($k = $data; $k -lt $data + $dataLen -and $k -lt $b.Length; $k++) {
      $a = [Math]::Abs([int]$b[$k] - 128); if ($a -gt $peak) { $peak = $a }
    }
  } else {
    $full = 32768
    for ($k = $data; $k -lt $data + $dataLen - 1 -and $k -lt $b.Length - 1; $k += 2) {
      $a = [Math]::Abs([int][BitConverter]::ToInt16($b, $k)); if ($a -gt $peak) { $peak = $a }
    }
  }
  $peakPct = [math]::Round($peak / $full * 100, 1)
}
# 2% csucs alatt nincs ertelmes beszed. Ilyenkor a Whisper a csendre HALLUCINAL,
# vagyis a felhasznalo nem hibat, hanem VELETLEN SZOVEGET kapna -- ezert allunk meg itt.
if ($peakPct -lt 2) {
  Write-Host ""
  Write-Host "   A MIKROFON GYAKORLATILAG NEMA (csucs: $peakPct%)." -ForegroundColor Red
  Write-Host "   A felvetel elkeszult ($kb KB), de nincs benne beszed." -ForegroundColor Red
  Write-Host ""
  Write-Host "   Ilyenkor NEM kuldom fel: a Whisper a csendbol veletlen szoveget talalna ki." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "   Mit nezz meg (ebben a sorrendben):" -ForegroundColor Cyan
  Write-Host "     1. Be van dugva a fejhallgato, es a MIKROFON-agat is bedugtad?" -ForegroundColor Cyan
  Write-Host "        (sok fejhallgatonal KET jack van: zold = ful, rozsaszin = mikrofon)" -ForegroundColor Cyan
  Write-Host "     2. Jobb klikk a hangszoro ikonra > Hangbeallitasok > Bemenet:" -ForegroundColor Cyan
  Write-Host "        a 'Microphone (High Definition Audio Device)' legyen kivalasztva" -ForegroundColor Cyan
  Write-Host "        -- ez a fejhallgatoe. A 'Mikrofon (Realtek USB2.0 MIC)' a webkamerae." -ForegroundColor Cyan
  Write-Host "     3. Ugyanott a bemeneti hangero: tekerd 100-ra, es ha van" -ForegroundColor Cyan
  Write-Host "        'Mikrofonerosites / Microphone Boost', azt is emeld meg (+20 dB)." -ForegroundColor Cyan
  Write-Host "     4. Nincs-e nemitva (athuzott mikrofon ikon)." -ForegroundColor Cyan
  Write-Host ""
  Write-Host "   (Enter = bezar)"
  [void](Read-Host)
  Remove-Item $Wav -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host "   felvetel: $kb KB, jelszint $peakPct% -- atiras..." -ForegroundColor DarkGray

# *** EKEZET-JAVITAS (2026-08-05):
#   A curl UTF-8 JSON-t ad vissza, de ha a kimenetet KOZVETLENUL valtozoba vesszuk, a
#   PowerShell 5.1 a KONZOL kodlapjaval (CP852) dekodalja -> 'e' helyett '|-e' lesz.
#   Ezert a valaszt FAJLBA iratjuk (-o), es EXPLICITEN UTF-8-kent olvassuk vissza.
#   Igy a konzol kodlapja egyaltalan nem jatszik.
$JsonFile = Join-Path $env:TEMP 'hu_diktalas.json'
if (Test-Path $JsonFile) { Remove-Item $JsonFile -Force }

$http = & curl.exe -s --max-time 120 -o "$JsonFile" -w "%{http_code}" https://api.groq.com/openai/v1/audio/transcriptions `
    -H "Authorization: Bearer $Key" `
    -F "file=@$Wav" -F "model=$Model" -F "language=hu" -F "response_format=json"

if (-not (Test-Path $JsonFile)) { throw "Nem erkezett valasz a Groq-tol (halozat?)." }
$resp = [System.IO.File]::ReadAllText($JsonFile, [System.Text.Encoding]::UTF8)
Remove-Item $JsonFile -Force -ErrorAction SilentlyContinue

# A HTTP-kodot is megnezzuk: egy lejart/visszavont kulcs igy egyertelmu uzenetet ad,
# nem pedig "nem ertelmezheto valasz"-t.
if ("$http" -ne "200") {
  if ("$http" -eq "401") { throw "A Groq elutasitotta a kulcsot (401). Csereld ki a groq.key tartalmat." }
  if ("$http" -eq "429") { throw "Groq: tul sok keres vagy elfogyott a keret (429). Probald par perc mulva." }
  throw "Groq HTTP $http -- valasz: $resp"
}

$j = $null
try { $j = $resp | ConvertFrom-Json } catch { throw "Nem ertelmezheto valasz: $resp" }
if ($j.error) { throw "Groq: $($j.error.message)" }

# a konzol-kiiras is UTF-8 legyen, kulonben a kepernyon torzulna (a vagolap mar jo)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$txt = ("" + $j.text).Trim()
if ([string]::IsNullOrWhiteSpace($txt)) { Write-Host "   (nem ertettem semmit)" -ForegroundColor Yellow; Start-Sleep 2; exit 0 }

Set-Clipboard -Value $txt
Remove-Item $Wav -Force -ErrorAction SilentlyContinue
Write-Host ""
Write-Host "   $txt" -ForegroundColor Green
Write-Host ""
Write-Host "   ^ A VAGOLAPON van -- Ctrl+V barhova" -ForegroundColor Cyan
Start-Sleep -Milliseconds 1400
