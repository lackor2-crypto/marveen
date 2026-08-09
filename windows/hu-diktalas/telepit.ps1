# =====================================================================
#  MAGYAR DIKTALAS  --  TELEPITO
# =====================================================================
#  Mit csinal:
#    1. atmasolja a fajlokat  %USERPROFILE%\.hu-diktalas  ala
#    2. HELYREALLITJA A CRLF SORVEGEKET a .cmd fajlokon (a git LF-fel checkoutolhat,
#       es egy LF-es .cmd-bol a cmd.exe AZONNAL KILEP -- ez mar megbuktatott minket)
#    3. bekeri a Groq API-kulcsot (ha meg nincs), es a fajlt CSAK a felhasznalonak
#       olvashatova teszi.  *A KULCS SOSE KERUL A REPOBA.*
#    4. beallitja az alapertelmezett mikrofont MIND A HAROM szerepre, hogy minden
#       program (Zoom/Teams/bongeszo) ugyanazt hasznalja
#    5. asztali parancsikonokat keszit
#
#  Futtatas:   powershell -ExecutionPolicy Bypass -File telepit.ps1
#  Nem kell rendszergazda.
#
#  ***KODOLAS: 100% ASCII. A PowerShell 5.1 a .ps1-et ANSI-kent olvassa, ezert egy
#     ekezetes karakter a fajlban (kulonosen utvonalban) elromlik: a felhasznalonev elromlik es nem talalja a kulcsot.
# =====================================================================
param(
  [string]$Mikrofon = '',     # pl. 'Realtek' vagy 'High Definition'; ures = a jelenlegi alapertelmezett
  [int]$Szint = 55,           # bemeneti szint %-ban (NEM 100: a vagas rontja a felismerest)
  [switch]$KulcsNelkul        # ne kerdezze a Groq-kulcsot (CI / nem-interaktiv)
)

$ErrorActionPreference = 'Stop'

$Src = $PSScriptRoot
$Dst = Join-Path $env:USERPROFILE '.hu-diktalas'

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host "    MAGYAR DIKTALAS -- telepites" -ForegroundColor Cyan
Write-Host "  ================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "    forras: $Src"
Write-Host "    cel   : $Dst"
Write-Host ""

# ---------- 1. masolas ----------
if (-not (Test-Path $Dst)) { New-Item -ItemType Directory -Path $Dst -Force | Out-Null }
$copied = 0
Get-ChildItem -Path $Src -File | Where-Object {
  $_.Name -notin @('telepit.ps1','README.md') -and $_.Name -notlike '*.bak-*'
} | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $Dst $_.Name) -Force
  $copied++
}
Write-Host "  [1/5] $copied fajl atmasolva" -ForegroundColor Green

# ---------- 2. CRLF helyreallitas a .cmd fajlokon ----------
# A git LF-fel is kicheckoutolhatja oket (kulonosen WSL-bol). Egy LF sorvegu .cmd-bol
# a cmd.exe azonnal kilep, es a felhasznalo csak annyit lat, hogy "felvillan egy fekete
# ablak". Ezert NEM bizzuk a .gitattributes-ra: itt egyszeruen ujrairjuk oket.
$fixed = 0
Get-ChildItem -Path $Dst -Filter *.cmd | ForEach-Object {
  $t = [System.IO.File]::ReadAllText($_.FullName)
  $t = $t -replace "`r`n", "`n" -replace "`n", "`r`n"
  [System.IO.File]::WriteAllText($_.FullName, $t, [System.Text.Encoding]::ASCII)
  $fixed++
}
Write-Host "  [2/5] $fixed .cmd fajl CRLF sorvegre allitva" -ForegroundColor Green

