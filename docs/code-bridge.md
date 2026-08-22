# Kód-híd: Telegram / Marvin -> VS Code Claude Code session

> Egy feladat átadása annak a **konkrét, már létező** VS Code Claude Code
> sessionnek, amelyik az adott projektet ismeri -- Marvin megkerülésével,
> GUI-automatizálás nélkül, publikus port nyitása nélkül.

## 1. Miért így néz ki

**A VS Code kiterjesztés magától nem indít promptot.** Mérve (Claude Code
extension 2.1.237): a `vscode://anthropic.claude-code/open?session=&prompt=`
URI a `claude-vscode.primaryEditor.open` parancsba fut, ami a promptot csak
**beírja** a beviteli mezőbe (`setInputText`) -- soha nem küldi el; ha a panel
már nyitva van, a promptot el is dobja. Nincs olyan parancs/API, ami elküldené.

Ezért a végrehajtó a **headless CLI ugyanarra a sessionre**:
`claude.exe -p --resume <sessionId> --output-format json`. Ez ugyanazt a
`~/.claude/projects/<workspace>/<uuid>.jsonl` naplót folytatja, amit a VS Code
panel mutat -- tehát megvan az előzmény, a projekt-ismeret, a korábbi döntések
és a workspace-kontextus. A panel innentől nézőke: ha újra megnyitod, látod a
hozzáírt köröket.

Amit **nem** használunk, szándékosan: AutoHotKey, egérkattintás,
billentyűzet-szimuláció, vágólap-beillesztés, ablak-fókusz. Egyik sem
determinisztikus és mind elromlik, ha a felhasználó közben a gépnél van.

**Az irány is mérés eredménye.** A WSL->Windows fájlelérés ezen a gépen
törött (`/mnt/c`, `/mnt/d` fel van csatolva, de EIO-t ad, és nincs jelszó
nélküli sudo a javításhoz), a Windows->WSL irány viszont hibátlan
(`127.0.0.1:3420` HTTP 200, `\\wsl.localhost\Ubuntu\...` fájlok). Ezért a
**Windows-oldali worker húz** feladatot a WSL-ben futó dashboardtól, nem a
dashboard tolja ki.

## 2. Felépítés

```
Telegram (dedikált kód-bot)  --+
Marvin (code-dispatch skill) --+--> POST /api/code/tasks --> code_tasks (SQLite sor)
dashboard / curl             --+                                 |
                                                                 | claim (loopback)
                              Windows worker (PowerShell) <-------+
                                     |
                                     +- claude.exe -p --resume <sessionId>   (a projekt sessionje)
                                     |        prompt = stdin (UTF-8), cwd = workspace
                                     |
                                     +- POST /api/code/tasks/<id>/result
                                              |
                                              +--> Telegram értesítés KÖZVETLENÜL,
                                                   programozottan (nulla LLM-token)
```

Marvin a feladás után **kilép**: nem vár, nem pollozik, nem tolmácsol.

### Session-térkép, nem globális változó

A `code_sessions` tábla kulcsa a **projekt-alias**, és minden sorban ott a
`workspace_path` + `session_id`. Tetszőleges számú session él egymás mellett,
mindegyik külön címezhető. Nincs "aktuális session" fogalom sehol a kódban.

- alias = a workspace mappaneve, kisbetűsítve (`aliasFromWorkspacePath`)
- feloldás: pontos egyezés -> egyértelmű prefix -> egyértelmű részlet;
  **többértelműség = hiba**, nem tippelés (`resolveProject`)
- a felderítés (worker, 60 mp-enként) sosem visz át egy aliast másik
  workspace-re, és sosem ír felül **kitűzött** (`pinned`) leképezést
- a feladat a **claim pillanatában** kapja meg a session-azonosítót, nem a
  feladáskor -- így egy közben frissült session-térkép is helyesen érvényesül

## 3. Telepítés

