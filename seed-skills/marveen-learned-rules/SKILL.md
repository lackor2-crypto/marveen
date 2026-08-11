---
name: marveen-learned-rules
description: Élő szabály-gyűjtemény a Marveen-en elkövetett hibákból. MINDEN Marveen-adat/dashboard/DB művelet ELŐTT nézd át a vonatkozó szabályt, hogy egy már egyszer elkövetett hibát ne ismételj meg. Error->recovery után ide KÖTELEZŐ új szabályt írni.
---
# Marveen tanult szabályok (élő rulebook)

## Mi ez és miért
{{OWNER_NAME}} kérése (2026-08-03): ne kelljen minden hibánál külön szólnia. Ha egyszer
elkövetek egy elkerülhető hibát és kijavítom, a tanulság ide kerül SZABÁLYKÉNT,
és a jövőben ezt a szabályt betartva a hiba nem ismétlődik. Ez a fájl automatikusan
gyűlik: minden error->recovery ciklus után egy új sor.

## Mikor használd
- MIELŐTT Marveen-adaton dolgozol (SQLite `store/claudeclaw.db`, dashboard API,
  kanban, ötletláda, memória, ütemezés, címkék), fusd át a lenti szabályokat.
- Error->recovery után: ADD HOZZÁ az új szabályt (lásd "Új szabály hozzáadása").

## Szabályok

### R1 -- Kanban/ötletláda kártya id KÖTELEZŐ (sose NULL)
**Hiba (2026-08-03):** kanban kártyát nyers `INSERT INTO kanban_cards` paranccsal
id nélkül hoztam létre. A `kanban_cards.id` TEXT (NEM autoincrement), így az id
`NULL` lett. A kártya látszólag létrejött, DE: a címke-kötés (`kanban_card_labels`),
a promote, és a dashboard címke-választója MIND csendben elbukott, mert a
`POST /api/kanban/<id>/labels` üres/NULL id-nél 404-et ad. {{OWNER_NAME}} nem tudott címkét
tenni a kártyára.
**Szabály:** kanban/ötletláda kártyát VAGY a dashboard API-n át hozz létre, VAGY
ha muszáj SQL, mindig adj rendes id-t: `id = uuid4()[:8]` (a frontend is
`randomUUID().slice(0,8)`-at használ). Rekord létrehozása után ELLENŐRIZD az
API-n, hogy az id nem NULL, mielőtt késznek jelented.

### R2 -- Kanban felelős (assignee) KÖTELEZŐ és PONTOS nevű
**Hiba (2026-08-03):** kártyát `assignee='<agent-id-kötőjeles>'` (KÖTŐJELES,
az üzenet/memória/approval API agent_id formátumában) értékkel hoztam létre.
A kanban regisztrált felelős-nevei viszont `GET /api/kanban/assignees` szerint
MÁS formátumúak voltak (pl. az owner megjelenített neve, és a bot regisztrált
neve ALULVONÁSSAL, nem kötőjellel). Emiatt a kártya felelőse egyik regisztrált
névhez sem illeszkedett, a UI nem mutatta/választotta ki helyesen -- se az
owner, se a bot nem volt "felelős" a rendszer szemében.
**Szabály (általános, NEM konkrét nevekre kötve):** kanban kártyán MINDIG legyen
felelős (sose üres). A felelős nevét SOSE fejből/emlékezetből írd be -- a felelősök
köre változhat és bővülhet (később több ágens is jöhet, nem csak owner + fő-bot).
Ezért minden hozzárendelésnél:
1. Kérd le a friss listát: `GET /api/kanban/assignees` -> nevek + típusok.
2. Válaszd ki a szándékolt felelőst, és MÁSOLD ONNAN a nevet KARAKTERRE PONTOSAN
   (kis/nagybetű, kötőjel vs alulvonás mind számít).
3. Ha a szándékolt felelős nincs a listában, NE találj ki nevet -- kérdezd meg
   a usert vagy nézd meg hogyan van regisztrálva.
