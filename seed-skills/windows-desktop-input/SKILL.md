---
name: windows-desktop-input
description: Valódi kattintás + gépelés + Enter szimulálása egy Windows desktop-appban (pl. WhatsApp Desktop üzenetküldés) WSL-ből, Task Scheduler Interactive-mintával. KOCKÁZATOSABB mint a windows-desktop-screenshot skill -- ez ténylegesen KÜLDHET/MÓDOSÍTHAT valamit, harmadik fél felé is látható lehet (pl. egy WhatsApp-kontaktnak). Csak akkor használd, ha Boss explicit engedélyezte az adott konkrét küldést/kattintást.
---

# Windows desktop input (kattintás + gépelés) WSL-ből

## Mikor használd

Boss kér egy KONKRÉT műveletet egy már futó Windows desktop-appban, ami
nem csak megnézés (arra lásd `windows-desktop-screenshot`), hanem tényleges
beavatkozás: szöveg beírása egy mezőbe, gomb megnyomása, üzenet elküldése.

Felfedezve/bevált 2026-08-07: Boss kérte, hogy a WhatsApp Desktopon (már
nyitva, "Kiss Zoltán" cseten) írjak be és küldjek el egy szöveget --
sikerült, ténylegesen megérkezett a kontaktnak.

**FONTOS -- ez outward-facing, visszafordíthatatlan akció.** Egy elküldött
WhatsApp/email/stb. üzenetet nem lehet visszavonni, és harmadik fél látja.
Mielőtt ezt a skillt bevetnéd:
- Boss-nak KONKRÉTAN és EXPLICITEN engedélyeznie kell az adott küldést
  (nem elég egy általános "csinálj desktop-automatizálást" -- lásd a
  system prompt "Executing actions with care" szakaszát).
- Ha van bármi esély hogy a cél már meg lett csinálva (pl. Boss maga is
  beírta közben), ELŐSZÖR nézd meg screenshottal (`windows-desktop-screenshot`),
  NE küldj vakon -- 2026-08-07-én pont ez történt, Boss már bediktálta
  Zoltánnak amit kértem volna elküldeni.

## Előfeltétel

Ugyanaz mint a `windows-desktop-screenshot` / `win-browser-control`
skilleknél: Marveen WSL2-ben fut a célgépen, `/mnt/c/...` elérhető, aktív
bejelentkezett konzol-session.

## Eljárás

1. **Előbb NÉZD MEG screenshottal** (`windows-desktop-screenshot` skill),
   hogy pontosan hol van a kattintandó mező/gomb a képernyőn (pixel-
   koordináta), és hogy a cél app tényleg a várt állapotban van-e (pl. a
   megfelelő kontakt/chat van-e nyitva).

2. **Írj egy PURPOSE-SPECIFIC wrapper .ps1-et közvetlenül a Windows oldalra**
   (ne próbáld a generikus `click_paste_send.ps1`-et sok `-Argument`
   paraméterrel hívni Task Scheduleren át -- a beágyazott idézőjelek a
   WSL -> PowerShell -> Register-ScheduledTask -> belső PowerShell láncban
   megbízhatatlanul törnek, élesben "Exit code 2"-t adott némán). Írd ki
   a konkrét koordinátákat/szöveget KÖZVETLENÜL a scriptbe egy heredoc-kal:
   ```bash
   cat > /mnt/c/Users/Public/marvin_action.ps1 << 'EOF'
   $ErrorActionPreference = 'SilentlyContinue'
   Add-Type @"
   using System;
   using System.Runtime.InteropServices;
   public class Win32X {
     [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
     [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
     [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);
     [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
   }
   "@
   $proc = Get-Process -Name "<processnev>*" | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
   if ($proc) {
     [Win32X]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
     [Win32X]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
     Start-Sleep -Milliseconds 800
   }
   [Win32X]::SetCursorPos(<x>, <y>) | Out-Null
   Start-Sleep -Milliseconds 150
   [Win32X]::mouse_event(0x0002, 0, 0, 0, 0)
   [Win32X]::mouse_event(0x0004, 0, 0, 0, 0)
   Start-Sleep -Milliseconds 300
   Set-Clipboard -Value "<szoveg>"
   Add-Type -AssemblyName System.Windows.Forms
   [System.Windows.Forms.SendKeys]::SendWait("^v")
   Start-Sleep -Milliseconds 400
   [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
   Start-Sleep -Milliseconds 500
   Add-Type -AssemblyName System.Drawing
   $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
   $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
   $g = [System.Drawing.Graphics]::FromImage($bmp)
   $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
   $bmp.Save("C:\Users\Public\marvin_action_after.png", [System.Drawing.Imaging.ImageFormat]::Png)
   "done" | Out-File -FilePath C:\Users\Public\marvin_action_status.txt -Force
   EOF
   ```
   Miért clipboard+paste (`^v`) és NEM `SendKeys::SendWait($szoveg)` a
   szöveghez: SendKeys karakterenként küld, és összezavarodik ékezetes/
   Unicode szövegen (magyar!) -- a vágólap-beillesztés robusztus.

