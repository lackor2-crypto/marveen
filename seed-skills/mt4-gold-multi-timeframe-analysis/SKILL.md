---
name: mt4-gold-multi-timeframe-analysis
description: Ütemezett arany (GOLD) technikai elemzés az ActivTrades MT4 terminal.exe-ből, top-down D1/H1/M15/M5 idősíkokkal, majd WhatsApp+email küldés Kiss Zoltánnak. Három sávos gyakoriság (Boss 2026-08-10): hosszú táv (D1) 1x/nap reggel, középtáv (H1) 2x/nap 8h+15h, rövidtáv (M15/M5) 45 percenként. Trigger -- scheduled-task "arany-elemzes-30perc" vagy "arany-kozeptav-15h" heartbeat, vagy bármikor amikor MT4 chart idősíkot kell váltani koordináta-kattintással screenshothoz.
---
# MT4 arany multi-timeframe elemzés

## Mikor használd
Két ütemezett feladat fedi le a három sávot (Boss 2026-08-10 explicit kérése
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
   ha nem, indítsd (Task Scheduler Interactive, target
   `D:\Tozsde_telepitesi_mappa\Activtrades_Mt4\terminal.exe /portable`).
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
   **Kimenet hossza (2026-08-10, Boss hangüzenet):** a TELJES, 4 idősíkot
   külön kifejtő szöveg csak NAPONTA EGYSZER menjen ki (az első futáskor --
   lásd a scheduled-task `last-full-date.txt` state-fájlját). Minden további
   aznapi futásnál csak egy 2-3 soros RÖVID üzenet: LONG / SHORT / OLDALAZÁS
   + aktuális ár + 1 mondat indoklás, idősíkonkénti levezetés nélkül.
6. Küldés `notify-with-fallback` + `kiss-zoltan-contact-accessibility`
   szerint: SIMA SZÖVEG (ékezet nélkül, mert a PowerShell fájl-kódolás
   Task Scheduleren át törhet ékezeteken), WhatsApp elsőként, a
   `windows-desktop-input` mintával (Set-Clipboard + `^v` + Enter),
   utána SAJÁT MAGADNAK screenshot a pipa-ellenőrzéshez (azt NE küldd
   tovább). Csak ha ez sikertelen, jöhet az email fallback.
7. Ha minden rendben (MT4 elindult/futott, mind a 4 screenshot sikerült,
   WhatsApp vagy email kiment), NE írj Bossnak Telegramon -- csendes
   heartbeat. Csak hibánál (MT4 nem tölt be, sem WhatsApp sem email nem
   megy) szólj.

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
  és a kattintás az ő ablakába megy (ma élőben: Boss Chrome könyvjelző-
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
- **A fájl-alapú kiolvasás (`scripts/gold-data.py`) SEM friss, amíg az MT4 a
  tálcán van.** Mérve 2026-08-10 15:01-kor: mind a négy idősík history-fájlja
  149 perce változatlan volt, miközben az MT4 futott, csak rejtve. Vagyis a
  fájl-alapú út az ÜTKÖZÉST szünteti meg (nincs fókusz-lopás, nincs kattintás),
  a FRISSESSÉGET nem. A script mindig kiírja a fájl korát: ha az több tíz perc,
  inkább hagyd ki a kört, mint hogy régi adatot küldj ki friss jelzésként --
  Kiss Zoltán nem lát chartot, csak a számokat hallja, nála egy csendben
  elavult ár rosszabb mint a hallgatás.

## Ellenőrzés
- Mind a 4 PNG friss időbélyegű és tényleg a várt idősík-címet mutatja
  (`[GOLD,Daily]`, `[GOLD,H1]`, `[GOLD,M15]`, `[GOLD,M5]` az ablak címében).
- A WhatsApp "after" screenshot pipát mutat az elküldött üzeneten.
