# Mi valósult meg a context-management tudásanyagból, és mi nem

Készült: 2026-08-12, Segédmunkás (lackor3). Boss kérése: "vesd ossze ezt a
dokumentumot es amit tud a marveen hogy ez benne van e es hogy mi nincs benne
ami a pdf-be benne van. mukodik e? melyvizsgalat!"

A vizsgált anyag: `Kontextusgenerator_Marveenba.pdf` (52 oldal, 70 pont). Ez
UGYANAZ a szöveg, amit korábban Telegramon küldtél: már be van másolva a repóba
`docs/context-compaction-knowledge.md` néven, és a `55af1bfe` kanban kártya
követi a megvalósítását.

---

## A legfontosabb dolog, mielőtt a listát nézed

A dokumentum záró bekezdése azt írja, hogy a következő lépés megnézni, "hol
épül fel a messages/context tömb, hol számolja a tokeneket, hol történik a
Claude API-hívás".

**A Marveenben ilyen hely nincs.** Az ágensek maguk Claude Code programok; a
Marveen kívülről vezényli őket (tmux, hookok, a leiratok olvasása, `/compact`
és `/clear` parancsok). A beszélgetés-tömböt és az API-hívást a Claude Code
birtokolja, nem mi.

Ezért a 70 pont három csoportra esik szét:

1. **Megvalósítható kívülről** (mérés, küszöbök, checkpoint, validálás,
   strukturált állapot, memória, visszakeresés) — ebből épült meg a legtöbb.
2. **Csak részben, hookon vagy prompton keresztül** (a tömörítés MIT tartson
   meg, mikor fusson) — befolyásolni tudjuk, előírni nem.
3. **Kívülről nem megvalósítható** (L0/L1/L3 rétegek a modell kontextusán
   BELÜL, saját tömörítő prompt és tömörítő modell, aszinkron tömörítés,
   lost-in-the-middle sorrendezés). Ezekhez az ágenseket át kellene tenni az
   Agent SDK-ra, ahol mi írjuk a ciklust. Ez nagy, önálló döntés.

Aki azt mondja, hogy mind a 70 pont "beépíthető", az a 3. csoportról nem mond
igazat.

---

## Ami MEGVAN és működik

| Komponens (a PDF 66. pontja szerint) | Állapot | Hol van |
|---|---|---|
| **ContextMonitor** | megvan | `src/web/active-model.ts` (méret + miért nem mérhető), `context-restart-gate-runner.ts` (lágy küszöb), `context-guard-runner.ts` (kemény védelem 90%/97%), állapot: `store/context-restart-gate-status.json`, látszik az ágens-kártyán |
| **StateStore** (5. pont, L2) | megvan, erős | `store/agent-taskstate/<agens>.json`: objective, phase, doneSteps, alreadyDelegated, **rejected**, **decisions**, **constraints**, **exactValues**, filesChanged, openQuestions, pendingDecision, **nextAction**. Ez majdnem pontosan a PDF PROJECT STATE sémája |
| **CheckpointManager** (23. pont) | megvan, DE hibás (lásd lentebb) | PreCompact hook a `templates/settings.json.template`-ben |
| **CompactionValidator** (24. pont) | megvan, féloldalas | `scripts/hooks/compaction-validator.py` (PostCompact). Kiírja mi maradt ki. **Javítani nem javít** |
| **Raw archive** (14. pont, L5) | megvan, más néven | a Claude Code leirat (`.jsonl`) append-only, semmi nem törli. Emellé: `conversation_log`, `daily_logs`, `tool_call_log`, ledger |
| **Döntés- és elvetett-megközelítés memória** (6-7. pont) | megvan | a taskstate `decisions` és `rejected` mezői + a memória-rendszer cold kategóriája |
| **Számok szó szerinti védelme** (10. pont) | megvan | a checkpoint `exactValues` mezője, és a validátor kifejezetten ezt ellenőrzi ("SOHA ne kerekíts") |
| **Git mint igazságforrás** (12. pont) | megvan | minden mérföldkő commit, a kártyákon a commit-azonosító |
| **Memória visszakeresés** (15-16. pont) | részben | SQLite + FTS5 + **BM25** rangsor, kulcsszó, kategória. A szemantikus fele halott, lásd a hibáknál |
| **Tömörítés a limit ELŐTT** (20. pont) | megvan | ágensenként állítható küszöb (nálam 80 ezer), a modell 200 ezres ablakához képest korán |
| **Tömörítés, nem törlés** (1. pont alapelve) | megvan | a kapu `/compact`-ot küld, `/clear`-t csak akkor, ha bizonyítottan nem segített a tömörítés |

---

## Ami NINCS meg

