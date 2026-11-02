---
name: letter-head-sender-recipient
description: Bíróságnak, hivatalnak, hatóságnak szóló levél/beadvány/nyilatkozat (Munkapad munkadarab) MINDIG levélfejjel kezdődik - ablakos boríték fejjel: keretes Feladó jobbra fent, Címzett balra az ablak helyén, felirattal, hely+dátum, ügyszám/tárgy, megszólítás. Sima címsor nem elég.
scope: global
---

# Levélfej: feladó és címzett kiírva és keretezve

## Mikor használd
Bármilyen hivatalos levelet, beadványt, nyilatkozatot, hiánypótlást, kérelmet fogalmazol hivatalnak, hatóságnak vagy bíróságnak a Munkapadon. Valós eset (2026-11-02): a tulajdonos egy bírósági nyilatkozatot (LSG L7 AS 450-26) kapott meg csak a bíróság címével és az ügyszámmal, feladó nélkül. Korábban egy bíróságon azért nem vették be az iratát, mert nem volt kiírva, ki a feladó és ki a címzett.

## Szabály (ablakos boríték, a tulajdonos saját beállítása, TG 4543)
A levél úgy kezdődik, ahogy a hivatalok egymásnak írnak: a **Feladó** keretes dobozként JOBBRA FENT, a **Címzett** BALRA, az ablakos boríték ablakában. Ez minden hivatalos levél (bíróság, hatóság, hivatal) közös formája, a tulajdonos egyszer beállította, nem kell újra kérnie.
1. **Első blokk: a Feladó** (`doc.addBlock`, `kind: "table"`). A szöveg sorai: a felirat (`Feladó:`; német változatban `Absender:`, angolban `Sender:`), majd a név, az utca, az irányítószám és város, mind külön sorban, és az UTOLSÓ sor szó szerint `#w=45&a=l&x=55&y=0&o=1` (45 % széles keretes doboz, jobbra fent, a szöveg fölött, nem foglal helyet).
2. **Második blokk: a Címzett** (`kind: "paragraph"`). A szöveg: NÉGY üres sor, majd a felirat (`Címzett:`; `Empfänger:`; `Recipient:`), majd a címzett neve, hatósága, irányítószáma és városa külön sorokban, végül KÉT üres sor. „Üres sor” = egy sornyi egyetlen zero-width space karakter (U+200B), különben a rendszer eltünteti. Ettől esik a cím az ablakba.
3. Utána: **hely, dátum** (`Chemnitz, 2026. 11. 02.`), az **ügyszám / tárgy** sor (Aktenzeichen / Tárgy / Betreff), a megszólítás, a törzs.
4. A feladó adatait a tulajdonos életfa-adataiból vedd (név, cím); a címzettét az iratból, amire válaszolsz. Ami nincs meg, oda `⚠ Hiányzó adat: ...` kerül, ne találj ki címet.
5. NEM jó: sima címsor a Feladó/Címzett helyett; a két fél egyetlen táblában egymás mellett; a Címzett a lap tetején, ablak nélküli helyen. Egy már megírt levélnél a fejet hozd ebbe a formába.
6. Nyelvi változatnál (`doc.translateSection`) a feliratok fordulnak (Feladó ↔ Absender, Címzett ↔ Empfänger), a pozíció-sor és az üres sorok változatlanok; a neveket és címeket nem fordítjuk.
7. Mintának a „Minijob: kérés a Minijob-Zentrale és a Rentenversicherung felé” munkadarab első két blokkja. Kódban: `buildLetterHead()` a `src/workbench-letterhead.ts`-ben (ugyanezt a két blokkot adja, teszt: `workbench-letterhead-window.test.ts`).

## Figyelő
A dokumentum-ellenőrzés (`letter_head_missing`) teendőt ad a munkadarabnak, ha a szövegben van megszólítás vagy aláírás-blokk, de nincs kiírt „Feladó:/Címzett:” (vagy Absender/Empfänger, Sender/Recipient) felirat. Ez teendő, nem akadály: a tulajdonos dönt. Ne kerüld meg azzal, hogy a feliratot elrejted; írd meg a táblát.

## Ellenőrzés
- Az Ellenőrzés fülön nincs „Levélfej hiányzik” pont.
- A letöltött piszkozat-PDF első lapján a Feladó keretes doboz jobbra fent van, a Címzett balra, az ablak helyén.
