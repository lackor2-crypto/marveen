---
name: marveen-learned-rules
description: Élő szabály-gyűjtemény a Marveen-en elkövetett hibákból. MINDEN Marveen-adat/dashboard/DB művelet ELŐTT nézd át a vonatkozó szabályt, hogy egy már egyszer elkövetett hibát ne ismételj meg. Error->recovery után ide KÖTELEZŐ új szabályt írni.
scope: global
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

### R8 -- Ami csak EZEN a telepítésen működik, az NINCS kész

**Hiba (2026-08-21):** az egységes életfa háttere teljesen elkészült -- a
személyek/cégek szerkesztése ellenőrzéssel, emberi hibaüzenetekkel --, de
KIZÁROLAG `POST /api/life/config`-on át volt elérhető. Itt ez nem tűnt fel,
mert a fa lakóit én írtam be API-ból. Egy frissen telepített Marveenben viszont
a felhasználó (aki nem programozó) semmit sem tudott volna kezdeni vele: üres
fa, és semmilyen felület, amivel feltölthette volna.

Ugyanebben a munkában két testvérhiba is előkerült: a beállító doboz elrejtőzik,
amint a fa áll (utána már nem lehetett volna új családtagot felvenni), és a
`_depoPost` a szerver `error` KÓDJÁT dobta tovább az emberi `message` helyett --
a felhasználó a "bad_config" szót látta volna.

**Szabály:** minden funkciónál végezd el a friss-telepítés próbát: üres `store/`,
üres adatbázis, a te adataid sehol -- **végig tudja csinálni a felületről,
terminál és API nélkül?** Ha nem, a munka nincs kész. Ellenőrizd külön:
(1) van felület minden beállításhoz, a KÉSŐBBI módosításhoz is;
(2) az üres kezdőállapot magától indul, és nem hibaüzenetnek látszik;
(3) van előnézet a visszafordíthatatlan lépés előtt;
(4) a felület a `message` mezőt mutatja, nem az `error` kódot.

Részletesen: `fresh-install-usable` skill + CLAUDE.md „FRISSEN TELEPÍTETT
MARVEENBEN IS MŰKÖDJÖN".


### R9 -- Elnevezés: KÉT zóna van, és a rossz zóna NÉMÁN hibázik

**Honnan jött (2026-08-24, Botond Péter, {{OWNER_NAME}} továbbította):** „Normál esetben a gép
is a slugos konvencióra törekszik. De szóközt soha ne használj könyvtárnevekben.
Meg speci karaktert. A szóköz miatt külön paraméternek veszik a parancsok. [...]
Aztán ha valami újat csinál, akkor azok alapján hozza létre."

**Szabály -- LÉTREHOZÁS ELŐTT döntsd el, melyik zónában vagy:**

| Zóna | Hol | Mi jár | Mi tilos |
|---|---|---|---|
| **Ember-zóna** | életfa, dokumentumok, bármi amit EMBER olvas | ékezet és szóköz **rendben**, sőt kötelező: a mappanév a felület nyelvét követi | vezető kötőjel (a parancsok kapcsolónak nézik), és a shell saját jelei: `$ \` ; & ! # ( ) ' " [ ] { } * ? ~` |
| **Gép-zóna** | `GIT_REPOS` és minden alatta, repó- és ágnév, script, fájlnév amihez gép nyúl, URL-részlet | `kisbetű-kötőjel` slug | ékezet, szóköz, nagybetű, bármilyen speciális jel |

**A zónát a SZÜLŐ útja dönti el**, nem a készülő elem sajátja -- különben magát a
`GIT_REPOS` mappát is slugosítani akarnánk, holott annak a neve szándékosan fix.

**Miért nem elég a gondos idézőjelezés.** Botond azt írja, „ékezet lényegében nem
baj". A mérés ennek ellentmond. 2026-09-05-én újramérve (nem emlékezetből):
`cmd.exe /c "echo árvíztűrő"` -- a bemenet UTF-8 (`á` = `c3 a1`, `ű` = `c5 b1`),
a kimenet egybájtos OEM (`á` -> `a0`, `ű` -> `fb`, `ő` -> `8b`). Vagyis a
`cmd.exe` **átírja** az ékezetet, és **hibaüzenetet nem ad** -- ugyanez tette
tönkre az MT4-költözésnél a `.bat` útvonalát. A némaság a rossz benne:
hibaüzenetre valaki utánanéz, rossz útvonalra nem.

