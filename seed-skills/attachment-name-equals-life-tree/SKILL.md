---
name: attachment-name-equals-life-tree
description: An annex or attachment goes into a letter or e-mail under EXACTLY the file name it has in the Life tree. A rename (e.g. Hungarian to German for a German authority) is done in the Life tree first, then the renamed file is attached unchanged. Use when attaching, renaming or sending annexes.
scope: global
---
# A melléklet neve = az Életfában lévő fájlnév, mindig

## Mikor használd
Levélhez, e-mailhez, beadványhoz mellékletet csatolsz, vagy a tulajdonos fájl-átnevezést kér egy melléklethez.

## Eljárás
1. Átnevezés CSAK az Életfában történik, és csak ha a tulajdonos kéri. Önhatalmúlag soha nem nevezel át mellékletet.
2. A címzett nyelve dönt: magyar hivatalnak magyar, német hivatalnak német, angol hivatalnak angol fájlnév. Ilyenkor az Életfában írod át a nevet, és UTÁNA csatolod.
3. A csatolt melléklet neve betűre azonos az Életfa fájlnevével (a kiterjesztés .pdf lesz, ha nem PDF volt). Nem készítesz új nevet a címkéből, a címből vagy a dátumból.
4. Az őrszem teszt: `SENTINEL: every annex is sent under its own file name` (`src/__tests__/workbench-docpackage.test.ts`). Ha elbukik, a csatoláskor újra előáll egy kitalált név: javítsd, ne a tesztet.

## Buktatók
- Az éles hibában a melléklet-listában `20261031...` kezdetű név állt, a levél alatt `K1 – ...` felirat: két különböző név ugyanarra a fájlra, később nem találni meg (Boss, 2026-10-31).
