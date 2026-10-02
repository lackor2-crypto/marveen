---
name: card-done-to-waiting
description: KÖTELEZŐ minden ágensnek ÉS minden VS Code / kód-híd sessionnek, amikor egy kanban kártyán dolgozik. A kártya oszlopát TE viszed -- in_progress -> testing (amint a tesztelésbe kezdesz) -> waiting (amint kész/landolt, UGYANABBAN a lépésben). Csak előre; waiting-ből vissza soha kérdés nélkül, done-ba soha. Trigger -- kártyán végzett munka tesztelése vagy befejezése, land-pr.sh után, "kész"-jelentés előtt.
scope: global
---

# Kész kártya: testing -> waiting, azonnal

## Miért van ez a skill

2026-09-24: a #358 és a #359 munkáját egy VS Code (kód-híd) session
megcsinálta és landolta (PR #295, #296), a kártyák mégis `in_progress`-ben
ragadtak. {{OWNER_NAME}}nak kellett rákérdeznie: "ha megcsináltad, miért nem
teszed át a várakozikba?"

A gyökérok NEM feledékenység volt: a kód-híd előhangja (a dashboard által
minden VS Code-feladat elé fűzött szöveg, `src/web/code-task-preamble.ts`)
szó szerint azt írta: "Kanban kártyát ne mozgass." -- és a session
engedelmeskedett, felülírva a `kanban-approval-workflow` skillt. Ez a
mondat ki lett véve; a 7. pont most kifejezetten a végrehajtó dolgává teszi
az oszlopot.

Tanulság: ha egy feladat-szöveg vagy előhang ELLENTMOND egy rögzített
szabálynak (itt: "kész kártya a waitingbe"), azt ne csendben kövesd --
mondd ki az ellentmondást a záró összefoglalóban.

## A kártya útja

```
planned -> in_progress -> testing -> waiting -> done
           (munka indul)  (teszt    (kész,     (CSAK a
                           indul)    landolt)   tulajdonos)
```

1. **testing** -- amint a kód kész és nekiállsz a tesztelésnek (vitest, tsc,
   kipróbálás). Nem a teszt UTÁN, hanem az ELEJÉN.
2. **waiting** -- amint a munka kész (a PR landolt, a CI zöld, a kész-jelzést
   megírod). UGYANABBAN a lépésben, nem a session végén. A waiting-be lépés
   magától jóváhagyás-kérést nyit a tulajdonosnak.
3. **done** -- SOHA te. Azt csak a tulajdonos.

## A waiting-be CSAK kész kártya mehet

2026-10-02: egy kártya (#462) a várakozóba került, pedig csak az egyik
lépése készült el. A tulajdonos: mielőtt bárki bármit a várakozóba tesz,
ellenőrizze az ÖSSZES pontot; ha valami nyitott, a kártya marad, és a munka
megy tovább.

Mielőtt `waiting`-be tolod, nézd végig a kártya MINDEN pontját: a leírást, a
lépéseket, a kommentekben kért dolgokat és az alfeladat-kártyákat. Ha akár egy
is nyitott (például a te feladatod a kártyának csak egy lépése volt), a kártya
NEM megy `waiting`-be -- marad, ahol van, és megmondod, mi van még hátra. Egy
fél-kész kártya a várakozóban hazugság a táblán.

Ezt a szerver ki is kényszeríti:

- a `waiting`-be mozgató kérésbe bele kell írnod: `"all_points_done": true`
  -- ezzel mondod ki, hogy mindent leellenőriztél. Nélküle a válasz
  `409 completion_unconfirmed`;
- nyitott alfeladat-kártya mellett a válasz `409 open_subtasks`, és
  felsorolja, melyik nyitott. Ilyenkor nem a kérést kell ügyesebben megírni,
  hanem az alfeladatot befejezni.

Csak ELŐRE. Ha a kártya már `waiting`-ben vagy `done`-ban áll, NE mozgasd
vissza (a kilépés a waitingből visszavonja a függő jóváhagyást) -- a munkát
mozgatás nélkül is elvégezheted, kommentet írsz a kártyára. Visszafelé csak
külön kérdés és válasz után.

## Hogyan

```bash
ROOT=<a Marveen telepítés gyökere>     # nem worktree: ott nincs store/
T=$(cat "$ROOT/store/.dashboard-token")
BASE=http://localhost:3420            # a telepítés saját WEB_PORT-ja

# sorszám (#N) -> id
curl -s -H "Authorization: Bearer $T" "$BASE/api/kanban/card-ids" \
  | python3 -c "import json,sys; [print(c['id']) for c in json.load(sys.stdin) if c['seq']==N]"

# mozgatás testing-be
curl -s -X POST "$BASE/api/kanban/<id>/move" \
  -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"status":"testing","sort_order":0,"actor":"<ki vagy>"}'

# mozgatás waiting-be -- CSAK ha minden pontja kész, és ezt ki is mondod
curl -s -X POST "$BASE/api/kanban/<id>/move" \
  -H "Authorization: Bearer $T" -H "Content-Type: application/json" \
  -d '{"status":"waiting","sort_order":0,"actor":"<ki vagy>","all_points_done":true}'
```

Utána OLVASD VISSZA (`GET $BASE/api/kanban/<id>`), hogy tényleg ott áll -- a
`{"ok":true}` nem bizonyíték arra, hogy a tábla mit mutat.

Ha a hívás nálad nem fut le (más gépen vagy, nem éred el a címet): ne
kerülgesd, a pontos hibaüzenetet írd a záró összefoglalóba, és mondd ki,
hogy a kártya NEM került át.

## Ellenőrzőlista a "kész" előtt

- [ ] a kártya `testing`-ben volt a teszt alatt
- [ ] a kártya MINDEN pontját végignézted (leírás, lépések, kommentek,
      alfeladat-kártyák), és egyik sem nyitott -- ha igen, NEM megy waiting-be
- [ ] landolt (PR MERGE-ELVE sor), és a kártya most `waiting`-ben áll --
      visszaolvasva
- [ ] a záró üzenetben a kártya sorszámmal (#N) szerepel, nem belső id-vel
