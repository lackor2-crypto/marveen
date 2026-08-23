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

> **A gyors út: az `Ügynökök` lap &rarr; a **VS Code Claude Code** kártya.**
> Rákattintva nyílik a Kód-híd ablak -- pontosan úgy, ahogy bármelyik másik
> ügynök beállítása a saját kártyájáról. Ott egy helyen van az állapot
> ("él-e a végrehajtó"), a Windows-végrehajtó két letölthető fájlja, a
> **valódi útvonalakkal kiírt** telepítő parancs (másoló gombbal), a
> bot-token, a projekt-tábla és a feladatküldés. Az alábbi fejezetek
> ugyanezt írják le kézzel -- ha az ablakot használod, egyik sem kell.
>
> 2026-08-22-ig ez külön menüpont volt a bal oldali RENDSZER csoportban.
> Boss: *"miért kivételezünk vele? mindenki alapból is ott keresné, ha már
> a többinél is ott van."* A tartalom változatlan, csak a helye lett a
> megszokott.

### 3.0 Beüzemelés friss telepítésen

**A kártya magától megjelenik** -- nincs "Új ügynök", nincs kézi felvétel. A
`CODE_BRIDGE_ENABLED` alapból bekapcsolt, tehát egy frissen telepített
Marveenen a VS Code kártya ott áll a fizetős sávban, Marveen után, és azt
mutatja, hol tartasz (`Nincs futó Windows-végrehajtó`). Rákattintva nyílik az
ablak, a tetején a **Beüzemelés** kártyával: sorrendben mutatja, mi a
következő lépés, és mindegyik mellett ott a gomb, ami a hozzá tartozó
kártyára ugrik:

| # | Lépés | Miből látszik | Kötelező |
|---|---|---|---|
| 1 | A híd be van kapcsolva | `health.enabled` | igen |
| 2 | A Windows-végrehajtó fut | `health.workerOnline` | igen |
| 3 | Van legalább egy regisztrált projekt | `health.sessions > 0` | igen |
| 4 | Telegram kód-bot | `health.botConfigured` | nem |

A kártya **eltűnik**, amint a három kötelező lépés kész -- egy működő hídon egy
állandó teendő-lista már csak zaj. A negyedik szándékosan opcionális: a felület
és az ügynök-átadás bot nélkül is megy, csak a Telegramos `/code` nem.

**A kiírt útvonalak a te telepítésedre érvényesek.** A `/api/code/health`
`installHint`-je megmondja, milyen gépen fut a Marveen (`hostKind`: `wsl`,
`windows` vagy `unix`), és ebből következik, mit kap a worker:

| hostKind | Amit a lap kiír | Miért |
|---|---|---|
| `wsl` | `-TokenPath "\\wsl.localhost\<distro>\...\store\.dashboard-token"` | a Windows így látja a WSL fájlrendszerét |
| `windows` | `-TokenPath "<telepítési út>\store\.dashboard-token"` | ugyanaz a fájlrendszer |
| `unix` | `-Token "<kimásolt token>"` | külön gépen **nincs** közös útvonal |

`unix` esetén a lap azt is megmondja, melyik fájlból kell kimásolni a tokent
(`installHint.tokenFile`), és figyelmeztet, hogy a `-BaseUrl` ne `localhost`
maradjon.


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
egyikhez sem kell. Négy közülük a **Beállítások** lapon és a Kód-híd ablakban
is szerkeszthető; a `CODE_BOT_TOKEN` viszont titkosnak van jelölve, ezért
csak a **Kód-híd ablakban** állítható (Ügynökök → a VS Code kártya):

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

A Kód-híd ablakból mindkét fájl letölthető (`marvin-code-worker.ps1` és
`.cmd`), és kiírja a hozzájuk tartozó, erre a gépre szabott indító
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

### 3.4 Projekt felvétele: választani kell, nem gépelni

A Kód-híd ablak **Projektek** kártyáján ott a *Felderített mappák a gépeden*
lista. Ezt nem te töltöd: a worker percenként bejárja a
`~/.claude/projects/<kódolt-cwd>/*.jsonl` átiratokat, és minden mappát bejelent,
amelyben nyitva volt egy VS Code Claude Code beszélgetés. A jelentésben ott van
az **elérési út és a session-azonosító is** -- eddig ez az adat egyszerűen sosem
került a felhasználó elé, ezért kellett mindkettőt kézzel begépelni.

Igazi mappa-tallózó **nem lehetséges**, és ezt érdemes egyszer kimondani: a
vezérlőpult a WSL-ben fut és nem látja a Windows lemezét (a `/mnt/c` EIO-t ad
jelszó nélküli sudo hiányában), a böngésző pedig valódi elérési utat sosem ad
ki egy lapnak. A "tallózás" ezért ez a lista.

