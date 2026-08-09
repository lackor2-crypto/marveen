# =====================================================================
#  MAGYAR DIKTALAS -- EGY KATTINTAS, AUTOMATA BEFEJEZESSEL
# =====================================================================
#  HASZNALAT: rakattintasz a talcan a hangszoro ikonra, sipol, BESZELSZ.
#  Amikor abbahagyod, MAGATOL befejezi es beilleszti a szoveget oda, ahol a
#  kurzorod all. Nincs mit lenyomni, nincs mit leallitani.
#
#  MIERT IGY (2026-08-08 esti visszajelzes):
#  Az elso valtozat kapcsologombos volt -- masodik kattintas allitotta le.
#  A TALCARA TUZOTT ikonnal ez NEM mukodik: a Windows a mar futo peldanyra
#  valt ahelyett, hogy ujat inditana, igy a leallito jelzes sosem szuletett
#  meg, es a felvetel a 60 mp-es hatarig ment ("kb. ket percet kell varni").
#  Ezert a leallitast nem gombra bizzuk, hanem a HANGRA.
#
#  MIERT NEM A VS CODE MIKROFONJA: a Claude Code bovitmeny mikrofon gombja nem
#  tud magyarul, es a motorja nem cserelheto -- a bovitmeny 15 beallitasa kozt
#  egyetlen beszed-, hang- vagy nyelv-kulcs sincs (ellenorizve a 2.1.226-on).
#
#  MOTOR: Groq Cloud, whisper-large-v3 (a pontos; a turbo 12% vs 10.3% WER),
#         language=hu, temperature=0, domain-szotar a prompt parameteren.
#  ***CSAK ASCII karakterek! (a PowerShell 5.1 ANSI-kent olvassa a .ps1-et)
# =====================================================================
$ErrorActionPreference = 'Stop'

$Base    = $PSScriptRoot
$KeyFile = Join-Path $Base 'groq.key'
$Wav     = Join-Path $env:TEMP 'hu_diktalas_auto.wav'
$Lock    = Join-Path $env:TEMP 'hu_diktalas.lock'
$Log     = Join-Path $Base 'diktal-auto.log'
# ***2026-08-09: TURBO -> TELJES MODELL ***
# A Groq Cloud KET atirasi modellt kinal (ellenorizve a /v1/models vegponton):
#     whisper-large-v3-turbo  - gyorsabb, de pontatlanabb
#     whisper-large-v3        - a TELJES modell, pontosabb nem-angol nyelven es
#                               kulonosen TULAJDONNEVEKEN (nalunk pont ez romlott el)
# A sebessegkulonbseg a Groq-on kicsi, a pontossag viszont szamit -> a teljes az alap.
# Felulirhato a `modell.txt`-bol, ujraforditas nelkul (A/B: hasonlit-modelleket.cmd).
$Model   = 'whisper-large-v3'
$ModelFile = Join-Path $PSScriptRoot 'modell.txt'
if (Test-Path $ModelFile) {
  $m = (Get-Content $ModelFile -Raw).Trim()
  if ($m) { $Model = $m }
}

function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -FilePath $Log -Append -Encoding UTF8 }
function Beep2($f,$d) { try { [console]::Beep($f,$d) } catch { } }

# Dupla inditas vedelme: ha veletlenul ketszer kattintasz, a masodik csendben
# kilep, nem indit parhuzamos felvetelt ugyanarra a mikrofonra.
if (Test-Path $Lock) {
  $age = (Get-Date) - (Get-Item $Lock).LastWriteTime
  if ($age.TotalSeconds -lt 120) { exit 0 }
  Remove-Item $Lock -Force -ErrorAction SilentlyContinue
}
New-Item -Path $Lock -ItemType File -Force | Out-Null