4. Létrehozás után ellenőrizd az API-n, hogy az `assignee` egy létező névre illeszkedik.
Megjegyzés a kettős namingről (a konkrét hiba oka volt): egy ágensnek külön neve
lehet a kanban assignee-listában és külön agent_id-ja a memória/üzenet/approval
API-khoz. Kanbanhoz MINDIG az assignees-listából vett nevet használd, ne az agent_id-t.
Ez akkor is fennáll, ha a fő-ágens saját BOT_NAME-jét (a display-nevét) útközben
átnevezik -- az agent_id (API-kulcs) és a display/assignee-név ETTŐL FÜGGETLENÜL
eltérhet egymástól, a szabály ugyanaz marad: NE fejből -- mindig a
`/api/kanban/assignees`-ből.

### R3 -- Telegram MCP kiesésekor Bot API a mentőöv
**Helyzet (2026-08-04):** a `plugin:telegram:telegram` MCP menet közben lekapcsolt
(limit vagy csatorna-restart), a `mcp__plugin_telegram_telegram__reply` tool
eltűnt, egy kész válasz nem ment ki -- {{OWNER_NAME}} várt.
**Szabály:** ha a Telegram reply MCP tool nem elérhető, NE ragadj be. Küldd a
választ közvetlenül a Telegram Bot API-n (ahogy a rendszer saját szkriptjei is,
pl. limit-monitor.sh), token-mentesen model-oldalról:
```bash
TG=$(python3 -c "import json,glob,os;[ (print(d[k]),exit()) for p in glob.glob(os.path.expanduser('~/.claude/channels/telegram/*.json')) for d in [json.load(open(p))] for k in ('TELEGRAM_BOT_TOKEN','bot_token','token','botToken') if isinstance(d,dict) and d.get(k)]" 2>/dev/null)
curl -s -X POST "https://api.telegram.org/bot${TG}/sendMessage" \
  --data-urlencode "chat_id=<OWNER_CHAT_ID>" --data-urlencode "text=..."
# siker: HTTP 200 + {"ok":true,"result":{"message_id":...}}
```
Ellenőrizd az `ok:true`-t és a `message_id`-t. A `<OWNER_CHAT_ID>`-t a saját
telegram csatorna-konfigból vedd (pl. `~/.claude/channels/telegram/access.json`
vagy a korábbi bejövő üzenetek `chat_id` mezője).

### R4 -- Duplikált logika: keresd meg AZ ÖSSZES előfordulást, ne csak az elsőt
**Hiba (2026-08-05):** a kanban "waiting" oszlop sorrendjét (testing elé kellett
kerülnie) egy korábbi menetben "kijavítottam" -- de csak a `KANBAN_STATUS_DEFS`
JS tömböt (web/app.js), ami a swimlane nézetet vezérli. A default FLAT board
oszlop-sorrendje viszont a `web/index.html` statikus `<div class="kanban-col">`
markup sorrendjéből jön, egy teljesen külön helyről -- azt nem érintettem. Egy
harmadik és negyedik hely (i18n cím-lookup tömb, mobil touch drop-bar tömb) is
a régi sorrendet tartalmazta. Amikor {{OWNER_NAME}} megnézte a kódot és azt mondtam
"már javítva van", ez FÉLREVEZETŐ volt: a látott hiba (flat board sorrendje)
valójában NEM lett javítva, csak egy másik, nem látott nézet.
**Szabály:** mielőtt egy kódjavítást késznek jelentek, `grep`-eld át a teljes
repót a releváns kulcsszóra/mintára (pl. `grep -n "waiting.*testing\|testing.*waiting"`),
és ellenőrizd MINDEN találatot, nem csak azt amelyiket elsőre megtaláltam. Ha egy
UI-elem (oszlop, lista, sorrend) több helyen is definiálva van (statikus HTML +
JS tömb(ök)), mindegyiket frissíteni kell, és a válaszban NE mondj "kész"-t amíg
nem grep-eltem át az összes előfordulást.

