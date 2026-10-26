---
name: workitem-language-version-overwrite
description: Re-translating a work item into a language that already has a version overwrites that version; it never creates a second work item for the same language next to the original. Use when translating, re-translating or creating a language version.
scope: global
---
# Újrafordításkor a meglévő nyelvi változatot írjuk felül

## Mikor használd
- Fordítás / Újrafordítás gomb, `doc.createVariant`, `doc.translateSection`, szövegfordítás mentése.
- Bármikor, amikor egy munkadarabnak már van ugyanilyen nyelvű változata.

## Szabály (Boss, 2026-10-26, TG 10489)
- Egy eredeti munkadarabnak egy nyelvből EGY változata lehet. Újrafordításkor NEM készül új munkadarab: a meglévő változat tartalmát írjuk felül (az eredeti nem érintett).
- Így nem szemetelődik tele a munkadarab melletti terület ("HU – ..." kétszer).
- Ha a változatot a felhasználó TÖRÖLTE, az új fordítás új változatot kaphat; ezt mondd ki neki, ne csendben.

## Eljárás
1. Fordítás előtt nézd meg: `doc.variants` / a változatok listája: van-e már ilyen nyelvű?
2. Ha van: a meglévőbe írj (`doc.translateSection` a meglévő változat azonosítójával). Ne hívj új `doc.createVariant`-et külön munkadarabbá.
3. Ha mégis két azonos nyelvű változatot találsz: ne törölj, szólj a felhasználónak, melyiket tartsa.

## Buktatók
- Valós eset (2026-10-26, "Billigkeitsantrag Berlin"): két "HU – Billigkeitsantrag Berlin" munkadarab keletkezett öt percen belül, mindkettő teljes fordítással.

## Ellenőrzés
- Az eredetihez nyelvenként legfeljebb egy (nem törölt) változat tartozik.
