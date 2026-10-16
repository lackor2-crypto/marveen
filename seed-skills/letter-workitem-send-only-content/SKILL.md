---
name: letter-workitem-send-only-content
description: Amikor a felhasználó levelet, beadványt, hiánypótlást, bírósági iratot kér "munkadarabként" (Munkapad), a munkadarab CSAK a küldendő szöveg legyen, betűre azonos a generált PDF-fel, és ALAPBÓL a felhasználó anyanyelvén készüljön, nem németül/angolul. Fordítás csak kérésre, utólag.
scope: global
---

# Levél-munkadarab: csak a küldendő szöveg, a felhasználó nyelvén

## Mikor használd
Levelet, hiánypótlást, beadványt, bírósági iratot, bármilyen hivatalos dokumentumot fogalmazol a Munkapadon. Valós eset (2026-10-15): a munkadarab tele volt belső magyarázattal, elérési úttal és ellenőrzés-jelzéssel, ami a PDF-ben nem volt ott, ráadásul az ágens németül írta, holott a felhasználó magyarul kérte.

## Szabályok
1. **A munkadarab = a PDF.** Ami a munkadarabban van, az szóról szóra, karakterre ugyanaz, mint a generált PDF-ben, és fordítva: ha a munkadarabban A betű van, a PDF-ben nem lehet B. A PDF külalakja a felhasználó dolga, a szöveg nem térhet el.
2. **A munkadarabba CSAK a küldendő szöveg kerül:** címzett, tárgy, megszólítás, törzs, záró forma, aláírás. Magyarázat, megjegyzés, forrás-útvonal, "elkészített/ellenőrzött" jelzés, "igaz/következtetés" sor SOHA. Ezek a projekt kontextus-fájljába vagy az ágens válaszába mennek, nem a levélbe.
3. **Nyelv: a felhasználó anyanyelve.** Nézd meg, milyen nyelven használja a felhasználó a Marvint (felület nyelve, `APP_LANG`, a beszélgetés nyelve), és azon fogalmazd meg és készítsd el a dokumentumot. Német, angol vagy más nyelv CSAK akkor az első nyelv, ha az a felhasználó anyanyelve. A felhasználó utána maga kéri a fordítást (németre, angolra, ...), vagy ha ő külföldi, magyarra; addig ne fordíts, és ne írj eleve idegen nyelven. Ha a nyelv bizonytalan, kérdezd meg.
4. Az Ellenőrző nézet (állapotjelzők, forrás-sorok, "Egyszerűbben/Hivatalosabban") eszköz, alapból ki van kapcsolva; ne tegyél a blokkok szövegébe semmit, ami csak abban a nézetben értelmes.
5. **Aláírás: a levél végén legyen kézi aláírás (kép), biztos, ami biztos.** Hivatalos levélnél (hiánypótlás, válasz, beadvány) az aláírás-blokk mellé tedd be a felhasználó mentett aláírás-képét (az Életfában az aláírás/signature nevű kép; a szerkesztő eszköztárának „Aláírás beszúrása” gombja ugyanezt listázza). Jogilag egy sima e-mailes hiánypótláshoz nem kell, de nem árt (a felhasználó kérése, 2026-10-16). A Hiányok fül jelez, ha van aláírás-blokk, de nincs benne aláírás-kép: azt javítsd, ne hagyd ott. Ha nincs mentett aláírás-kép, szólj a felhasználónak, ne találj ki.
6. Átadás előtt hasonlítsd össze a letöltött piszkozat-PDF szövegét (`pdftotext`) a munkadarab blokkjaival. Eltérést jelents, ne magyarázd el.

## Buktatók
- A mellékletek a PDF-ben a levél UTÁN jönnek (jegyzék + mellékletek); ez rendben van, nem eltérés.
- "Új fejezet" névtelen fejezet: töröld vagy nevezd át, mielőtt átadod.

## Ellenőrzés
- A blokkokban nincs elérési út, "ellenőrizve", "elkészített", forrás-jelzés, magyarázat.
- A dokumentum nyelve a felhasználó nyelve.
- A PDF első része szóról szóra a blokkok szövege.
- Az aláírás-blokk mellett van aláírás-kép, és a Hiányok fülön nincs aláírás-figyelmeztetés.
