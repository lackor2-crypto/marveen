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
