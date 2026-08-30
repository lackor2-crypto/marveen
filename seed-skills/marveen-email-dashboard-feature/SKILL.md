---
name: marveen-email-dashboard-feature
description: Marveen email-dashboard funkciók biztonságos, fork-barát megépítése Himalaya backenddel, HU/EN i18n-nel és izolált tesztekkel. Használd email kereső, szűrő, lista vagy postafiók UI/API fejlesztésénél.
scope: global
---

# Marveen email-dashboard funkció

## Mikor használd

- Új email lista, kereső, szűrő vagy postafiók funkciónál.
- Ha a Himalaya CLI-hez felhasználói adatból kell argumentumokat képezni.
- Ha egymást felülíró frontend email-kérések versenyhelyzetet okozhatnak.

## Eljárás

1. Ellenőrizd a kanbant, kérj explicit engedélyt a követett kód módosítása előtt, és alkalmazd a `marveen-fork-friendly-development` skillt.
2. Nézd meg a telepített CLI tényleges szintaxisát, például `himalaya envelope search --help`. Ne feltételezz elavult kapcsolókat.
3. A tiszta query-normalizálást és CLI-argumentum építést tedd új, kis TypeScript modulba. A felhasználói szöveget soha ne shell-stringként fűzd össze. `execFile` argumentumtömböt és a DSL saját idézett stringértékét használd.
4. Korlátozd és trimeld a bemenetet. A backend csak engedélyezett keresési mezőket és operátorokat állítson elő.
5. A meglévő envelope végpontot additívan bővítsd opcionális paraméterrel. Az üres query változatlanul a régi listázási útvonalat használja.
6. Frontenden `AbortController` és monoton request ID együtt védje ki, hogy egy régi válasz felülírja az új mailbox vagy query eredményét.
7. Fiók- vagy mappaváltáskor töröld a keresési állapotot. Üres keresőmezőnél állítsd vissza a normál listát.
8. Minden új label, placeholder, üres állapot és hibaüzenet egyszerre kerüljön a HU és EN nyelvi fájlba. Futtasd az `i18n-final-verification` skillt.
9. Adj unit tesztet a query normalizálására, maximális hosszára és az idézés/injection elleni argumentumképzésre.
10. Az élő checkout tesztvédőjét ne kerüld meg. Készíts ideiglenes izolált checkoutot, másold át az érintett fájlokat, linkeld a meglévő `node_modules` könyvtárat, majd futtasd a célzott teszteket, typechecket és syntax-checket.
11. A feladatot `waiting` állapotba tedd, kérj formális jóváhagyást, és csak ellenőrzött jóváhagyás után legyen `done`.

## Buktatók

- A `himalaya envelope list` nem keres. Az aktuális CLI-ben külön `envelope search` parancs és query DSL lehet.
- A shell-escape nem azonos a Himalaya DSL string-idézésével. A query értékét a DSL számára idézd, miközben továbbra is külön `execFile` argumentum marad.
- Csak `AbortController` nem elég minden időzítésnél. A request ID ellenőrzés legyen második védelem.
- Ne futtasd a teszteket az élő telepítésen, ha a suite ezt tiltja. Az izoláció biztonsági garancia, nem akadály.
- Ne commitolj idegen, párhuzamos módosításokat. Stage-elj explicit fájllistával.
- Élő kereső/UI-elrendezést leíró hangüzenetek (pozíció, "lenyíló vagy fix panel", "melyik oszlopot érintse") nagyon félreérthetők -- {{OWNER_NAME}} 2026-08-09 ugyanazt a keresőt 3x korrigálta menet közben (mező- vs postafiók-szerinti szűrés; lenyíló dropdown vs mindig-látható fix panel; a levéllista/-olvasó oszlop NE változzon gépeléskor, csak kattintásra). Ha egy hangüzenet-sorozat vizuális elrendezést ír le, építsd meg amit pontosan hallasz (pozíció, "fix" vs "lenyíló", melyik meglévő elem NE mozduljon), majd egy tömör összefoglalóval jelezd mit értettél -- ne találgass tovább a saját logikád szerint "elegánsabb" megoldás felé.
- Bevált minta innentől: a keresési találatokat egy ELKÜLÖNÍTETT, mindig jelenlévő panelbe írd (nem popup, nem a fő listát felülíró szűrés) -- a fő lista/olvasó oszlopok kizárólag tényleges kattintásra változzanak, sosem gépelés közben.
- A panel véglegesített formája (több kör után): `position:absolute` (SOSEM tolja lejjebb a lenti oszlopokat, hiába nő/csökken), tartalom szerint dinamikus magasság (nem fix px), és CSAK saját magán hoverelve nyílik ki (`max-height` CSS-átmenet a panelen magán) -- NE a keresőmezőn/gombon lévő hoverre kösd a megjelenését, mert a mező és a panel között lévő RÉS közben eltűnik a doboz, mielőtt az egér odaérne ({{OWNER_NAME}} 2026-08-09: "nem tudok rákattintani, mert leviszem a keresőgombtól és eltűnik"). A panel saját magát kell hogy hordozza hoverelhető felületként, nincs átugorható hézag.

## Ellenőrzés

- A célzott unit és CSS contract tesztek sikeresek izolált checkoutban.
- `npm run typecheck`, `npm run syntax-check` és `git diff --check` sikeres.
- A HU és EN email-kulcshalmaz azonos, minden használt kulcs mindkét fájlban szerepel.
- Üres query a normál mailbox-listát adja; keresés csak az aktív mappában fut; gyors query/mappaváltásnál régi válasz nem jelenik meg.
