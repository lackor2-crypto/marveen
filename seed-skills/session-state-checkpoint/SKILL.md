---
name: session-state-checkpoint
description: Mentsd ki a munkád strukturált állapotát MIELŐTT a kontextus elveszik. Használd task-határon (funkció kész, teszt zöld, commit megvan), hosszú feladat közben félidőben, és MINDIG mielőtt /clear-t vagy /compact-ot kérnél vagy elfogadnál. Trigger: "tisztítsd a kontextust", "tömörítés", commit után, több órás feladat, vagy ha a kontextusod a küszöb közelébe ér.
---
# Munkamenet-állapot checkpoint

## Mikor használd
- **Task-határon** (ez a legjobb pillanat): funkció elkészült, teszt zöld lett, commit megvan, egy rész-feladatot lezártál.
- **Mielőtt /clear-t vagy /compact-ot kérsz** vagy elfogadsz. A `/clear` NEM készít mentést semmiről.
- **Hosszú feladat közben**, ha félidőnél tartasz és sok döntés gyűlt össze.
- **Mielőtt kockázatos műveletbe kezdesz** (merge, migráció, service-újraindítás), hogy legyen hova visszatérni.

Nem kell checkpoint puszta beszélgetéshez vagy egy egylépéses kérdéshez.

## Miért
A tömörítés előtti automatikus mentés csak a tömörítéskor fut le. Ha a session máshogy hal meg (kézi `/clear`, kapu-vezérelt tisztítás, összeomlás, limitbe futás), akkor CSAK az van meg, amit előre kimentettél. Egy task-határon kimentett állapot már a lemezen van, bármi történik utána.

Amit a tömörítés elsőként elveszít: a döntések INDOKA, a már elvetett megközelítések, a felhasználó kikötései és a pontos számok. Ezért ezek külön mezőt kapnak.

## Eljárás
Egy hívás, a repo gyökeréből (`<agens>` a saját neved, pl. a munkamappád neve):

```bash
bash scripts/checkpoint-state.sh <agens> '{
  "objective":"a teljes feladat egy mondatban",
  "phase":"IMPLEMENTING",
  "summary":"amin epp dolgozom",
  "doneSteps":["mar kesz lepes -- ne ismeteld"],
  "alreadyDelegated":["mit kinek adtam at -- ne kuldd ujra"],
  "rejected":["mit probaltam es miert nem jo -- NE probald ujra"],
  "decisions":["mit dontottem es miert"],
  "constraints":["amit a felhasznalo kikotott"],
  "exactValues":["kuszob=150000","timeout=37 mp"],
  "filesChanged":["src/x.ts -- mit modositottam benne"],
  "openQuestions":["amire nincs valasz"],
  "nextAction":"az EGYETLEN kovetkezo konkret lepes"
}'
```

Minden mező opcionális, de a `nextAction` majdnem mindig kell. Hosszú JSON-t adhatsz STDIN-en is (`... | bash scripts/checkpoint-state.sh <agens> -`).

Ha a feladat TÉNYLEG befejeződött, töröld a rekordot, hogy ne játszódjon vissza feleslegesen:

```bash
bash scripts/checkpoint-state.sh <agens> --clear
```

## Buktatók
- **A `phase` értékei:** PLANNING | IMPLEMENTING | TESTING | DEBUGGING | BLOCKED | WAITING_USER. Bármi mást is elfogad, de ezekkel értelmezhető.
- **Ne prózázz és ne másolj be tool-kimenetet vagy fájl-tartalmat.** Egy elem legyen egy sor. A rendszer levág: listánként 25 elem, elemenként 300 karakter. A fájl a lemezen van, újra tudod olvasni.
- **A pontos számot SOHA ne kerekítsd.** A "37 másodperc" nem lehet "kb. 40 másodperc": ez pont az a hiba, amit az összefoglalók termelnek.
- **A rekord egyszer játszódik vissza** (consumed jelölés), és 12 óra után lejár. Ha félidőben újra checkpointolsz, az felülírja az előzőt és újra élesíti.
- **Ne írj közvetlenül a `store/agent-taskstate/` fájlokba.** A script validál (hibás JSON esetén ÜRES rekord keletkezne, ami csendben semmit nem játszik vissza) és ellenőrzi is a szerver válaszát.
- **Egy 200-as HTTP kód önmagában nem bizonyíték:** a script azt is megnézi, hogy a rekord tényleg tartalommal jött-e vissza. Ha `FAIL`-t látsz, a mentés NEM történt meg.

## Ellenőrzés
Nézd meg, mit kapnál vissza egy tömörítés után:

```bash
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:${MARVEEN_WEB_PORT:-3420}/api/agent-taskstate/<agens>/replay?source=compact"
```

A blokkban a kötött követelmények elöl, a KÖVETKEZŐ AKCIÓ leghátul kell legyen. Ha `additionalContext: null` jött vissza, akkor nincs mit visszajátszani: vagy üres a rekord, vagy már elfogyott (consumed), vagy lejárt.

## Kapcsolódó
- A teljes architektúra és a fázisok: `docs/context-compaction-knowledge.md`, kanban kártya 55af1bfe.
- A tömörítés előtti automatikus mentést a PreCompact hook végzi (`templates/settings.json.template`), matcher `auto|manual`.