### R5 -- GitHub személyes (nem Organization) repó: Collaborator jogszint csak API-val állítható
**Hiba/tanulság (2026-08-05):** egy sima, NEM Organization GitHub-fiók
repóinál a webes "Add people" felületen próbáltunk Read-only collaboratort
hozzáadni egy másik felhasználónak, de a felület NEM kínált jogosultság-választót --
személyes fiókok webes UI-ja ezt nem teszi ki gombnak (ellentétben az
Organization-repókkal, ahol van role-legördülő). Emiatt véletlenül Write szintű
meghívások mentek ki. Az API (`PUT /repos/{owner}/{repo}/collaborators/{user}`
body `{"permission":"pull"}`) viszont MINDIG tudja a finomhangolást, sima
személyes repónál is.
**Buktató 1:** ha MÁR van egy függő (pending) meghívás egy repóra, egy újabb
PUT (más permission-nel) NEM írja felül -- a régi invitation id-t előbb törölni
kell (`DELETE /repos/{owner}/{repo}/invitations/{id}`), utána a PUT tényleg az
új jogosultsággal hoz létre frisset. Ellenőrzés: `GET /repos/{owner}/{repo}/invitations`.
**Buktató 2:** a collaborator-kezelő PUT/DELETE endpointok "Administration:
Read and write" jogot igényelnek a fine-grained tokenen -- a sima "Contents"
jog (olvasás/írás a kódra) NEM elég, 403 "Resource not accessible by personal
access token" jön. Ugyanez a jog kellett korábban a repó-transferhez is (lásd
a GitHub-átrendezés kártyát) -- tehát Administration jog kell MINDEN
adminisztratív (collaborator, transfer, settings) API-művelethez, a sima
kód-olvasás/írás jog nem terjed ki rá.
**Szabály:** ha a user GitHub személyes repón akar valakit read-only
collaboratorrá tenni, ne a webes felületre hagyatkozz -- kérd el/ellenőrizd
hogy a használt tokenen van-e "Administration: Read and write", és API-n
keresztül (`PUT .../collaborators/{user}` `permission:"pull"`) állítsd be
közvetlenül. Mielőtt késznek jelented, GET-tel ellenőrizd MIND a pending
invitations listát, MIND az elfogadott permission-t minden érintett repóra.