**Ikon: soha ne találj ki.** A konvenció `src/naming-conventions.ts`
(`iconForKey` / `iconForFolderName`), és a kulcs a **gépi** név (`legal`), nem a
lemezen látszó (`Jogi` / `Legal`) -- az nyelvfüggő. Amire nincs szabály, az a
semleges mappa-ikon; kitalált ikon nincs.

**Gépi út (ne fejből ellenőrizd):**
- kódból: `checkNameForPath(szuloRel, nev, lang)` -> `{ ok, zone, suggestion, message }`
- felületről / API-ból: `GET /api/life/name-check?parent=...&name=...`
- a `mkdirLife` / `renameLife` sikeres eredménye mellett is jön `notice` +
  `suggestion`, ha a név később bajt csinálna

**NEM TILTUNK, TANÁCSOLUNK.** A művelet sikerül, a felhasználó pedig lát egy
mondatot és egy javasolt nevet. A saját fájában joga van szóközös nevet adni.

**A nulla itt is két dolgot jelent.** Ha „nem találsz vonatkozó szabályt", külön
kell tudnod, hogy tényleg nincs rá szabály, vagy ez a skill be sem töltődött.
Amíg ezt a sort olvasod, a skill betöltődött. Ha egy ügynök úgy nyilatkozik,
hogy „nincs elnevezési szabály", az **csak** akkor igaz, ha ezt az R9-et látta és
tényleg nem vonatkozik az esetre -- különben a skillt nem érte el, és azt kell
mondania, nem azt, hogy nincs szabály.


### R11 -- Egy munkadarabhoz EGY nyilvántartó JSON tartozik: a `marveen-item.json`
**Hiba (2026-10-15, Boss):** a Wohngeld munkadarab mappájában egy törölt munkadarab
sírköve (`marveen-item.json`, `"tombstone":true`) árválkodott a `.canvas.json` mellett,
és a tulajdonos nem értette, minek két json fájl.
**Szabály:** a munkadarab mappájában a `marveen-item.json` a munkadarab SAJÁT
nyilvántartó fájlja (a benne lévő `id` az övé). Másik munkadarab fájlját vagy
sírkövet nem teszel mellé, és nem hozol létre kézzel extra `.json` fájlt. A
`.canvas.json` / `.deck.json` a munkadarab TARTALMA, azt nem törlöd ezen a címen.
Ha más `id`-jú `marveen-item.json`-t látsz a mappában, szólj a tulajdonosnak.
Kódból: `src/workbench-snapshot.ts`.


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

### R12 -- Munkadarab-JSON a projekt gyökerébe SOHA (#679)
**Hiba (2026-10-17, Boss TG 9425/9427):** a Tőzsde projekt gyökerében ott állt egy `uj-prezentacio.deck.json`. A pptx-import a deck JSON-t a forrásfájl mappájába írta, ami a projekt gyökere volt.
**Szabály:** `.deck.json` / `.canvas.json` / `.timeline.json` / `marveen-item.json` csak munkadarab-mappába kerülhet. A `writeProjectFile` `json_outside_item` hibával visszautasítja a gyökérbe írást, az `itemJsonFolder` és a draft-store üres célmappánál a munkadarab-dobozra esik vissza. Új írási útnál a célmappa ellenőrzése kötelező, ne a forrásfájl mappájából következtess.
**Mérés:** a munkadarab-mappát a `marveen-item.json` jelzi (a projekt gyökerében csak `.marveen-id` van), ne a `.marveen-id` alapján szűrj.

