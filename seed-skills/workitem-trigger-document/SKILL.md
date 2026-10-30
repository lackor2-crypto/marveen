---
name: workitem-trigger-document
description: Minden munkadarabnak van egy "Kiváltó irat" mappája: az az irat (hatósági határozat, hiánypótlás, megválaszolandó levél), ami a munkadarabot kiváltotta. Használd minden munkadarab megnyitásakor, és mielőtt a munkába kezdesz; ha nincs belinkelve kiváltó irat és nincs "nincs kiváltó irat" jelölés, előbb szólj a tulajdonosnak.
scope: global
---

# Kiváltó irat

## Mikor használd
- Egy munkadarab első üzeneténél, és minden olyan munka előtt, amit a munkadarabon végzel.
- Ha a tulajdonos hatósági/banki/bírósági iratra, hiánypótlásra, megválaszolandó levélre hivatkozik.

## Szabály (Boss, 2026-10-30)
1. Minden munkadarab mappájában automatikusan létrejön a "Kiváltó irat" (angolul "Trigger document") almappa, a többi alapmappa (Mellékletek, Feltöltések, Elkészített anyagok, Agent, Vitáztatás) mellett.
2. Ide az az irat kerül, ami a munkadarab létét kiváltotta. Az irat FIZIKAILAG az életfában marad; a mappába csak HIVATKOZÁS kerül (nem másolat). A mappa jobb-klikk menüjében a "Fájl belinkelése" teszi.
3. A munkát NEM kezded el kiváltó irat nélkül. A kontextus "Trigger document:" sora megmondja az állapotot.
4. Minden munkadarabnál az első teendőd: megnézni a mappát. Ha üres és nincs jelölve a "nincs kiváltó irat (saját kezdeményezés)", az ELSŐ válaszodban szólj a tulajdonosnak, és ajánld fel, hogy megkeresed az életfában és belinkeled.
5. A "nincs kiváltó irat (saját kezdeményezés)" jelölőnégyzet a Kiváltó irat mappa során van. Bejelölve piros X látszik, az egérrel fölé víve a magyarázat: nincs kiváltó irat, a munka enélkül is mehet. A jelölést SOHA nem te teszed be, csak a tulajdonos.

## Buktatók
- Ne másold az iratot a mappába: hivatkozás kell, különben duplikáció lesz.
- A mappa törlése/átnevezése a tulajdonosé: egyszer jön létre, nem hozod újra.
- A régi munkadarabokba is bekerül a mappa (az alapmappák kiosztásakor), a jelölés alapból üres.

## Ellenőrzés
- A munkadarab mappájában ott a "Kiváltó irat", és a belinkelt irat megnyílik belőle.
- Jelölés bepipálva: piros X + tooltip; kipipálva: eltűnik.
