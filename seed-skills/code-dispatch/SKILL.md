---
name: code-dispatch
description: Programozási/fejlesztési feladat ÁTADÁSA a projekt saját VS Code Claude Code sessionjének a kód-hídon keresztül (POST /api/code/tasks), majd AZONNALI kilépés -- az eredményt a Claude Code küldi vissza közvetlenül, nem te. Akkor használd, ha {{OWNER_NAME}} kódot íratna/javíttatna egy konkrét projektben ("csináld meg a X projektben", "javítsd a Y-t a tradingbotban", "/code ..."). NE használd, ha a feladat nem kód, vagy ha nincs regisztrált session a projekthez.
---

# Kód-feladat átadása a VS Code Claude Code sessionnek

## Mi ez

Minden projektnek van egy **saját, hosszú életű VS Code Claude Code sessionje**
(előzmények, projekt-ismeret, korábbi döntések, workspace-kontextus benne).
A kód-híd (`/api/code/*`) sorba teszi a feladatot, a Windows-oldali worker
kiveszi, és **UGYANABBAN a sessionben** futtatja le (`claude -p --resume <sessionId>`).

**Te — akármelyik Marveen-ügynök vagy — csak feladod a feladatot, és kilépsz.**

Ez a készség a **közös** készségtárban lakik (`~/.claude/skills`, minden ügynök
oda van linkelve), tehát nem a fő ügynök kiváltsága: **bármelyik ügynök**
átadhat kódfeladatot a VS Code sessionnek. A végrehajtó ugyanaz marad, akárki
adja fel, és a sor egyszerre egy feladatot futtat — nem kell egyeztetned senkivel.

## Kemény szabályok

1. **NE hozz létre programozó AI-agentet.** Nincs sub-agent, nincs fleet-task,
   nincs delegálás -- a projekt sessionje maga a végrehajtó.
2. **NE várj az eredményre.** Ne pollozd a státuszt, ne aludj, ne nézd vissza.
   A feladat percekig is futhat; a te kontextusod nem erre való.
3. **NE tolmácsold az eredményt.** A kész-értesítés a Claude Code eredményéből
   megy ki közvetlenül a tulajdonosnak, programozottan, LLM nélkül. Ha te is
   összefoglalnád, az dupla üzenet + fölösleges tokenköltség.
4. **Egy rövid nyugta, aztán vége a körnek.** Pl. "Átadva: tradingbot (a1b2c3d4)".
5. **A `requestedBy` a SAJÁT ügynök-neved.** Az alábbi példában a fő ügynöké
   áll; ha te más vagy, írd át a sajátodra. Ebből látszik a Feladatok listában
   és a naplóban, ki kérte a feladatot — más nevében feladni félrevezető.
6. **A promptot SZÓ SZERINT add tovább.** Ne fogalmazd át, ne rövidítsd, ne
   egészítsd ki a saját értelmezéseddel -- a projekt sessionje jobban ismeri a
   kódot, mint te; a te parafrázisod csak információt veszít.

## Eljárás

### 1. Nézd meg, milyen projektek vannak

```bash
TOKEN=$(cat {{PROJECT_ROOT}}/store/.dashboard-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:{{WEB_PORT}}/api/code/projects | python3 -m json.tool
```

Az alias alapból a workspace mappaneve (kisbetűs). A feladást elég az alias
egyértelmű elejével/részletével címezni (`trading` -> `tradingbot`); ha több
projektre illik, a híd hibát ad vissza a jelöltekkel -- olyankor kérdezz vissza,
NE találgass.

### 2. Add fel a feladatot

```bash
TOKEN=$(cat {{PROJECT_ROOT}}/store/.dashboard-token)
curl -s -X POST http://127.0.0.1:{{WEB_PORT}}/api/code/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"project":"tradingbot","prompt":"IDE JON SZO SZERINT A FELADAT","origin":"agent","requestedBy":"{{MAIN_AGENT_ID}}"}
JSON
```

A válasz `201` + a feladat rekordja (`id`, `project`, `status: queued`).
Hiba esetén `400` + `error` (pl. `unknown project` a jelöltekkel) -- ilyenkor
mondd meg a tulajdonosnak, mi volt a baj, és NE próbálkozz másik projekttel.

Ha a promptban idézőjel/újsor/backtick van, a fenti heredoc-os forma
(`-d @-` + `<<'JSON'`) a biztonságos: a shell semmit nem helyettesít benne.
Nagyon hosszú prompthoz írd fájlba és `-d @/tmp/task.json`.

### 3. Nyugtázd, és lépj ki

Egy sor a tulajdonosnak (magyarul, rövid azonosítóval), és **fejezd be a kört**.
Ne hívj több eszközt, ne kérdezz rá a státuszra.

## Mit NEM csinál a híd

- **Nem nyit új sessiont**, és nem forkol: mindig a projekt meglévő sessionjét
  folytatja. Ha egy projekthez nincs regisztrált session, a feladás hibázik --
  ilyenkor a workernek kell futnia a Windows-gépen, illetve a sessiont
  egyszer meg kell nyitni VS Code-ban abban a workspace-ben.
- **Nem futtat semmit a te gépeden/kontextusodban.**
- **Nem tud már futó feladatot leállítani.** Csak sorban álló (`queued`)
  feladat törölhető.

## Óvatosság

- **Soha ne add fel a feladatot annak a sessionnek, amelyikben ÉPP TE futsz**
  (a saját workspace-ed aliasa): az a saját beszélgetésedbe írna bele.
- A worker egyszerre EGY feladatot futtat; a többi sorban vár. Ez szándékos:
  két párhuzamos `--resume` ugyanarra a sessionre egymásra írná a naplót.
- Amíg egy feladat fut, a tulajdonos ne gépeljen abba a VS Code panelbe.

## Kapcsolódó

- Részletes üzemeltetés: `docs/code-bridge.md`
- Telegram-oldal: a dedikált kód-bot `/code`, `/status`, `/result`,
  `/projects`, `/cancel` parancsai -- azok TELJESEN kihagynak téged.