try {
  if (-not (Test-Path $KeyFile)) { throw "Hianyzik a kulcs-fajl: $KeyFile" }
  $Key = (Get-Content $KeyFile -Raw).Trim()
  . (Join-Path $Base 'recorder.ps1')
  . (Join-Path $Base 'micgain.ps1')
  Remove-Item $Wav -Force -ErrorAction SilentlyContinue

  # --- MEGJEGYEZZUK, MELYIK ABLAKBA KELL A SZOVEG.
  # Talcarol inditva a fokusz elmozdulhat (a talca gombja veszi at), ezert nem
  # eleg feltetelezni, hogy a beillesztes pillanataban meg mindig a szerkeszto
  # az aktiv ablak. Ha az aktiv ablak epp a talca/Intezo vagy a sajat
  # futtatonk, azt NEM jegyezzuk meg -- oda nem akarunk beilleszteni.
  Add-Type -Name U32 -Namespace HuDikt -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern int GetWindowThreadProcessId(System.IntPtr h, out int pid);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool AttachThreadInput(int a, int b, bool attach);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern int GetCurrentThreadId();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern short GetAsyncKeyState(int vKey);
'@

  # A sipszo a felvetel ELOTT szol, es varunk is utana -- kulonben a mikrofon
  # felvenne a sajat sipszot (meresen 22.9% csucs egy nema szobaban, amibol a
  # Whisper egy "A" betut hallucinalt).
  Beep2 880 120
  Start-Sleep -Milliseconds 350

  # *2026-08-09: NEM a WAVE_MAPPER-t hasznaljuk tobbe. A `mikrofon.txt`-ben all,
  # MELYIK eszkozt akarjuk (a `mikrofon-valaszto.ps1` irja oda a meres nyerteset).
  # Indok: a WAVE_MAPPER a REGI MME-reteg preferalt eszkoze, ami NEM feltetlenul
  # azonos a modern MMDevice-alapertelmezettel -- ezert fordulhatott elo, hogy a
  # diagnosztika tokeletes eszkozt jelzett, kozben a felvetel a masikrol jott.
  $micFile = Join-Path $Base 'mikrofon.txt'
  $devIdx  = -1
  $want    = ''      # mindig letezzen: az onhangolo also blokk erre hivatkozik
  if (Test-Path $micFile) {
    $want = (Get-Content $micFile -Raw).Trim()
    if ($want) {
      $devIdx = [HuWaveRecorder]::FindDevice($want)
      if ($devIdx -lt 0) { Log "FIGYELEM: a kert mikrofon nem talalhato: '$want' -- marad a rendszer-alapertelmezett" }
    }
  }
  $rec = New-Object HuWaveRecorder
  if (-not $rec.Start($devIdx)) { throw "A felvetel nem indult el (waveIn hibakod: $($rec.LastError))." }
  Log "mikrofon: [$devIdx] $($rec.OpenedDeviceName)"

  # --- LEALLITAS: EGERKATTINTAS, barhol.
  # Ez egyben kijeloli a beszurasi pontot is: ahova kattintasz, oda kerul a
  # szoveg. Igy a leallitas es a "hova tegyem" ugyanaz a mozdulat.
  #
  # Miert nem csend-figyeles: Boss diktalas kozben megall gondolkodni, es a
  # felvetel ido elott befejezodne. Miert nem "masodik kattintas a talcaikonra":
  # a Windows olyankor a mar futo peldanyra valt, uj peldanyt nem indit.
  #
  # Eloszor megvarjuk, hogy az INDITO kattintast elengedd -- kulonben ugyanaz a
  # kattintas azonnal le is allitana a felvetelt.
  $MAX_SEC = 300          # 5 perc
  $t0 = Get-Date
  $released = $false
  while ($true) {
    Start-Sleep -Milliseconds 40
    $down = ([HuDikt.U32]::GetAsyncKeyState(1) -band 0x8000) -ne 0
    $elapsed = ((Get-Date) - $t0).TotalSeconds

    if (-not $released) {
      # az indito kattintas elengedese (vagy 1.5 mp utan mindenkeppen elorelepunk)
      if (-not $down -or $elapsed -gt 1.5) { $released = $true }
      continue
    }
    if ($down)               { Log "leallitva kattintassal ($([math]::Round($elapsed,1)) mp)"; break }
    if ($elapsed -ge $MAX_SEC) { Log "elerte az 5 perces felso hatart"; break }
  }

  # Hagyjuk, hogy a kattintas elvegezze a dolgat: fokusz + kurzor a helyere.
  Start-Sleep -Milliseconds 400
  [void]$rec.StopAndSave($Wav)
  Beep2 440 120
  if (-not (Test-Path $Wav)) { throw "Nem keszult hangfelvetel." }

  # --- Vegso ellenorzes a teljes felvetelen. A Whisper a csendbol veletlen
  # szoveget talal ki, es ez a valtozat AUTOMATIKUSAN BEILLESZT -- tehat a
  # hallucinacio egyenesen a szerkesztodbe kerulne. A csucs onmagaban nem eleg
  # (a szoba alapzaja is 2% fole megy): a beszed HULLAMZIK, a zaj egyenletes,
  # ezert a hangos es halk keretek ARANYAT is nezzuk.
  $b = [System.IO.File]::ReadAllBytes($Wav)
  $FRAME = 800
  $frames = New-Object System.Collections.ArrayList
  $peak = 0; [double]$all = 0; $n = 0; [double]$fsum = 0; $fn = 0
  for ($k = 44; $k -lt $b.Length - 1; $k += 2) {
    $s = [BitConverter]::ToInt16($b, $k); $a = [Math]::Abs([int]$s)
    if ($a -gt $peak) { $peak = $a }
    $sq = [double]$s * $s; $all += $sq; $n++; $fsum += $sq; $fn++
    if ($fn -ge $FRAME) { [void]$frames.Add([Math]::Sqrt($fsum/$fn)); $fsum = 0; $fn = 0 }
  }
  if ($fn -gt 0) { [void]$frames.Add([Math]::Sqrt($fsum/$fn)) }
  $pk  = [math]::Round($peak / 32768 * 100, 1)
  $rms = if ($n) { [math]::Round([Math]::Sqrt($all/$n) / 32768 * 100, 2) } else { 0 }
  $dyn = 0.0
  if ($frames.Count -ge 8) {
    $srt = @($frames | Sort-Object)
    $lo = $srt[[int]([Math]::Floor($srt.Count * 0.10))]
    $hi = $srt[[int]([Math]::Floor($srt.Count * 0.90))]
    if ($lo -gt 1) { $dyn = [math]::Round($hi / $lo, 2) }
  }
  $secs = [math]::Round($n / 16000.0, 1)

  # ***VAGAS-MERES (2026-08-09) ***
  # A csucs ONMAGABAN nem arulja el, van-e baj: egyetlen hangos szotag is 100%-ot ad.
  # Ami szamit: HANY MINTA ul a plafonon. Ha ez ezrelek alatt van, az normalis
  # beszed-csucs; ha szazalekokban merheto, a hullamforma teteje LE VAN VAGVA, es
  # abbol a felismeres nem tudja kiolvasni a hangokat. Eddig ezt tippeltem -- most merjuk.
  $clip = 0
  for ($k = 44; $k -lt $b.Length - 1; $k += 2) {
    if ([Math]::Abs([int][BitConverter]::ToInt16($b, $k)) -ge 32700) { $clip++ }
  }
  $clipPct = if ($n) { [math]::Round(100.0 * $clip / $n, 3) } else { 0 }
  Log "felvetel: $secs mp, csucs $pk%, RMS $rms%, dinamika ${dyn}x, vagott minta ${clipPct}%"
  if ($clipPct -gt 0.5) {
    Log "FIGYELEM: a mintak ${clipPct}%-a a plafonon ul = VALODI VAGAS. Ez rontja a felismerest."
  }

  # ***ONHANGOLO BEMENETI SZINT (2026-08-09) ***
  # Miert kell: a webkamera mikrofonjat 40%-rol 100%-ra vittem, hogy 1 meterrol is
  # halljon -- de ezzel TULLOTTEM: a felvetel VAGOTT (csucs 100%, RMS 16.7%), es a
  # levagott hullamcsucsokbol a Whisper mar nem tudja kiolvasni a hangokat
  # (mert: "hangfelvelot", "tizenetet", "Orgodette" a helyes szavak helyett).
  # Kezzel hangolni torekeny -- ezert a program allitja magat:
  #     VAG (csucs >= 99%)          -> a bemeneti hangero 0.75-szorosara
  #     TUL HALK (csucs < 25%)      -> +12 szazalekpont
  # Nehany mondat alatt beall a jo szintre, es ott is marad (a Windows megjegyzi).
  # !A cel NEM a maximum, hanem a VAGAS ALATTI legnagyobb szint: 60-85% csucs.
  if ($devIdx -ge 0 -and $want) {
    $curVol = [MicGain]::GetVolume($want)
    if ($curVol -ge 0) {
      $newVol = $null
      # ***2026-08-09 HELYESBITES: a csucs ONMAGABAN NEM jelent vagast.
      # Merve: a webkamera mikrofonjanal a szint 55% -> 23% -> 17% -> 13% ment le,
      # es az RMS KOZBEN VALTOZATLAN maradt (16.8 -> 17.1%). A Windows hangero-csuszka
      # NEM hat erre az eszkozre: a webkameraban sajat automatikus erosites (AGC) van,
      # ami kiegyenliti. A szabalyozom tehat egy HALOTT GOMBOT tekert a padloig.
      # Ratetel: a `csucs 100% / RMS 17% / dinamika 14x` NORMALIS beszed-dinamika
      # (a beszed cresztfaktora nagy) -- nem torzitas. Ezert a vagast csak akkor
      # allapitjuk meg, ha a csucs ES az RMS is magas.
      if     ($pk -ge 99 -and $rms -gt 25) { $newVol = [Math]::Max(20, [Math]::Round($curVol * 0.8)) }
      elseif ($pk -lt 25 -and $rms -lt 3)  { $newVol = [Math]::Min(100, $curVol + 12) }
      if ($newVol -ne $null -and $newVol -ne $curVol) {
        $set = [MicGain]::SetVolume($want, $newVol)
        Log ("bemeneti szint hangolva: {0}% -> {1}%  (ok: csucs {2}%)" -f $curVol, $set, $pk)
      }
    }
  }

  # ***2026-08-09: A KUSZOB UJRAHANGOLVA 1 METERES TAVOLSAGRA ***
  # A regi szabaly `rms -lt 0.8` volt. Ez KOZELROL (karmikrofon, 2 cm) helyes, de
  # 1 METERROL a beszed RMS-e termeszetesen 0.3-0.8% koruli -> a regi kapu a VALODI
  # tavoli beszedet is elutasitotta. Bizonyitek a naplobol (2026-08-09 14:36):
  #     18.7 mp, csucs 6.6%, RMS 0.58%, dinamika 4.89x  -> "nema"-kent eldobva,
  #   pedig a 4.89-es dinamika egyertelmuen BESZED (a zaj egyenletes, 1.5-3x).
  #
  # Az uj logika sulypontja a DINAMIKA, mert az TAVOLSAG-FUGGETLEN: a beszed
  # hullamzik (szunetek a szavak kozott), a szoba alapzaja nem. Az abszolut szintet
  # pedig nem kapuzni kell, hanem NORMALIZALNI (lentebb).
  # !A ket also korlat megmarad, mert ez a valtozat AUTOMATIKUSAN BEILLESZT:
  #   ha csendet kuldenenk fel, a Whisper KITALALNA egy szoveget, es az egyenesen
  #   a szerkesztodbe kerulne. (Elt mereskor: a csendre "NAMASTE"-t adott.)
  # ***2026-08-09 HELYESBITES -- SAJAT HIBA.
  # A dinamika-kuszob (3.5x) AGC-s mikrofonra ROSSZ. Elutasitott egy felvetelt,
  # amiben RMS 18%-kal, vagyis HANGOSAN beszelt a Boss -- csak epp a webkamera
  # automatikus erositese (AGC) szetlapitotta a dinamikat 2.78x-re. Az AGC dolga
  # PONTOSAN a dinamika csokkentese, tehat ott ez a merce ertelmetlen.
  #
  # Helyes logika: a dinamika CSAK akkor dontson, ha a szint ALACSONY -- ott
  # valoban az valasztja el a tavoli beszedet a szoba alapzajatol. Ha a felvetel
  # HANGOS (RMS >= 3%), az bizonyosan nem csend, barmilyen lapos is.
  $nema = $false; $ok = ''
  if ($pk -lt 2 -or $rms -lt 0.25) {
    $nema = $true; $ok = "tul halk (csucs<2 vagy RMS<0.25)"
  } elseif ($rms -lt 3.0 -and $dyn -lt 3.5) {
    $nema = $true; $ok = "halk ES lapos (RMS<3 es dinamika<3.5) -- valoszinuleg csak alapzaj"
  }
  if ($nema) {
    Log "NINCS ERTELMES BESZED -- nem kuldom fel, nem illesztek be semmit ($ok)"
    Beep2 220 400
    throw "nema"
  }
  # A lapos dinamika onmagaban nem hiba, de ROSSZABB atirast ad -- naplozzuk, hogy
  # kesobb is lassuk, melyik felvetelek voltak osszenyomva.
  if ($dyn -lt 4.0) {
    Log "megjegyzes: alacsony dinamika (${dyn}x) -- a mikrofon AGC-je osszenyomja a hangot, ez rontja a felismerest"
  }

  # *SZOFTVERES NORMALIZALAS -- ez teszi lehetove az 1 meteres tavolsagot.
  # A HARDVERES erosites mar a PLAFONON van (+30 dB, tartomany -16...+30 dB), tehat
  # onnan nincs tovabb. A Whisper viszont sokkal jobban atir egy felerositett,
  # kicsit zajos felvetelt, mint egy tisztat, de nagyon halkat.
  # A csucsot ~85%-ra visszuk, de az erositest KORLATOZZUK: kulonben egy majdnem
  # nema felvetelbol 25x-es zajt csinalnank, amire a Whisper hallucinal.
  $targetPeak = 0.85 * 32767.0
  $gain = if ($peak -gt 0) { [Math]::Min(25.0, $targetPeak / $peak) } else { 1.0 }
  if ($gain -gt 1.05) {
    for ($k = 44; $k -lt $b.Length - 1; $k += 2) {
      $v = [int]([BitConverter]::ToInt16($b, $k) * $gain)
      if ($v -gt 32767) { $v = 32767 } elseif ($v -lt -32768) { $v = -32768 }
      [Array]::Copy([BitConverter]::GetBytes([int16]$v), 0, $b, $k, 2)
    }
    [System.IO.File]::WriteAllBytes($Wav, $b)
    Log ("normalizalas: {0}x erosites -> csucs {1}%" -f [math]::Round($gain,1), [math]::Round($pk*$gain,1))
  }

  $JsonFile = Join-Path $env:TEMP 'hu_diktalas_auto.json'
  Remove-Item $JsonFile -Force -ErrorAction SilentlyContinue
  # ***2026-08-09: SZOTAR (prompt-torzitas) ***
  # A hiba NEM a hangminoseg volt. Merve: a normal magyar mondatokat hibatlanul irta at,
  # es KIZAROLAG a tulajdonnevek romlottak el:
  #     Marveen -> "Marlin",  usalackor -> "hus alacsok",  lackor2 -> "lacskot ketto",
  #     pusholni -> "pussolni",  freeberischeaper -> "FreeBel is CheatBelfis"
  # Ezek nem magyar szavak, a Whisper sosem talalja el oket magatol. A megoldas a
  # `prompt` parameter: raveztjuk a szakszavakra. A szoveget a `szotar.txt`-bol
  # olvassuk (UTF-8, a felhasznalo barmikor bovitheti), es a curl `-F "nev=<fajl"`
  # alakjaval adjuk at -- igy a shell/kodlap NEM tud belerontani az ekezetekbe.
  $SzotarFile = Join-Path $Base 'szotar.txt'
  $promptArg = @()
  if (Test-Path $SzotarFile) {
    # !A `prompt` HATARA 224 TOKEN (Groq/OpenAI dokumentacio). Ami tullog, azt a
    # szolgaltatas CSENDBEN eldobja -- vagyis a szotar egy resze eszrevetlenul nem
    # ervenyesulne. Ez pontosan az a "hamis atmenet", amibol ma mar kettot fogtam,
    # ezert MERJUK es SZOLUNK. A becsles ~2.5 karakter/token magyar szovegre;
    # 520 karakter felett mar veszelyes a kozelseg.
    $szChars = (Get-Item $SzotarFile).Length
    if ($szChars -gt 520) {
      Log "FIGYELEM: a szotar.txt $szChars karakter (~$([math]::Round($szChars/2.5)) token), a limit 224 token. Rovidits rajta, kulonben a vege NEM ervenyesul!"
    }
    $promptArg = @("-F", "prompt=<$SzotarFile")
  }
  # temperature=0 -> moho (greedy) dekodolas: a legdeterministikusabb, es ez keruli el
  # leginkabb a hallucinaciot csendes/zajos reszeken. A Groq alapertelmezese is 0, de
  # EXPLICITEN adjuk meg, hogy egy szolgaltatoi default-valtozas ne csendben rontson el.
  # A `language=hu` nem csak a pontossagot, a KESLELTETEST is javitja (Groq doksi).
  $http = & curl.exe -s --max-time 120 -o "$JsonFile" -w "%{http_code}" https://api.groq.com/openai/v1/audio/transcriptions `
      -H "Authorization: Bearer $Key" `
      -F "file=@$Wav" -F "model=$Model" -F "language=hu" -F "temperature=0" `
      -F "response_format=json" @promptArg

  if ("$http" -ne "200") { Log "Groq HTTP $http"; Beep2 220 400; throw "http $http" }
  $resp = [System.IO.File]::ReadAllText($JsonFile, [System.Text.Encoding]::UTF8)
  Remove-Item $JsonFile -Force -ErrorAction SilentlyContinue
  $txt = ("" + ($resp | ConvertFrom-Json).text).Trim()

  # ***UTOLAGOS JAVITASOK a `javitasok.txt`-bol ("hibas=helyes" soronkent).
  # A szotar (prompt) a legtobbet megoldja, de nehany nev makacs -- azokat itt
  # cserejuk ki. Kis/nagybetu-fuggetlen. A HOSSZABB mintakat eloszor, kulonben egy
  # rovid minta szetvagna a hosszabbat (pl. "Marlin" a "Marlinban" belsejeben).
  $JavFile = Join-Path $Base 'javitasok.txt'
  if ($txt -and (Test-Path $JavFile)) {
    $n = 0
    Get-Content $JavFile -Encoding UTF8 |
      Where-Object { $_ -and -not $_.StartsWith('#') -and $_.Contains('=') } |
      Sort-Object { -($_.Split('=')[0].Length) } |
      ForEach-Object {
        $p = $_.Split('=', 2)
        $bad = $p[0].Trim(); $good = $p[1].Trim()
        if ($bad) {
          $new = [regex]::Replace($txt, [regex]::Escape($bad), $good,
                                  [Text.RegularExpressions.RegexOptions]::IgnoreCase)
          if ($new -ne $txt) { $txt = $new; $n++ }
        }
      }
    if ($n -gt 0) { Log "szotar-javitas: $n csere" }
  }
  if ([string]::IsNullOrWhiteSpace($txt)) { Log "ures atirat"; Beep2 220 400; throw "ures" }

  Set-Clipboard -Value $txt
  if ($env:HU_DIKTALAS_DRYRUN -eq '1') {
    Log "DRY-RUN: NEM illesztek be. Szoveg lett volna: $txt"
  } else {
    # A fokuszt NEM kell allitgatni: a leallito kattintasod mar odavitte, ahova
    # a szoveget szanod. Csak megnezzuk, hova fog menni, es naplozzuk -- ha
    # veletlenul a talcara/Intezobe kattintottal, abbol a naplobol derul ki.
    try {
      $fg = [HuDikt.U32]::GetForegroundWindow()
      $fpid = 0; [void][HuDikt.U32]::GetWindowThreadProcessId($fg, [ref]$fpid)
      $fname = (Get-Process -Id $fpid -ErrorAction SilentlyContinue).ProcessName
      Log "beillesztes ide: $fname"
      if ($fname -match '^(explorer|ApplicationFrameHost)$') {
        Log "FIGYELEM: a talcara/Intezobe kattintottal -- a szoveg a vagolapon van, Ctrl+V-vel beteheted"
      }
    } catch { }
    Start-Sleep -Milliseconds 120
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Log "kesz: $txt"
  }
  Beep2 1200 90
}
catch {
  Log ("HIBA: " + $_.Exception.Message)
}
finally {
  Remove-Item $Lock -Force -ErrorAction SilentlyContinue
  Remove-Item $Wav  -Force -ErrorAction SilentlyContinue
}
