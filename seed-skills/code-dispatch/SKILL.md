---
name: code-dispatch
description: Programozási/fejlesztési feladat ÁTADÁSA a projekt saját VS Code Claude Code sessionjének a kód-hídon keresztül (POST /api/code/tasks), majd AZONNALI kilépés -- az eredményt a Claude Code küldi vissza közvetlenül, nem te. Akkor használd, ha {{OWNER_NAME}} kódot íratna/javíttatna egy konkrét projektben ("csináld meg a X projektben", "javítsd a Y-t a tradingbotban", "/code ..."), vagy ha azt kéri, listázd ki a VS Code chat füleket. NE használd, ha a feladat nem kód, vagy ha nincs regisztrált session a projekthez.
scope: global
---

# Kód-feladat átadása a VS Code Claude Code sessionnek

## Mi ez

Minden projektnek van egy **saját, hosszú életű VS Code Claude Code sessionje**
(előzmények, projekt-ismeret, korábbi döntések, workspace-kontextus benne).
A kód-híd (`/api/code/*`) sorba teszi a feladatot, a Windows-oldali worker
kiveszi, és **UGYANABBAN a sessionben** futtatja le (`claude -p --resume <sessionId>`).

Egy projekten belül **több chat fül** (beszélgetés) is nyitva lehet a VS Code-ban
-- mindegyik külön session, külön problémával. A híd bármelyikbe tud címezni;
alapból a projekt élő fülébe megy a feladat.

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
7. **Ha a feladat maga hosszú (percekig futó) háttérfolyamatot indít** (pl.
   teljes teszt-suite), írd bele a promptba ezt a két szabályt (mérve
   2026-08-30, lásd `docs/code-bridge.md` 8. szakasz): (a) a háttérfolyamatot
   `setsid`-del indítsa, ne `nohup ... &`-nal -- a `wsl.exe`-hívás saját pty-je
   a tool-hívás végén megszűnik, és a `nohup`+`disown` ezt nem éli túl (mért
   eset: SIGHUP, kilépőkód 129, 2 másodperc múlva); (b) sose jelentsen
   "fut"-ot vagy "kész"-t egyetlen pillanatnyi ellenőrzésből -- két, időben
   eltolt ellenőrzés kell (indítás után azonnal + kb. +20 mp), és "kész"-t
   csak a log végén álló tényleges kilépőkód-sor igazolhat.
