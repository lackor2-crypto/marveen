---
name: kanban-approval-workflow
description: Amikor egy kanban kártyához tartozó munka elkészült és sikeresen le lett tesztelve (élesben kipróbálva), ugyanabban a lépésben: (1) git commit helyben, (2) kártya waiting-be, (3) azonnal jóváhagyás-kérés az API-n, (4) Telegram-jelzés Bossnak. Egyik lépés se maradjon ki és ne csússzon későbbre.
---

# Kanban -> tesztelés -> jóváhagyás -> commit

## Mikor használd

Trigger: egy kártyához tartozó fejlesztői munka KÉSZ és SIKERESEN TESZTELVE
(élesben kipróbálva, működik). Ez az a pillanat, ahol korábban két hiba is
történt (Boss 2026-08-05 este észlelte mindkettőt):
1. a kártya "waiting"-be került, de jóváhagyás-kérés nélkül maradt ott --
   Bossnak kellett észrevennie és szólnia
2. a kész, tesztelt kódváltozás órákig/napokig commit nélkül maradt a
   munkakönyvtárban, csak külön rákérdezésre lett commitolva

## Munka INDÍTÁSAKOR (nem csak záráskor)

**Hiba (2026-08-06):** egy kártyához (imapflow/IMAP body-fetch terv) a tervezés
után Boss rábólintott ("csinald"), elkezdtem az implementációt, de a kártya
"planned" állapotban maradt -- Boss kérdezte rá: "elvileg most folyamatban
van a munka de megsem tetted at a folyamatban mappaba. miert?"

**Szabály:** amint egy kártyához (akár a tervezés/jóváhagyás UTÁN) ténylegesen
elkezdesz dolgozni -- ez az ELSŐ lépés, MIELŐTT bármi kódot írnál/futtatnál:
```bash
curl -s -X POST "http://localhost:3420/api/kanban/<id>/move" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"status":"in_progress","sort_order":0,"actor":"<agent_id>"}'
```
Ez ugyanúgy vonatkozik akkor is, ha a kártya korábban "planned"-ben volt egy
külön tervező-kör után -- a tervezés önmagában NEM viszi automatikusan
"in_progress"-be, a tényleges implementáció-kezdés igen.

## Tesztelés fázis (Boss, 2026-08-06)

Amikor a kódolás/implementáció kész és rákezdesz a tesztelésre (unit tesztek
futtatása, élő ellenőrzés, stb.): MIELŐTT elkezdenéd a tesztelést, told a
kártyát "testing" státuszra (ÉS státusz létezik a kanban rendszerben,
külön a "waiting"-től):
```bash
curl -s -X POST "http://localhost:3420/api/kanban/<id>/move" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  -d '{"status":"testing","sort_order":0,"actor":"<agent_id>"}'
```
Amikor a tesztelésnek VÉGE (sikeres vagy sikertelen, de lezárult), told
"waiting"-re (a lenti fő eljárás szerint, jóváhagyás-kéréssel együtt).
Tehát a teljes út egy tipikus kártyán: planned -> in_progress (munka
kezdetekor) -> testing (teszt/ellenőrzés kezdetekor) -> waiting (teszt
után, jóváhagyásra várva) -> done (csak Boss jóváhagyása után).

## Eljárás

Amint a teszt sikeres, EGY menetben, ne szét-szórtan:

