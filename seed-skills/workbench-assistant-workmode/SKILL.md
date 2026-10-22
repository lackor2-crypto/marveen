---
name: workbench-assistant-workmode
description: The Workbench assistant's Work mode sheet (Settings -> AI Workbench -> Work mode) and the machine placement check after an upload, a finalisation or a Life-tree move. Use when you work on a work item for the owner, when you want a lasting working rule, or when you change how the Workbench assistant behaves.
scope: global
---
# A Munkapad-asszisztens munkamódja

## Mikor használd
- Egy munkadarabon dolgozol (chat, feltöltés, véglegesítés, Életfába költöztetés).
- Rájöttél valamire, ami legközelebb is jól jönne (mit ne keress újra, hova mi kerül).
- A Munkapad-asszisztens viselkedésén módosítasz (kód: `src/workbench-workmode.ts`, `src/workbench-placement-check.ts`).

## Mi ez
- **Munkamód lap.** Egyetlen szerkeszthető szöveg a Beállítások → AI Munkapad → Munkamód kártyán. Ez írja le, hogyan dolgozik az asszisztens:
  - kontextus-fájl, teendők, kutatás;
  - amit egyszer megtalált, nem keresi újra;
  - a mappák szerepe (Feltöltések, Mellékletek, Elkészített anyagok, Közös anyagok);
  - Vitáztatás;
  - költöztetés az Életfába;
  - önellenőrzés;
  - önfejlődés.

  Friss telepítésen a beépített alapszöveg él (`DEFAULT_WORKMODE`, a felület nyelvén). Az asszisztens minden fordulóban megkapja a kontextus `workmode` blokkjában.
- **Önfejlődés = csak javaslat.** Az asszisztens a `workmode.propose` eszközzel (rule, reason) javasol. A szabály NEM kerül fel a lapra, amíg a tulajdonos az előnézet után az „Elfogadom” gombra nem kattint. Elfogadáskor a szabály a lap végére kerül, pontosan úgy, ahogy az előnézet mutatta. A lapot ágens soha nem írja át maga.
- **Gépi önellenőrzés.** Feltöltés, véglegesítés és Életfába költöztetés után a szerver ugyanazzal a felismerővel nézi meg, hol állnak a munkadarab fájljai, amelyikkel a fa (`workbench-misplaced.ts`).
  - Ha valami rossz helyen van (pl. egy melléklet az Elkészített anyagok között), az asszisztens beírja a munkadarab chatjébe, és a felületen egy toast is jelez.
  - Nem mozdít el semmit, a tulajdonos dönt.
  - A puha jelzés (Agent mappa, külső vélemény a Vitáztatásban) nem hiba, ezért nem jelzi.

## Eljárás
1. Munka előtt olvasd el a Munkamód lapot (az asszisztens a kontextusban kapja; ágensként: `GET /api/workbench/workmode`).
2. Tartós szabályt NE írj sehova magadtól. Javasold:
   - asszisztensként a `workmode.propose` eszközzel;
   - ágensként mondd el a tulajdonosnak, és ő írja fel a kártyán.
3. Ha a gépi ellenőrzés rossz helyen lévő fájlt jelez, ne mozgasd át kérdés nélkül. Írd le, mit javasolsz, és várd meg a tulajdonos döntését.
4. Az Életfába költöztetésnél a mellékletek a Mellékletek közé kerülnek, NEM az Elkészített anyagok közé.

## Buktatók
- Az üres javaslatlista nem azt jelenti, hogy nincs szabály: a szabályok a lapon vannak. Ha a lapot nem sikerült betölteni, az hibaként jelenik meg, nem üres lapként.
- A lap a kontextusban `WORKMODE_IN_CONTEXT` karakternél le van vágva. A hosszú lapot rövidítsd, ne az alapszöveget növeld.
- A nyitott javaslatok száma korlátos (`WORKMODE_MAX_PENDING`), és ugyanazt a szabályt kétszer nem lehet javasolni (`workmode_duplicate`).

## Ellenőrzés
- `npx vitest run src/__tests__/workbench-workmode.test.ts`
- A felületen: Beállítások → AI Munkapad → Munkamód. Ott van a szerkesztés, a mentés, az alapszöveg visszaállítása, és a javaslatok elfogadása vagy elvetése az előnézettel.
