---
name: one-card-one-fix
description: Egy hiba = egy kártya, azonnal és teljesen készre. Egy hibát nem szabdalunk szét több kártyára és nem tolunk át másik kártya alá; a kártyát félbehagyni tilos; ha a javítás közben új hiba jön elő, azt azonnal javítani kell, mintha a tulajdonos kérte volna. Fusd át minden kártya-munka elején.
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

## Öt pont

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

## Mit NE csinálj

- Ne nyiss új kártyát egy már folyó kártya közben felmerült hibának azzal, hogy
  „majd külön". Javítsd ugyanabban a munkában.
- Ne mozgasd a hibát egyik kártyáról a másikra.
- Ne hagyd félbe a kártyát, mert egy másikra vársz.
- Ne hagyj ott egy félkész kártyát azzal, hogy „ez már a várakozóban van".
  A waiting nem terminál állapot; a félkész munkát be kell fejezni.

## Mi NEM sérül

Ez NEM mond ellent a „kapcsolódó kártya belinkelése" szabálynak: valódi
kapcsolatot továbbra is jelezni kell. A tilalom a hiba szétdarabolására, másik
kártya alá tolására, és a félbehagyásra vonatkozik.

Ez NEM mond ellent a visszafelé-mozgatás tilalmának sem: egy kártyát a
`waiting`-ből korábbi oszlopba mozgatni továbbra is CSAK külön kérdés után
szabad. A waiting-kártyát a MOZGATÁSA NÉLKÜL fejezed be (komment + worktree) --
a waiting státusz a munka elvégzését nem blokkolja, csak a visszafelé-húzást köti
kérdéshez.

## Ellenőrzés

- A kártya készen van-e ténylegesen (nem félig)?
- A munka közben felmerült minden hiba javítva lett-e ugyanitt?
- Nem toltál-e át semmit másik kártya alá?
- Nem hagytál-e ott egy félkész kártyát csak azért, mert a várakozóban áll?
