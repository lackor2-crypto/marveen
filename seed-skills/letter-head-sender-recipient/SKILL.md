---
name: letter-head-sender-recipient
description: Bíróságnak, hivatalnak, hatóságnak szóló levél/beadvány/nyilatkozat (Munkapad munkadarab) MINDIG levélfejjel kezdődik - keretezett Feladó / Címzett tábla felirattal, hely+dátum, ügyszám/tárgy, megszólítás. Sima címsor nem elég.
scope: global
---

# Levélfej: feladó és címzett kiírva és keretezve

## Mikor használd
Bármilyen hivatalos levelet, beadványt, nyilatkozatot, hiánypótlást, kérelmet fogalmazol hivatalnak, hatóságnak vagy bíróságnak a Munkapadon. Valós eset (2026-11-02): a tulajdonos egy bírósági nyilatkozatot (LSG L7 AS 450-26) kapott meg csak a bíróság címével és az ügyszámmal, feladó nélkül. Korábban egy bíróságon azért nem vették be az iratát, mert nem volt kiírva, ki a feladó és ki a címzett.

## Szabály
1. **A levél elején EGY tábla blokk áll** (`doc.addBlock`, `kind: "table"`): a sorok külön sorban, egy sor két cellája ` | ` jellel elválasztva. Az első sor a felirat, a dokumentum nyelvén:
   - magyar: `Feladó: Korpás László | Címzett: Sächsisches Landessozialgericht`
   - német változat: `Absender: ... | Empfänger: ...`
   - angol: `Sender: ... | Recipient: ...`
   Alatta a két fél címsorai (utca, irányítószám, város), a cellák párban egy-egy sorban. A PDF a táblát vékony kerettel rajzolja: ez a „keret”.
2. Utána jön: **hely, dátum** (`Chemnitz, 2026. 11. 02.`), majd az **ügyszám / tárgy** sor (Aktenzeichen / Tárgy / Betreff), majd a megszólítás és a törzs.
3. A feladó adatait a tulajdonos életfa-adataiból vedd (név, cím); a címzettét az iratból, amire válaszolsz. Ami nincs meg, oda `⚠ Hiányzó adat: ...` kerül, ne találj ki címet.
4. Mintának a meglévő jó fejléc: a „Wohngeld 2026 - Korpas Laszlo” mappa levele (Absender/Empfänger tábla).
5. Nyelvi változatnál (`doc.translateSection`) a tábla is fordul: Feladó ↔ Absender, Címzett ↔ Empfänger. A neveket és címeket nem fordítjuk.

## Figyelő
A dokumentum-ellenőrzés (`letter_head_missing`) teendőt ad a munkadarabnak, ha a szövegben van megszólítás vagy aláírás-blokk, de nincs kiírt „Feladó:/Címzett:” (vagy Absender/Empfänger, Sender/Recipient) felirat. Ez teendő, nem akadály: a tulajdonos dönt. Ne kerüld meg azzal, hogy a feliratot elrejted; írd meg a táblát.

## Ellenőrzés
- Az Ellenőrzés fülön nincs „Levélfej hiányzik” pont.
- A letöltött piszkozat-PDF első lapján látszik a keretezett Feladó / Címzett.
