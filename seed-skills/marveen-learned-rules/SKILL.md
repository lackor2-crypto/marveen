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

### R18 -- Az aláírás-kép nyelvi változatonként KÜLÖN áll, semmi nem tükröződik (Boss TG 4119, megfordítja a TG 3975-öt)
**Hiba (2026-10-31):** az aláírás oda-vissza tükröződött az eredeti és a német változat között. A német oldalon más a sortörés, ezért az egyik oldalon jó hely a másikon ráfedett a szövegre, és pontosan beállítani egyiket sem lehetett.
**Szabály:** az aláírás-kép hozzáadása, mozgatása, méretezése, törlése CSAK azt a munkadarabot érinti, amelyiken történt. Nincs tükrözés (`workbench-sigmirror` törölve). Az aláírás-kép továbbra sem része annak, amiből a fordítás készül (`isSignatureImage`): egyik oldali változása nem teszi "régivé" a másikat.
**Mérés:** `workbench-signature-mirror.test.ts` (mozgatás az egyik oldalon, a másik érintetlen) + böngészős próba.

### R19 -- Az elküldött szöveg nem maradhat és nem jöhet vissza a chat-mezőbe, akármelyik út írja (Boss TG 3608, majd TG 4006: "ez a hiba ne jöjjön vissza")
**Hiba (2026-10-31):** az asszisztens chatben elküldés (Enter) után a szöveg a beviteli mezőben maradt; a fotón a diktálás (mikrofon) közben is be volt kapcsolva, és a válasz futott (sorba álló küldés). A diktáló `stop()` után kézbesítette a mondat végét, és visszaírta. A TG 3608 javítás csak a diktálási munkamenet "elfelejtését" fedte, a többi visszaíró utat nem.
**Szabály:** a küldés (Enter és a Küldés gomb is, sorba állva is) KÖTELEZŐEN (1) leállítja a chat-mező diktálását `abort()`-tal (`dictAbortForSend`), (2) rögzíti az elküldött szöveget (`chatNoteSent`), és rövid ideig (4 mp) minden pontosan ezt a szöveget visszaíró változás visszhang, ami kiürül (`chatEchoStrip`, `chatGuardInput`, időzített újranézés). A felhasználó saját gépelése/beillesztése kikapcsolja a kaput, így ugyanaz az üzenet újra elküldhető (nincs rejtett korlát). Új küldő útvonalnál a `chatNoteSent`-et be kell kötni.
**Mérés:** `workbench-chat-sent-not-back.test.ts` + böngészős próba (gépelés, diktálás közbeni sorba álló küldés, IME-visszhang, azonos szöveg újragépelése); a régi kódon a próba pontosan ezt buktatta.

### R20 -- A tulajdonos saját kattintása token módban is saját kattintás: EGY kapu, nem gombonként (Boss TG 4029, harmadszor)
**Hiba (2026-10-31):** a "Véglegesíteni csak te tudsz, a saját kattintásoddal" felirat az átnézés + pipa + "Végleges PDF készítése" után is megjött, mert a véglegesítés kimaradt az #1556 közös kapujából (szándékosan "szigorú" maradt). Ugyanez a gyökérok volt #1512, #1520, #1556 alatt is.
**Szabály:** a felületről jövő tulajdonosi kattintást (session VAGY token + `Sec-Fetch-Site: same-origin`) a `isOwnerOrPageClick` fogadja el, MINDEN ilyen gombnál: véglegesítés (mindkét végpont), érzékeny-kapcsoló, bíróság-szabályok. Új tulajdonos-gombnál ezt használd, ne a nyers `isOwnerClick`-et. Ügynök (token, fejléc nélkül) továbbra is 403. Kivétel marad (külön kérdés): jóváhagyás elfogadása és az azonnali levélküldés.
**Mérés:** `owner-page-click-gates.test.ts` (nincs szigorú `!isOwnerClick(ctx)) return fail`) + böngészős végigkattintás token módban (átnézés, pipa, PDF).