### R13 -- Linkelt/hivatkozott tartalmat SOHA ne vedd üresnek: kövesd a linket
**Hiba (2026-10-18, Boss TG):** A Munkapad "Mellékletek" FIZIKAI mappáját `ls`-sel üresnek láttam (csak `.marveen-id`), és tényként állítottam Bossnak, hogy a másolatok törlése adatvesztés, "mert a Mellékletek üres". Valójában a 13 melléklet REGISZTRÁLT ANNEXKÉNT (`wb_doc_annexes`, `life_rel`) az EREDETI fájlokra mutatott máshol az életfában. A fizikai mappa üres volt, mégsem volt üres. Boss javított.
**Szabály:** Ha valami linkelt/hivatkozott (annex, belinkelt fájl, referencia, DB-bejegyzés), SOHA ne vedd üresnek a fizikai mappa vagy a találatszám alapján. Kövesd a linket, nézd meg MIRE mutat és tényleg megvan-e, és úgy vedd, mintha ott lenne a mappában. Nem-nulla mappa / van bejegyzés -> TILOS azt mondani, hogy "nincs ott semmi" (különben duplikáció vagy hibás döntés). Ez a "NULLA két dolgot jelenthet" kiterjesztése a hivatkozás-követéssel.
**Mérés:** a Munkapad mellékleteknél a `wb_doc_annexes` tábla / a munkadarab snapshot (`marveen-item.json` `tables`) / a Munkapad annex-nézet a forrás, NEM a fizikai mappa listázása.

### R14 -- Halott/kvótás ügynökre nem osztunk; ami rajta ragadt, elvesszük
**Hiba (2026-10-18, Boss TG):** Az ütemező egy kvótás (halott) ügynökre (lackor3) osztott ki 4 feladatot, és végtelenül retry-zett rá (1160/824/711/261 próbálkozás), Telegram-spammel. A kvóta-blokkolt session pane-je sosem lett "busy" (parked), ezért a retry nem állt le magától.
**Szabály:** Munka kiosztása ELŐTT -- manuális delegálás ÉS ütemezett/automatikus kiosztás egyaránt -- élő forrásból ellenőrizd, él-e a címzett (`GET /api/agents/availability`: `reason` != `quota`/`stopped`, `resetsAt` nem a jövőben). Halottnak NE ossz, ne retry-zz rá a végtelenségig. Ha menet közben hal meg (token elfogy) és ott ragad a munka, utólag is: vedd el tőle és add élő ügynöknek (vagy a fő ágens végezze). Beragadt ütemezett retry visszavonható: `DELETE /api/schedules/pending/<id>`.
**Mérés:** `GET /api/schedules/pending` megmutatja a beragadt retry-ket (`attemptCount`, `lastReason`, `agentName`).

