---
name: windows-desktop-screenshot
description: Valódi képernyőkép készítése {{OWNER_NAME}} Windows asztaláról (nem böngésző-URL, hanem BÁRMILYEN futó desktop-app, pl. MetaTrader) WSL-ből, Task Scheduler Interactive-mintával. Akkor használd, ha egy már FUTÓ Windows alkalmazás tartalmát kell látnod/elemezned (chart, ablak, bármi vizuális), vagy azt előtérbe kell hoznod.
---

# Windows desktop screenshot WSL-ből

## Mikor használd

{{OWNER_NAME}} kér egy elemzést/leolvasást egy már futó Windows desktop-appról (pl.
"nézd meg a MetaTradert", "mi van a képernyőn"), és nem elég a
`win-browser-control` skill (az csak URL-t nyit Chrome-ban, nem lát
vissza semmit). Ez a skill a MÁSIK irány: KÉPERNYŐKÉPET hoz vissza WSL-be,
amit aztán a saját vision-eddel el tudsz olvasni/elemezni.

Felfedezve 2026-08-07: {{OWNER_NAME}} ragaszkodott hozzá hogy egy MetaTrader
arany-chart elemzést saját magam csináljak meg, screenshot nélkül tőle.
Kiderült hogy a `terminal.exe` (MT4) MÁR FUTOTT a gépén (Session 4,
Console) -- nem kellett elindítani, csak előtérbe hozni és lefotózni.

## Előfeltétel

Ugyanaz mint a `win-browser-control` skillnél: Marveen WSL2-ben fut
ugyanazon a Windows gépen, WSL interop bekapcsolva, `/mnt/c/...` elérhető,
és van aktív bejelentkezett konzol-session (ellenőrzés:
`/mnt/c/Windows/System32/tasklist.exe /V /FI "IMAGENAME eq explorer.exe"`).

## Eljárás

1. **Ellenőrizd, fut-e már a célalkalmazás** (ne indíts feleslegesen újat):
   ```bash
   /mnt/c/Windows/System32/tasklist.exe /V /FI "IMAGENAME eq <processname>.exe"
   ```
   Nézd meg a `Session Name` oszlopot -- ha `Console` és van PID, fut és
   látható a fizikai képernyőn. (MetaTrader 4 processz-neve `terminal.exe`,
   MetaTrader 5-é `terminal64.exe`.)

2. **Másold fel a screenshot-scriptet** (csak első alkalommal, utána marad):
   ```bash
   cp ~/.claude/skills/windows-desktop-screenshot/scripts/foreground_and_screenshot.ps1 /mnt/c/Users/Public/marvin_screenshot.ps1
   ```

3. **Regisztráld + futtasd Task Scheduler-rel, LogonType Interactive**
   (ugyanaz a mechanizmus mint a `win-browser-control` skillben -- WSL
   interop-on át indított folyamat Session 0-ban fut, láthatatlanul; ez
   viszont Session 2/4-ben, a valódi asztalon):
   ```bash
   /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command '
   $id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Users\Public\marvin_screenshot.ps1 -ProcessName terminal -OutPath C:\Users\Public\marvin_screenshot.png"
   $principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive
   Register-ScheduledTask -TaskName "MarvinScreenshot" -Action $action -Principal $principal -Force | Out-Null
   Start-ScheduledTask -TaskName "MarvinScreenshot"
   '
   ```
   `-ProcessName` a célalkalmazás processz-neve (előtérbe hozza mielőtt
   fotóz) -- hagyd üresen (`-ProcessName ""`) ha nem kell semmit előtérbe
   hozni, csak az aktuális képernyőt akarod.

4. **Várj 3-4 másodpercet, majd olvasd be a PNG-t közvetlenül Read-del:**
   ```bash
   sleep 4
   ```
   ```
   Read /mnt/c/Users/Public/marvin_screenshot.png
   ```
   A Read tool multimodális, a képet közvetlenül "látod" -- nincs szükség
   külön OCR-re vagy leírásra, elemezd vizuálisan.

5. Ismételt fotózáshoz (pl. 30 percenkénti ütemezett elemzésnél) elég csak
   a 3-4. lépést újra lefuttatni -- a feladat regisztrálva marad,
   `Start-ScheduledTask -TaskName "MarvinScreenshot"` mindig friss képet
   csinál.

## Buktatók

- NE `Start-Process`/`cmd.exe start`-tal próbáld -- lásd `win-browser-control`
  skill, ugyanaz a Session 0 néma-hiba csapda érvényes screenshotra is.
- Az ablak-előtérbe-hozás (`SetForegroundWindow`) csak akkor működik
  megbízhatóan, ha a PowerShell folyamat MAGA a Session 2/4-ben fut (tehát
  a Task Scheduler Interactive feladat BELSEJÉBŐL hívod, nem WSL-ről
  közvetlenül) -- ez már eleve úgy van felépítve a scriptben.
- Ha a célapp `MainWindowHandle`-je 0 (pl. minimalizálva van a tálcára,
  nem a taskbarra), az előtérbe-hozás csendben kimarad, de a teljes
  képernyőkép attól még elkészül -- nézd meg mi látszik rajta, lehet hogy
  elég úgy is, vagy manuálisan kell a tulajdonosnak ({{OWNER_NAME}}) visszaállítania az ablakot.
- A kimeneti PNG felülíródik minden futtatáskor (nincs verziózás) -- ha
  meg akarod őrizni egy adott pillanat képét, másold el más névvel mielőtt
  újra futtatod.
- `$ErrorActionPreference = 'SilentlyContinue'` van a scriptben -- ha a
  screenshot NEM készül el (a `.status.txt` fájl hiányzik vagy régi
  időbélyegű), az néma hiba, nem dob vissza semmit. Mindig ellenőrizd a
  PNG módosítási idejét (`ls -la`) mielőtt beolvasod, hogy tényleg friss-e.

## Ellenőrzés

- `ls -la /mnt/c/Users/Public/marvin_screenshot.png` -- friss időbélyeg
  (néhány másodperce, nem órákkal korábbi).
- A Read tool-lal megnyitott kép ténylegesen a várt alkalmazást mutatja,
  nem egy másik ablakot vagy üres asztalt.
