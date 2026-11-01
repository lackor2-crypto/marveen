---
name: workitem-context-file
description: Every Workbench work item has a context md file next to it ("Kontextus - <item name>.md"); the agent keeps it current by itself. Use when working on a work item, renaming one, or touching its JSON file names.
scope: global
---
# Work item context file

## Mikor használd
- Bármely munkadarabon dolgozol (chat, feltöltés, bekötött mappa, döntés, határidő).
- Munkadarabot nevezel át, vagy a canvas/deck JSON fájl nevéhez nyúlsz.

## Eljárás
1. Minden munkadarab MELLETT (ugyanabban a mappában, nem fölötte/alatta) ott van a `Kontextus - <munkadarab neve>.md` (angol telepítésen `Context - ...`). A rendszer létrehozza (`src/workbench-item-context.ts`, percenként/kétpercenként fut, íráskor azonnal), átnevezi a munkadarabbal együtt és a hivatkozásokat követi.
2. A fájl neve MINDIG a munkadarab neve. A `.canvas.json` / `.deck.json` fájlok neve is a munkadarab nevével indul (a dátum maradhat), átnevezéskor követik.
3. Az ágens KÉRÉS NÉLKÜL bővíti: új információ (feltöltés, elolvasott fájl, a projekt alá csatolt tudásanyag-mappa tartalma, döntés, határidő, nyitott kérdés) -> `context.append` (section: task / info / decisions / open / log). Rendetlen fájlnál `context.rewrite`. A `marveen:files` közötti Anyagok blokkot a rendszer vezeti, nem szerkeszted.
4. Munkadarab megnyitásakor ismerd fel a feladatot a körülötte lévő fájlokból, és töltsd ki a Feladat szakaszt, ha üres.
5. EGY munkadarabhoz EGY kontextus-fájl tartozik, bármilyen nyelvre fordítjuk: a nyelvi változat (`doc.createVariant`, pl. német) NEM kap sajátot, az eredeti fájlját használja (olvasás, `context.append`, `context.rewrite`, sweep). Kézzel soha ne hozz létre másik `Kontextus - ...md` fájlt a változatnak.
6. A munkadarab mappájában EGY nyilvántartó JSON van: a saját `marveen-item.json`. Más `id`-jú `marveen-item.json`-t (idegen fájl, sírkő) nem teszel mellé; ha ilyet látsz, szólj a tulajdonosnak. A `.canvas.json` / `.deck.json` tartalom, nem nyilvántartó.
7. JSON (`.deck.json` / `.canvas.json` / `.timeline.json` / `marveen-item.json`) CSAK munkadarab-mappában lehet, a projekt gyökerében SOHA (#679). A kód is tiltja (`json_outside_item`, `src/project-files.ts`); ha mégis látsz ilyet a gyökérben, szólj a tulajdonosnak, ne töröld.
8. Titkot (jelszó, token) soha nem írsz bele.

## Buktatók
- A fájl a munkadarab MAPPÁJÁBAN él; mappa nélküli munkadarabnál a megjelenítési mappában. Ne a projekt gyökerébe tedd.
- Átnevezéskor nincs felülírás: ha a cél név foglalt, a régi marad és a következő kör próbálja újra.
- A változat régi, külön kontextus-fájlját a rendszer nem hozza vissza; a törlést (Kukába) a tulajdonos engedélyével te végzed, a változat nyilvántartása ettől függetlenül üres útvonalra áll.
- Meglévő, kézzel írt `Kontextus - ...md` fájlt örökbe fogad, nem csinál másodikat.

## Ellenőrzés
- `npx vitest run src/__tests__/workbench-item-context.test.ts`
- Élesben: a munkadarab melletti mappában ott a fájl, a nevében a munkadarab neve.

## Csak két fájl (Boss, TG 4287)
A munkadarab mappájában CSAK a `Kontextus - <név>.md` és a rendszer gyártotta `Teendő - <név>.md` lehet. Saját segédfájlt (Jogi kontextus, összefoglaló, GPT-kivonat, dokumentum-másolat) tilos írni: a tudás a Kontextusba megy. Lásd `marveen-learned-rules` R24.