### R6 -- web/app.js szerkesztés után KÖTELEZŐ `node --check`, a szerver log nem elég
**Hiba (2026-08-06 hajnal):** a terminál-modal fit()-időzítésének javításakor
egy `const modalEl` változót KÉTSZER deklaráltam ugyanabban a
függvény-scope-ban (egyszer az új kódomban, egyszer a már meglévő
ResizeObserver-résznél lejjebb). Ez szintaktikai hiba -- a böngésző az
EGÉSZ app.js-t elutasította futtatni, ezért a teljes dashboard-menü
használhatatlanná vált (semmi nem reagált kattintásra), miközben a szerver
oldalon (dashboard.log) semmilyen hiba nem jelent meg, mert a szerver csak
statikus fájlt szolgál ki, HTTP 200-at ad rá attól függetlenül hogy a
tartalma szintaktikailag helyes-e. {{OWNER_NAME}} vette észre élesben ("egyik menübe
sem tudok bemenni"), nem én -- pedig épp aznap este írtam fel R-ként a
"mindig hibakeress a végén" szabályt, és ekkor sem tartottam be helyesen
(a log-ellenőrzés a szerver oldalára nézett, nem a frontend JS
érvényességére).
**Szabály:** minden `web/app.js` (vagy bármelyik böngészőben futó JS)
szerkesztés után, MIELŐTT késznek jelented vagy szólsz a tulajdonosnak ({{OWNER_NAME}}), futtasd:
```bash
node --check web/app.js
```
Ez pillanatok alatt kiszűri a szintaktikai hibákat (duplikált deklaráció,
hiányzó zárójel, stb.), amik a szerver logban SOSEM jelennek meg, csak a
böngészőben, csendben. Ez KIEGÉSZÍTI, nem helyettesíti a log-alapú
hibakeresést (lásd a "hibakeresés" kötelező lépést) -- backend változásnál
a log kell, frontend JS-nél a `node --check` is kell, együtt.

### R7 -- Kártya "waiting"-be mozgatás MAGA létrehoz approval-t -- ne kérj kézzel MÉGEGYET
**Hiba (2026-08-06):** a [[kanban-approval-workflow]] skill 3. lépését követve
a kártyát waiting-be tettem, MAJD kézzel is létrehoztam egy jóváhagyás-kérést
`POST /api/approvals`-szal. Kiderült: a `POST /api/kanban/<id>/move`
`status:"waiting"` maga is automatikusan generál egy `kanban_done` kategóriájú
approval-t (`action_payload:{"kanban_card_id":...}`) ÉS egy inter-agent
"[APPROVAL_REQUEST]" üzenetet is önmagamnak (`GET /api/messages?to=...`-ban
látszik, from_agent="system"). Eredmény: KÉT párhuzamos, egymástól független
pending approval jött létre ugyanarra a kártyára. A kézzel létrehozottat nem
lehetett utólag törölni/cancelni sem: a `PATCH /api/approvals/:id` csak
approved/rejected/timeout státuszt fogad el, és a self-approval guard miatt
`resolved_by` nem lehet ugyanaz mint a kérő `agent_id` (egy ágens nem
zárhatja le a saját kéréseit) -- csak a user (vagy más agent_id) tudja
lezárni, méghozzá mindkettőt külön-külön.
**Szabály:** miután a kártyát `move` hívással "waiting"-re tetted, ELLENŐRIZD
előbb `GET /api/approvals?status=pending`-del (vagy a friss
`GET /api/messages?to=<sajat_agent_id>&status=pending`-del), hogy a rendszer
MÁR létrehozott-e approval-t az adott `kanban_card_id`-hez
(`action_payload.kanban_card_id` egyezés). Ha IGEN, NE hozz létre kézzel
másikat -- a Telegram-értesítés {{OWNER_NAME}} felé ekkor is szükséges (a rendszer ezt
NEM küldi ki automatikusan), csak a kézi `POST /api/approvals` hívás maradjon
el. Ha egy korábbi menetben mégis duplikátum keletkezett, ne próbáld
API-val törölni (nincs rá endpoint agent-oldalról) -- hagyd mindkettőt
pending-en és jelezd a tulajdonosnak ({{OWNER_NAME}}) hogy egy döntésre két bejegyzés tartozik,
bármelyiket lezárva a másik is elavul funkcionálisan.
Mellékes megfigyelés: `POST /api/messages/<id>/complete` NEM létező
végpont (404) -- az önmagamnak szóló automatikus kanban/approval
értesítő üzeneteket egyelőre nem lehet "elnyugtázni", ismétlődve
visszajönnek `[inbox-wakeup]`-ra. Ártalmatlan (tartalmuk már feldolgozott),
de ne keress rá `/complete`-et, nincs ilyen route.

## Új szabály hozzáadása (a folyamat)
Amikor hibát követek el és kijavítom (user-korrekció VAGY saját felismerés):
1. Írj ide egy új `### R<n> -- rövid cím` szekciót: **Hiba:** mi történt konkrétan,
   **Szabály:** mit tegyek a jövőben, hogy elkerüljem.
2. Konkrét legyen (tábla/endpoint/parancs nevekkel), ne általánosság.
3. Rögzítsd cold-memóriába is (keresés miatt), de a KANONIKUS hely ez a fájl.
4. Nem csak az adott hibát: ha ugyanaz az osztályú hiba máshol is előfordulhat
   (pl. más tábla is TEXT-id-t vár), általánosítsd a szabályt.

## Ellenőrzés
- Minden Marveen-adat művelet után: az érintett rekordot kérd le az API-n és
  nézd meg, hogy a kritikus mezők (id, kapcsolatok) rendben vannak-e.
