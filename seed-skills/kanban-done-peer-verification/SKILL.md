---
name: kanban-done-peer-verification
description: Amikor egy másik ágens ellenőrzési feladatot küld egy fuggo `kanban_done` jóváhagyásra (trusted-peer üzenet, `verify-result` kéréssel) -- hogyan végezd el a csak-olvasó ellenőrzést és hogyan jelentsd vissza.
scope: global
---

# Kanban-done fuggo jóváhagyás peer-ellenőrzése

## Mikor használd

Trigger: egy `<trusted-peer>` üzenet érkezik egy másik ágenstől, `category:
kanban_done` jóváhagyás ellenőrzését kéri, és `verify-result` POST-tal kell
visszajelenteni (`agent`, `status: pass|fail`, `report`). A cél: {{OWNER_NAME}}
elé csak olyan `done`-ra váró kártya kerüljön, amit egy MÁSIK ágens is
tényszerűen ellenőrzött -- ne csak a kártyát mozgató ágens saját állítására
támaszkodjunk. Kapcsolódó: [[kanban-approval-workflow]] (a kérő oldal),
[[verify-via-live-pane-before-diagnosing]] (az élő-mérés elve).

## Eljárás

1. **Azonosítsd a kártyát és a releváns commitokat.** A jóváhagyás leírása
   megnevezi a kártyát (pl. `95a1a07b`) -- `git log --oneline -- <érintett
   fájlok>` a commit-történet felderítéséhez. Ha TÖBB commit is érinti
   ugyanazt a területet (pl. egy korábbi fix-et egy KÉSŐBBI Boss-kérés felül
   is írt), olvasd el mindkettő teljes commit-üzenetét (`git show <hash>
   --stat`) -- a legfrissebb Boss-kérés az irányadó, ne a korábbi.
2. **Olvasd el a tényleges kódot**, ne csak a commit-üzenetet: `Read`/`grep`
   a releváns fájlokra, és vesd össze a commit állítását a kóddal (pl. "a
   `<details>` `open` nélkül van" -- nézd meg tényleg nincs-e `open`).
3. **Csak-olvasó teszt-futtatás izolált worktree-ben.** A cél NEM az élő
   rendszer módosítása. Ha van már a jóváhagyás commitjához tartozó worktree
   (`git worktree list`), használd azt; ha nincs, hozz létre egyet, DE ne
   dolgozz benne írva -- csak `npx vitest run <releváns teszt-fájlok>` és
   `npx tsc --noEmit`. Válaszd ki a releváns tesztfájlokat a módosított
   területek alapján (pl. lang-fájl változott -> `lang-parity` +
   `i18n-no-hardcoded-hu`), ne feltétlenül a teljes suite-ot -- ha a commit
   már állít egy teljes-suite eredményt, elég a releváns részhalmazt
   újrafuttatni, és a jelentésben jelezd, hogy nem a teljeset futtattad.
4. **Jelentsd vissza a KÖTELEZŐ `verify-result` hívással**, ne csak
   inter-agent üzenettel -- az üzenet önmagában nem zárja le a fuggo
   jóváhagyást a dashboardon:
   ```bash
   curl -s -X POST http://localhost:3420/api/approvals/<approval_id>/verify-result \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat /home/boss/marveen/store/.dashboard-token)" \
     -d '{"agent":"<sajat_agent_id>","status":"pass","report":"rovid, tenyszeru osszefoglalo"}'
   ```
   `status: fail` -- ha bármi eltér az állítástól; a `report`-ban KONKRÉTAN
   mi hibás, ne csak "nem jó".

## Buktatók

- **TILOS bármilyen állapotváltoztató hívás** az élő rendszeren (POST/PUT/
  PATCH/DELETE) a `verify-result` híváson kívül -- ez a peer-review
  read-only jellegű, "csak kipróbálom" hívás valódi kárt okozhat (lásd a
  2026-08-24-i eset: egy próba átállította a dashboard jelszavát).
- Ha egy kártya története TÖBB, egymást felülíró javítást tartalmaz (pl.
  "nyisd meg alapból" -> később "zárd vissza alapból, de tedd
  kijelölhetővé"), NE az elsőt vedd mérvadónak -- a `git log` időrendje
  dönt, és a legutolsó Boss-kérés az érvényes elvárás.
- Ha egy ellenőrzéshez elkerülhetetlen lenne egy író hívás, NE tedd meg --
  írd le a jelentésben, mit nem tudtál így ellenőrizni, és jelöld `status:
  fail`-nek vagy magyarázd meg a hiányt a `report`-ban, ne találgass.

## Ellenőrzés

- A `verify-result` POST válasza `{"ok":true}` -- ez jelzi, hogy a
  jóváhagyás rendszere ténylegesen fogadta a jelentést, nem csak az
  inter-agent üzenet ment el.
- A jelentés (`report`) tartalmazza: mit néztél meg (fájl/sor), milyen
  tesztet futtattál és milyen eredménnyel, és ha volt korlátozás (nem
  futtattad a teljes suite-ot), azt is.
