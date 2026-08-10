---
name: win-browser-control
description: Amikor Boss Telegramon (telefonrol) arra ker, hogy nyisd meg a bongeszot / egy weboldalt / egy Youtube videot A GEPEN (nem a telefonjan) -- pl. "indits el egy videot a szamitogepemen", "nyisd meg a bongeszot es menj fel X oldalra" -- vagy hogy ALLITSD LE amit korabban elinditottal ("allitsd le a videot"). Marveen WSL2-ben fut Boss sajat Windows gepen, tehat kepes kozvetlenul a Windows asztalra hatni, nem csak linket kuldeni. Uj nyitasnal az elozo ablakot automatikusan bezarja, hogy ne szoljon ket hang egyszerre.
---

# Windows böngésző-vezérlés WSL-ből

## Mikor használd

Boss Telegramon egy URL-t / keresést kér, és **explicit vagy kontextusból
egyértelmű, hogy a saját Windows gépén** (nem a telefonján) akarja
megnyitva látni -- pl. "indíts el egy videót a gépemen", "nyisd meg a
böngészőt és menj fel az emailemre". Ez MÁS, mint amikor csak egy linket
kér elküldeni Telegramon (azt simán a `reply` tool-lal, sima linkkel intézd).

Boss, 2026-08-05: eredetileg csak egy YouTube-linket küldtem neki
Telegramon, ő visszaszólt hangüzenetben, hogy ez nem jó, a GÉPÉN akarja
látni (telefonról vezérel, de a gépén, nagy képernyőn néz). Az is
elhangzott, hogy ez legyen általános képesség ("nyisd meg a böngészőt és
menj fel az emailemre, vagy bármi") -- ne csak a YouTube-esetre.

## A KRITIKUS buktató, amit élőben találtam meg (2026-08-05) -- NE told el

Az első próbálkozás `cmd.exe /c start "" "URL"` / közvetlen
`powershell.exe Start-Process` volt WSL interop-on át. Lefutott hibátlanul,
Boss mégsem látott/hallott semmit ("semmi nem tortent"). Ok, bebizonyítva
egy önteszttel (lásd lent): a WSL interop által indított Windows-folyamat
**Session 0**-ban fut ezen a gépen -- a szolgáltatások láthatatlan
munkamenetében --, míg Boss tényleges bejelentkezett asztala **Session
2** ("Console"). Session 0-ból nyitott ablak sosem jelenik meg és sosem
hallható a fizikai képernyőn/hangszórón, hibaüzenet nélkül. Ebből
következik az is, hogy utólagos ellenőrzés (`Get-Process | Where
MainWindowTitle`, `AppActivate`) is hamis negatívot ad WSL-ből indítva --
ne ebből ítélj.

**A megoldás:** Windows Task Scheduler, `LogonType Interactive`
principal-lal regisztrált feladat -- ez a mechanizmus, amit maguk a
Windows szolgáltatások használnak, ha (ritkán, szándékosan) UI-t akarnak
mutatni a bejelentkezett usernek. Egy így indított folyamat TÉNYLEG
Session 2-ben fut (self-teszttel visszaellenőrizve:
`[System.Diagnostics.Process]::GetCurrentProcess().SessionId` egy fájlba
írva, WSL-ről visszaolvasva -- 2-t adott, nem 0-t).

Ne egyszerűsítsd vissza `Start-Process`/`cmd.exe start`-ra, még ha
tisztábbnak is tűnik -- pontosan ez a "tiszta" verzió az, ami néma
sikerrel bukik.

## Előfeltétel

- Marveen WSL2-ben fut UGYANAZON a Windows gépen, amit vezérelni kell --
  `/mnt/c/Windows/...` elérhető, WSL interop bekapcsolva.
- Van aktív, bejelentkezett konzol-session a gépen. Ellenőrzés:
  ```bash
  /mnt/c/Windows/System32/tasklist.exe /V /FI "IMAGENAME eq explorer.exe"
  ```
  Ha nincs `explorer.exe` `Console` session-ben, senki nincs bejelentkezve
  -- szólj Boss-nak, hogy a gép nem abban az állapotban van.

## Eljárás

```bash
python3 ~/.claude/skills/win-browser-control/scripts/open_url.py "https://..."
python3 ~/.claude/skills/win-browser-control/scripts/open_url.py --close   # csak leállítás
```

Ez regisztrál/frissít egy `MarvinOpenUrl` nevű ütemezett feladatot
(`LogonType Interactive`, a Chrome-ot `--new-window <url>`-lel indítva),
majd azonnal lefuttatja. VADONATÚJ, önálló Chrome-ablakot nyit -- nem egy
meglévő ablak egy háttér-fülét --, hogy Boss biztosan lássa/hallja, ne kelljen
fület váltania, és a meglévő (sokszor 10+) nyitott fülét ne zavarja.

**Az ELŐZŐ ablakot automatikusan bezárja, mielőtt az újat megnyitja**
(Boss 2026-08-06: "ket hang egyszerre nem szabad hogy beszeljen").
Ehhez Marvin ablakai SAJÁT Chrome-profilban futnak
(`%LOCALAPPDATA%\MarvinChromeProfile`) -- ez nem kozmetika, hanem ez teszi
egyáltalán lehetővé a funkciót:

- A Chrome profilonként egy-példányos. Boss saját profiljával indítva (az ő
  Chrome-ja MINDIG fut) a `--new-window` csak átadja az URL-t a MEGLÉVŐ
  folyamatnak és kilép -- nincs saját folyamatunk amit bezárhatnánk, a
  "chrome.exe" kilövése pedig Boss 20+ fülét vinné magával.
- Saját profillal viszont van saját folyamatfánk, és a bezárás szűrője
  pontos: KIZÁRÓLAG olyan chrome.exe-t érint, aminek a parancssorában ott a
  `MarvinChromeProfile` marker. Boss böngészőjéhez így véletlenül sem nyúl.
- Ára: ez a profil nincs bejelentkezve Boss Google-fiókjába (nyilvános
  YouTube-videóhoz nem kell). Ha valamihez tényleg a bejelentkezett profil
  kell, azt külön kell kezelni -- és ott az automatikus bezárás nem működhet.

A leállítás előbb `CloseMainWindow()`-t próbál (szabályos ablak-bezárás), és
csak ha az nem megy, akkor kényszerít -- és ad 2,5 másodpercet a Chrome-nak
kiírni a profilját, MIELŐTT kényszerítene. Ez nem kozmetika: az azonnali
kilövés elvesztette az utolsó cookie-írást, és ettől jött vissza a YouTube
cookie-elfogadó fal egy olyan profilon, ami már elfogadta.

**YouTube: cookie-fal és autoplay** (Boss 2026-08-10: "nem megy, mert el kell
előbb fogadni valamit"). Olyan gépen, ahol senki nem ül a billentyűzetnél, egy
elfogadó fal vagy egy autoplay-blokk néma hiba: az ablak megnyílik, de nem
szól semmi. Két lépés kezeli:

- A `watch?v=` / `youtu.be/` / `shorts/` linkeket a script a nocookie-s
  beágyazott lejátszóra fordítja (`youtube-nocookie.com/embed/<id>?autoplay=1`),
  ahol nincs cookie-elfogadó fal. Ha az uploader letiltotta a beágyazást (ezt
  az oEmbed API előre megmondja), marad a normál watch-link.
- A Chrome `--autoplay-policy=no-user-gesture-required` kapcsolóval indul, mert
  egy frissen nyitott ablakon nem történt felhasználói gesztus, és e nélkül a
  Chrome nem indítja el a hangot. Az állapot (mely PID-eket nyitottuk,
milyen URL-re, mikor) ide kerül:
`~/.claude/skills/win-browser-control/state/last-window.json` -- ez napló és
hibakereséshez van, a bezárás NEM függ tőle: elveszett vagy elavult
állapotfájl sem hagyhat nyitva ablakot, és nem lőhet ki idegen folyamatot.

YouTube kereséshez: előbb `WebSearch`-csel találd meg a konkrét
`watch?v=...` linket, azt add át a script-nek -- ne magát a keresőoldalt
nyisd meg, hacsak Boss nem kifejezetten a találati listát kérte.

Ne közvetlen `cmd.exe`/`Start-Process` hívást írj újra -- lásd fent, ez a
látszólag egyszerűbb út a néma hibát adja.

## Buktatók

- NE próbáld PID vagy ablakcím alapján bezárni Boss saját Chrome-jában
  megnyitott lapot: a Session 0-ból (WSL interop) az ablak-felsorolás és a
  WM_CLOSE nem éri el a konzol-session ablakait, PID-re lőni pedig Boss
  összes fülét kilövi. A saját profil az egyetlen biztonságos út (lásd fent).

- `Get-Process | Where MainWindowTitle` és `AppActivate` WSL interop alól
  megbízhatatlan/üres, MÉG SIKERES indítás esetén IS (session-izoláció
  miatt a lekérdező folyamat maga sem látja a Session 2 ablakait) -- ne
  ebből ítéld meg a sikert.
- Miután elindítottad, MINDIG kérj vissza visszajelzést Boss-tól
  Telegramon ("nézd meg a képernyőt"), mert innen nincs teljesen
  megbízható módod ellenőrizni, hogy ténylegesen megjelent-e/hallható-e.
- Ha egy user-neve ékezetes (pl. "László"), NE told át bash/WSL szövegként
  a Windows oldalra (kódlap-ütközés miatt torzul, `l�szl�`-t láttam a
  `whoami` kimenetén WSL-ből nézve) -- a script ezért a usert magán a
  Windows oldalon, PowerShell-ből kérdezi le
  (`[System.Security.Principal.WindowsIdentity]::GetCurrent().Name`), nem
  bash-ből adja át.

- **ELSŐ videó a friss `MarvinChromeProfile`-on: YouTube cookie-fal + nincs autoplay** (2026-08-10, élesben megfogva, Boss jelenlétében). Amíg usalackor be nem építi ezt közvetlenül az `open_url.py`-ba (lásd kártya #101fffd0 #150/#151 komment), KÉZI UTÓLAGOS lépésként számolj vele:
  1. Nyitás után 3-5 mp múlva végy egy screenshotot (`windows-desktop-screenshot` skill mintája) -- **NE Boss telefonon küldött fotójából olvasd le a koordinátákat**, az Telegram-tömörítés miatt más felbontású/skálázású, mint a valódi képernyő. Mindig a saját, frissen készített screenshotodból számolj.
  2. Ha megjelenik a "Before you continue to YouTube" cookie-fal (csak az ELSŐ indításnál fordul elő adott profilon, utána a cookie megjegyzi): koordináta-kattintás helyett UIAutomation `InvokePattern`-nel keresd meg és nyomd meg az "Accept all" gombot -- ez megbízhatóbb, mint pixel-koordináta (a dialógus mérete/elhelyezkedése változó volt két egymást követő screenshoton is). Minta:
     ```powershell
     Add-Type -AssemblyName UIAutomationClient
     Add-Type -AssemblyName UIAutomationTypes
     $p = Get-Process -Name chrome | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*<cím-részlet>*" } | Select-Object -First 1
     $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
     $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
     $btn = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond) | Where-Object { $_.Current.Name -eq "Accept all" } | Select-Object -First 1
     if ($btn) { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
     ```
     (A window handle megszerzéséhez előbb `ShowWindow(hWnd, 9)` + `SetForegroundWindow(hWnd)` kellhet, hogy Chrome felépítse a teljes accessibility-fát.)
  3. Autoplay: MINDEN új ablaknál (nem csak elsőnél) előfordulhat, hogy a videó betölt de nem indul el magától, mert Chrome user-gesztust vár arra a konkrét ablakra. Nyitás után küldj egy kattintást a lejátszó közepére (vagy a `k`/space billentyűt), és csak EZUTÁN jelentsd sikeresnek a nyitást.
  4. A "Chrome didn't shut down correctly / Restore pages?" buborék ártalmatlan (nem blokkolja a lejátszást), figyelmen kívül hagyható -- kozmetikai, a kényszerített bezárás mellékhatása.

## Ellenőrzés

Automatikus bezárás élő ellenőrzése (2026-08-10-en így mértem le):
```bash
# hany Marvin-ablak van eppen (a szam a chrome.exe folyamatok szama, nem 1)
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command \
  "(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*MarvinChromeProfile*' } | Measure-Object).Count"
```
Nyiss egy videót, kérdezd le a PID-eket, nyiss egy másikat: a script kiírja
mely PID-eket zárta be, és a lekérdezés után egyetlen régi PID sem élhet.
Boss saját Chrome-jának PID-jei (pl. `tasklist /FI "IMAGENAME eq chrome.exe"`)
változatlanul életben kell maradjanak.

Self-teszt (session-probe, nem nyit semmit, csak fájlba írja a
munkamenet-azonosítót -- ha `MarvinOpenUrl` feladat esetleg hibázna, ezzel
lehet gyorsan visszaellenőrizni hogy a Task Scheduler-es út tényleg
Session 2-be jut-e):
```bash
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command '
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -Command \"[System.Diagnostics.Process]::GetCurrentProcess().SessionId | Out-File -FilePath C:\Users\Public\marvin_probe.txt -Force\""
$principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive
Register-ScheduledTask -TaskName "MarvinProbe" -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName "MarvinProbe"
Start-Sleep -Seconds 2
'
cat /mnt/c/Users/Public/marvin_probe.txt   # 2 = jó (interaktív), 0 = rossz (Session 0)
```

Rendes használat: `open_url.py` sikeres kimenete `opened (new Chrome
window, interactive session): <url>`, és Boss visszaigazolja Telegramon,
hogy megjelent a gépén.
