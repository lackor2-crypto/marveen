---
name: weekly-system-maintenance
description: Heti egyszeri, automatikus Windows karbantartas WSL alol: rendszerhibak es lassulasi okok atnezese, biztonsagos beepitett javito/tisztito lepesek, meghajto-optimalizalas, majd rovid riport. Kockazatos/admin/reboot lepes CSAK jovahagyassal. Trigger: heti scheduled task, vagy "windows karbantartas / gyorsitsd fel a gepet".
---
# Weekly System Maintenance (Windows, WSL alol)

## Mikor használd
Heti automatikus futas (scheduled task: weekly-system-maintenance), vagy ha {{OWNER_NAME}} Windows-karbantartast/gyorsitast ker.

## Környezet (FONTOS)
- Ez WSL2 a Windows host felett. A Windows-eszkozoket interop-on hivod. A `powershell.exe` gyakran NINCS a PATH-ban, ezert TELJES ut:
  `PS="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"`  majd `"$PS" -NoProfile -Command "..."`
- A WSL user NEM admin Windows oldalon (`IsInRole(Administrator)=False`). Ezert az admin-igenyu lepesek UAC-elevaciot kernek -> ezek JOVAHAGYAS-kotelesek ({{OWNER_NAME}} futtatja emelt joggal / rabolint a UAC-ra). Autonomy-config leképzes: admin/rendszermodositas ~ `system_config_change` (level 2), ujrainditas ~ `system_reboot` (level 2), a szinteket olvasd a `store/autonomy-config.json`-bol. Lasd [[autonomous-diagnose-repair]].

## Eljárás
### 1. Diagnosztika (AUTONOM, csak olvas, nem kell admin)
- Lemez: `"$PS" -NoProfile -Command "Get-Volume C | Select DriveLetter,@{n='FreeGB';e={[math]::Round($_.SizeRemaining/1GB,1)}},HealthStatus"`
- Meghajto tipus (SSD/HDD!) + egeszseg: `"$PS" -NoProfile -Command "Get-PhysicalDisk | Select FriendlyName,MediaType,HealthStatus,OperationalStatus"`
- Top processzek: `"$PS" -NoProfile -Command "Get-Process | Sort CPU -Desc | Select -First 8 Name,CPU,@{n='MB';e={[math]::Round($_.WS/1MB)}}"`
- Startup elemek: `"$PS" -NoProfile -Command "Get-CimInstance Win32_StartupCommand | Select Name,Command,Location"`
- Rendszerhibak (utolso 7 nap, Error): `"$PS" -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName='System';Level=2;StartTime=(Get-Date).AddDays(-7)} -MaxEvents 20 | Select TimeCreated,Id,ProviderName,Message"`
- Temp meret: `"$PS" -NoProfile -Command "'{0:N0} MB' -f ((Get-ChildItem \$env:TEMP -Recurse -EA SilentlyContinue | Measure Length -Sum).Sum/1MB)"`
- Pending reboot: a `HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending` es `...\WindowsUpdate\Auto Update\RebootRequired` kulcsok letezese.
- Allits fel rovid hipotezist a lassitok/hibak okarol.

### 2. Biztonsagos javitas/tisztitas (AUTONOM, visszafordithato)
- DNS cache urites: `/mnt/c/Windows/System32/cmd.exe /c ipconfig /flushdns` (nem admin, artalmatlan)
- User TEMP tisztitas (csak temp, a zarolt fajlok kimaradnak):
  `"$PS" -NoProfile -Command "Get-ChildItem \$env:TEMP -Recurse -EA SilentlyContinue | Where LastWriteTime -lt (Get-Date).AddDays(-3) | Remove-Item -Recurse -Force -EA SilentlyContinue"`
- Windows Store cache (opcionalis, nem admin): `/mnt/c/Windows/System32/wsreset.exe` (ablakot nyithat)
- Storage Sense egyszeri lefuttatasa, HA be van kapcsolva (nem torol tobbet mint a beallitas).
- Minden tisztitas UTAN merd ujra a nyert helyet, jegyezd a riporthoz.

### 3. Kockazatos / admin / reboot -> JOVAHAGYAS (batch, teljes sablon)
Ezek admin-elevaciot (UAC) igenyelnek. Kerj engedelyt EGY korben (Mit/Miert/Hatas/Pontosan mire/Kockazat), majd add at a tulajdonosnak ({{OWNER_NAME}}) a parancsot emelt PowerShellben, VAGY: `"$PS" -Command "Start-Process powershell -Verb RunAs -ArgumentList '-Command','...'"` (UAC-t dob, {{OWNER_NAME}} kattint):
- Rendszerfajl-javitas: `sfc /scannow`
- Windows-kep javitas: `DISM /Online /Cleanup-Image /RestoreHealth`
- Lemez-ellenorzes: `chkdsk C: /scan` (online). FIGYELEM: `/f` vagy `/r` ujrainditast utemez -> az mar reboot-approval.
- Meghajto-optimalizalas: SSD-n `Optimize-Volume -DriveLetter C -ReTrim` (TRIM), HDD-n `-Defrag`. A MediaType-ot az 1. lepesbol tudod -- SSD-t SOSE defragmentalj.
- Recycle Bin urites (`Clear-RecycleBin -Force`) -- visszafordithatatlan, ezert approval.
- Windows Update telepites / startup-elem letiltas -> reboot-approval.

### 4. Riport (Telegram) + esemeny-log
Rovid: mit talalt (hibak, lassitok), mit javitott autonoman (nyert hely), mi var jovahagyasra (a batch). Ha minden rendben es nem volt teendo, egy soros nyugtazas.
A futas fo lepeseit naplozd a kozos esemeny-logba (visszanezheto: `tail store/event-log.txt`):
`bash scripts/eventlog.sh "weekly-maint:<lepes>" ok|error|warn "rovid uzenet"`
(pl. `weekly-maint:temp-clean` ok "320 MB", `weekly-maint:sfc` warn "jovahagyasra var"). Hibanal `error` + a rovid hibauzenet.

## Buktatók
- WSL user NEM admin -> admin parancs headless NEM fut le; UAC kell ({{OWNER_NAME}}). Ne probald csendben, ne talalj ki elevaciot.
- `powershell.exe` sokszor nincs PATH-ban -> teljes ut (lasd fent).
- SSD-n NE defragmentalj (feleslegesen koptat) -> csak `ReTrim`. Eloszor MediaType!
- `chkdsk /f` es `/r` rebootot utemez -> az mar reboot-approval, ne inditsd el figyelmeztetes nelkul.
- Recycle Bin urites es a >nap temp-torles: a temp biztonsagos, a Recycle Bin NEM (approval).
- Esemenynaplo: a legtobb Error zaj (indulasi warning, mar megoldott) -> ne riasszd a tulajdonost ({{OWNER_NAME}}) minden sorra, csak ismetlodo/kritikus mintara.
- A cache/temp tisztitas ritkan gyorsit erdemben ha nincs lemez-szukosseg -- a riportban legy oszinte errol (lasd a Linux-oldali [[autonomous-diagnose-repair]] tanulsagot).

## Ellenőrzés
- A riport tartalmazza: talalt hibak + autonom javitasok + jovahagyasra varo lepesek.
- Semmi admin/reboot nem futott jovahagyas nelkul.
- Az autonom lepesek visszafordithatoak voltak (temp/cache/dns), semmi visszafordithatatlan (Recycle Bin, torles) nem futott automatikusan.
