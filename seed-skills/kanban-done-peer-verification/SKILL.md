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
   ugyanazt a területet (pl. egy korábbi fix-et {{OWNER_NAME}} egy KÉSŐBBI
   kérése felül is írt), olvasd el mindkettő teljes commit-üzenetét (`git show
   <hash> --stat`) -- {{OWNER_NAME}} legfrissebb kérése az irányadó, ne a
   korábbi.
2. **Olvasd el a tényleges kódot**, ne csak a commit-üzenetet: `Read`/`grep`
   a releváns fájlokra, és vesd össze a commit állítását a kóddal (pl. "a
   `<details>` `open` nélkül van" -- nézd meg tényleg nincs-e `open`).
2b. **Olvasd el a kártya TELJES komment-történetét, ne csak a legutolsót.**
   Egy korábbi komment gyakran explicit "AMI NYITVA MARAD" / "nem javítottam"
   listát hagy hátra egy adott, konkrét hibáról -- ha a LEGUTOLSÓ (a kérést
   kiváltó) komment ezt nem említi, az NEM jelenti, hogy megoldódott. Nézd meg
   FRISSEN a kódban, hogy a korábban jelzett nyitott hiba tényleg javítva
   van-e. Valós eset (2026-09-02): egy korábbi komment explicit jelezte, hogy
   a szerver hibaválaszai gépi angol kódot adnak vissza `message` mező
   nélkül (sérti a fresh-install-usable/user-is-not-a-programmer szabályt) --
   a kártyát `waiting`-be mozgató belső ellenőrzés ezt nem említette, de a
   friss `grep` igazolta: a hiba MÉG MINDIG ott volt.
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
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
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
  dönt, és {{OWNER_NAME}} legutolsó kérése az érvényes elvárás.
- Ha egy ellenőrzéshez elkerülhetetlen lenne egy író hívás, NE tedd meg --
  írd le a jelentésben, mit nem tudtál így ellenőrizni, és jelöld `status:
  fail`-nek vagy magyarázd meg a hiányt a `report`-ban, ne találgass.
- **Ne bízz a kártya korábbi kommentjeiben állapotként** -- a kommentek egy
  MÚLTBELI pillanatot rögzítenek (pl. "stale backend, nem jó a build"), de
  azóta új commit/rebuild/restart történhetett. A `recheck-before-restating`
  elvét itt is alkalmazd: mérd meg FRISSEN (git log commit-időbélyeg vs.
  `dist/**` fájl mtime vs. a futó process induló ideje), és csak a saját friss
  mérésedet írd a `report`-ba -- ha eltér a komment állításától, azt is jelezd.
  Valós eset (2026-09-02): egy korábbi komment "stale backend"-et jelzett, a
  friss mérés (dist mtime + futó process induló ideje + élő GET-hívás)
  igazolta, hogy a build és a restart azóta megtörtént -- a komment elavult
  volt, nem a jelenlegi állapot.
- **Futó process megtalálásához `ss -tlnp | grep <port>` megbízhatóbb, mint
  `pgrep -f`** -- a `pgrep -f "node.*dist/web"`-szerű minta rááll a SAJÁT
  shell-parancsodra is (ha a parancssorodban szerepel hasonló szöveg), és egy
  bash-wrapper processzt ad vissza a tényleges node-process helyett. A port
  alapján keresés egyértelmű.
- **API GET-hívásnál a param-nevet OLVASD KI a forrásból, ne találd ki** -- egy
  rossz param-név gyakran félrevezető hibaüzenetet ad vissza (pl. "session is
  required", ami úgy néz ki, mintha a session nem létezne, holott csak a
  paraméter neve rossz). Egy ilyen hibaüzenet önmagában NEM bizonyíték
  semmire -- grep-eld ki a hibaszöveget a forrásból, és a helyes paraméterrel
  próbáld újra, mielőtt bármilyen következtetést levonnál belőle.

## Ellenőrzés

- A `verify-result` POST válasza `{"ok":true}` -- ez jelzi, hogy a
  jóváhagyás rendszere ténylegesen fogadta a jelentést, nem csak az
  inter-agent üzenet ment el.
- A jelentés (`report`) tartalmazza: mit néztél meg (fájl/sor), milyen
  tesztet futtattál és milyen eredménnyel, és ha volt korlátozás (nem
  futtattad a teljes suite-ot), azt is.

## Ha a saját FAIL-edre javítási feladatot kapsz (más mód, nem csak-olvasó)

Egy `fail` után {{OWNER_NAME}} eldöntheti, hogy a JAVÍTÁST is a te ágensedre
bízza -- ez explicit szövegben jön ("Javitasi feladat... kodot IRHATSZ",
"LANDOLAS: szabad kezed van"), és MÁS mint a fenti csak-olvasó eljárás:
kódot írhatsz, izolált worktree-ben (`git worktree add -b <ag>-<kartya>-<tema>
<path> HEAD`), a végén KÖTELEZŐ a TELJES `npx vitest run` + `npx tsc --noEmit`
zöld, és ha zöld, önállóan COMMITOLHATSZ és LANDOLHATSZ a main-re -- nem kell
review-ra várni. Csak akkor `verify-result: pass`, ha a teljes suite (nem csak
a célzott fájlok) zöld volt.

**Ütközés-elhárítás:** ha KÖZBEN a kártyát eredetileg mozgató ágens (aki a
`fail`-t kapta tőled) jelzi, hogy ő is nekiáll ugyanennek a javításnak
("megjavitom, kerlek ujra-verifikalj"), AZONNAL szólj neki inter-agent
üzenettel, hogy {{OWNER_NAME}} már közvetlenül neked adta a javítást, és NE
dolgozzon rá -- két ágens ugyanarra a fájlra írt párhuzamos commitja néma
felülírás/ütközés kockázata. Valós eset (2026-09-03, kártya `2f7b6d4f`): a
delegálás és a kolléga saját kezdeményezésű "megjavitom" üzenete percek
különbséggel érkezett -- a korai, tiszta leállító üzenet előzte meg, hogy két
worktree-ben párhuzamosan íródjon ugyanaz a két fix.

A javítás után: (1) `verify-result` a MÁR MEGLÉVŐ approval-ra (ugyanaz az id,
amit a `fail`-hez is használtál), `status:"pass"`, a `report`-ban a commit
azonosítójával; (2) kanban komment a kártyára, mi lett javítva és melyik
commit; (3) inter-agent üzenet a delegáló ágensnek a commit id-vel.
