---
name: wsl-windows-gui-command
description: Windows GUI/tray alkalmazas inditasa vagy parancssori kapcsolo eljuttatasa WSL-bol. Hasznald amikor egy .exe-t WSL-bol hivsz es az "lefut" (exit 0) de semmi nem tortenik, vagy amikor egy tray-appnak parancsot kell kuldeni. Feladatutemezo (LogonType Interactive) + UTF-8 BOM minta.
---
# Windows GUI-parancs WSL-bol

## Mikor hasznald

- Egy Windows .exe-t hivsz WSL-bol es exit 0-val AZONNAL visszater, de a
  hatasa elmarad (nem indul el, nem ment, nem latszik a tasklistben).
- Egy tray-app (PersistentWindows, hasonlok) parancssori kapcsolojat kell
  eljuttatni.
- Barmi ami a valodi asztali sessiont igenyli.

## A ket buktato, ami miatt ez a skill letezik (2026-08-11, eles eset)

1. **A WSL-bol inditott folyamat nem kap interaktiv asztalt.** `execFile`/
   `spawn` a .exe-re lefut, `exit 0`, es SEMMI nem tortenik -- meg a
   tasklistben sem jelenik meg. A hibakod nulla, tehat minden hivo retegnek
   sikeresnek latszik. Ez orakig el tud rejtozni ("a gomb zold, a fajl regi").
2. **BOM nelkul kiirt .ps1 = ekezetvesztes.** A Windows PowerShell 5.1 a
   BOM nelkuli fajlt ANSI-kent olvassa. Ha az utvonalban ekezetes profilnev
   van (`C:\Users\<ekezetes-nev>\...`), a task `0x80070002` (FILE_NOT_FOUND) hibaval
   bukik -- ami semmiben nem hasonlit egy karakterkodolasi hibara.

## Eljaras

1. Konvertald az utvonalat: `wslpath -w "/mnt/c/..."`.
2. Ird ki a .ps1-et **UTF-8 BOM-mal** (Node: `'\uFEFF' + script`; Python:
   `encoding='utf-8-sig'`), soremelesnek `\r\n`. Ne `-Command`-dal add at a
   scriptet: a WSL -> PowerShell idezojel-lanc megbizhatatlanul torik.
3. Regisztrald es inditsd:
   ```powershell
   $id = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
   $action = New-ScheduledTaskAction -Execute $exe -Argument '-flag=ertek'
   $principal = New-ScheduledTaskPrincipal -UserId $id -LogonType Interactive
   Register-ScheduledTask -TaskName 'Nev' -Action $action -Principal $principal -Force | Out-Null
   Start-ScheduledTask -TaskName 'Nev'
   ```
   Auto-starthoz: `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $id`
   es add at `-Trigger $trigger`-rel. Admin jog NEM kell (a user sajat
   szintjen fut); `-RunLevel Highest` viszont UAC-t kerhet, azt keruld.
4. **Ellenorizd a HATAST, ne az exit kodot.** Nezd a celfajl mtime-jat, a
   tasklistet, vagy screenshotot. Az exit 0 itt semmit nem bizonyit.
5. Hibakereseshez: `Get-ScheduledTaskInfo -TaskName 'Nev'` ->
   `LastTaskResult`. 0 = ok, `2147942402` = 0x80070002 FILE_NOT_FOUND
   (tipikusan a 2. buktato).

## Buktatok

- **Ha megolsz egy GUI-folyamatot, INDITSD IS EL.** Az `explorer.exe`-t
  `taskkill /F`-fel megolve a Windows NEM inditja ujra magatol: az asztal,
  az ikonok es a TALCA is eltunik, a felhasznalo egy fekete kepernyot kap
  amirol semmit nem tud inditani (2026-08-11, eles eset {{OWNER_NAME}} gepen). Az
  ujrainditast ugyanezen a Feladatutemezo-uton kell megtenni, es meg kell
  varni amig a folyamat tenyleg fut. Reszleges hiba eseten IS inditsd el --
  akkor a legrosszabb fekete kepernyovel magara hagyni valakit.

- Egy tray-app altalaban EGY peldanyban futhat. A parancssori kapcsolo az
  INDULO peldanynak szol; ha mar fut egy, a masodik indítas kilephet
  hatas nelkul. Ha a parancs nem hat, probald: leallitas -> indítas a
  kapcsoloval.
- Takarits: az egyszeri celra regisztralt taskot `Unregister-ScheduledTask
  -Confirm:$false`-szal szedd le, kulonben ott marad a gepen.
- A `/mnt/c/Users/Public/` jo hely a generalt scriptnek: WSL-bol irhato es
  a task futtato useretol fuggetlenul olvashato.

## Ellenorzes

- `Get-ScheduledTaskInfo` LastTaskResult == 0
- a cel tenyleges allapota valtozott (fajl mtime / tasklist / screenshot)
- a mar nem kellő task le van szedve