> **A gyors út: a `Kód-híd` lap.** A vezérlőpult bal oldalán, a RENDSZER
> csoport tetején. Ott egy helyen van az állapot ("él-e a végrehajtó"), a
> Windows-végrehajtó két letölthető fájlja, a **valódi útvonalakkal kiírt**
> telepítő parancs (másoló gombbal), a bot-token, a projekt-tábla és a
> feladatküldés. Az alábbi fejezetek ugyanezt írják le kézzel -- ha a lapot
> használod, egyik sem kell.


### 3.1 Dedikált Telegram kód-bot (opcionális, de ez a Marvin-mentes út)

Egy bot-tokent egyszerre egy `getUpdates` fogyasztó olvashat, és a fő bot
slotja Marvin sessionjében futó natív csatorna-pluginé (második olvasó =
409 Conflict). Ezért kell **saját bot**:

1. BotFather -> `/newbot` -> név + felhasználónév -> token
2. `.env` (vagy `store/config-overrides.json`):
   ```
   CODE_BOT_TOKEN=123456:AA...
   CODE_BOT_ALLOWED_CHAT_IDS=<a te chat_id-d>      # üresen: csak a tulaj chatje
   ```
3. Írj a botnak egy `/start`-ot, majd a dashboard újraindítása után `/projects`.

Token nélkül is működik minden (REST + Marvin-skill), csak Telegramról nem
lehet közvetlenül feladni.

### 3.2 Konfiguráció

| Kulcs | Alap | Mit csinál |
|---|---|---|
| `CODE_BRIDGE_ENABLED` | `1` | 0/false/no/off -> minden `/api/code/*` 503, poller és reaper nem indul |
| `CODE_PERMISSION_MODE` | `acceptEdits` | a `claude.exe --permission-mode` értéke |
| `CODE_BOT_TOKEN` | üres | a dedikált kód-bot tokenje (üres -> nincs Telegram-oldal) |
| `CODE_BOT_ALLOWED_CHAT_IDS` | üres | vesszős lista; üresen csak a tulajdonos chatje |
| `CODE_BRIDGE_EXCLUDE` | üres | vesszős alias-lista, amit a híd **soha nem** regisztrál és nem fogad el (pl. az az ablak, amelyikben épp beszélgetsz) |

Mind az öt kulcs szerepel a beállítás-regiszterben, tehát fájlt szerkeszteni
egyikhez sem kell. Négy közülük a **Beállítások** lapon és a **Kód-híd** lapon
is szerkeszthető; a `CODE_BOT_TOKEN` viszont titkosnak van jelölve, ezért
csak a **Kód-híd lapon** állítható:

- a `GET /api/settings` válaszából a **teljes sora kimarad** (nem maszkolt
  érték: már az is információ lenne, hogy a kulcs létezik és be van állítva),
- a `POST /api/settings` ugyanarra a kulcsra `403`-at ad,
- mentés után **soha nem megy vissza a böngészőbe** -- a felület csak azt
  mondja meg, van-e beállítva.

Mindegyik kulcs a vezérlőpult **indulásakor** olvasódik be, ezért mentés után
újraindítás kell. A lap ezt nemcsak kiírja: **gombot is ad hozzá**, és a gomb
csak akkor jelenik meg, ha az elmentett érték tényleg eltér a futótól -- így
nem szoktat hozzá ahhoz, hogy egy újraindítás-gomb csak dekoráció.

`acceptEdits` és nem `bypassPermissions`: a fájlszerkesztést engedi (különben
minden feladat elakadna egy meg nem válaszolható kérdésen), de a veszélyes
műveleteknél marad a kapu. A `bypassPermissions` tudatos, kézi döntés legyen.

### 3.3 Windows worker

A **Kód-híd** lapról mindkét fájl letölthető (`marvin-code-worker.ps1` és
`.cmd`), és a lap kiírja a hozzájuk tartozó, erre a gépre szabott indító
parancsot is -- se repót klónozni, se UNC-útvonalat gépelni nem kell.

