---
name: win-browser-control
description: Amikor Boss Telegramon (telefonrol) arra ker, hogy nyisd meg a bongeszot / egy weboldalt / egy Youtube videot A GEPEN (nem a telefonjan) -- pl. "indits el egy videot a szamitogepemen", "nyisd meg a bongeszot es menj fel X oldalra". Marveen WSL2-ben fut Boss sajat Windows gepen, tehat kepes kozvetlenul a Windows asztalra hatni, nem csak linket kuldeni.
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
```

Ez regisztrál/frissít egy `MarvinOpenUrl` nevű ütemezett feladatot
(`LogonType Interactive`, a Chrome-ot `--new-window <url>`-lel indítva),
majd azonnal lefuttatja. VADONATÚJ, önálló Chrome-ablakot nyit -- nem egy
meglévő ablak egy háttér-fülét --, hogy Boss biztosan lássa/hallja, ne kelljen
fület váltania, és a meglévő (sokszor 10+) nyitott fülét ne zavarja.

YouTube kereséshez: előbb `WebSearch`-csel találd meg a konkrét
`watch?v=...` linket, azt add át a script-nek -- ne magát a keresőoldalt
nyisd meg, hacsak Boss nem kifejezetten a találati listát kérte.

Ne közvetlen `cmd.exe`/`Start-Process` hívást írj újra -- lásd fent, ez a
látszólag egyszerűbb út a néma hibát adja.

## Buktatók

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

## Ellenőrzés

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
