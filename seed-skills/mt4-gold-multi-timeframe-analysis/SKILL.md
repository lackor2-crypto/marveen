---
name: mt4-gold-multi-timeframe-analysis
description: Ütemezett arany (GOLD) technikai elemzés az ActivTrades MT4 terminal.exe-ből, top-down D1/H1/M15/M5 idősíkokkal, majd WhatsApp+email küldés Kiss Zoltánnak. Három sávos gyakoriság ({{OWNER_NAME}} 2026-08-10): hosszú táv (D1) 1x/nap reggel, középtáv (H1) 2x/nap 8h+15h, rövidtáv (M15/M5) 45 percenként. Trigger -- scheduled-task "arany-elemzes-30perc" vagy "arany-kozeptav-15h" heartbeat, vagy bármikor amikor MT4 chart idősíkot kell váltani koordináta-kattintással screenshothoz.
scope: global
---
# MT4 arany multi-timeframe elemzés

## Mikor használd
Két ütemezett feladat fedi le a három sávot ({{OWNER_NAME}} 2026-08-10 explicit kérése
-- "a hosszú távot elég egy nap egyszer reggel, a közép távot elég egyszer
reggel 8-kor és egyszer délután 15-kor, a rövidtávot pedig 45 percenkénte"):

- **`arany-elemzes-30perc`** (a név maradt a régi, de a schedule már
  `*/45 8-18 * * 1-5`): a napi ELSŐ futása (kb 8:00) adja a TELJES,
  mind a 4 idősíkot kifejtő riportot -- ez fedi a hosszú távot (D1, 1x/nap
  reggel) ÉS a reggeli középtávú (H1) igényt egyben. Minden további aznapi
  45-perces futása csak a RÖVID, LONG/SHORT/OLDALAZÁS jelzést küldi (M15/M5
  alapján) -- ez a rövidtávú sáv.
- **`arany-kozeptav-15h`** (`0 15 * * 1-5`): kizárólag a délutáni
  középtávú (H1) check-in, hogy a 8-as és a 15-ös középtávú igény
  külön-külön meglegyen anélkül hogy a rövidtávú 45-perces ciklusba
  duplikálva lenne.

## Eljárás
1. `windows-desktop-screenshot` skill: ellenőrizd fut-e a `terminal.exe`,
   ha nem, indítsd (Task Scheduler Interactive). **A telepítés útját NE írd be
   fixen** -- 2026-08 folyamán át is költözött (`D:\Tozsde_telepitesi_mappa\`
   -> `F:\...\Projektek\...\MT4_ActivTrades`), és a beégetett régi út miatt
   heteken át minden mérés hibára futott. A tényleges mappát ez mondja meg:
   `python3 scripts/gold-data.py --human` első sora (`[mappa] ...`), illetve a
   `MT4_TERMINAL_DIR` a `.env`-ben.
2. Írj EGY paraméterezhető `.ps1`-et Windows oldalra (`marvin_gold_tf.ps1`),
   ami: SetForegroundWindow a `terminal` processzre, SetCursorPos+kattintás
   a toolbar idősík-gombjára (`-X` paraméter, y mindig 66), majd teljes
   képernyő screenshot `-OutPath`-ra. Így NEM kell 4x külön scriptet írni,
   csak `Set-ScheduledTask -Action` mezőt cserélni és újraindítani.
   Koordináták (1920 széles, ablak maximalizálva, y=66):
   M1=894, M5=923, M15=951, M30=979, H1=1007, H4=1035, D1=1063, W1=1091, MN=1119.
3. Sorrend: D1 (hosszú táv/bias) → H1 (középtáv) → M15 (fő elemzési
   idősík) → M5 (belépés-időzítés). Minden lépés: `Set-ScheduledTask`
   új `-Argument`-tel (X + OutPath), `Start-ScheduledTask`, `sleep 4`,
   `Read` a PNG-t.
4. A chartokon már rajta van: 20/100 MA, RSI(14), MACD(12,26,9),
   Bollinger(20,2), ATR(14), Stochastic -- az ár/indikátor-értékek a
   chart bal-felső sarkában szövegesen is megjelennek, onnan olvasd le
   pontosan (ne csak vizuálisan becsülj).
5. Elemzés: fokozatold (erős sell / gyenge sell / oldalazás / gyenge buy /
   erős buy) -- csak akkor erős a jelzés, ha rövid táv (M15/M5) egyezik a
   hosszú távú (D1/H1) iránnyal. Ha a rövid táv csak pihen/korrigál
   tulaldott/tulvett állapotban a hosszú távú irány mentén, az "gyenge"
   jelzés, nem "erős".
   **Kimenet hossza (2026-08-10, {{OWNER_NAME}} hangüzenet):** a TELJES, 4 idősíkot
   külön kifejtő szöveg csak NAPONTA EGYSZER menjen ki (az első futáskor --
   lásd a scheduled-task `last-full-date.txt` state-fájlját). Minden további
   aznapi futásnál csak egy 2-3 soros RÖVID üzenet: LONG / SHORT / OLDALAZÁS
   + aktuális ár + 1 mondat indoklás, idősíkonkénti levezetés nélkül.

   **⛔ FLEET-DEDUP -- KÖTELEZŐ minden sikeres küldés után (2026-09-08, valós hiány):**
   a `last-full-date.txt` PER-AGENS -- csak a futtató ágens saját
   `~/.claude/scheduled-tasks/` mappájában van, MÁS ágens (aki egy későbbi `any`
   sloton épp ő kapja a fire-t) NEM látja, tehát önmagában NEM véd a duplikáció
   ellen. Minden sikeres küldés után KÖTELEZŐ egy **`shared` kategóriájú**
   memóriát írni `arany-elemzes-elkuldve` kulccsal, benne: slot (dátum+idő),
   típus (TELJES/RÖVID), küldő ágens, ár, verdikt, és a kézbesítés-bizonyíték
   (script exit-kód + verify-screenshot út). A memória KÖTELEZŐEN `shared` --
   `hot`-ban a többi ágens nem feltétlenül látja, és pont az a lényeg, hogy lássa.
   Küldés ELŐTT minden ágens ellenőrizze ezt a shared emléket a mai dátumra: ha
   már van TELJES mára, csak RÖVID mehet; ha ugyanarra a slotra már van bármi, ne
   küldjön. Szóhasználat: a WhatsApp szürke pipa = "KIMENT" (a szerverig jutott),
   NEM "megkapta" (az a készülékig). Valós hiba 2026-09-08: a reggeli TELJES
   kiment, de csak a `last-full-date.txt` frissült -> egy másik ágens kívülről nem
   látta, duplikálás-kockázat; utólag pótolva.
5b. ⛔ KÖTELEZŐ KÜLDÉSI SÉMA -- MINDIG UGYANEZ A NÉGY BLOKK ({{OWNER_NAME}} 2026-08-27,
   Telegram üzenet 534/536/547/549): "Allitsd fol egy semat, es mindig ugyanabban
   a semaban magyarazd el. [...] hosszu tav ... kozeptav ... rovid tav ...
   osszefoglalo ... ez legyen alap." Kiss Zoltán VAK, képernyőolvasót használ ->
   SIMA SZÖVEG, ékezet nélkül, se angol szakszó, se emoji, se táblázat.

   IDŐTÁV-CSOPORTOSÍTÁS ({{OWNER_NAME}} 2026-08-27, üzenet 547/549 -- KÖTELEZŐ):
   HOSSZÚ TÁV = D1 + H4 ; KÖZÉPTÁV = H1 (órás chart) ; RÖVID TÁV = M15 + M5 + M1.

   Az üzenet MINDIG pontosan ez a négy blokk, ebben a sorrendben:

   ```
   Arany (GOLD) elemzes
   Ido: <YYYY-MM-DD HH:MM>
   Jelenlegi ar: <ar> USD

   Hosszu tav: <irany + erosseg, tamasz/ellenallas szint, 1 mondat>
   Kozeptav: <irany + erosseg, 1 mondat>
   Rovid tav: <irany + M5/M1 sztochasztik + belepes-idozites, 1-2 mondat>
   Osszefoglalo: <vegso jelzes + mit tegyen roviden>
   ```

   NE írd a blokk-fejlécbe zárójelben az idősíkot ({{OWNER_NAME}} 2026-08-27, üzenet 555:
   "nem kell mindig mondanod, hogy melyik idosavot nezed"). Tehát `Rovid tav:`,
   nem `Rovid tav (M15, M5, M1):` -- az idősíkokat te nézed meg, a címzettnek nem
   kell tudnia, melyikből jön a jelzés.

   Szóhasználat -- MINDIG magyar ({{OWNER_NAME}} 543): Irány `emelkedo`/`csokkeno`/`oldalazo`
   trend (a "bullish"/"BUY"/"SELL" mint címke TILOS). Erősség `eros`/`kozepes`/
   `gyenge` -- "eros" csak ha az adott táv egyezik a hosszú távú iránnyal. Az
   Osszefoglalo VÉGSŐ jelzése MINDIG az 5-fokú magyar skála EGYIKE: `eros vetel` /
   `gyenge vetel` / `oldalazas` / `gyenge eladas` / `eros eladas`. FULL futás: mind
   a három táv élő chartból (D1, H4, H1, M15, M5, M1). RÖVID futás: csak a rövid
   táv (M15/M5/M1) élő, a felső két táv a reggeli emlékből ("-- reggel merve").
   A rövid táv blokkban KÖTELEZŐ a sztochasztik állapota KÜLÖN M5-re ÉS M1-re
   ({{OWNER_NAME}} 2026-08-27, üzenet 555), pl. "M5-on a sztochasztik tuladott, M1-en
   tulvett" -- röviden, magyarázat nélkül; ha a rövid táv a reggeli emlékből jön,
   nincs friss M5/M1 sztochasztik, ne találd ki. Továbbá KÖTELEZŐ jelezni, hogy
   M5-ön az ár a SZÁZAS (piros) mozgóátlag ALATT vagy FELETT van ({{OWNER_NAME}} 2026-08-27,
   üzenet 557), pl. "M5-on az ar a szazas mozgoatlag alatt van" -- csak M5-ön.
   A belépés-időzítést (hol léphet be, kb. meddig várjon) a rövid táv blokk végén
   MINDIG az M1-ből (legfeljebb az M5-ből is) add meg -- az M1-et MINDEN futásnál
   KÖTELEZŐ megnézni ({{OWNER_NAME}} 2026-08-27, üzenet 551).
6. Küldés `notify-with-fallback` + `kiss-zoltan-contact-accessibility`
   szerint: SIMA SZÖVEG (ékezet nélkül, mert a PowerShell fájl-kódolás
   Task Scheduleren át törhet ékezeteken), WhatsApp elsőként, a
   `windows-desktop-input` mintával (Set-Clipboard + `^v` + Enter),
   utána SAJÁT MAGADNAK screenshot a pipa-ellenőrzéshez (azt NE küldd
   tovább). Csak ha ez sikertelen, jöhet az email fallback -- de olvasd el a
   `notify-with-fallback` piszkozat-buktatóját: a `scripts/gmail-send.py`
   alapból `draft` módban fut, a piszkozat pedig NEM kézbesítés.
7. Ha minden rendben (MT4 elindult/futott, mind a 4 screenshot sikerült, és a
   WhatsApp-üzenet TÉNYLEG kiment -- pipa a screenshoton), NE írj a
   tulajdonosnak ({{OWNER_NAME}}) Telegramon -- csendes heartbeat.
   Szólj neki, ha: MT4 nem tölt be; a WhatsApp bukott (akkor is, ha készült
   email-piszkozat -- pont azt kell megírnod, hogy van kiküldeni való);
   vagy sem WhatsApp, sem email nem ment.

## Buktatók

### ⛔ AUTO TRADING KIKAPCSOLVA -> AZ EA NEM ÍR, ÉS SEMMI NEM SZÓL RÓLA (2026-09-07, valós eset)

Az MT4 újraindítása után az **Auto Trading KIKAPCSOLVA jöhet vissza**. Ilyenkor a
`GOLD_Live_Export` EA ott ül a charton, a fejlécében az áll hogy "működik" -- de
**egyetlen sort sem ír**. Tünet: a `gold_live.txt` mtime-ja nem változik, és a
`gold-data.py --human` "EA snapshot ... N perce" száma csak nő. A tulajdonos
2026-09-07-én ezt előbb vette észre, mint én.

**MÉRD MEG, ne tippeld.** A gomb állapota screenshotról olvasható le:
- **piros stop ikon** a sárga mappa sarkában = Auto Trading **KI**
- **zöld play ikon** = Auto Trading **BE**

Bekapcsolás: kattintás a `(455, 57)` pontra (1920 széles, maximalizált ablak),
**interaktív scheduled taskon át**. A kattintás **kapcsoló (toggle)**, ezért
KÖTELEZŐ előtte ÉS utána is screenshotot csinálni, és a két ikont
összehasonlítani -- ha már be volt kapcsolva, ezzel épp KIkapcsolod.
Összehasonlításhoz elég egy kivágás: `PIL.Image.crop((400,42,520,74))`.

### ⛔ A FORCE-KILL ELVESZTI A CHART-ÁLLAPOTOT, ÉS VELE AZ EA-T (2026-09-07, valós eset)

`Stop-Process -Force` után az MT4 **nem menti el a profilt**, ezért a következő
indításnál az EA **nem kerül vissza a chartra**. A bizonyíték a naplóban van
(`MQL4/Logs/<YYYYMMDD>.log`): ha a restart után **nincs**
`Expert ...\GOLD_Live_Export GOLD,H1: loaded successfully` sor, akkor az EA
jelenleg nincs feltéve -- akkor sem, ha a chart máskülönben rendben látszik.
Ugyanez viszi el a `GOLD1.hst` friss M1-gyertyáit is (lásd lentebb).

Ezért a bezárás MINDIG: `WM_CLOSE` (`PostMessage 0x0010`) az `EnumWindows`-szal
megtalált **valódi** ablak-handle-re, interaktív scheduled taskon át. A közvetlen
WSL-powershell `CloseMainWindow()` hiába fut le -- ott a `MainWindowTitle` üres,
tehát nincs handle, amire küldhetné. Csak akkor `Stop-Process -Force`, ha a
`WM_CLOSE` után ~10 másodperccel is fut a folyamat, és akkor is tudd, hogy ezzel
elvesztetted a profilt.

### ⛔ A GOLD CHART-FÜL KOORDINÁTÁJA NEM FIX -- ELLENŐRIZD AZ ABLAKCÍMET

A `l3_gold_short.ps1` `x=115`-öt kattint a fülsávon (`y=955`). 2026-09-07-én ez
már a **UsaTec** fülre esett, és az egész kör egy idegen instrumentum chartjáról
készült -- a státuszfájl közben végig `SHOT_OK`-ot írt. A fülsáv sorrendje
változik, tehát a koordináta nem bizonyíték.

**Kattintás után KÖTELEZŐ az ablakcímet visszaolvasni** (`GetWindowText`), és csak
akkor elfogadni a screenshotot, ha `[GOLD,<idősík>]` áll benne. A GOLD általában
a **legelső** fül (`x` kb. 41), de ezt is a címmel igazold, ne a koordinátával.

### ⛔ A GOLD CHART -- 2026-09-07 ÓTA EGY VAN, RAJTA AZ EA IS

Sokáig **két** GOLD chart volt: egy `GOLD,H1` indikátorok nélkül, és egy
indikátoros (SuperTrend, Sto(5,3,3), RSI(14), MACD(12,26,9), ATR(14),
Bollinger, MA20/MA100). 2026-09-07 estéjére **egy** maradt: az indikátoros,
és **ezen ül a `GOLD_Live_Export` EA is**, a tulajdonos kifejezett kérésére:
"hat ha neked az ugy jobb az elemzeshez tedd fel persze ra. rajta is hagyhatod
ha akarod."

**Az idősíkja NEM állandó** -- a tulajdonos váltogatja (2026-09-07 21:14-kor
`Daily` -> `M15`, naplóban `uninit reason 3`). Ezért a chartot **soha ne az
idősíkjáról azonosítsd**, hanem abból, hogy `GOLD` és rajta vannak az
indikátorok. Hogy induláskor melyik chartra kerül fel az EA, azt a mentett
profil dönti el -- lásd lentebb: "MELYIK CHARTRA JÖN FEL AZ EA".

Miért így jobb: egy chart ad friss exportot ÉS leolvasható indikátort, tehát
idősík-váltás után az **M1 sztochasztik is leolvasható a képernyőről** -- az
egyetlen járható út, mert az M1 nincs az EA exportjában (lásd lentebb).

**Ettől függetlenül nem kell OCR-ezni:** a `gold-data.py` maga számolja az
indikátorokat az EA exportjából, és az értékei egyeznek az MT4-ével.
2026-09-07-i kereszt-ellenőrzés H1-en: `gold-data.py` Sto 78,59/60,12, RSI
48,57, MACD -8,478/-11,713 -- az MT4 chartján Sto 80,53/59,58, RSI 49,16, MACD
-8,366/-11,700 (az eltérés a néhány perces snapshot-korkülönbség). A számok
forrása a `gold-data.py`; a screenshot arra való, hogy lásd a chart szerkezetét
és azt, amit a `gold-data.py` nem tud (M1).

### Az EA áthelyezése egyik chartról a másikra (mért, működő eljárás)

Ha az EA rossz charton ül, ez a sorrend működik (2026-09-07, végigmérve).
Minden koordináta 1920x1200-as, maximalizált ablakra érvényes, és **minden
lépést screenshottal kell igazolni** -- vakon egyet sem.

0. A vezérlő szkriptet **rejtett ablakkal** indítsd
   (`powershell.exe -NoProfile -WindowStyle Hidden -File ...` egy `/IT`
   scheduled taskban). Enélkül a PowerShell konzolablak a képernyő közepére
   ugrik, elveszi a fókuszt, és **a kattintásaid a konzolra mennek** -- a
   státuszfájl közben végig sikert ír.
1. **ELŐSZÖR vedd le a régi chartról, csak UTÁNA tedd fel az újra.** Fordított
   sorrendnél egy pillanatra két példány írja ugyanazt a `gold_live.txt`-t.
2. Levétel: chart-fül kattintás -> jobb klikk a chart közepén (`900,400`) ->
   egérrel rá az `Expert Advisors` sorra (`975,514`) -> `Remove` (`1147,537`).
   Igazolás: a chart bal felső sarkából eltűnik az EA státusz-szövege, a jobb
   felsőből a mosolygó fej.
3. Felrakás: a CÉL chart-fülre kattintás -> `Ctrl+N` (Navigátor; kapcsoló, ne
   nyomd meg kétszer) -> a `Sajat` mappa kinyitása (`38,295`) ->
   `GOLD_Live_Export` dupla kattintás (`142,313`) -> a megnyíló ablakban `OK`
   (`941,858`).
4. Igazolás **a chart fejlécéből**, nem a naplóból: ott áll, hogy
   `HU: mukodik | kiiras 30 mp-enkent | sikeres: N | utolso: <ido>`, és a
   számláló nő. A lemezes napló és a `gold_live.txt` mtime-ja WSL-ből nézve
   **percekkel késhet** -- a fejléc az élő forrás.
5. **Rögzítés (enélkül a következő indításnál elveszik):** `WM_CLOSE`
   (`PostMessage 0x0010`) az ablak-handle-re. A napló `uninit reason 9`-et ír
   (= terminál bezárás), és az MT4 ilyenkor menti a profilt.
6. **Bizonyítás:** indítsd újra (`MarvinMT4Launch`), és a naplóban az ÚJ
   betöltési sornak az ÚJ chartot kell mondania. 2026-09-07:
   `20:25:36.064 Expert Sajat\GOLD_Live_Export GOLD,Daily: loaded successfully`,
   közvetlenül az öt indikátor betöltése után. Enélkül a "felraktam" állítás
   nem bizonyított.

### ⛔ MELYIK CHARTRA JÖN FEL AZ EA -- A `.chr` DÖNTI EL, NEM A NAPLÓ

A napló azt mondja meg, mi **történt**; a mentett profil azt, mi **fog**. Az MT4
minden nyitott chartot egy `profiles/<profil>/chartNN.chr` fájlba ment
bezáráskor (a profil nevét a `profiles/lastprofile.ini` mondja meg), és
induláskor ezekből állítja vissza -- az EA abban a fájlban van, amelyik chartra
fel volt téve.

Az egyetlen megbízható ellenőrzés (WSL-ből, csak olvasás, semmit nem módosít):

```bash
T=$(cat store/mt4-terminal-dir.txt)
cd "$T/profiles/default" && for f in chart*.chr; do
  printf '%-14s %-8s per=%-4s EA=%s\n' "$f" \
    "$(grep -a -m1 '^symbol=' "$f" | tr -d '\r' | cut -d= -f2)" \
    "$(grep -a -m1 '^period=' "$f" | tr -d '\r' | cut -d= -f2)" \
    "$(grep -ac 'GOLD_Live_Export' "$f")"
done
grep -al 'GOLD_Live_Export' chart*.chr   # ennyi peldany fog elindulni
```

Ha ez **egynél több** fájlt sorol fel, a következő indításnál **több EA
példány** fogja ugyanazt a `gold_live.txt`-t írni.

**Mért hiba, 2026-09-07.** Levettem az EA-t a `GOLD,H1`-ről (`20:23:16 uninit
reason 1`), felraktam az indikátorosra, bezártam, újraindítottam -- és az EA
**mindkét** charton feljött: `20:25:35.774 GOLD,H1` ÉS `20:25:36.064
GOLD,Daily: loaded successfully`. A levétel megtörtént, de a bezáráskor mentett
profil még tartalmazta a H1 chartot az EA-val, tehát egy ideig két példány
írta a `gold_live.txt`-t. Azért nem vettem észre, mert a naplóban **csak az új
chart betöltési sorát kerestem**: egy `grep`, ami csak azt igazolja, amit
látni akarsz, semmit nem igazol.

**A profil a bezárás pillanatának állapotát menti**, ezért a `.chr`-t mindig a
bezárás UTÁN nézd meg, soha nem előtte.

**DE A `.chr` NEM AZ EGYETLEN FORRÁS -- ez a mérés 2026-09-08-án megbukott.**
A `MarvinMT4Launch` task nem csupaszon indítja a terminált, hanem egy indítási
konfigurációval: `terminal.exe "<MT4>\config\marveen-startup.ini" /portable`.
Abban a fájlban egy `[StartUp]` blokk áll:

```ini
[StartUp]
Symbol=GOLD
Period=H1
Expert=Sajat\GOLD_Live_Export
```

Ez **minden indításkor** nyit egy `GOLD,H1` chartot és felteszi rá az EA-t --
a profiltól **függetlenül**. Mért bizonyíték (2026-09-08 07:16, a profilban
ekkor egyetlen `.chr` tartalmazta az EA-t):

```
07:16:56.337  Expert Sajat\GOLD_Live_Export GOLD,H1:  loaded successfully
07:16:56.604  Expert Sajat\GOLD_Live_Export GOLD,M15: loaded successfully
```

Vagyis **két példány** indult, és mindkettő ugyanazt a `gold_live.txt`-t írja.
(Az adat ettől még értelmezhető maradt: a `gold-data.py` `verdikt: ok`-ot
adott -- de két író ugyanarra a fájlra nem szándékolt állapot.)

**A helyes bizonyítás tehát HÁROM dolog, együtt:** (1) az új chart betöltési
sora a naplóban, (2) `grep -al 'GOLD_Live_Export' chart*.chr` -> **pontosan
egy** fájl, ÉS (3) az indítási `.ini`-ben **nincs** `[StartUp] Expert=` sor:

```bash
T=$(cat store/mt4-terminal-dir.txt); cat "$T/config/marveen-startup.ini"
```

Figyelem: ugyanennek a fájlnak az `[Experts] Enabled=true` sora az, ami az
**AutoTrading-ot bekapcsolja** induláskor -- azt tehát NEM szabad kidobni,
csak a `[StartUp]` blokkot (lásd a "kikapcsolt Auto Trading" buktatót).

### ⛔ AZ M1 NINCS AZ EA EXPORTJÁBAN -- ÉS A .hst CSAK TISZTA BEZÁRÁSKOR FRISSÜL

A `gold_live.txt` `TF` sorai: **D1, H1, M15, M5**. **M1 nincs köztük**, és a
`gold-data.py --tf` sem fogad el M1-et. Az M1 egyetlen lemezes forrása a
`history/<szerver>/GOLD1.hst`, amit az MT4 **csak tiszta bezáráskor** ír ki --
force-kill után órákkal korábbi marad (2026-09-07: 10:42-es gyertya 17:45-kor).

Következmény: **ha az M1 sztochasztik kell az üzenetbe, az MT4-et előtte
rendesen be kell zárni** (WM_CLOSE), és utána olvasni a `GOLD1.hst`-t
(`read_hst` + `stochastic(bars)` a `gold-data.py`-ból). Ha ez nem tehető meg,
**akkor az üzenetbe azt kell írni, hogy nem volt leolvasható** -- értéket
kitalálni TILOS. A tulajdonos szabálya (üzenet 555) az, hogy az M1 és M5
sztochasztik szerepeljen; a "nem mértem" ezt teljesíti, a kitalált szám nem.

- A WhatsApp chat state-jét MINDIG nézd meg friss screenshottal küldés
  ELŐTT -- előfordulhat hogy egy korábbi 30-perces ciklus már küldött
  üzenetet és Zoltán válaszolt rá (pl. hangüzenettel); ez nem hiba, csak
  friss adat, de ne ijedj meg tőle és ne kezeld hibaként.
- Az idősík-gomb koordinátái CSAK az adott ablak-elrendezésnél/felbontásnál
  érvényesek (1920 széles, terminal.exe maximalizálva) -- ha az ablak
  mozgott/méreteződött, frissítsd egy friss screenshotból.
- Egy `Set-ScheduledTask -Action` + `Start-ScheduledTask` páros elég
  minden idősík-váltáshoz, nem kell mindig újra `Register-ScheduledTask`-ot
  hívni.
- **EGY GAZDA: a `MarvinGoldTF` feladathoz és a
  `C:\Users\Public\marvin_gold_tf.ps1` fájlhoz egyszerre CSAK EGY ágens
  nyúljon.** 2026-08-10-en két ágens (Marvin és a Szakértő) egyszerre
  dolgozott ugyanazon a futáson, és mindketten felülírták ugyanazt a
  task-ot és ugyanazt a szkriptet, eltérő paraméterezéssel (`-X/-OutPath`
  argumentumok kontra környezeti változók) -- a másik ágens futása így a
  RÉGI paraméterezéssel indult el, és négyszer rossz ablakra kattintott.
  Jelenlegi gazda: **usalackor (Szakértő)**, amíg Marvin kerete magasan áll;
  a visszavétel előtt Marvin szól, nem párhuzamosan módosítunk.
- **Kattintás előtt ELLENŐRIZD a fókuszt.** A `SetForegroundWindow` kérés,
  nem parancs: ha a felhasználó épp aktívan dolgozik, a Windows megtagadja,
  és a kattintás az ő ablakába megy (ma élőben: {{OWNER_NAME}} Chrome könyvjelző-
  sávjára). `GetForegroundWindow()` összehasonlítás a cél-handle-lel, és
  eltérés esetén KIHAGYNI a kört -- részletek a `windows-desktop-input`
  skill Buktatók szekciójában.
- **Tálcára rejtett MT4-et nem lehet lefotózni.** Ha a `terminal.exe`
  ablakai `IsWindowVisible=False` állapotban vannak (MT4 a tálcán), a
  `PrintWindow` feketét ad -- élőben megmérve. Ilyenkor a helyes döntés a
  kör CSENDES kihagyása (a következő 45 perces futás úgyis próbálja), nem
  pedig az ablak ráugrasztása a felhasználó munkájára. Ha ez ismétlődik, a
  hosszú távú megoldás a kanban bd02805a kártyán van: a chart-adat
  MQL4-oldali fájl-exportból jöjjön, ne képernyőképből.
- **A `.hst`-ből olvasott adat SEM friss, amíg az MT4 a tálcán van.** Mérve
  2026-08-10 15:01-kor: mind a négy idősík history-fájlja 149 perce változatlan
  volt, miközben az MT4 futott, csak rejtve. A fájl-alapú út az ÜTKÖZÉST
  szünteti meg (nincs fókusz-lopás, nincs kattintás), a FRISSESSÉGET nem.
  Erre való a `GOLD_Live_Export` EA (`scripts/mt4/GOLD_Live_Export.mq4`,
  kártya 70efa568): a charton futva 30 másodpercenként kiírja a formálódó
  gyertyát és a Bid/Ask-ot az `MQL4/Files/gold_live.txt`-be, és a
  `gold-data.py` ezt előnyben részesíti a `.hst`-vel szemben. Ha a kimenet
  `forras: hst`, akkor az EA nincs a charton vagy nem fut.
- **Olvasd el a `frissesseg` blokkot, mielőtt bármit kiküldenél.** A script már
  megkülönbözteti az eseteket, nem neked kell a percszámból kitalálni:
  `mt4_fut: false` = nem fut a terminál, az adat áll; `megjegyzes` = mi a baj
  emberi mondatban. Hibás út vagy hiányzó GOLD-előzmény esetén a script már NEM
  0-val lép ki (2 = nincs meg a MetaTrader mappa, 3 = megvan de nincs GOLD
  előzmény, 4 = minden idősík hibás) -- korábban ilyenkor is sikert jelzett.
- **A frissesség idősíkonként dől el (kanban 891a30f6), nem a legfrissebből.**
  A `frissesseg.idosikok` blokk minden idősíkra külön verdiktet ad: `ok` /
  `elavult` / `nem_tudom` / `nincs_adat`. A döntést az UTOLSÓ GYERTYA kora hozza
  (nem a fájl mtime-ja, ami gyertya nélkül is frissülhet), idősíkonként arányos
  küszöbbel (N×az idősík perce), így egy éjszakai D1 nem riaszt hamisan, egy 30+
  perces M5 viszont igen. A régi hiba az volt, hogy a legfrissebb idősíket
  nézte, és ha csak az M5 állt 3855 percet, a jelzés SOHA nem futott le.
  - `verdikt: elavult` + **kilépőkód 5** = az MT4 fut ÉS a piac nyitva (a live
    snapshot friss), de van idősík, ami nem frissül -- valószínűleg annak a
    chartja nincs nyitva az MT4-ben. Ilyenkor **hagyd ki a kört azon az
    idősíkon**, ne küldj ki róla régi árat.
  - `verdikt: nem_tudom` (kód 0) = régi az adat, DE nincs friss live snapshot,
    ezért a tiszta függvény nem találgatja, hogy hétvége/ünnep van-e vagy egy
    chart halott. A piac-nyitva jelzés EGYETLEN becsületes automatikus forrása a
    live snapshot frissessége; a naptári hétvégét a függvény szándékosan nem
    használja verdiktre. **TEENDŐ (kötelező, ezt a script NEM dönti el
    helyetted):** `nem_tudom` mellett SOHA ne küldj ki egy idősíkot azonnal.
    Neked kell eldöntened a naptárból/óráról (`date`, Europe/Budapest), amit a
    tiszta függvény szándékosan nem néz:
    - Ha MOST kereskedési idő van (hétköznap, nem ünnep, a piacnak nyitva
      kellene lennie) és mégis régi az adat -> a chart halott, kezeld
      `elavult`-ként: **hagyd ki a kört azon az idősíkon**, ne küldj róla régi
      árat. {{OWNER_NAME}} eredeti esete ez: M5 3855 perc (~64 óra) hétköznap
      SOSEM magyarázható hétvégével, tehát elavult -> kihagyni, nem kiküldeni.
    - Ha MOST tényleg zárva a piac (hétvége/ünnep, a GOLD legfeljebb ~49 órát
      áll egy hétvégén), a régi adat várható -> nincs új jelzés, csendben
      hagyd ki, ne küldj elavultat frissként.
    Vagyis a `nem_tudom` nem "zöld út", hanem "nézd meg te a naptárt". A
    végleges, kézi döntést kiváltó megoldás a `gold_live.txt`-et író
    `GOLD_Live_Export` EA (kártya 70efa568).
  - `verdikt: nincs_adat` = azon az idősíkon nincs beolvasott gyertya (friss
    telepítésen ez normális, nem hiba).
  Ha több tíz perces az adat és közben nyitva a piac, inkább hagyd ki a kört,
  mint hogy régi adatot küldj ki friss jelzésként -- Kiss Zoltán nem lát
  chartot, csak a számokat hallja, nála egy csendben elavult ár rosszabb mint
  a hallgatás.

## Ellenőrzés
- Mind a 4 PNG friss időbélyegű és tényleg a várt idősík-címet mutatja
  (`[GOLD,Daily]`, `[GOLD,H1]`, `[GOLD,M15]`, `[GOLD,M5]` az ablak címében).
- A WhatsApp "after" screenshot pipát mutat az elküldött üzeneten.