| Hiányzik | PDF pont | Mit jelent a gyakorlatban |
|---|---|---|
| **Tool-output kiszervezés** | 27-28., Phase 9 | Egy nagy fájl vagy parancs-kimenet teljes egészében a kontextusban ül a következő tömörítésig. Ez a legnagyobb egyszeri nyereség, és ez a következő tervezett lépés (F4) |
| **Javítás sikertelen tömörítés után** | 24. második fele | A validátor szól, hogy kimaradt valami, de nem szerzi vissza. Ma ezt kézzel kell |
| **Címezhető memória-azonosítók** | 17. | Nincs `DEC-017` stílusú hivatkozás a tömörített kontextusban, és nincs `retrieve_memory(id)` eszköz |
| **Hierarchikus tömörítés** | 19., Phase 10 | Egyetlen lapos tömörítés van, nem esemény -> epizód -> feladat -> projekt lánc |
| **Ellentmondás-figyelés, elavult adat jelölése** | 25., 31-32. | Ha egy régi döntést felülír egy új, semmi nem jelzi |
| **Feladathatárnál induló tömörítés** | 22., 46., Phase 11 | A kiváltó ok ma kizárólag a token-szám. A "feature kész + teszt zöld + commit -> tömörítés" nincs |
| **Recall-mérés, benchmark** | 36-38., Phase 12 | Semmi nem méri, hogy egy tömörítés után mennyi információ maradt meg |
| **Négyfokozatú küszöb** | 20. | Van lágy (token) és kemény (90%/97%), de nincs figyelmeztető/előkészítő/agresszív fokozat |
| **Saját tömörítő prompt és tömörítő modell** | 9., 33-34. | A Claude Code birtokolja. A PreCompact hook prompt csak részben pótolja |

---

## Hibák, amiket a vizsgálat találott

### 1. A tömörítés előtti checkpoint HIBÁRA FUT (súlyos)

A PreCompact hook "agent" típusú, és a Claude Code ezt visszautasítja:

```
failed: Agent stop hooks are not yet supported outside REPL
```

Mérés a flotta leiratain: **10 ilyen hiba, 5 különböző ágensnél** (lackor3: 6,
lagunaxs, ling, nemotronsuper, north: 1-1). Ez a PDF 23. pontja, szó szerint:
"checkpoint -> compact, és ne: compact -> reméljük, hogy minden megmaradt".

Amikor elbukik, ez marad el: a memória-mentés, a skill-reflexió ÉS a
strukturált állapot mentése. Vagyis pont az, ami miatt a tömörítés
biztonságos lenne.

Enyhítő körülmény: a strukturált állapot fájlja a korábbi kézi mentésekből
megmarad, és a PostCompact validátor észreveszi, ha valami kimaradt. De ez
utólagos vigasz, nem megoldás.

### 2. A szemantikus memória-keresés halott

A kód kész (embedding oszlop, Ollama-hívás, koszinusz-hasonlóság), de:

```
memories: 110
embeddinggel: 0
```

Nulla. Az Ollama nincs elérhető úton, tehát a keresés csendben BM25-only. A
PDF 16. pontja pont ezt a fél megoldást kifogásolja. Nem hiba a kódban, hanem
egy soha be nem kapcsolt függőség — és semmi nem mondja meg a felhasználónak.

### 3. A küszöb nem plafon (a te kérdésed)

"ha be van kapcsolva az automata tömörítés akkor nem is mehetne feljebb mint a
beallitott ertek! jelenleg 80 ezer. akor megis hogy ment feljebb?"

Három oka volt, kettő ma este megszűnt:

1. A tömörítés CSAK tétlen ágensen futhat le. Ha folyamatosan dolgozom, a szám
   nő, és a kapu minden körben azt írja: `pane-busy (mid-turn, not safe)`.
   Ez szándékos: egy munka közben elindított tömörítés félbevágja a fordulót.
2. A kapu 5 percenként nézett rá. Ha pont akkor dolgoztam, újabb 5 perc.
   **Ma este átállítva: a küszöb fölött percenként néz rá.**
3. A mérés három ágensnél egyáltalán nem működött, tehát náluk sosem indult el.
   **Ma este javítva** (commit b4d6dbc).

Ami marad: a küszöb egy CÉLÉRTÉK, nem plafon. Igazi plafon a kemény védelem
(a modell ablakának 90%-a), az viszont durvább eszköz. A PDF 20. pontja is
pontosan így, sávokban gondolkodik.

---

## Amit ma este ebből meg is csináltam

- A kézi Tömörítés gomb utókövetése: ha a tömörítés után a kontextus MÉG MINDIG
  a beállított érték fölött van, a rendszer újra tömörít. Legfeljebb két extra
  kör, és leáll, ha egy kör alig mozdított a számon (`decideFollowUp`).
- A kapu a küszöb fölött percenként ellenőriz.
- A kontextus-mérés javítása (rossz leirat + friss munkamenet félreértelmezése).

## Amit ebből érdemes legközelebb megcsinálni, ebben a sorrendben

1. **A PreCompact checkpoint hibájának javítása.** Ez már meglévő funkció, ami
   nem fut le. A legrosszabb fajta hiba: a rendszer azt hiszi, védve van.
2. **Tool-output kiszervezés** (F4). A legnagyobb token-megtakarítás.
3. **Javítás validálás után**: ha a validátor talál hiányt, szerezze vissza a
   leiratból, ne csak jelentse.
4. **Szemantikus keresés**: vagy kapcsoljuk be az Ollamát, vagy mondjuk meg a
   felületen, hogy ez a funkció nincs bekapcsolva.
5. **Feladathatárnál tömörítés**: a commit + zöld teszt jó pillanat, sokkal jobb
   mint egy szám átlépése munka közben.