8. **A chat fület NE találgasd.** Ha a tulajdonos fülre utal ("a tegnapi
   indikátoros beszélgetésbe"), kérd le a füleket (2. lépés), és a **címek**
   alapján válassz. Ha két cím is illik rá, kérdezz vissza. Rossz fül = egy
   idegen beszélgetés közepébe írsz bele, ami ott értelmezhetetlen.
9. **Az azonosítót ne mondd fel cím helyett.** A fület a **címe** azonosítja a
   tulajdonosnak; az UUID a gépnek szól. Ha van cím, azt mondd (a rövid
   azonosító legfeljebb zárójelben).

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

Egy sor = egy **mappa** (workspace), nem egy chat fül. A `tabCount` mutatja,
hány beszélgetés van benne.

Minden sor megmondja azt is, **mit szabad ennek a végrehajtónak kiosztani**:

| Mező | Mit jelent |
| --- | --- |
| `roleHolder` | `vscode:<projekt>` — ezen a néven szerepel a szerep-kiosztásban és az org charton is |
| `roles` | amit a tulaj bejelölt a kártyán: `planner` / `implementer` / `checker` |
| `rolesAssigned` (a válasz tetején) | van-e **bárhol** kiosztott szerep a flottában |
| `contextTokens` | mennyi kontextust használ éppen az a beszélgetés, vagy `null` |

Az üres `roles` KÉT dolgot jelenthet, és a kettőt nem szabad összemosni:

* `rolesAssigned: false` → **nincs korlátozás**, bármilyen munkát adhatsz neki.
* `rolesAssigned: true`, de ennek a sornak üres a `roles`-a → a tulaj
  SZÁNDÉKOSAN nem adott neki szerepet: ne ossz rá tervezést/megvalósítást,
  hanem mondd meg, hogy nincs rá jogosultsága, és kérdezz vissza.

A `contextTokens: null` NEM „üres beszélgetés": azt jelenti, hogy nem látunk
rá (régi Windows worker, még nincs benne válasz, olvashatatlan napló). Sose
írd, hogy nulla a kontextusa.

### 2. Milyen chat fülek vannak (ha fülről van szó)

Akkor kell, ha a tulajdonos **kilistáztatná** a füleket, vagy ha egy konkrét
beszélgetésbe kéri a feladatot. Ha csak "csináld meg X projektben", ez a lépés
kihagyható -- a projekt alapértelmezett füle a cél.

```bash
TOKEN=$(cat {{PROJECT_ROOT}}/store/.dashboard-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:{{WEB_PORT}}/api/code/tabs | python3 -m json.tool
```

Válasz (rövidítve):

```json
{
  "projects": [
    { "project": "tradingbot",
      "workspacePath": "F:\\...\\tradingbot",
      "currentSessionId": "a1b2c3d4-....",
      "tabs": [
        { "sessionId": "a1b2c3d4-....", "shortId": "a1b2c3d4",
          "title": "Kod-hid tesztelese", "mtime": 1755950000000,
          "primary": true, "current": true }
      ] }
  ],
  "workerOnline": true, "lastSeenAt": 1755950000000,
  "note": null, "reason": "ok",
  "window": { "maxTabsPerProject": 10, "maxAgeDays": 21 }
}
```

- `title` = amit a VS Code a fülön mutat (a beszélgetés saját címe). **Ezt
  mondd** a tulajdonosnak. Ha `null`, még nincs címe -- akkor a rövid azonosító
  és az életkor marad; címet NE találj ki hozzá.
- `current: true` = **ide megy a feladat, ha nem címzel fület.**
- A lista mindig szűkített: projektenként a legutóbbi `window.maxTabsPerProject`
  fül, és csak `window.maxAgeDays` napnál frissebb. Ha valamit nem találsz benne,
  az lehet, hogy csak régi -- ezt mondd, ne azt, hogy "nincs ilyen".

**Az üres lista KÉT dolgot jelenthet — a `reason` mondja meg, melyiket:**

| `reason` | Mit jelent | Mit mondj |
| --- | --- | --- |
| `ok` | van mit mutatni | listázd |
| `empty` | a worker jelentett, és tényleg nincs nyitott beszélgetés | "nincs nyitott chat fül" |
| `worker-never` | a Windows worker MÉG SOHA nem jelentkezett | **NEM** azt jelenti, hogy nincs fül: nem látunk oda. Mondd, hogy a workert el kell indítani a Windows-gépen |
| `worker-stale` | a worker jelentkezett már, de a `lastSeenAt` óta hallgat | a lista ELAVULT lehet; mondd meg, mikor jelentkezett utoljára |

**Soha ne írd azt, hogy "nincs nyitott chat fül", ha a `reason` nem `empty`.**
A `note` mező kész magyar mondatot ad ugyanerről -- azt szó szerint átveheted.

### 3. Add fel a feladatot

```bash
TOKEN=$(cat {{PROJECT_ROOT}}/store/.dashboard-token)
curl -s -X POST http://127.0.0.1:{{WEB_PORT}}/api/code/tasks \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"project":"tradingbot","prompt":"IDE JON SZO SZERINT A FELADAT","origin":"agent","requestedBy":"{{MAIN_AGENT_ID}}"}
JSON
```

Konkrét chat fülbe az **opcionális** `sessionId` mezővel:

```json
{"project":"tradingbot","prompt":"...","origin":"agent","requestedBy":"{{MAIN_AGENT_ID}}","sessionId":"a1b2c3d4"}
```

- `sessionId` elhagyva vagy `null` -> a projekt alapértelmezett fülébe megy
  (az, amelyik a 2. lépésben `current: true`).
- Elég a rövid azonosító eleje, ha egyértelmű. Ha több fülre illik, a híd
  hibát ad vissza a jelöltekkel -- olyankor kérdezz vissza, NE találgass.
- A válasz `targetSessionId` mezője mondja meg, melyik fülbe címezted; ha `null`,
  az alapértelmezettbe ment.

A válasz `201` + a feladat rekordja (`id`, `project`, `status: queued`).
Hiba esetén `400` + `error` (pl. `unknown project` a jelöltekkel) -- ilyenkor
mondd meg a tulajdonosnak, mi volt a baj, és NE próbálkozz másik projekttel.
Ha a hiba azt mondja, hogy nem lát rá a projekt beszélgetéseire, az a **worker**
hiánya, nem rossz azonosító -- ezt add tovább, ne találgasd az okot.

Ha a promptban idézőjel/újsor/backtick van, a fenti heredoc-os forma
(`-d @-` + `<<'JSON'`) a biztonságos: a shell semmit nem helyettesít benne.
Nagyon hosszú prompthoz írd fájlba és `-d @/tmp/task.json`.

### 4. Nyugtázd, és lépj ki

Egy sor a tulajdonosnak (magyarul, a fül CÍMÉVEL, rövid azonosítóval), és
**fejezd be a kört**. Ne hívj több eszközt, ne kérdezz rá a státuszra.

## Mit NEM csinál a híd

- **Nem nyit új sessiont**, és nem forkol: mindig egy meglévő beszélgetést
  folytat. Új chat fül csak a VS Code-ban, kézzel nyílik. Ha egy projekthez
  nincs regisztrált session, a feladás hibázik -- ilyenkor a workernek kell
  futnia a Windows-gépen, illetve a sessiont egyszer meg kell nyitni VS Code-ban
  abban a workspace-ben.
- **Nem futtat semmit a te gépeden/kontextusodban.**
- **Nem tud már futó feladatot leállítani.** Csak sorban álló (`queued`)
  feladat törölhető.
- **Nem mutatja a munka MENETÉT.** A híd a végeredményt adja vissza. Ha a
  tulajdonos élőben nézné, mit csinál éppen a gépén a Claude Code, arra a
  Claude mobilalkalmazás "Code" füle való (lásd lent) -- azt NE próbáld
  pótolni státusz-pollozással.

## Óvatosság

- **Soha ne add fel a feladatot annak a sessionnek, amelyikben ÉPP TE futsz**
  (a saját workspace-ed aliasa): az a saját beszélgetésedbe írna bele.
- A worker egyszerre EGY feladatot futtat; a többi sorban vár. Ez szándékos:
  két párhuzamos `--resume` ugyanarra a sessionre egymásra írná a naplót.
- Amíg egy feladat fut, a tulajdonos ne gépeljen abba a VS Code panelbe --
  és a Claude mobilalkalmazásból se írjon ugyanabba a beszélgetésbe.

## Három út ugyanahhoz a VS Code sessionhöz

A tulajdonosnak három, egymást kiegészítő útja van; ez a készség az elsőről szól.

1. **Marveen (te)** -- Telegramon vagy a felületen szól, te feladod a feladatot
   a hídon. Ez az egyetlen út, ahol **nem kell semmit begépelnie**: elmondja,
   mit akar, te választod ki a projektet és a fület.
2. **A kód-bot Telegramon** -- `/tabs`, `/code <projekt> #<ful> <feladat>`,
   `/status`, `/result`, `/cancel`. Téged teljesen kihagy.
3. **A Claude mobilalkalmazás "Code" füle** -- ott a gépén futó VS Code Claude
   Code **munkamenete élőben látszik** (mit csinál éppen, melyik fájlt írja),
   és beszélgetni is lehet vele. Ez a híd MELLETT működik, nem helyette: a híd
   feladatot ad és eredményt hoz, a mobilalkalmazás a folyamatot mutatja.

Ha a tulajdonos azt kérdezi, "hogyan látom, mit csinál éppen", a helyes válasz
a 3. pont -- ne kezdj el státuszt pollozni helyette (2. kemény szabály).

## Kapcsolódó

- Részletes üzemeltetés: `docs/code-bridge.md`
- Telegram-oldal: a dedikált kód-bot `/code`, `/tabs`, `/status`, `/result`,
  `/projects`, `/cancel` parancsai -- azok TELJESEN kihagynak téged.
- Felületen: Fejlesztés oldal -> "Chat fülek" kártya (ugyanaz a lista), és a
  feladás melletti "Chat fül" választó.