### R21 -- Egy ügyben több hivatalos levél: a levél saját mappát kap, nem másolat-készletet (Boss TG 4025/4045, B opció)
**Hiba (2026-10-31):** a második hivatalos levél (elutasító határozat) munkadarabja az ügymappa ALMAPPÁJÁBA került, de "al-dokumentumnak" számított (`isSubDocumentItem`), így semmilyen szokásos mappát nem kapott, és a fában a közös és a saját sorok keveredtek.
**Szabály:** az ügymappa tartja a KÖZÖS részt (Feltöltések, Agent, közös Mellékletek). Minden hivatalos levél az ügymappa KÖZVETLEN almappájában saját mappát kap, benne CSAK a három saját mappával: Kiváltó irat (az a levél), Elkészített anyagok (a válasz rá), Mellékletek (csak hozzá). Ami szabványos mappán BELÜL van, vagy vita-mappa, az továbbra is al-dokumentum. Kód: `isLetterFolderUnder`, `ensureLetterFolders`. Egyszer készül, a törölt mappa törölt marad.
**Mérés:** `workbench-letter-folders.test.ts` + izolált példányon a fa (a levél mappájában pontosan a három mappa).

### R22 -- "A szavak egyeznek" nem "a dokumentum egyezik"; a tárolt üres sor nem takarhatja az előtöltést; a nyelvválasztó nem ugrat el (Boss TG 4072/4081/4105, "miért jönnek vissza?")
**Hiba (2026-10-31):** nem visszaállítás volt, három külön, javítatlan gyökérok: (1) a PDF-újrahasznosítás csak a SZAVAKAT hasonlította, így egy elmozdított aláírás-kép "nem változott"-nak látszott; (2) a levél-űrlap tárolt, üres sora eltakarta az előtöltést (címzett/tárgy), a tárgykeresés egész bekezdésben keresett, a záró név a tulajdonos beceneve ("Boss") lett; (3) a nyelvválasztó a másik változat munkadarabjára UGRATOTT, ami már véglegesített volt, és üres ablakot nyitott.
**Szabály:** (1) a PDF-egyezést csak kép nélküli dokumentumnál szabad a szavakból megállapítani, kép (hely, méret) mindig újragenerál; (2) ami az űrlapon látszik, az MOST ismert érték legyen (tárolt üres mező nem ír felül ismertet; a tulajdonos által beírt soha nem íródik felül); a záró név a levél aláírója, sosem a tulajdonos beceneve; (3) a nyelvválasztó nem navigál: a választott változat (végleges PDF vagy piszkozat) új lapon nyílik, a tulajdonos marad ott, ahol dolgozott, és a toast kimondja, melyiket nyitotta meg.
**Mérés:** `workbench-refinalize.test.ts`, `workbench-maildraft-prefill-794.test.ts`, `workbench-finalpick.test.ts` + böngészős végigkattintás (nyelvválasztó véglegesített változattal).

### R23 -- Az "Elkészített anyagok" mappába CSAK az kerül, ami ténylegesen ki is ment (Boss, 2026-11-01)
**Hiba (2026-11-01):** a Wohngeld-ügy "Elkészített anyagok" mappájában öt PDF állt: három régi végleges verzió, a magyar változat és a német. Csak a német levél ment ki a hivatalnak e-mailen; a magyar változat csak szerkesztéshez/fordításhoz készült, sehová nem lett csatolva, a régi verziók pedig szemét.
**Szabály:** az Elkészített anyagok mappa a KIKÜLDÖTT (e-mailhez csatolt vagy postán feladott) anyagot tartja, levelenként egy, a legutolsó végleges PDF. (1) A segéd-változat (pl. a magyar mása egy német levélnek), amit nem küldtek el, NEM kerül ide; tartalmilag azonos változatokból csak a kiment marad. (2) Újra-véglegesítésnél a régebbi verzió törlődik, nem gyűlik. (3) Törlés előtt nézd meg a munkadarabot, a nyelvet, az "elküldve" jelölést és a levélpiszkozat csatolmányait, a szövegeket vesd össze (`pdftotext` + `diff`), és jelentsd a törölt fájlok nevét. (4) Külön nyilatkozat vagy más ténylegesen elkészített és kiküldött irat több fájlt is jelenthet.
**Mérés:** a mappa minden fájlja megfeleltethető egy elküldött levélnek/csatolmánynak; nincs két azonos tartalmú vagy régebbi verziójú PDF.

