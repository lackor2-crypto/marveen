---
name: letter-workitem-send-only-content
description: Amikor a felhasználó levelet, beadványt, hiánypótlást, bírósági iratot kér "munkadarabként" (Munkapad), a munkadarab CSAK a küldendő szöveg legyen, betűre azonos a generált PDF-fel, és ALAPBÓL a Marveen felületének nyelvén (bal alsó sarok: hu / en) készüljön, a címzett nyelvétől függetlenül. Fordítás csak kérésre, utólag, nyelvi változatként.
scope: global
---

# Levél-munkadarab: csak a küldendő szöveg, a felhasználó nyelvén

## Mikor használd
Levelet, hiánypótlást, beadványt, bírósági iratot, bármilyen hivatalos dokumentumot fogalmazol a Munkapadon. Valós eset (2026-10-15): a munkadarab tele volt belső magyarázattal, elérési úttal és ellenőrzés-jelzéssel, ami a PDF-ben nem volt ott, ráadásul az ágens németül írta, holott a felhasználó magyarul kérte. Másodszor (2026-10-18) egy német hivatalnak szóló levelet kezdett németül: a címzett nyelve nem döntheti el a dokumentum nyelvét.

## Szabályok
1. **A munkadarab = a PDF.** Ami a munkadarabban van, az szóról szóra, karakterre ugyanaz, mint a generált PDF-ben, és fordítva: ha a munkadarabban A betű van, a PDF-ben nem lehet B. A PDF külalakja a felhasználó dolga, a szöveg nem térhet el.
2. **A munkadarabba CSAK a küldendő szöveg kerül:** címzett, tárgy, megszólítás, törzs, záró forma, aláírás. Magyarázat, megjegyzés, forrás-útvonal, "elkészített/ellenőrzött" jelzés, "igaz/következtetés" sor SOHA. Ezek a projekt kontextus-fájljába vagy az ágens válaszába mennek, nem a levélbe.
3. **Nyelv: a Marveen felületének nyelve (a bal alsó sarokban állított, hu / en), az ELSŐ szótól.** A promptban a „Document language" sor mondja meg; azon fogalmazd meg a címzettet, a tárgyat, a megszólítást, a törzset, a levélpiszkozat (.eml) tárgyát és szövegét is. Magyar felületen magyar, angol felületen angol levél készül. A **címzett, a hatóság, a bíróság vagy a bejövő levél nyelve NEM számít**: német hivatalnak szóló levél is magyarul (vagy az angol felhasználónál angolul) készül el, a német változatot a felhasználó utólag kéri, és az külön nyelvi változat (`doc.createVariant`, majd `doc.translateSection`). Soha ne kezdj idegen nyelven „időt spórolni", és ne mondd, hogy „majd lefordítom". Kivétel csak: a felhasználó ebben a beszélgetésben kifejezetten másik nyelvet kér. A forrásból szó szerint idézett részek az eredeti nyelven maradnak. Ha a nyelv bizonytalan, kérdezd meg, ne találgass.
4. Az Ellenőrző nézet (állapotjelzők, forrás-sorok, "Egyszerűbben/Hivatalosabban") eszköz, alapból ki van kapcsolva; ne tegyél a blokkok szövegébe semmit, ami csak abban a nézetben értelmes.
5. **Aláírás: a levél végén legyen kézi aláírás (kép), biztos, ami biztos.** Hivatalos levélnél (hiánypótlás, válasz, beadvány) az aláírás-blokk mellé tedd be a felhasználó mentett aláírás-képét (az Életfában az aláírás/signature nevű kép; a szerkesztő eszköztárának „Aláírás beszúrása” gombja ugyanezt listázza). Jogilag egy sima e-mailes hiánypótláshoz nem kell, de nem árt (a felhasználó kérése, 2026-10-16). A Hiányok fül jelez, ha van aláírás-blokk, de nincs benne aláírás-kép: azt javítsd, ne hagyd ott. Ha nincs mentett aláírás-kép, szólj a felhasználónak, ne találj ki.
6. Átadás előtt hasonlítsd össze a letöltött piszkozat-PDF szövegét (`pdftotext`) a munkadarab blokkjaival. Eltérést jelents, ne magyarázd el.

## Buktatók
- A mellékletek a PDF-ben a levél UTÁN jönnek (jegyzék + mellékletek); ez rendben van, nem eltérés.
- "Új fejezet" névtelen fejezet: töröld vagy nevezd át, mielőtt átadod.

## Ellenőrzés
- A blokkokban nincs elérési út, "ellenőrizve", "elkészített", forrás-jelzés, magyarázat.
- A dokumentum nyelve a felület nyelve (a promptbeli „Document language” sor), nem a címzetté.
- A PDF első része szóról szóra a blokkok szövege.
- Az aláírás-blokk mellett van aláírás-kép, és a Hiányok fülön nincs aláírás-figyelmeztetés.