Kézzel: a repóban `scripts/windows/marvin-code-worker.ps1`. Másold a Windows-gépre
(pl. `%USERPROFILE%\marvin-code-worker\`), és indítsd:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\marvin-code-worker\marvin-code-worker.ps1"
```

Paraméterek (mind opcionális):

| Paraméter | Alap | Mire jó |
|---|---|---|
| `-BaseUrl` | `http://127.0.0.1:3420` | a dashboard címe |
| `-TokenPath` | `\\wsl.localhost\Ubuntu\home\<user>\marveen\store\.dashboard-token` | a Bearer token forrása |
| `-PollSeconds` | `3` | feladat-lekérdezés gyakorisága |
| `-DiscoverSeconds` | `60` | session-felderítés gyakorisága |
| `-TaskTimeoutSeconds` | `3600` | eddig vár a `claude.exe`-re, utána kilövi |
| `-Once` | - | egy feladat, aztán kilép (teszthez) |
| `-DiscoverOnly` | - | csak felderít, feladatot nem vesz ki |

Napló: `%LOCALAPPDATA%\marvin-code-worker\worker.log` (2 MB-nál rotál).
Egyszerre csak egy példány fut (`Global\MarvinCodeWorker` mutex).

**Automatikus indítás** (a `marvin-code-worker.cmd` mellette van):

```
schtasks /create /tn "MarvinCodeWorker" /sc onlogon /rl highest /tr "\"%USERPROFILE%\marvin-code-worker\marvin-code-worker.cmd\""
```

vagy tedd a `.cmd`-t a `shell:startup` mappába. (A worker felhasználói
munkamenetben fusson: a `claude.exe` a felhasználó `~/.claude` beállításait
és bejelentkezését használja.)

## 4. Használat

### Telegramról (Marvin teljes kihagyásával)

| Parancs | Mit csinál |
|---|---|
| `/code <projekt> <feladat>` | átadja a feladatot a projekt sessionjének |
| `/status [projekt]` | mi fut, mi vár |
| `/result [id vagy projekt]` | a TELJES eredmény (darabolva, nem csonkolva) |
| `/projects` | a regisztrált sessionök |
| `/cancel <id>` | sorban álló feladat törlése |

Az első szó a projekt, **minden más szó szerint** megy tovább. Az elkészülés
után rövid, programozott értesítés jön (OK/hiba + idő + kör + költség + max 280
karakteres kivonat); a részletes eredmény `/result`-tal kérhető.

### Marvintól

A `code-dispatch` skill: felad egy taskot `origin: "agent"`-tel, nyugtáz egy
sorban, és **befejezi a kört**. Nem hoz létre programozó agentet, nem vár, nem
tolmácsol.

### REST

```bash
TOKEN=$(cat ~/marveen/store/.dashboard-token)
curl -s -X POST http://127.0.0.1:3420/api/code/tasks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"project\":\"tradingbot\",\"prompt\":\"...\",\"origin\":\"api\"}"
```

| Végpont | Ki hívja |
|---|---|
| `GET/POST /api/code/projects`, `DELETE /api/code/projects/:project` | tulaj |
| `POST /api/code/sessions` | worker (felderítés) |
| `POST /api/code/tasks`, `GET /api/code/tasks` | feladó / tulaj |
| `DELETE /api/code/tasks` | tulaj (előzmény-takarítás; a `queued`/`running` sorokat nem viszi el) |
| `POST /api/code/tasks/claim` | worker |
| `GET /api/code/tasks/:id`, `POST .../heartbeat`, `.../result`, `.../cancel` | worker / tulaj |
| `GET /api/code/latest/:project` | dashboard |

## 5. Biztonság

- **Nincs új publikus felület.** Minden `/api/code/*` a meglévő dashboard-kapu
  mögött van (`Authorization: Bearer <store/.dashboard-token>`).
- A **worker-végpontok** (claim / heartbeat / result / sessions) ezen felül
  **loopback-peert** követelnek (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`) --
  a Windows-gép a localhost-forwardingon át pont így látszik. Kiszivárgott
  tokennel távolról sem lehet a sort leszívni.
- A kód-bot **allowlistes**: ismeretlen chat üzenetére nincs válasz (még
  hibaüzenet sem, ami elárulná, hogy a bot létezik).
- A prompt **soha nem megy parancssorba**: a worker stdinre írja UTF-8-ban.
- Feladatonként max 12 000 karakter prompt (`PROMPT_MAX_CHARS`).

## 6. Hogy nem tűnhet el egy feladat

- **Lease + heartbeat**: a claim 5 perces bérletet ad, a worker futás közben
  60 mp-enként hosszabbítja. Ha a Windows-gép újraindul vagy a worker meghal,
  a bérlet lejár, és a dashboard 60 mp-es körökben visszateszi a sorba
  (`code-bridge-runner.ts`).
- **Attempt-korlát**: 3 sikertelen nekifutás után a feladat `failed`, és
  **hangosan** szól Telegramon -- nem hallgat el.
- **Idegen heartbeat**: másik worker heartbeatje nem hosszabbít.
- **Elveszett leképezés**: ha a projekt sessionje eltűnt, a feladatot senki nem
  tudja kivenni. A híd 3 perc türelmi idő után (annyi, hogy egy újraindulás
  vagy egy kimaradt felderítési kör ne számítson) hibára viszi és **szól** róla.
  Addig sem blokkol: a mögötte álló, futtatható feladatokat a worker kiveszi.

## 7. Hibaelhárítás

| Tünet | Ok / teendő |
|---|---|
| `/projects` üres | nem fut a worker, vagy nem éri el a tokent (`worker.log`) |
| `unknown project` | többértelmű vagy ismeretlen alias -- a válasz kiírja a jelölteket |
| minden `/api/code/*` 503 | `CODE_BRIDGE_ENABLED=0` |
| `code-bot: getUpdates failed 409` | ugyanazt a tokent másik poller olvassa (nem lehet a fő bot tokenje) |
| a feladat `queued` marad | worker áll; `schtasks /query /tn MarvinCodeWorker`, `worker.log` |
| `loopback only` 403 | a worker nem a helyi gépről hív (proxy/távoli hívás) |
| a válasz ékezetei romlanak | a PS 5.1 alap ISO-8859-1-et küldene; a worker ezért UTF-8 bájtokat POST-ol -- valószínűleg régi worker-példány fut |
| megszakítottam, mégis megjött az eredmény | ez rendben van: a futó CLI-t nem lehet leállítani. A feladat `cancelled` marad, de az eredményt megőrizzük -- `/result <id>` mutatja |
| a `cancel` 409-cel válaszol | a feladat már fut. Csak `queued` állapotban törölhető |
| eltűnt egy projekt a listából | a workspace mappája már nincs meg, ezért a felderítés kivette. Ha meg akarod tartani, tűzd ki (`pin`) -- kitűzött sort a felderítés soha nem bánt |
| tele van a Feladatok lista próbakörökkel | „Előzmények törlése” a Kód-híd lapon: csak a lezárt sorokat viszi el |

### A néma hibamód: áll a végrehajtó

A hídnak **egyetlen** olyan hibája van, ami magától nem látszik: a Windows-oldali
végrehajtó megáll. A feladatok ilyenkor szépen sorba állnak, a híd "be van
kapcsolva", minden lap zölden mutat -- és semmi nem szól. (2026-08-22-én mérve:
08-20 19:47 óta állt, és az egyetlen nyoma egy üres projekt-lista volt.)

Ezért a végrehajtó minden bejelentkezése (felderítés, feladat-kivétel,
életjel) rögzül a `code_workers` táblában, és ebből él két dolog:

- `GET /api/code/health` -> `workerOnline`, `lastSeenAt`, `sessions`, `queued`,
  `running`, `failed24h`, `done24h`. A **felderítés előtt** stemplünk: a nulla
  sessiont jelentő worker is ÉLŐ worker, és éppen ez a különbség a diagnózis.
- az **Áttekintés önellenőrzése**: `code_bridge_dead` / `code_bridge_never`
  pirosan, a Kód-híd lapra kattintva; `code_bridge_ok` zölden, mert a hallgatás
  megkülönböztethetetlen lenne a nem futó ellenőrzéstől. Arról a telepítésről,
  ahol a hidat sosem indították el, egyik sem szól.

## 8. Korlátok, amikkel együtt kell élni

- **Egy feladat egyszerre.** A worker sorosít; két párhuzamos `--resume`
  ugyanarra a sessionre egymásra írná a naplót.
- **Futó feladat nem állítható le** Telegramról (csak `queued` törölhető).
- **Ne gépelj a panelbe, amíg fut egy feladat** az adott sessionben. Az új
  köröket a panel újranyitása után látod.
- **A saját, élő beszélgetésed sessionjére ne adj fel feladatot** -- oda a
  CLI beleírna. A leképezés törlése önmagában kevés: a felderítés egy perc
  múlva visszateszi. A végleges kizárás a `CODE_BRIDGE_EXCLUDE=<alias>`
  beállítás (a felderítés ki is törli a meglévő sort, és a feladás is elutasít).

  Ha ugyanabban a mappában mégis akarsz egy **másik, nem élő** sessiont
  vezérelni, adj neki SAJÁT aliast -- a kizárás aliasra szól, a kitűzött
  leképezést pedig a felderítés nem mozdítja el:

  ```bash
  TOKEN=$(cat ~/marveen/store/.dashboard-token)
  curl -s -X POST http://127.0.0.1:3420/api/code/projects \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"project\":\"tozsde-ea\",\"workspacePath\":\"d:\\\\Tozsde_telepitesi_mappa\",\"sessionId\":\"<session-uuid>\"}"
  ```

  A session-uuid a `~/.claude/projects/<kodolt-cwd>/<uuid>.jsonl` fájlnév.
- A felderítés projektmappánként a **legfrissebb, legalább 2 KB-os** naplót
  veszi -- egy épp indított, üres session nem írja felül a régit.

## 9. Elfogadási mérések

A címzés-teszteket **három, kifejezetten erre létrehozott workspace-en** futtattuk
(`marvin`, `tradingbot`, `freeberischeaper`), mindegyikben külön session-fájllal
és külön kódszóval -- valódi projektbe egyetlen teszt sem írt bele. A workspace-ek
a mérés után törölve lettek, ezért a `/projects` addig üres, amíg egy VS
Code-ablakban el nem indul egy valódi beszélgetés (a worker egy percen belül
felveszi).

- **Felderítés**: 7 projekt regisztrálva egy körben.
- **Címzés**: `tradingbot` feladat -> a Trading Bot sessionje (`7b3f1a20...aa02`)
  válaszolt a saját kódszavával; a projekt naplófájljainak száma **maradt 1**,
  mérete 16 082 -> 20 725 bájt nőtt: **nem nyílt új session és nem forkolt**.
- **Három session egymás mellett**: párhuzamosan feladott feladatokra
  mindhárom a **saját** kódszavát adta vissza, keveredés nélkül.
- Egység-tesztek: `src/__tests__/code-bridge.test.ts` (33 teszt).

## 10. Fájlok

| Fájl | Szerep |
|---|---|
| `src/web/code-bridge-store.ts` | session-térkép + feladatsor (SQLite) |
| `src/web/routes/code.ts` | REST + loopback-kapu |
| `src/web/code-bridge-telegram.ts` | dedikált bot pollere + parancsfelület |
| `src/web/code-bridge-notify.ts` | programozott kész-értesítés (nulla LLM) |
| `src/web/code-bridge-runner.ts` | lejárt bérletek visszatevése |
| `scripts/windows/marvin-code-worker.ps1` | a Windows-oldali végrehajtó |
| `seed-skills/code-dispatch/SKILL.md` | Marvin feladás-eljárása |
| `web/app.js` &rarr; `renderCodeBridgeAgentCards` | a végrehajtó kártyája a Csapat lapon |
