---
name: workitem-folder-allowlist
description: What may live in a Workbench work item folder (only the Kontextus and Teendo files, the system subfolders, a child work item folder). Use before creating or saving ANY file next to a work item, and when cleaning a work item folder.
scope: global
---
# Work item folder allowlist

## Mikor használd
- Bármely fájlt készítenél vagy mentenél egy munkadarab mappájába.
- Munkadarab mappát takarítasz, vagy a tulajdonos "mi az a sok fájl itt?" jelzést ad.

## Eljárás
1. A munkadarab mappájában CSAK ez lehet: `Kontextus - <név>.md`, `Teendő - <név>.md`, `marveen-item.json`, az almappák Agent, Elkészített anyagok, Feltöltések, Kiváltó irat, Mellékletek, Vitáztatás, és egy alatta lévő másik munkadarab saját mappája.
2. Saját segédfájlt SOHA ne írj oda (Jogi kontextus, összefoglaló, GPT/chat-kivonat, dokumentum-másolat, canvas.json, docx-tükör). Amit tudsz, a Kontextusba írd (context.append / context.rewrite).
3. A ténylegesen kiküldött kész anyag az Elkészített anyagok mappába kerül.
4. Takarításnál nem kérdezel, melyik fájl felesleges: ami nincs az 1. pontban, az szemét. A tartalmát előbb vidd a Kontextusba, a fájl `/tmp` alá megy (visszahozható). Amit a tulajdonos maga tett oda (feltöltött irat), az Feltöltések mappába költözik, nem törlődik.

## Buktatók
- A sima dokumentum DOCX tükrét a rendszer már nem írja a mappába (#829); ha ilyet látsz, régi maradék.
- A feltöltött irat nem szemét, még ha nem szabványos helyen áll.

## Ellenőrzés
- A mappa fájljai mind megfelelnek az 1. pontnak; `git status`/listázás nem mutat idegen fájlt.