0. **Hibakeresés a logban, MIELŐTT bármit "késznek" jelentesz** (Boss
   2026-08-06, kötelező szabály: "amikor programozol valamit, a végén
   bármilyen kicsi is, indíts egy hibakeresést"). Ha a munka egy futó
   szolgáltatást érint (dashboard/web/channels), újraindítás/deploy UTÁN
   fésüld át a friss logot ÚJ, VÁRATLAN hibáért -- ne csak azt nézd amit
   direkt tesztelni akartál:
   ```bash
   grep -iE "ERROR|uncaught|exception|TypeError|undefined is not|Cannot read" store/dashboard.log | tail -40
   ps -p $(cat store/claudeclaw.pid) -o pid,etime,cmd   # még fut, nem crashelt
   ```
   Ha `web/app.js`-t (vagy bármelyik böngészőben futó JS-t) szerkesztettél,
   ez a log-nézés NEM ELÉG -- egy szintaktikai hiba a frontend JS-ben
   NEM jelenik meg sehol a szerver logban (a szerver csak statikus fájlt
   szolgál ki, 200-at ad rá, minden "rendben" onnan nézve), viszont a
   böngészőben az EGÉSZ oldal JS-e leáll, semmi gomb/menü nem reagál.
   KÖTELEZŐ, minden app.js-szerkesztés után, MIELŐTT szólsz Bossnak:
   ```bash
   node --check web/app.js
   ```
   (2026-08-06: pont ez történt -- egy duplikált `const` deklaráció miatt
   az egész menü használhatatlanná vált, Boss vette észre, nem én.)
   Ha ismert, már dokumentált hibát látsz (pl. a Gmail IMAP throttling),
   azt szűrd ki és NE tévezd össze új hibával -- de mindig NÉZD MEG előbb,
   ne feltételezd hogy nincs semmi új.
1. **Commit helyben** (nem push!) -- a kész, tesztelt változtatást azonnal
   mentsd git commitba, sima leíró üzenettel. Ez akkor is véd, ha a kártya
   jóváhagyása később történik, vagy ha közben újraindul a session.
   ```bash
   git add <érintett fájlok>
   git commit -m "..."
   ```
2. **Kártya -> waiting**
   ```bash
   curl -s -X POST "http://localhost:3420/api/kanban/<id>/move" \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     -d '{"status":"waiting","sort_order":0,"actor":"<agent_id>"}'
   ```
3. **Jóváhagyás-kérés AZONNAL, ugyanitt** (ne várj arra hogy Boss rákérdezzen)

   **KÖTELEZŐ: `action_payload` benne legyen a kártya id-vel!** (Boss,
   2026-08-06: "a jóváhagyás gomb az tegye át kézbe, mert nem került át" --
   kiderült hogy az automata kártya→done mozgatás MÁR LÉTEZIK a szerverben
   (`src/web/routes/approvals.ts`, a PATCH resolve-ág), DE csak akkor fut le,
   ha az approval `action_payload` mezője tartalmazza
   `{"kanban_card_id":"<id>"}`-t. Ha ez hiányzik -- ahogy korábban minden
   kézi approval-kérésemből hiányzott -- Boss jóváhagyás-gombja csendben
   nem csinál semmit a kártyával, nekem kell utólag észrevennem és kézzel
   áttolnom. `action_payload` egy JSON-STRING legyen (nem objektum).):
   ```bash
   curl -s -X POST http://localhost:3420/api/approvals \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     -d '{"agent_id":"<agent_id>","category":"kanban_done","action_description":"Kártya: <cím> (<id>) - mit csinál, hogyan lett tesztelve. Jóváhagyás után viheto done-ra.","action_payload":"{\"kanban_card_id\":\"<id>\"}","timeout_seconds":86400}'
   ```
4. **Telegram-jelzés** -- rövid emberi nyelvű üzenet Bossnak, hogy mi készült
   el, mi lett tesztelve, és hogy jóváhagyásra vár.

A push GitHub-ra ettől független, KÜLÖN engedély kell hozzá mindig -- ezt a
lépést a fenti négyes NEM tartalmazza automatikusan.

## Kapcsolódó szabályok

- [[kanban-done-requires-approval]] -- done-ra csak jóváhagyás után, soha
  magadtól.
- [[kanban-immediate-approval-request]] -- a jóváhagyás-kérés a waiting-be
  vitellel egy lépésben történjen, ne később.

## Buktatók

- Ha egyszerre több kártya is készen van, mindegyikhez KÜLÖN jóváhagyás-kérés
  kell, ne vonj össze többet egybe -- Boss egyenként dönt.
- A commit üzenet legyen tényleges, konkrét (mi változott, miért), ne
  általános "fixes" vagy "update" szöveg.

## Ellenőrzés

- [ ] Lefutott a hibakeresés a friss logon (0. lépés), új/váratlan hiba nélkül
- [ ] A kész, tesztelt változás benne van egy git commitban (helyi)
- [ ] A kártya "waiting" állapotban van
- [ ] Van hozzá pending approval bejegyzés (GET /api/approvals ellenőrzi)
- [ ] Boss kapott róla Telegram-üzenetet