### R24 -- A munkadarab mappájában CSAK a Kontextus és a Teendő fájl lehet; a sima dokumentum DOCX tükre nem kerül a mappába (Boss TG 4278/4282/4287)
**Hiba (2026-11-01):** a Wohngeld-ügy munkadarab mappájában egy ágens írt egy külön „Jogi kontextus" fájlt a Kontextus mellé, a dokumentum DOCX tükre pedig másolatként állt ott, a szülő mappában pedig GPT-kivonat, canvas JSON és két docx-duplikátum.
**Szabály:** (1) a mappában csak a „Kontextus - ….md" és a rendszer gyártotta „Teendő - ….md" lehet; az ágens a tudását a Kontextusba írja (context.append/rewrite), nem új fájlba. (2) A sima (nem Word-ből importált, nem szöveges jegyzet) dokumentumról a rendszer NEM ír másolatot a munkadarab mappájába; a kiküldött anyag az Elkészített anyagok mappába kerül (R23). (3) Törlés előtt a tartalmat a Kontextusba kell vinni, az eredeti `/tmp` alá kerül.
**Mérés:** `workbench-docmirror.test.ts` (nincs másolat), `workitem-folder-files-rule.test.ts`.

### R25 -- Hivatalos levél feje: ablakos boríték, jobbra keretes Feladó, balra Címzett (Boss TG 4542/4543)
**Eset (2026-11-03):** a tulajdonos egy Minijob-levélen kézzel beállította a fejet: a Feladó keretes doboz jobbra fent, a Címzett balra az ablakos boríték ablakában. Kérte, hogy ez minden hivatalos levél (bíróság, hatóság) formája legyen, a skillekben, memóriában, CLAUDE.md-ben, főleg a projekt alatti asszisztenseknél, globálisan beégetve.
**Szabály:** Feladó = `table` blokk, utolsó sora `#w=45&a=l&x=55&y=0&o=1`; Címzett = az első `paragraph`: 4 üres (U+200B) sor, `Címzett:` + sorok, 2 üres sor. Utána hely+dátum, tárgy, megszólítás. Egy forrás: `buildLetterHead()` (`src/workbench-letterhead.ts`), a prompt (`workbench-agent.ts`, `workbench-agent/context.ts`), a `letter-head-sender-recipient` skill és az ágensek CLAUDE.md-je (`ensureLetterHeadSection`) ugyanezt mondja.
**Mérés:** `workbench-letterhead-window.test.ts`, `letterhead-window-rule.test.ts`.

### R26 -- Az összetartozó új munkadarab az eredeti munkadarab mappájába jön létre, a három saját mappát a rendszer adja (Boss, 2026-11-03, "globálisan beégetve")
**Hiba (2026-11-03):** a Minijob-ügy második levelét (DRV Bund Clearingstelle) az ágens a közös csoportmappába hozta létre (öt alapmappával), nem az eredeti munkadarab mappája alá; a tulajdonosnak kellett kézzel áthúznia. Utána az ágens a Wohngeld-minta félreértése miatt kitörölte az Elkészített anyagok és Mellékletek mappát is, pedig a szabály (R21) háromra szól.
**Szabály:** ha egy új munkadarab egy meglévőhöz tartozik (ugyanaz az ügy, második levél, folytatás), `POST /api/workbench/items` `folder` = a meglévő munkadarab mappája, így az alá kerül. A rendszer ilyenkor (R21, `ensureLetterFolders`) csak a három saját mappát adja: Kiváltó irat, Elkészített anyagok, Mellékletek. Ezeket nem töröljük, és a közös mappákat (Feltöltések, Agent, Vitáztatás) nem hozzuk létre hozzá. A munkapad-asszisztens kontextusa is mondja ezt (`SUB_ITEM_RULE`, `src/workbench-agent/context.ts`). Mappát törölni csak a tulajdonos kérésére szabad, és előtte a mintát (R21) kell nézni, nem egy példányt.
**Mérés:** az új alá-munkadarab mappájában pontosan a három mappa van; az eredeti munkadarab mappája alatt áll, nem mellette.

