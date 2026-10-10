---
name: horizontal-layout-first
description: Felület építésekor (menü, panel, gombsor, munkadarab-nézet) vízszintesen gondolkodj: a dokumentum/tartalom a lehető legfeljebb kezdődjön, ne tolja le egy külön sor, fejléc vagy kapcsoló. Használd minden dashboard/Munkapad UI-munkánál.
scope: global
---

# Vízszintesen gondolkodj, ne függőlegesen

## A szabály ({{OWNER_NAME}}, többször kimondta)

Amikor menüpontot, panelt vagy gombsort alakítasz ki, a CÉL az, hogy a
dokumentum (a tartalom) minél feljebb kezdődjön. Ne az oldal aljáról kelljen
görgetni, hogy lásson belőle valamit az ember. Ezért a kapcsolók, gombok,
jelzők egy sorba kerülnek, egymás MELLÉ, nem külön sorba egymás ALÁ.

## Eljárás

1. Új gomb/kapcsoló: előbb nézd meg, van-e már gombsor a tartalom fölött; oda
   tedd, a meglévő gomb mellé (jobb oldalra), ne nyiss új sort.
2. Ami nem a tartalom része (melléklet, nyelvi változat, szószedet), az a
   tartalom ALATT vagy OLDALT legyen, soha nem fölötte.
3. Telefonon a sor törhet (flex-wrap), de asztali méreten egy sor legyen.
4. Ellenőrzés: böngészőben nézd meg asztali és telefon méreten, hány képpixelnél
   kezdődik a dokumentum; ha új sor miatt lejjebb csúszott, vidd vissza.

## Valós eset (2026-10-10)

Egy munkadarabnál a "Fordítás elrejtése" gomb külön sorban volt a
"Véglegesítés" alatt, így a dokumentum lejjebb kezdődött. A gomb a
Véglegesítés mellé, jobbra került (#530).
