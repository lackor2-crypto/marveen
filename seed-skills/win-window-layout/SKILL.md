---
name: win-window-layout
description: {{OWNER_NAME}} Windows-asztalanak ablak-elrendezeset menti el es allitja vissza WSL-bol (PersistentWindows + Task Scheduler Interactive). Akkor hasznald, ha {{OWNER_NAME}} azt keri hogy "mentsd el az ablakok allasat", "allitsd vissza az iroda-elrendezest", vagy ha egy tobb-ablakos munkakornyezetet kell reprodukalni (pl. monitor-valtas / RDP utan szethullott ablakok).
scope: global
---

# Windows ablak-elrendezés mentése és visszaállítása

## Mikor használd

{{OWNER_NAME}} több alkalmazást használ egyszerre, és az ablakok elrendezése munka
közben szétesik (monitor le/vissza, RDP, felébredés alvásból), vagy egy adott
munkához mindig ugyanaz az elrendezés kell ("iroda", "tőzsde"). Ez a skill
elmenti a jelenlegi állást névre, és később visszaállítja.

Alapja a PersistentWindows (kangyu-california/PersistentWindows, v5.76,
wingettel telepítve, {{OWNER_NAME}} jóváhagyásával -- kanban 6ccb5ced).

## Eljárás

```bash
python3 ~/.claude/skills/win-window-layout/scripts/window_layout.py save iroda
python3 ~/.claude/skills/win-window-layout/scripts/window_layout.py restore iroda
python3 ~/.claude/skills/win-window-layout/scripts/window_layout.py list
```

A név elhagyható (alapértelmezés: `marvin`). A név csak betű/szám/kötőjel/
aláhúzás lehet -- a script visszautasít mindent, ami Windows-parancssorban
idézőjelezést igényelne, ahelyett hogy köré kerülgetné.

## Amit élesben megmértem (2026-08-10) -- ezek nélkül nem működik

- **A winget "Links" shim NEM jó erre.** A
  `WinGet\Links\PersistentWindows.exe`-n keresztül hívva a `-capture_to_disk`
  sikerrel tért vissza (exit 0) és **semmit nem írt ki**: nem jött létre
  adatbázis, nem lett capture. A `WinGet\Packages\...\PersistentWindows.exe`
  valódi útvonalon ugyanaz a parancs működik. A script ezért nem a shimet
  hívja, hanem kikeresi a valódi exe-t (verzió-független glob).
- **Session 0 csapda, ugyanaz mint a többi desktop-skillnél.** Ablakot
  felsorolni/mozgatni csak a bejelentkezett konzol-munkamenetből lehet, a WSL
  interopból indított folyamat Session 0-ba kerül és némán nem csinál semmit.
  Ezért megy minden hívás Task Scheduler `LogonType Interactive` feladaton át.
- **A capture NEM fájlonként áll, hanem EGY LiteDB adatbázisban**
  (`%LOCALAPPDATA%\PersistentWindows\PersistentWindows.<ver>.db`). Ezért a
  neveket nem lehet a fájlrendszerből kilistázni: a `list` a saját
  nyilvántartásunkat mutatja (`state/layouts.json`), plusz az adatbázis
  utolsó módosítási idejét. Amit valaki kézzel, a tálca-ikonból mentett, az
  ebben a listában NEM fog látszani.
- **A PersistentWindows exit kódja nem bizonyíték.** 0-val tér vissza akkor
  is, ha nem mentett semmit -- a script ezért az adatbázis időbélyegét nézi,
  nem a visszatérési értéket.
- **A visszaállítás kétszer fut** (a projekt Help.md-je szerint a második kör
  helyezi el azokat az ablakokat, amiket az első kör indított el).

## Buktatók

- **Tálcára minimalizáló appok (pl. MetaTrader) visszaállítása bizonytalan.**
  Élő mérésnél: elmentettem az elrendezést, elmozgattam az MT4 ablakát
  (0,0 -> 260,120), majd visszaállítottam -- a visszaállítás TÉNYLEGESEN hatott
  az ablakra, de nem a mentett téglalapba tette vissza, hanem tálcára
  minimalizálva hagyta (`MainWindowHandle` 0 lett). Az ilyen appot utána
  kézzel kell visszahozni (`ShowWindow SW_RESTORE` + `SetWindowPos`). Mielőtt
  egy elrendezést élesben ráengedsz {{OWNER_NAME}} asztalára, mondd meg neki mi fog
  történni, és ne futtasd amikor épp dolgozik.
- Emelt jogú (adminként futó) ablakok visszaállításához maga a
  PersistentWindows is emelt jogot igényel -- ilyen ablakok kimaradhatnak.
- A visszaállítás az EGÉSZ asztalra hat, nem csak egy ablakra: ez nem
  "nyisd meg X-et" művelet, hanem átrendezi ami nyitva van.

## Ellenőrzés

- `save` után: a parancs kiírja az adatbázis frissítési idejét -- ha nem
  frissült, hibával lép ki (nem hazudik sikert).
- `restore` után: nézd meg egy konkrét ablak téglalapját, ne szemre ítélj:
  ```bash
  # GetWindowRect egy folyamat fő-ablakára, Task Scheduler Interactive taskból
  ```
  A `state/last-action.json` rögzíti mi volt az utolsó művelet és sikerült-e.