Soronként egy állapot és egy teendő:

| Állapot | Mit jelent | Gomb |
|---|---|---|
| `new` | a worker látja, de nincs felvéve | **Felvétel** -- alias a mappanévből, session a jelentésből, kitűzve |
| `registered` | már fel van véve (a saját nevén) | nincs -- kétszer felvenni nincs mit |
| `excluded` | `CODE_BRIDGE_EXCLUDE` kizárja | **Kizárás feloldása** -- és alatta rögtön az újraindítás-gomb |

A kizárt sor nem kozmetika: 2026-08-22-én a tulajdonos **egyetlen** VS Code
workspace-e (`tozsde_telepitesi_mappa`) volt kizárva, ezért a projektlista üres
maradt, és semmi nem mondta meg, miért -- így szorult rá a kézi űrlapra. Az
állapotot ugyanaz az `isExcludedProject()` adja, amire a feladatsor is
visszautasít, tehát a lap nem kínálhat "Felvétel" gombot olyan mappára, amit a
szerver 400-zal dob vissza.

**A session-azonosító többnyire elhagyható.** A `POST /api/code/projects` a
worker jelentéséből tölti ki, ha ismeri azt a mappát -- záró visszaper és
kis/nagybetű nem számít (`sameWorkspace()`). Csak akkor kötelező, ha a worker
sosem látta a mappát (másik gép, zárt VS Code); ilyenkor a hibaüzenet ezt ki is
mondja, a felület pedig már a küldés előtt, magyarul szól. Az azonosítót a VS
Code Claude Code panel `/status` parancsa írja ki.

A kézi űrlap megmaradt, de a lista **alatt**, lecsukva, és mindhárom mezője
mellett ott a magyarázat -- mit írj bele, honnan tudod meg, és kötelező-e.

A **nulla projektes ügynök-kártya** is ebből a listából beszél. Amíg egy
projekt sincs felvéve, a kártya nem általánosságban buzdít, hanem megmondja,
hol tartasz: *"N mappát talált a gépeden, de még egyik sincs felvéve"*,
kizárt mappáknál *"mind ki van zárva -- a listában feloldhatod"*, és csak
akkor kéri új projekt megnyitását VS Code-ban, ha a worker tényleg nem talált
semmit. A számokat a `GET /api/code/health` `candidates: { free, excluded }`
mezője adja; régi backend esetén (nincs a válaszban) a kártya a régi
szövegre esik vissza.

## 4. Használat

### Telegramról (Marvin teljes kihagyásával)

| Parancs | Mit csinál |
|---|---|
| `/code <projekt> [#<ful>] <feladat>` | átadja a feladatot a projekt sessionjének (opcionálisan egy konkrét chat fülnek) |
| `/tabs [projekt]` | milyen chat fülek vannak nyitva, **címmel** |
| `/status [projekt]` | mi fut, mi vár |
| `/result [id vagy projekt]` | a TELJES eredmény (darabolva, nem csonkolva) |
| `/projects` | a regisztrált sessionök |
| `/cancel <id>` | sorban álló feladat törlése |

Az első szó a projekt, **minden más szó szerint** megy tovább. Az elkészülés
után rövid, programozott értesítés jön (OK/hiba + idő + kör + költség + max 280
karakteres kivonat); a részletes eredmény `/result`-tal kérhető.

### Chat fülek: egy projektben több beszélgetés

Egy VS Code workspace-ben több chat fül lehet nyitva, mindegyik **külön
session, külön problémával**. A híd ezt látja, mert a worker minden
beszélgetés-naplót jelent a mappából, a fül **címével** együtt (azt a
`{"type":"ai-title"}` sor adja, ugyanaz, amit a VS Code a fülön mutat).

- **Az ügynök-kártya = MAPPA, nem fül.** Egy workspace-hez egy kártya tartozik;
  a fülek azon belül vannak. Új chathez nem kell új kártya.
- **Címzés nélkül** a feladat a projekt élő fülébe megy (a regisztrált session,
  vagy ha az nincs, a legfrissebb napló) -- pontosan úgy, mint korábban.
- **Címezni** a rövid azonosító elejével lehet (`/code tradingbot #a1b2c3d4 ...`,
  vagy REST-en a `sessionId` mező). Ha a töredék több fülre illik, a híd
  **hibát ad a jelöltekkel** -- nem választ helyetted.
- A lista szűkített: projektenként a 10 legfrissebb fül, 21 napnál nem régebbi.

**Az üres lista két dolgot jelenthet**, ezért a `GET /api/code/tabs` egy
`reason` mezőt is ad (`ok` / `empty` / `worker-never` / `worker-stale`): az
`empty` azt jelenti, hogy tényleg nincs nyitott beszélgetés, a `worker-*`
viszont azt, hogy **nem látunk oda**. A felület és a Telegram is ezt a mezőt
mondja vissza -- "nincs chat fül" csak `empty` esetén hangzik el.