3. **Regisztráld + futtasd Task Scheduler-rel** (a wrapper .ps1-et
   argumentum nélkül hívva -- nincs beágyazott idézőjel-probléma, mert
   minden érték már a fájlban van):
   ```bash
   /mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -Command '
   $id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\Users\Public\marvin_action.ps1"
   $principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive
   Register-ScheduledTask -TaskName "MarvinAction" -Action $action -Principal $principal -Force | Out-Null
   Start-ScheduledTask -TaskName "MarvinAction"
   '
   ```

4. **Várj 3-4 másodpercet, olvasd be az "after" screenshotot Read-del**,
   hogy tényleg megtörtént-e amit vártál (nem csak feltételezed).

## Buktatók

- Ugyanaz a Session 0 csapda mint a másik két skillnél -- lásd
  `win-browser-control`/`windows-desktop-screenshot`.
- **A Task Schedulerből indított PowerShell KONZOLABLAKA előtérbe ugrik és
  elnyeli a kattintást** (2026-08-10, élőben): a WhatsApp chat-listájára
  szánt kattintás a saját konzolomba ment, ami ettől még "Select" módba is
  került. Kívülről ez néma hiba: a script lefut, a screenshot elkészül, csak
  éppen semmi nem történt a cél-appban. Két dolog kell EGYÜTT:
  1. `-WindowStyle Hidden` a task argumentumában
     (`-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ...`),
  2. a cél-ablak EXPLICIT előtérbe hozása a scriptben a kattintás előtt
     (`SetForegroundWindow` a `MainWindowHandle`-re), nem elég feltételezni
     hogy az app látszik.
- A Store-appok (pl. WhatsApp Desktop) processz-neve nem feltétlenül az
  amire számítasz (`WhatsApp.Root.exe`, a valódi ablak egy
  `msedgewebview2` process alatt van), és `tasklist /FI "IMAGENAME eq
  WhatsApp.exe"` üres listát ad akkor is, ha az app fut. Ablakot keress,
  ne processz-nevet: `Get-Process | Where-Object { $_.MainWindowTitle -eq
  'WhatsApp' }`.
- Ha a Store-app egyáltalán nem fut, az AppUserModelID-vel indítható:
  `Get-StartApps | Where-Object { $_.Name -like '*WhatsApp*' }` adja az
  AppID-t, majd `explorer.exe shell:AppsFolder\<AppID>` a task Execute/
  Argument párosaként. Indulás után a tálca-ikonra kattintás hozza elő az
  ablakot.
- **Ne ismételd meg "biztonságból" ha bizonytalan vagy hogy lement-e** --
  2026-08-07-én egy "Exit code 2" hibaüzenet után megismételtem a
  futtatást, de valójában az ELSŐ próbálkozás is elment, csak a
  regisztrációs parancs adott vissza hibakódot -- eredmény: a teszt-üzenet
  KÉTSZER ment ki ugyanannak a kontaktnak. Mielőtt újra próbálkozol egy
  hibás visszatérési kód után, ELLENŐRIZD screenshottal hogy tényleg nem
  történt-e meg, ne csak a bash exit code-ra hagyatkozz.
- A kattintási koordináták a KONKRÉT ablak-elrendezéstől/felbontástól
  függenek -- mindig egy FRISS screenshotból olvasd le őket, ne bízz egy
  korábbi futásból megjegyzett koordinátában (az ablak mérete/pozíciója
  változhatott).
- `SendKeys::SendWait("{ENTER}")` néhány appban új sort szúr be küldés
  helyett (pl. ha Shift+Enter a "submit" és sima Enter új sor) -- ha nem
  megy el az üzenet, nézd meg az app saját küldés-billentyűjét.

## Ellenőrzés

- Az "after" screenshot ténylegesen mutatja a beírt/elküldött tartalmat
  a cél alkalmazásban.
- Boss visszaigazolja hogy a másik fél (pl. a WhatsApp-kontakt) tényleg
  megkapta.