### R27 -- Az üres sor MINDIG önálló üres bekezdés-blokk; soha nem rejtett jel egy szövegen belül (Boss, 2026-11-03: "az üres sorok ne tűnjenek el")
**Hiba (2026-11-03):** az ágens üres sorokat rejtett (zéró szélességű) jellel tett egy többsoros blokk szövegébe (a címzett elé, a biztosítási szám közepére), és egy önálló üres blokkot is tett a felsorolás végére. A szerkesztő mentéskor a rejtett jelet kitörli és a szöveget trimmeli, így a blokkon belüli üres sorok eltűntek, a címzett felcsúszott, a „K 006” pedig mellékletre hivatkozásnak látszott. Az API-val tett üres blokk a lapon üres elemként összeesett, a tulajdonos nem látta ott az üres sort.
**Szabály:** (1) üres sort csak külön, önálló üres bekezdés-blokkal (a `BLANK_LINE` jel egyetlen blokk) szabad tenni, soha nem egy blokk szövegébe, és soha nem szó közepére. (2) A lap egy üres bekezdést ugyanúgy rajzol, mint az Enterrel csináltat: egy `<br>`-t tartalmazó sort (`dpBlankParagraph`, `web/workbench.js`). (3) Ha egy szerkesztésben valami eltűnik, előbb a mentési utat (a szerkesztő olvasása) nézd, ne a szerver tárolását.
**Mérés:** `workbench-blank-line-drawn.test.ts`, `workbench-doc-blank-line.test.ts`, `tw-blank-line-kept.test.ts`.

### R28 -- Hivatalos levél tördelése: a részeket üres sor választja el (Boss TG 4581/4582, 2026-11-03, "beégetve, bármelyik projekt alatt")
**Hiba (2026-11-03):** a Minijob-levélben a dátum, a tárgy, a Munkáltató/Betriebsnummer/Biztosítási szám/Hivatkozás sorok és a megszólítás egybefolytak, üres sor nélkül; az aláírás előtt-után sem volt hézag.
**Szabály:** hely+dátum után üres sor; a Tárgy külön bekezdés + üres sor; a hivatkozás-sorok külön bekezdés, előtte-utána üres sor; megszólítás előtt-után üres sor; törzs-bekezdések között üres sor; a záró formula előtt egy üres sor, utána kb. 3 az aláírásnak, majd a nyomtatott név. Üres sor = U+200B sor. Egy forrás: `LETTER_LAYOUT_RULES_EN` (`src/workbench-letterhead.ts`) -> asszisztens-prompt (workbench-agent.ts, workbench-agent/context.ts), minden ágens CLAUDE.md-je (`buildLetterHeadBody`), sablon, skill `letter-head-sender-recipient`. Figyelő: `letter_spacing_missing` (teendő, nem kapu). A Címzett az ablak helyén kezdődik (TG 4597): ha az asszisztens sima újsorokkal írta, a `trim()` levágta az üres sorokat és a Címzett felülre, a Feladó mellé került; ezért `enforceRecipientWindow()` (`src/workbench-letterhead.ts`) az ágens által írt `Címzett:`-tel kezdődő bekezdésnek automatikusan visszaadja a 4 üres (U+200B) sort (`addBlock`/`updateBlock`, csak `author: 'agent'`).
**Mérés:** `workbench-letter-spacing.test.ts`, `letterhead-window-rule.test.ts`.