### R15 -- Rejtett korlátozást SOHA nem építünk be (Boss TG 3856, törvény)
**Hiba (2026-10-31, Boss TG):** Három kérésnél is magamtól épített korlát állta Boss útját: a melléklet csak az Életfából csatolható (#716), a Munkapad chat 8000 karakternél vágta a beillesztést, és a projekt-mappákba nem lehetett fájlt linkelni. Boss mindháromnál ugyanazt kérdezte: „Miért? Mi bajt okoz?"
**Szabály:** Fejlesztésnél (mappa, dokumentum, melléklet, bevitel, bármi) önmagadtól NE építs be korlátot, tiltást, méret- vagy hely-határt. Ha szerinted egy korlát NAGYON fontos (nélküle tényleges hiba/kár van), ELŐBB jelezd a tulajdonosnak a csatornáján („ezt a korlátot szeretném beletenni, ezért: ..."), és csak az engedélyével told be; a felület kimondja, mi a korlát és miért. Szembejövő rejtett korlátot jelezz és vedd le.
**Mérés:** kódoláskor keress `refuse` / 409 / `max` / `limit` / `only` / „csak" jellegű új ágat a saját diffedben: mindegyikre kell tulajdonosi engedély.

### R16 -- A hibát a GYÖKERÉNÉL javítjuk, minden előfordulásánál egyszerre (Boss TG 3948, törvény)
**Hiba (2026-10-31, Boss TG):** A "Megerősítem" gomb 403-at adott tokenes megnyitásnál; ugyanez a hiba már kétszer előjött más gombnál (#1512, #1520), mert mindig csak az éppen bejelentett gombot javítottuk, a közös szabályt (egy session-only ellenőrzés) nem.
**Szabály:** Ha a tulajdonos egy gombot/funkciót javíttat, ELŐBB keresd meg, hol használatos még ugyanaz a szabály, függvény, ellenőrzés, kirajzoló vagy CSS (grep a teljes kódban: szerver, frontend, tesztek, sablonok), és a KÖZÖS okot javítsd, ne az egyes példányt. A javítás után sorold fel, mely további helyekre hatott, és mindegyiket próbáld ki. Ha két helyen ugyanazt másolva találod, vond össze egy közös forrásra.
**Mérés:** `grep -rn` a hibás feltételre/függvényre a javítás előtt és után; a darabszám a javítás után 0 (vagy indokolt kivétel), a kész-üzenetben szerepel, mi mindenre hatott.

### R17 -- Sorrendről SOHA nem kérdezünk, ha több dolgot kért: mindet megcsináljuk (Boss TG 3953, törvény)
**Hiba (2026-10-31, Boss TG):** A tulajdonos több javítást kért, és megkérdeztem, melyikkel kezdjem. Válasza: „mindegy, mert mindet meg kell csinálni, a sorrend sosem számít, ilyet legközelebb ne is kérdezz."
**Szabály:** Ha a tulajdonos több feladatot, hibát vagy gombot említ, MINDET elvégzed. A sorrendről nem kérdezel: rutin döntés, magad választasz. A sorrend-kérdés nem „kötelező visszakérdezés": az csak kétértelmű MIT/MIN/mekkora esetén áll.
**Mérés:** a válaszban nincs „melyikkel kezdjem" kérdés; a kész-üzenet mind a kért elemet felsorolja.

### R18 -- Az aláírás oda-vissza tükröződik az eredeti és a nyelvi változat között (Boss TG 3975/3977, "beégetve")
**Kérés (2026-10-31):** ha az aláírást a magyarra teszi, kerüljön a fordításra is, és ha a fordításra, kerüljön a magyarra is.
**Szabály:** az aláírás-kép (fájlnevében: aláírás/alairas/signature/unterschrift/szignó) hozzáadása, mozgatása, méretezése és törlése KÖTELEZŐEN átmegy a másik oldalra, az oldal-mentés, a fordítási oszlop mentése és minden blokk-művelet közös útján (`src/workbench-sigmirror.ts`, `mirrorSignaturesFrom`). Az aláírás NEM része a fordítás ujjlenyomatának (`sectionHash`, kliensen `twSig`), különben a fordítás "elavult" lenne tőle. Új szerkesztő-útvonalnál a tükrözést oda is be kell kötni.
**Mérés:** `workbench-signature-mirror.test.ts` + böngészős végigpróbálás mindkét irányban.

### R19 -- Az elküldött szöveg nem maradhat és nem jöhet vissza a chat-mezőbe, akármelyik út írja (Boss TG 3608, majd TG 4006: "ez a hiba ne jöjjön vissza")
**Hiba (2026-10-31):** az asszisztens chatben elküldés (Enter) után a szöveg a beviteli mezőben maradt; a fotón a diktálás (mikrofon) közben is be volt kapcsolva, és a válasz futott (sorba álló küldés). A diktáló `stop()` után kézbesítette a mondat végét, és visszaírta. A TG 3608 javítás csak a diktálási munkamenet "elfelejtését" fedte, a többi visszaíró utat nem.
**Szabály:** a küldés (Enter és a Küldés gomb is, sorba állva is) KÖTELEZŐEN (1) leállítja a chat-mező diktálását `abort()`-tal (`dictAbortForSend`), (2) rögzíti az elküldött szöveget (`chatNoteSent`), és rövid ideig (4 mp) minden pontosan ezt a szöveget visszaíró változás visszhang, ami kiürül (`chatEchoStrip`, `chatGuardInput`, időzített újranézés). A felhasználó saját gépelése/beillesztése kikapcsolja a kaput, így ugyanaz az üzenet újra elküldhető (nincs rejtett korlát). Új küldő útvonalnál a `chatNoteSent`-et be kell kötni.
**Mérés:** `workbench-chat-sent-not-back.test.ts` + böngészős próba (gépelés, diktálás közbeni sorba álló küldés, IME-visszhang, azonos szöveg újragépelése); a régi kódon a próba pontosan ezt buktatta.
