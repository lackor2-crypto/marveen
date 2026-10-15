---
name: letter-workitem-send-only-content
description: Amikor a tulajdonos azt kéri, hogy egy levelet/beadványt/hiánypótlást "munkadarabként" készíts el a meglévő tudásból, a munkadarab CSAK azt a szöveget tartalmazza, amit ténylegesen elküldünk. Belső jegyzet, útvonal, ellenőrzés-jelzés nem kerülhet bele, és a végleges PDF karakterre egyezzen a munkadarabbal.
scope: global
---

# Levél-munkadarab: csak az kerül bele, amit elküldünk

## Mikor használd
A tulajdonos levelet, hiánypótlást, beadványt kér a Munkapadon ("csináljuk meg a munkadarabot a meglévő tudásunk alapján"). Valós eset (2026-10-15): a hivatalnak szánt munkadarabban belső hivatkozások, elérési utak és gépi ellenőrzés-jelzések látszottak, a PDF pedig nem azt mutatta, amit a munkadarab.

## Szabályok
1. **A munkadarab = a küldendő levél.** Címzett, tárgy, megszólítás, törzs, záró forma, aláírás, és a hivatalosan hivatkozott mellékletek (Anlage-szám + cím). Más nem.
2. **Belső anyag a kontextus-fájlba** (a projekt CLAUDE.md-je / kontextus md), nem a levélbe: forrás-útvonalak, "elkészített/ellenőrzött" jelzések, megjegyzések, amit a tulajdonos és az ágens használ. A levélben ilyen mondat nem lehet.
3. **Nyelv:** a tulajdonos kérése dönt. Ha magyarul kérte, az első szöveg magyar; a hivatalnak szánt fordítás külön, jelezve. Ha a kért nyelv nem világos, kérdezd meg, ne találd ki.
4. **PDF = munkadarab, karakterre.** A "Megnyitom és átnézem" és a véglegesítés a munkadarab blokkjaiból rendereljen; a külalak eltérhet, a szöveg nem. Ami a PDF-ben van, annak a munkadarabban kell lennie, és fordítva.
5. Átadás előtt hasonlítsd össze: a letöltött piszkozat-PDF szövege (`pdftotext`) és a blokkok szövege. Eltérést jelents, ne magyarázd el.

## Buktatók
- A mellékletek panelje a szerkesztőben a levél része? Nem: a PDF-ben a mellékletjegyzék és a mellékletek a levél UTÁN jönnek. Ezt mondd meg a tulajdonosnak, ha összekeveri.
- "Új fejezet" névtelen fejezet maradhat a levélben: töröld vagy nevezd át, mielőtt átadod.

## Ellenőrzés
- A munkadarab blokkjaiban nincs elérési út, "ellenőrizve", "elkészített" vagy forrás-jelzés.
- A PDF első része szóról szóra a blokkok szövege.
