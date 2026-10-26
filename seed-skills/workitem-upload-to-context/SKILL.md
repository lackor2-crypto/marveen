---
name: workitem-upload-to-context
description: Everything uploaded or attached to a work item (any folder, annex, debate, chat, folder next to the item) must be read out (OCR for images), analysed and its facts written into the item's context file. Use whenever a file arrives at a work item.
scope: global
---
# Feltöltött anyag -> kontextus (kötelező)

## Mikor használd
- Bármi, amit a munkadarabhoz feltöltenek vagy csatolnak: Mellékletek, Vitáztatás, Agent, Elkészített anyagok, a munkadarab melletti mappa, chat-melléklet.
- Minden típus: .png, .jpg, .pdf, .docx, .md, .txt, .odt, ...

## Eljárás
1. Olvasd ki a TELJES tartalmat. Kép: OCR / képolvasás, a szöveg és a lényeges adatok (dátum, időpont, összeg, név, hivatkozási szám). PDF/Word: szöveg + táblázat.
2. Elemezd: mi ez, mi a lényege, milyen tényt állít, mi érinti a munkadarab célját.
3. Írd be a munkadarab Kontextus fájljába (workitem-context-file): forrásfájl neve + a kinyert tények, szó szerinti adatokkal (idősáv, szám, dátum). Ne kerekíts.
4. Ha a kinyert adat ELLENTMOND annak, amit a felhasználó mondott (pl. a bírság 13:30-13:50 idősávot ír, a felhasználó 15:30-ig ott volt), jelezd a kontextusban és a felhasználónak.
5. A kiolvashatatlan fájlt ne hagyd csendben: írd a kontextusba, hogy nem sikerült, és szólj.

## Buktatók
- Valós eset (2026-10-26, berlini rendőrségi levél): a feltöltött PNG-ből nem olvasta ki senki a bírság időpontját, ezért a levél a 13:30-13:50 és a tényleges 15:30 közti eltérést nem tudta kezelni.
- Fájlnévből vagy a feltöltés tényéből ne következtess tartalomra.

## Ellenőrzés
- A Kontextus fájlban minden feltöltött fájlhoz van bejegyzés a kinyert adatokkal.