# ---------- 3. Groq API-kulcs ----------
$KeyFile = Join-Path $Dst 'groq.key'
if (Test-Path $KeyFile) {
  Write-Host "  [3/5] A Groq-kulcs mar megvan (nem irom felul)" -ForegroundColor Green
} elseif ($KulcsNelkul) {
  Write-Host "  [3/5] Groq-kulcs KIHAGYVA (-KulcsNelkul). A diktalas addig nem mukodik." -ForegroundColor Yellow
} else {
  Write-Host "  [3/5] Groq API-kulcs" -ForegroundColor White
  Write-Host "        Szerezd be: https://console.groq.com/keys  (ingyenes)" -ForegroundColor DarkGray
  Write-Host "        A kulcs CSAK ide a gepre kerul, a repoba SOHA." -ForegroundColor DarkGray
  $sec = Read-Host "        Illeszd be a kulcsot (gsk_...), vagy Enter a kihagyashoz" -AsSecureString
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
             [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  if ($plain -and $plain.Trim()) {
    [System.IO.File]::WriteAllText($KeyFile, $plain.Trim(), [System.Text.Encoding]::ASCII)
    # jogosultsag szukitese: oroklodes le, csak a felhasznalo
    & icacls.exe "$KeyFile" /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    Write-Host "        Elmentve, jogosultsag a felhasznalora szukitve." -ForegroundColor Green
  } else {
    Write-Host "        Kihagyva. Kesobb: ird a kulcsot ide -> $KeyFile" -ForegroundColor Yellow
  }
}

# ---------- 4. mikrofon ----------
. (Join-Path $Dst 'micgain.ps1')
. (Join-Path $Dst 'recorder.ps1')

if (-not $Mikrofon) {
  # alapertelmezes: ami MOST a rendszer alapertelmezett bemenete
  $rep = [MicGain]::ReportDefaults()
  $m = [regex]::Match($rep, 'Console\s*:\s*(.+)')
  if ($m.Success) { $Mikrofon = $m.Groups[1].Value.Trim() }
}
if ($Mikrofon) {
  $res = [MicGain]::SetDefault($Mikrofon)
  if ($res -like 'HIBA*') {
    Write-Host "  [4/5] $res" -ForegroundColor Yellow
    Write-Host "        Elerheto bemenetek: $([HuWaveRecorder]::ListDevices())" -ForegroundColor Yellow
  } else {
    [void][MicGain]::SetVolume($Mikrofon, $Szint)
    $Mikrofon | Set-Content -Path (Join-Path $Dst 'mikrofon.txt') -Encoding UTF8 -NoNewline
    Write-Host "  [4/5] Mikrofon: $res  (szint $Szint%, mind a 3 szerepre)" -ForegroundColor Green
  }
} else {
  Write-Host "  [4/5] Nem talaltam bemeneti eszkozt -- fusd le kesobb: mikrofon-valaszto.cmd" -ForegroundColor Yellow
}

# ---------- 5. parancsikonok ----------
$desk = [Environment]::GetFolderPath('Desktop')
$sh = New-Object -ComObject WScript.Shell
function Link($name, $target, $args, $icon) {
  $lnk = $sh.CreateShortcut((Join-Path $desk "$name.lnk"))
  $lnk.TargetPath = $target
  if ($args) { $lnk.Arguments = $args }
  $lnk.WorkingDirectory = $Dst
  if ($icon) { $lnk.IconLocation = $icon }
  $lnk.Save()
}
# A diktalas inditoja EXE legyen (wscript), mert csak EXE-t enged a Windows talcara tuzni.
Link 'Magyar diktalas' "$env:SystemRoot\System32\wscript.exe" "`"$Dst\diktal-auto.vbs`"" "$env:SystemRoot\System32\SndVol.exe,0"
Link 'Mikrofon - kamera'      "$env:ComSpec" "/c `"$Dst\MIKROFON-kamera.cmd`"" "$env:SystemRoot\System32\SndVol.exe,0"
Link 'Mikrofon - fejhallgato' "$env:ComSpec" "/c `"$Dst\MIKROFON-fejhallgato.cmd`"" "$env:SystemRoot\System32\SndVol.exe,0"
Write-Host "  [5/5] Asztali parancsikonok elkeszitve" -ForegroundColor Green

Write-Host ""
Write-Host "  ================================================================" -ForegroundColor Green
Write-Host "    KESZ" -ForegroundColor Green
Write-Host "  ================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Hasznalat: kattints a 'Magyar diktalas' ikonra -> sipol -> beszelsz" -ForegroundColor White
Write-Host "             -> kattints oda, ahova a szoveget akarod = leall ES beilleszti" -ForegroundColor White
Write-Host ""
Write-Host "  Talcara tuzes: jobb klikk az ikonon -> Pin to taskbar" -ForegroundColor DarkGray
Write-Host "  (a Win10 letiltotta a programozott kituzest, ezert kezzel kell)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Ha halk vagy rossz mikrofont hasznal:  $Dst\mikrofon-valaszto.cmd" -ForegroundColor DarkGray
Write-Host ""