### R29 -- Gyorsítótár-fájl csak akkor érvényes, ha teljes: a létezés nem bizonyíték (Boss, 2026-11-03, "a 78M-et nem generálja le a PDF-et")
**Hiba (2026-11-03):** a render forrásfájlja (.fodt) a tartalom hash-e alatt áll. Egy újraindítás (a Marveen frissítése) a fájl írása közben 0 bájtos fájlt hagyott ott. A kód „ha létezik, jó" alapon újrahasznosította, ezért a 78M ugyanazon tartalmából minden alkalommal üres oldal lett (a tartalom és a hash nem változott, így magától sosem javult); a tulajdonos a végleges PDF-et sem tudta elkészíteni.
**Szabály:** (1) hash-alapú gyorsítótár-fájl csak akkor érvényes, ha a mérete a tartalom mérete (`ensureSourceFile`), a PDF-gyorsítótáré pedig, ha nem üres (`usableCachedPdf`); (2) a fájlt ideiglenes néven írjuk és átnevezzük, így félig írt fájl nem kerülhet a végleges név alá; (3) ha egy dokumentum PDF-je üres, a gyorsítótárat nézd (`store/workbench-render/docmodel`, 0 bájtos fájl), ne a tartalmat.
**Mérés:** `workbench-render-source-truncated.test.ts`; `find store/workbench-render -size 0` nem ad találatot.

### R30 -- A fordított levél feje UGYANAZ, mint az eredetié: ugyanott, ugyanakkora (Boss TG 4734/4742, 2026-11-03, "milliméterre pontosan", "globálisan beégetve")
**Hiba (2026-11-03):** a német változatban az Absender tábla balra került és háromszoros szélességű lett, az Empfänger lejjebb ült, mint az eredetiben. Az adat jó volt (`#w=45&a=l&x=55&y=0&o=1` megmaradt), a fordítás oldal rajzolója (`twTableHtml`/`twPageHtml`) a táblát sima, teljes szélességű blokkként rajzolta, és a modell néha levágta a Címzett üres sorait.
**Szabály:** (1) a fordítás oldal a táblát ugyanazokból az adatokból rajzolja, mint a munkadarab oldala (`dpTableParts`): jobbra fent, a szöveg fölött (`wb-tw-tbl-over`), azonos szélességgel; (2) fordításkor a `Címzett:`-tel kezdődő bekezdés üres soraiból pontosan annyi marad, mint az eredetiben (`mirrorRecipientWindow`, `src/workbench-letterhead.ts`); (3) az asszisztens-promptban és minden ágens CLAUDE.md-jében ott a TRANSLATION sor (`LETTER_LAYOUT_RULES_EN`); (4) a fordító sosem fordítja az elrendezés-sort és az üres sorokat.
**Mérés:** `translation-letter-head-same-place.test.ts`; böngészőben a fordított tábla bal széle ugyanaz a törtrésze az oldalnak, mint az eredetié.

