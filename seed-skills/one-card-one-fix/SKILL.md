---
name: one-card-one-fix
description: Egy hiba = egy kártya, és EGY PROJEKT = EGY KÁRTYA, azonnal és teljesen készre. Egy hibát nem szabdalunk szét több kártyára és nem tolunk át másik kártya alá; a kártyát félbehagyni tilos; ha a javítás közben új hiba jön elő, azt azonnal javítani kell, mintha a tulajdonos kérte volna. Fusd át minden kártya-munka elején.
scope: global
---

# Egy hiba = egy kártya, azonnal és teljesen készre

## A szabály (2026-09-07, {{OWNER_NAME}})

{{OWNER_NAME}} szó szerint: „egy hiba egy kártya és kész! nem szabad keverni más
kártyákkal! ... ha van egy kártya akkor szigorúan tilos kivenni a kártyából egy
adott hibát és betenni egy másik kártya alá! ... azonnal készre kell csinálni a
kártyát. ... ha új hibák jönnek elő azt azonnal javítani kell! ... ha egy kártya
bug javításánál előjön másik új hiba azt úgy kell venni hogy az user kérte annak
is a javítását."

## Hat pont

1. **Egy hiba = egy kártya.** A kártya önmagában áll. Ne hivatkozgass kártyáról
   kártyára, és ne szabdald szét egy hibát több kártyára. Az egymásra
   hivatkozó, egymástól függő kártyák akadnak össze és állítják meg egymást --
   ez a hibák és leállások fő forrása.
2. **SZIGORÚAN TILOS egy adott hibát kivenni egy kártyából és áthelyezni egy
   másik kártya alá.** Ami egy kártyán van, azt ott kell befejezni. Az
   áthelyezés csak problémát okoz.
3. **A kártyát azonnal, teljesen készre kell csinálni.** Nincs „félbehagyom",
   nincs „majd". Addig megy, amíg kész, és nem vár másik kártyára.
4. **Ha a javítás közben ÚJ hiba jön elő, azt AZONNAL javítani kell** -- úgy
   véve, mintha a tulajdonos annak a javítását is kérte volna. Nincs „erre nincs
   felhatalmazásom", nincs „ezt a user nem kérte". A felmerült hiba javítása a
   kártya része, nem új engedélyhez kötött külön feladat.
5. **A „várakozó" (waiting) oszlop NEM felmentés a befejezés alól.** Ha egy
   kártya várakozóban áll, de a munka valójában NINCS kész, azt ugyanúgy be kell
   fejezni -- nem hands-off attól, hogy waiting-ben van. Nincs olyan, hogy „ez
   már waiting, ezt már nem csinálom meg". A befejezés a kártya MOZGATÁSA NÉLKÜL
   is megy: komment a kártyára + a munka izolált worktree-ben, a kártya közben
   maradhat „várakozó"-ban.
6. **EGY PROJEKT = EGY KÁRTYA (2026-09-23, {{OWNER_NAME}}).** „Egy projekt, egy
   kanban kártya. ... le kell tiltani azt, hogy másik kanban kártyát nyisson,
   amikor egy részfeladat készen van, vagy új feladat jön hozzá, de hozzátartozik
   ahhoz a munkához." Részfeladat, következő fázis, új hiba, kiegészítés egy MÉG
   NYITOTT kártya projektjéhez: **komment arra a kártyára** (vagy alfeladat
   `parent_id`-val), SOHA új felső szintű kártya. A valós eset: a Munkapad
   (#336) hét kártyára szabdalva állt, {{OWNER_NAME}}-nak kellett összeszednie.

## Gép is kikényszeríti

A `POST /api/kanban` (és a Munkapad `kanban.create` eszköze) egy NYITOTT
kártyához kapcsolódó új kártyát `409 same_project` hibával elutasít -- a
válasz megnevezi, melyik kártyán folytasd. Kapcsolódónak számít, amit a
`related` mezőben megadsz, ÉS amire a címben/leírásban hivatkozol (8 jegyű
azonosító vagy `#sorszám`).

Ha a munka TÉNYLEG önálló projekt (más ügyfél, más cél, külön lezárható),
küldd újra `"separate_project": "<miért önálló, legalább 15 karakter>"`
mezővel; az indok bekerül a kártya leírásába. Ezt ne használd kiskapunak: ha
kétséges, kérdezd meg {{OWNER_NAME}}-t.

Lezárt (`done`) vagy archivált kártyához kapcsolódó új munka szabadon
létrejöhet -- az már nem ugyanaz a nyitott projekt.

## Mit NE csinálj

- Ne nyiss új kártyát egy már folyó kártya közben felmerült hibának azzal, hogy
  „majd külön". Javítsd ugyanabban a munkában.
- Ne nyiss új kártyát egy nyitott projekt következő fázisának, részfeladatának
  vagy kiegészítésének. Kommentként megy a meglévő kártyára.
- Ne mozgasd a hibát egyik kártyáról a másikra.
- Ne hagyd félbe a kártyát, mert egy másikra vársz.
- Ne hagyj ott egy félkész kártyát azzal, hogy „ez már a várakozóban van".
  A waiting nem terminál állapot; a félkész munkát be kell fejezni.

## Mi NEM sérül

Ez NEM mond ellent a „kapcsolódó kártya belinkelése" szabálynak: valódi
kapcsolatot továbbra is jelezni kell -- de belinkelni LEZÁRT kártyát, vagy
tényleg ÖNÁLLÓ projektet lehet. A tilalom a hiba és a projekt szétdarabolására,
másik kártya alá tolására, és a félbehagyásra vonatkozik.

Ez NEM mond ellent a visszafelé-mozgatás tilalmának sem: egy kártyát a
`waiting`-ből korábbi oszlopba mozgatni továbbra is CSAK külön kérdés után
szabad. A waiting-kártyát a MOZGATÁSA NÉLKÜL fejezed be (komment + worktree) --
a waiting státusz a munka elvégzését nem blokkolja, csak a visszafelé-húzást köti
kérdéshez.

## Ellenőrzés

- A kártya készen van-e ténylegesen (nem félig)?
- A munka közben felmerült minden hiba javítva lett-e ugyanitt?
- Nem toltál-e át semmit másik kártya alá?
- Nem nyitottál-e új kártyát egy még nyitott projekt részének?
- Nem hagytál-e ott egy félkész kártyát csak azért, mert a várakozóban áll?
