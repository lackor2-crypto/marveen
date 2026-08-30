---
name: wsl-windows-claude-login-sync
description: Amikor egy WSL alatt futó Claude Code ágens "hit limit"-en ragad, a gazda beloginol egy másik fiókkal, és az ágens mégsem indul újra. Vagy amikor login-állapotot kell szinkronban tartani WSL és Windows között. Trigger: "átloginoltam és mégis limit", "PowerShellből is lehessen loginolni", credential sync, /mnt/c fájlfigyelés.
scope: global
---
# WSL <-> Windows Claude login szinkron

## Mikor használd
- A gazda beloginol Claude Code-ba PowerShellből, az Ubuntu azt írja "sikeres", de a WSL-ben futó ágens továbbra is limitre panaszkodik.
- Bármikor, amikor WSL és Windows oldali Claude állapotot (credentials, config) kell szinkronban tartani.
- Amikor egy /mnt/c alatti fájl változására kell reagálni.

## A gyökérok
Két teljesen külön hitelesítési tár:
- Windows: `C:\Users\<user>\.claude\.credentials.json` (WSL-ből `/mnt/c/Users/<user>/.claude/.credentials.json`)
- WSL: `~/.claude/.credentials.json`

Egyik login sem látszik a másik oldalról. A gazda szempontjából "sikeres bejelentkezés" történt, az ágens szempontjából semmi.

## Eljárás
1. Ellenőrizd, hogy tényleg két fájl van-e, és melyik a frissebb:
   ```bash
   python3 -c "import json,os,datetime
   for p in ['$HOME/.claude/.credentials.json','/mnt/c/Users/<user>/.claude/.credentials.json']:
       d=json.load(open(p))['claudeAiOauth']
       print(p, datetime.datetime.fromtimestamp(os.path.getmtime(p)), d['refreshToken'][-8:], d['expiresAt'])"
   ```
2. Írj kétirányú tükör scriptet (minta: `marveen/store/cred-sync.sh`). Döntési szabály:
   - csak akkor cselekedj, ha a két `refreshToken` KÜLÖNBÖZIK (valódi új login). Azonos refreshToken = rutin accessToken-frissítés, nincs teendő.
   - a nagyobb `expiresAt` a nyertes (a token élettartama fix, tehát a későbbi lejárat = későbbi bejelentkezés).
   - NE mtime alapján dönts: a DrvFs és az ext4 órája nem ugyanaz, oda-vissza csapkodás lesz belőle.
3. Írj figyelő daemont (minta: `marveen/store/cred-watch.sh`), 2 másodperces poll ciklussal, systemd user service-ként, `Restart=always`.
4. A tükrözés után kickeld a meglévő credential-switch watchdogot, az döntse el kell-e service restart.
5. Ellenőrizd: `loginctl show-user <user> -p Linger` legyen `yes`, különben boot után nem indul.

## Buktatók
- **2026-08-07 -- limit-reset után a folyamat NEM éled fel magától.** A cred-switch-watchdog eredetileg csak OAuth grant-változásra (relogin) reagált. Valódi eset: 08:35-kor limitbe fut, channels.sh saját crash-restartja visszajön, DE a friss folyamat a limit-blokkolt állapotban indul, és amikor 9-kor nullázódik a keret, EZ a már futó folyamat magától nem próbálja újra -- csak egy ÚJ folyamat venné észre. {{OWNER_NAME}} ezért azt hitte "be kell loginolnia", pedig valójában restart kellett, a login csak véletlenül azt váltotta ki. Javítás: `store/cred-switch-watchdog.sh`-ba került egy (C) szekció, ami a pane/log szövegből kiolvassa a "resets HH:MMam/pm" időpontot, és amint az elmúlt, MAGÁTÓL újraindítja a channels service-t -- relogin nélkül. Dedup a parse-olt reset-epoch alapján (nem szöveg-hash), hogy a logban maradó régi üzenet ne indítson ismételt restartot.
- **/mnt/c-n NINCS inotify.** A DrvFs nem küld eseményt, egy systemd `.path` unit ott SOHA nem tüzel. Csak poll működik. Két `stat` hívás 2 másodpercenként gyakorlatilag ingyen van.
- **A Windows profil neve nem kitalálható.** A `/mnt/c/Users/` alatt régi kódolású szemét könyvtárak is vannak (`L szl˘`, `Lúszl“`). Kérdezd meg magát a Windowst: `cd /mnt/c && cmd.exe /c 'echo %USERPROFILE%' | tr -d '\r\n'`, majd `wslpath -u`. Cache-eld, mert a cmd.exe hívás ~200 ms.
- **Soha ne teszteld élő tokennel.** Tegyél env override-ot a forrás/cél útvonalra (`CRED_SYNC_WSL`, `CRED_SYNC_WIN`), és eldobható fájlokon futtasd végig mindkét irányt. Egy rossz token azonnal megöli a futó ágenst.
- **Atomikus írás kell**: temp fájl a CÉL könyvtárban, aztán `mv`. Félig kiírt credentials fájlt senki ne olvashasson. Írás előtt backup.
- **A watchdog cooldown elnyelheti a második logint.** Ha a gazda 10 percen belül kétszer lép be (fiókot keresve), a második nem indít újra semmit. Vidd le 120 másodpercre systemd drop-innal, ne a script átírásával.
- **Követett kód**: a scripteket gitignore alatti könyvtárba tedd (`store/`), különben egy frissítés letörli őket.

## Ellenőrzés
```bash
touch /mnt/c/Users/<user>/.claude/.credentials.json && sleep 4 && tail -3 store/cred-watch.log
touch ~/.claude/.credentials.json && sleep 4 && tail -3 store/cred-watch.log
systemctl --user show <agent>-channels.service -p ActiveEnterTimestamp   # NEM indulhatott újra, a grant nem változott
```
Elvárt reakcióidő: 1-2 másodperc a fájl változásától.