### R31 -- A "Fordítás mentése" CSAK ment, sosem fordít újra (Boss TG 4749, 2026-11-03, "égesd be jó mélyen")
**Hiba (2026-11-03):** a Fordítás mentése gomb, ha az eredeti azóta változott ("régi" fordítás), újrafordította az egészet és azt mentette, így a tulajdonos kézzel javított német szövege elveszett (a #840 régi ága).
**Szabály:** a mentés pontosan azt írja, ami a fordítás oldalon áll, kézi javítással együtt, minden fejezetre, aminek van fordítása. Újrafordítást KIZÁRÓLAG az "Újrafordítás" gomb (`twRun`) indít. Szerkesztett tartalmat felülíró "okos" automatika tilos. Kapu: `tw-save-never-retranslates.test.ts` (a `twSave` törzsében nincs `twRun(`).
**Mérés:** böngészőben kézi szöveg után mentés: 0 translate-preview hívás, a kézi szöveg megmarad.

### R32 -- Az eredeti és a fordítás oldala UGYANAZ a szélesség és négy oldali margó (Boss TG 4778, 2026-11-03)
**Hiba (2026-11-03):** a fordítás oldala 28/30 px belső margót kapott, az eredeti 56/64/72/72 pxet, ráadásul a három oszlopos nézetben a fordítás kártyája oldalpaddinggel és kerettel még 27 pxet elvett a szélességből: más helyre törtek a sorok, a két oldal szétcsúszott.
**Szabály:** `.wb-dp-page` és `.wb-tw-page` ugyanazt a `--pg-pt/pr/pb/pl` négyest és a `width: min(100%, 794px)` szélességet használja, a keskeny nézet felülírása is közös; az oszlopok egyforma szélesek (`.wb-tw-cols.has-both`), a fordítás kártyájának nincs saját oldalpaddingje/kerete (árnyék a keret, a többi elem van beljebb húzva). Új margó csak EGY helyen változhat, mindkét oldalon. Kapu: `translation-page-same-margins.test.ts`.
**Mérés:** böngészőben 3 oszlopos nézetben mindkét oldal 434 px széles, padding 72/64/56/72 mindkettőn.

### R33 -- A tulajdonos állítása készpénz: levélből kivenni "bizonyíték hiánya" miatt TILOS (Boss, 2026-11-06, kiabálva, harmadszor)
**Hiba (2026-11-06):** a LSG L7 AS 450-26 észrevételekből az ágens kivette a "skizofréniában szenved" mondatot, mert "orvosi irat nincs csatolva", és ezzel megint a tulajdonos szavát kérdőjelezte meg (mint a jogszabálynál, a "Munkadj"-nál, a Karacs-szerepnél). Pedig az orvosi irat megvolt (Család/Bakos Éva/Egészség/Anyu pszichiáter papirja német.pdf), és a tulajdonos a saját élethelyzetét ismeri.
**Szabály:** amit a tulajdonos tényként kimond (betegség, ki mit végzett, összeg, esemény), azt a szövegbe beírjuk, és úgy kezeljük, mintha igaz és bizonyított volna. Forrásnak a `doc.addClaim` `kind: "owner"` elég. TILOS kivenni, enyhíteni vagy "nincs rá bizonyíték" miatt átfogalmazni a saját döntésünkből; ha a bíróság papírt kér, akkor adjuk. Ha kockázatot látunk (ellentmondás más beadvánnyal, az ellenfél megtámadhatja), azt a chatben JELEZZÜK, de a szöveget nem húzzuk ki. Kivenni csak a tulajdonos kifejezett kérésére szabad. Ugyanez áll a jogszabályra/ítéletre (hivatalos forrásból vett = tény) és minden más tényre.
**Mérés:** a vázlatban a tulajdonos által kimondott tények megvannak; a kockázat külön, a chat-jelentésben szerepel, nem a levél szövegének csonkításában.

### R34 -- Saját e-mail fiók címe SOSEM címzett; a záró formula alatt a levél aláírója áll (Boss TG 5283, 2026-11-07, "globálisan beégetve")
**Hiba (2026-11-07):** a véglegesített német levél e-mail piszkozatában a címzett a tulajdonos SAJÁT címe volt (a levél/kontextus első címe), a szövegben kétszer állt a "Mit freundlichen Grüßen", az aláíró neve (Bakos Éva) hiányzott: a záró formulát névnek vette a rendszer, az aláírás-kép blokk pedig elrejtette a nevet.
**Szabály:** a Marvinban beállított összes levelező fiók címe (`sendingAccounts()`, a Google is) kizárt címzett és másolat: `ownMailAddresses()` / `firstForeignAddress()` / `withoutOwnAddresses()` a `workbench-maildraft.ts`-ben. A címzett-keresés (chat, kontextus, levél, forrás-változat, tárolt sor) mind ezen át megy, a `saveMailDraft` `own_address` hibával visszautasítja, a felület ember-mondatot ad. Elsőként az számít címzettnek, amit a tulajdonos a chatbe vagy a kontextusba írt. Az aláíró (`letterSignatory`): a záró formula (`CLOSING_LINE`) sosem név, a képblokkot átlépi, egyedül álló záró formula alatt nincs név (a fölötte lévő törzsszöveg nem az), tartalék az Absender/Feladó blokk neve. Új címforrás vagy új záró formula csak ezeken a közös helyeken kerülhet be. Kapu: `workbench-maildraft-own-address-871.test.ts`.
**Mérés:** böngészőben: a címzett az idegen cím, a törzsben a záró formula egyszer, alatta "Bakos Éva"; saját cím beírására: "Ez a cím a saját e-mail fiókjaid egyike...".

### R35 -- A melléklet CÍME a dokumentum nyelvén áll: német levél német melléklet-címet kap (Boss, 2026-11-08, "majdnem kinyomtattam")
**Hiba (2026-11-08):** a német változat (LSG L7 AS 450-26 Stellungnahme) mellékleteinek külső lapja "Anlage K1" volt, alatta viszont a MAGYAR cím ("Postbank-kivonat, Bakos Éva: kifizetések Botond Péternek ... (18 átutalás)"). A tulajdonos majdnem kinyomtatta/elküldte. Ok: a nyelvi változatnak nincs saját mellékletlistája, az eredetiét használja (`annexOwnerId`), így a címe is az eredeti magyar címe volt, és a változatban nem volt hova átírni (`updateAnnex` változaton `INHERITED` hibát adott).
**Szabály:** (1) minden melléklet címe a DOKUMENTUM nyelvén van, mert ez kerül a külső lapra az "Anlage K1" / "K1. melléklet" / "Annex K1" alá. (2) A nyelvi változatnak SAJÁT címe van mellékletenként (`wb_doc_annex_titles`; a lista, a fájlok és a sorrend az eredetié): `doc.updateAnnex {annex, title}` a VÁLTOZATON ezt állítja, a magyar cím csak tartalék. (3) Nyelvi változat készítésekor vagy befejezésekor a melléklet-címeket UGYANABBAN a lépésben le kell fordítani és beállítani; amíg egy cím más nyelvű, a változat nem "kész". (4) Gép is figyeli: `annexTitleLanguageIssues()` (`workbench-docannex.js`, egy nyelvre jellemző szavak alapján) -> az ellenőrzés `annex_title_language` tétele (teendő a listán), és az `annexPdfs()` (a külső lapok gyártója: véglegesítés, e-mail melléklet, csomagmappa) NEM készít semmit, `annex_title_language` hibával áll meg, amíg a cím nyelve nem stimmel. (5) Új nyelv vagy új szó a felismerőbe: `TITLE_WORDS` a `workbench-docannex.ts`-ben. Véglegesített (zárolt) változat címét csak az újranyitás után lehet átírni; a tulajdonos nyomja az Újranyitást, az ágens nem kerüli meg.
**Mérés:** `workbench-doclang.test.ts` ("the annex title is in the document's language"): a magyar cím német levélben találat, a német cím nem, a változat saját címe nem írja át az eredetit, az `annexPdfs` megáll; böngészőben a külső lap német címet mutat.

### R36 -- Az üres sor SOR: sehol nem vágható le, se a szöveg fölött, se benne, se alatta (Boss TG 5986, 2026-11-12, "végérvényesen", "globálisan beégetve")
**Hiba (2026-11-12, sokadszor):** a levél Címzett blokkja felugrott a Feladó mellé, mert a fölötte álló 4 üres sor eltűnt. Ok: a munkadarab oldala mentéskor kidobta az üres sor jelét (U+200B), a szerver pedig minden blokk szövegén `trim()`-et futtatott (addBlock, updateBlock, proposeRewrite, fordítás), így az üres sorok az oldal ELSŐ mentésénél elvesztek. A korábbi javítások (#565, #838, #851) mindig csak egy helyen tették vissza.
**Szabály:** egy dokumentum-blokk szövegében az üres sor ugyanolyan sor, mint amiben írás van: ha a tulajdonos Entert (vagy Shift+Entert) nyom, az ott marad. EGY közös szabály van rá: szerveren `blockText()` / `canonLineParts()` (`src/workbench-blanklines.ts`), böngészőben ugyanaz betűre (`dpCanonParts` / `dpCanonText` a `web/workbench.js`-ben). Az üres sor egyetlen U+200B karakterként tárolódik. Blokk szövegét író kód SOHA nem hív kézzel `trim()`-et és nem szedi ki az U+200B-t: a `blockText()`-en megy át. Ez minden dokumentumfajtára áll (munkadarab oldala, fordítás-oldal, nyelvi változat, asszisztens által írt blokk, Word-import, PDF és Word kimenet).
**Mérés:** `npx vitest run src/__tests__/blank-line-is-a-line.test.ts` (a szabály, a böngésző-szerver azonosság, és az, hogy egy író sem vág kézzel); böngészőben: gépelés + mentés után a Címzett blokk 4 üres sora megvan, a piszkozat PDF-ben a Címzett a Feladó ALATT áll.

### R37 -- Egy cellát szélesebbre húzni auto-layout táblán átméretezi az EGÉSZ táblát
**Hiba (2026-08-07):** a Jóváhagyások táblán egy sor leírás-cellájának
kattintásra kinyíló állapota `max-width:280px -> 420px`-re nőtt. A tábla
(`.ssh-table`, `table-layout` nincs rajta beállítva, alapértelmezett `auto`)
emiatt ÚJRASZÁMOLTA az összes oszlop szélességét a legszélesebb cella
alapján -- a kattintott sor kinyitásakor a TELJES tábla látványosan
átméreteződött, nem csak az a sor. Boss vette észre ("ha rákattintok az
egyikre hogy nyíljon ki, az össze[s] kisebb nagyobb lesz").
**Szabály:** ha egy tábla-cella tartalma állapottól függően változik
(kinyit/becsuk, hosszú/rövid szöveg), és a táblának NINCS `table-layout:
fixed`-je, SOSE változtasd a cella `max-width`/`width` értékét a két állapot
között -- tartsd fixen, és csak a `white-space`/`word-break` értékét
váltogasd (a sor magasabb lesz, nem szélesebb). Ha a cellának valóban
szélesebbnek KELL lennie kinyitáskor, akkor előbb tedd rá a táblára
`table-layout: fixed`-et és explicit oszlopszélességeket, különben minden
más oszlop is ugrálni fog vele.

### R38 -- Teljesítmény- vagy funkció-kapcsolót MAGADTÓL kikapcsolni TILOS

**Hiba:** valaki (ágens vagy terminál) 2026-08-10-en letrehozta a
`~/.local/share/marveen-himalaya/disable-imap-direct` marker-fajlt. Ez egyetlen
fajl letezesevel kikapcsolta a direct-IMAP gyorsutvonalat MINDHAROM helyen
(level-body, mappalista, levellista), igy minden level ujra a himalaya CLI-n at
jott, ami MINDIG a teljes levelet letolti, mellekletestul. Ket napig lassu volt
minden: egy 55 karakteres level 22 MB-os mellekettel 37,2 masodperc helyett
0,8 masodperc lett volna. Semmi nem naplozta, semmi nem mutatta a dashboardon,
es csak akkor derult ki, amikor Boss panaszkodott. Boss dontese: "toroljuk ki
azt a lehetoseget, hogy soha az eletben ne tudjak azt kikapcsolni".

**Szabály:** egy meglevo teljesitmeny-gyorsutvonalat, funkciot vagy vedelmet
NEM kapcsolhatsz ki sajat hatarozatbol -- se kill-switch fajllal, se env
valtozoval, se flag atirasaval -- CSAK ha a tulajdonos kifejezetten engedelyezi.
Ha diagnosztizalas kozben ideiglenesen kikapcsolsz valamit: (1) a SAJAT fordulod
vegen allitsd vissza, (2) ha megis bent marad, azonnal szolj Telegramon es vedd
fel kanban kartyara, (3) SOSE hagyd ott csendben. Ha egy kapcsolo tenylegesen
karos (mint ez volt), a helyes lepes nem a hasznalata, hanem a MEGSZUNTETESE:
az automatikus, keresenkenti fallback (a helper null-t ad hibara) mindig
biztonsagosabb, mint egy kezi, mindent-egyszerre kikapcsolo gomb.

### R39 -- Kanban lekérdezésnél NE `sqlite3` CLI, a gép nem garantáltan tartalmazza
**Hiba (2026-08-22):** heartbeat közben mai lejáratú kanban kártyát kerestem
`sqlite3 store/claudeclaw.db "SELECT ..."` paranccsal -- exit 127, a `sqlite3`
bináris nincs telepítve ezen a gépen. Elsőre néma hibát okozott volna, ha nem
nézem meg az exit kódot.
**Szabály:** kanban/DB lekérdezéshez ELSŐDLEGESEN a dashboard API-t használd
(`GET /api/kanban` + helyi szűrés Python/jq-val), ne közvetlen `sqlite3` hívást
-- a CLI jelenléte gépfüggő, az API mindig elérhető amíg a dashboard fut.