### Élőben nézni, mit csinál éppen: a Claude mobilalkalmazás

A híd **feladatot ad és eredményt hoz** -- a munka menetét nem közvetíti.
Ha élőben látnád, mit csinál éppen a gépeden a VS Code Claude Code (melyik
fájlt írja, hol tart), arra a **Claude mobilalkalmazás "Code" füle** való: ott
ugyanezek a sessionök látszanak, folyamatában, és beszélgetni is lehet velük.

Ez a hídat **kiegészíti, nem váltja ki**. Három út vezet ugyanahhoz a
sessionhöz:

| Út | Mire jó | Kell-e gépelni |
|---|---|---|
| **Marveen ügynök** (Telegram/felület, `code-dispatch` skill) | elmondod, mit akarsz, az ügynök kiválasztja a projektet és a fület, és feladja | nem: se projektnév, se parancs |
| **Kód-bot Telegramon** (`/tabs`, `/code`) | gyors, ügynök nélkül, sorbaállítva | igen: parancs + projekt |
| **Claude mobilalkalmazás "Code" füle** | **a folyamat élő követése**, közvetlen beszélgetés | igen, de közvetlenül a sessionnel |

Egy figyelmeztetés: amíg egy hídon feladott feladat fut, ne írj ugyanabba a
beszélgetésbe se a VS Code-ban, se a mobilalkalmazásból -- két párhuzamos
menet egymásra írná a session naplóját.

### Bármelyik ügynöktől

A `code-dispatch` skill: felad egy taskot `origin: "agent"`-tel, nyugtáz egy
sorban, és **befejezi a kört**. Nem hoz létre programozó agentet, nem vár, nem
tolmácsol.

Ez **nem** Marvin kiváltsága. A készség a közös készségtárban lakik
(`~/.claude/skills`, minden ügynök `.claude/skills`-e oda van linkelve), tehát a
flotta bármelyik tagja átadhat kódfeladatot a VS Code sessionnek -- a végrehajtó
ugyanaz marad, és a sor egyszerre egy feladatot futtat, akárki adta fel. A
`requestedBy`-ba mindenki a **saját** ügynök-nevét írja; ebből látszik a
Feladatok listában, ki kérte.

Az irány szándékosan ez: az ügynökök használják a VS Code sessiont, nem
fordítva. A projekt sessionje ismeri a kódot és az előzményeket -- egy ügynök
parafrázisa csak információt veszítene.

### REST

```bash
TOKEN=$(cat ~/marveen/store/.dashboard-token)
curl -s -X POST http://127.0.0.1:3420/api/code/tasks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"project\":\"tradingbot\",\"prompt\":\"...\",\"origin\":\"api\"}"
```

| Végpont | Ki hívja |
|---|---|
| `GET /api/code/candidates` | dashboard (amit a worker a gépen talált MAPPÁNKÉNT: `new` / `registered` / `excluded`, `tabCount`-tal) |
| `GET /api/code/tabs` | dashboard + kód-bot + ügynök (chat fülek projektenként, címmel; `reason` mezővel) |
| `GET/POST /api/code/projects`, `DELETE /api/code/projects/:project` | tulaj (a POST `sessionId`-je elhagyható, ha a workernek van jelentése arról a mappáról) |
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
| tele van a Feladatok lista próbakörökkel | „Előzmények törlése” a Kód-híd ablakban: csak a lezárt sorokat viszi el |

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
  pirosan, a Kód-híd ablakot nyitva; `code_bridge_ok` zölden, mert a hallgatás
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
| `web/app.js` &rarr; `renderCodeBridgeAgentCards` | a végrehajtó kártyája az Ügynökök lapon (a **fizetős** sávban, Marveen után); kattintásra nyitja a beállításokat |
| `web/app.js` &rarr; `openCodeBridgeModal` | a Kód-híd ablak (`#cbOverlay`) -- a bal oldali menüpont helyett |
| `web/app.js` &rarr; `cbRenderCandidates` | a felderített mappák listája (a "tallózás" helyett) |
| `src/web/code-bridge-store.ts` &rarr; `recordCodeCandidates` | a worker legutóbbi **nyers** jelentése, a kizárás/regisztráció szűrése előtt |
| `web/app.js` &rarr; `cbSetupStepList` / `cbRenderSetup` | a beüzemelési lista, amíg a kötelező lépések hiányoznak |
| `src/web/routes/code.ts` &rarr; `detectHostKind` | melyik telepítési módon fut a Marveen (`wsl` / `windows` / `unix`) |
