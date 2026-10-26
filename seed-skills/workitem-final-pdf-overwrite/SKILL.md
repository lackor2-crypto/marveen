---
name: workitem-final-pdf-overwrite
description: Finalising a changed work item again replaces that item's own earlier final PDF in the Finished materials folder (no duplicates, no v1/v2 pile); PDFs of other work items in the same folder stay. Use when finalising, re-finalising or touching Finished materials.
scope: global
---
# Újravéglegesítéskor a saját régi PDF-et felülírjuk

## Mikor használd
- Véglegesítés (Végleges PDF), újravéglegesítés módosítás után.
- Az "Elkészített anyagok" mappa tartalmához nyúlsz.

## Szabály (Boss, 2026-10-26, TG 10494)
- Ugyanannak a munkadarabnak az új véglegesítése FELÜLÍRJA a saját korábbi végleges PDF-jét az Elkészített anyagokban: nincs duplikáció, nincs verziózás, nincs keveredés.
- Egy MÁSIK munkadarab véglegesítése NEM írja felül: mellé kerül. Mindig látszania kell, melyik PDF melyik munkadarabhoz tartozik.
- Változatlan tartalomnál (azonos hash, azonos nyelv) már eddig sem készül második példány.

## Eljárás
1. Az új PDF elkészülte UTÁN (sikeres mentés után) távolítsd el ugyanannak a munkadarabnak a korábbi végleges PDF-jeit (visszaállítható módon: Kuka-végpont, nem végleges törlés).
2. Más munkadarab fájljához ne nyúlj; az azonosítás a munkadarab final-metaadatából (pdf_path), ne a fájlnévből történjen.
3. Ha a régi PDF már el lett küldve (levélhez csatolva), jelezd a felhasználónak, mielőtt felülírod.

## Buktatók
- Jelenlegi viselkedés (2026-10-26 előtt): a módosított tartalom új "– vN.pdf" fájlt kap a régi mellé.
- Nyelvi változat külön munkadarab: a saját PDF-je külön, nem írja felül az eredetiét.

## Ellenőrzés
- Elkészített anyagokban munkadarabonként egy végleges PDF van.
