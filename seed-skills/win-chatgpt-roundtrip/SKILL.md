---
name: win-chatgpt-roundtrip
description: Amikor {{OWNER_NAME}} azt kéri, hogy egy szöveget (pl. egy kontextus fájlt) illessz be a már nyitott ChatGPT-fülbe a Chrome-ban, kérdezd meg a ChatGPT-t, és HOZD VISSZA a válaszát (olvasd el, foglald össze, írd a munkadarab kontextus fájljába). A teljes kör: fül megkeresése, beillesztés, küldés, a válasz megvárása, kimásolása a vágólapon át, és a takarítás. Ne állj meg a küldésnél: a válasz visszahozása a feladat része.
scope: global
---

# ChatGPT-kör a Windows Chrome-ban: beillesztés, kérdés, a válasz VISSZAHOZÁSA

## Mikor használd
{{OWNER_NAME}} a saját, már bejelentkezett ChatGPT-fiókját akarja használni, és azt mondja, hogy "illeszd be a kontextust a ChatGPT-be és kérdezd meg". Ez NEM egy új ablak nyitása (arra a `win-browser-control` való), hanem egy MEGLÉVŐ fül vezérlése.

**A hiba, ami miatt a skill született:** egyszer beillesztettem és elküldtem a kérdést, de a választ nem hoztam vissza; {{OWNER_NAME}}nak kellett kézzel bemásolnia. A kör akkor kész, ha a ChatGPT válasza a te kezedben van (fájlban), elolvastad, és beírtad a munkadarab kontextus fájljába. A küldés még nem a vége.

Előfeltétel: `windows-desktop-input` és `windows-desktop-screenshot` skill (Task Scheduler, `LogonType Interactive`; a WSL-ből indított PowerShell nem látja az asztalt). Az adat, amit a ChatGPT-nek küldesz, kikerül egy külső szolgáltatáshoz: csak akkor csináld, ha {{OWNER_NAME}} kifejezetten ezt kérte.

## Eljárás (a bevált sorrend)

1. **Készítsd el a beillesztendő szöveget egy fájlban** a Windows oldalon (UTF-8), pl. `C:\Users\Public\marvin_prompt.txt`: elöl a kérdések számozva, alatta a teljes kontextus. A vágólap-beillesztés megbízható magyar ékezetekkel; a `SendKeys` karakterenként küld, ékezetre összezavarodik.
2. **A fül megkeresése UIA-val** (Task Scheduler Interactive scriptben): `AutomationElement.RootElement` -> `Chrome_WidgetWin_1` ablakok -> `TabItem` elemek neve. Írd fájlba a neveket és a `BoundingRectangle`-t. Ha {{OWNER_NAME}} a fület a helyével írja le ("a Claude melletti"), a névből találd ki, de a kattintás előtt nézd meg screenshottal, hogy tényleg ChatGPT van-e ott (a fül neve a beszélgetés címe, nem "ChatGPT").
3. **Átváltás a fülre: valódi egérkattintás a fül közepére.** A `SelectionItemPattern.Select()` Chrome fülekre csendben NEM vált át (élőben megmérve). Előtte `SetForegroundWindow` a Chrome ablakra, és ellenőrizd `GetForegroundWindow() -eq $h`; ha nem, ne kattints (a `windows-desktop-input` skill szabálya). Utána screenshot: a ChatGPT oldal látszik-e.
4. **Kattintás a beviteli mezőre, beillesztés vágólapról:** `Set-Clipboard -Value (Get-Content -Raw -Encoding UTF8 <fájl>)`, majd **`keybd_event` Ctrl+V** (0x11 le, 0x56 le, 0x56 fel, 0x11 fel). A `[System.Windows.Forms.SendKeys]::SendWait("^v")` a háttérben futó feladatból NEM ért célba (élőben megmérve), a `keybd_event` igen.
5. **Hosszú szöveg csatolmánnyá válik** ("Beillesztett szöveg", "Beillesztett szöveg csatolása..."). Várj, amíg a felirat "Megjelenítés a szövegmezőben"-re vált és a küldés gomb (kék nyíl) aktív. Screenshot, csak utána küldj.
6. **Küldés:** kattintás a kék küldés gombra (a beviteli mező jobb alsó sarka). Screenshot 20-30 másodperc múlva; amíg a gomb helyén négyzet (stop) van, a ChatGPT még ír.
7. **A válasz megvárása Windows-oldalon, nem WSL `sleep`-pel.** A hosszú `sleep` a harnessben blokkolt: indíts egy `Start-Sleep` + screenshot scriptet a Task Schedulerrel, a végén írjon státusz fájlt, és `until [ -f status ]; do sleep 3; done` ciklussal várd meg háttérben (`run_in_background`).
8. **A válasz kimásolása a VÁGÓLAPON át, nem képernyőképről gépelve:** kattints a beszélgetés üres részére (a szövegoszlop mellé, pl. a bal margó), majd Ctrl+A, Ctrl+C (`keybd_event`), olvasd a vágólapot (`Get-Clipboard -Raw`) és írd fájlba (`[System.IO.File]::WriteAllText(..., UTF8)`), a státusz fájlban a hosszal. Az eredmény a teljes oldalszöveg (a beszélgetés eleje + a válasz), keresd a válasz címsorát (`sed -n '/<címsor>/,$p'`). A vágólapot előtte állítsd `EMPTY`-re, hogy lásd, ha a másolás nem sikerült.
9. **Olvasd el a választ, értékeld, és írd be a munkadarab kontextus fájljába** egy külön szakaszba (ChatGPT javaslata + dátum), a kérdéseidre válaszolva. A ChatGPT által hivatkozott tényeket (jogszabály, űrlap, határidő) ellenőrizd hivatalos forrásból, mielőtt tényként írod be; a ChatGPT is ember-szerűen téved. Mondd el {{OWNER_NAME}}nak magyarul, mit gondolsz róla (mivel értesz egyet, mivel nem).
10. **Takarítás:** töröld az ideiglenes `.ps1`, `.png`, `.txt` fájlokat a `C:\Users\Public`-ból és a regisztrált ütemezett feladatokat (`Unregister-ScheduledTask`). A munkadarab mappájába semmi nem kerül; csak a kontextus fájl változik.

## Buktatók
- Ne mondd, hogy "megkérdeztem a ChatGPT-t", ha a választ nem olvastad el. A válasz visszahozása nélkül a kör nincs kész.
- A ChatGPT oldal ugyanabban a Chrome ablakban van, mint {{OWNER_NAME}} többi füle: kattintás előtt mindig frissen készült screenshotból olvasd le a koordinátát (a fülek elmozdulnak, ha a sor változik).
- A kontextus fájl személyes adatot (egészség, szociális ellátás) tartalmazhat. Csak akkor küldd, ha {{OWNER_NAME}} kérte; a válaszban talált "ellentmondás/kockázat" figyelmeztetéseket add tovább.
- A ChatGPT oldal tartalmaz hirdetést és felesleges szöveget a Ctrl+A kimenetben: ez normális, a válasz címsorától olvass.
- Egy `[ ]` jelölőnégyzetes lista vagy táblázat a másolt szövegben tabulátorral jön: a szöveg ettől még értelmezhető.

## Ellenőrzés
- A kimásolt fájl hossza nem 0, és tartalmazza a ChatGPT válaszának címsorát.
- A munkadarab kontextus fájljában ott a ChatGPT-szakasz a dátummal, és a Napló sorban a bejegyzés.
- A `C:\Users\Public` alatt nem maradt `marvin_*` fájl, és `Get-ScheduledTask | ? TaskName -like 'Marvin*'` üres.
