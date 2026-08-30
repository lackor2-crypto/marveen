---
name: kanban-card-creation
description: KÖTELEZŐ eljárás minden új kanban kártya létrehozásakor -- címke nélküli kártya soha nem jöhet létre, és kapcsolódó kártyát mindig be kell linkelni. Trigger -- bármikor amikor POST /api/kanban-ot hívnál, vagy {{OWNER_NAME}} ad egy feladatot amit fel kell venni a táblára.
scope: global
---

# Kanban kártya létrehozása -- címke és kapcsolat KÖTELEZŐ

## Miért van ez a skill

2026-08-08: {{OWNER_NAME}} többször (már "százszor") jelezte, hogy címke nélküli
kártya soha nem létezhet, mégis ismétlődően előfordult (4 kártya is
címke nélkül maradt egyszerre: OpenRouter/Token Monitor hiba, seed-skills
migráció, seed-skills alkönyvtár-bug hatásvizsgálat, arany-elemzés skill).

Gyökér volt: a `POST /api/kanban` végpont MAGA NEM vette fel a label-t --
a kártya és a címke két KÜLÖN API-hívás volt (`POST /api/kanban` majd
`POST /api/kanban/<id>/labels`). Ha a második lépés kimaradt vagy egy
másik feladat közbeszólt, a kártya csendben címke nélkül maradt.

**2026-08-10 óta ez a rés BE VAN ZÁRVA a szerverben** ({{OWNER_NAME}}: "erősítsd
meg valahol, ne történjen ilyen többet", miután megint találtunk címke
nélküli kártyát). A `POST /api/kanban` mostantól `400`-zal ELUTASÍTJA a
címke nélküli kártyát, és a `labels` mezőt a kártyával EGYÜTT, egyetlen
hívásban veszi fel -- így nem létezhet olyan pillanat, amikor a kártya
már megvan, a címke még nem. Nem a memóriádon múlik többé.

Egy másik, önmagában is súlyos hiba ugyanebből az esetből: a "Skill:
30-percenkénti arany elemzés" kártyát először `marveen_fejlesztese`-nek
címkéztem, mert Marvin-skilleket (windows-desktop-screenshot stb.)
építettem hozzá -- ez ROSSZ. A cimkézés nem azt kérdezi "Marvin-eszközzel
épült-e", hanem "kinek/minek szól maga a FELADAT": a tőzsdei elemzés
{{OWNER_NAME}} SZEMÉLYES ügye (ő kérte, neki/Kiss Zoltánnak szól), tehát
`szemelyes`, függetlenül attól hogy Marvin-infrastruktúrát használtam
a megépítéséhez. Lásd lent a döntési szempontokat.

## Eljárás -- MINDEN kártyánál, kivétel nélkül

1. Állítsd össze a kártya adatait (title, description, priority, project).
2. **Döntsd el a címkét, MIELŐTT létrehoznád a kártyát.** A négy
   (vagy {{OWNER_NAME}} által bővített) címke közül válassz:
   - `marveen_fejlesztese` -- MAGÁNAK a Marvin/Marveen rendszernek
     (kód, dashboard, memória, kanban, csatornák) a fejlesztése/hibája.
     A kérdés: "ez Marvin-t magát javítja/bővíti?" -- NEM az, hogy
     "Marvin-eszközzel csináltam-e".
   - `iroda_fejlesztese` -- az Iroda workspace-hez (email, céges munka)
     kötődő fejlesztés.
   - `szemelyes` -- {{OWNER_NAME}} személyes ügye/kérése, akkor is ha Marvin
     skilleket/automatizálást építettem hozzá (pl. tőzsdei elemzés,
     családi/magánügy).
   - `botond` -- Botond/Freeber-projekthez kötődő tétel.
   - Ha {{OWNER_NAME}} új kategóriát nyit, azt is ide vedd fel referenciaként.
3. **Ha a döntés NEM egyértelmű 100%-osan** (bármi kétely van, akár
   halvány is): **NE találgass, NE dönts magadtól.** Kérdezd meg
   {{OWNER_NAME}}-ot Telegramon egy rövid, konkrét kérdéssel (pl. "Ez a kártya
   [X] -- iroda_fejlesztese vagy marveen_fejlesztese?"), és VÁRD MEG
   a választ mielőtt létrehoznád a kártyát. Csak akkor dönthetsz
   magad, ha a besorolás annyira nyilvánvaló, hogy nincs benne kétely.
4. Hozd létre a kártyát a címkével EGYÜTT, egy hívásban -- a `labels`
   tömb id-t VAGY nevet is elfogad:
   ```bash
   curl -s -X POST http://localhost:{{WEB_PORT}}/api/kanban \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     -d '{"title":"...","description":"...","status":"planned","labels":["marveen_fejlesztese"]}'
   ```
   A válasz visszaadja a felvett címkéket: `{"ok":true,"id":"...","labels":["d52715fe"]}`.
5. Ha `400`-at kapsz ("Címke kötelező" vagy "Ismeretlen címke"), a kártya
   NEM jött létre. Ne próbáld megkerülni: válassz a hibaüzenetben felsorolt
   címkék közül, vagy kérdezd meg {{OWNER_NAME}}-t (3. lépés).
6. Alfeladatnál (`parent_id`) nem kell címkét megadni: a szerver a szülő
   kártya címkéit örökli rá.

## Kapcsolódó kártyák felderítése -- KÖTELEZŐ, a létrehozás UTOLSÓ lépése

{{OWNER_NAME}} 2026-08-10: "amikor létrehoz egy kártyát, az első vagy az utolsó pont,
és csak akkor lehet lezárni, ha ezek megvannak". Egy kártya sem hagyható
magára, ha van hozzá tartozó másik.

**Miért:** az email-témában egyetlen szülő-kártyához öt másik tartozott, és
egyikről sem lehetett a másikra jutni. {{OWNER_NAME}} ebből azt a következtetést vonta
le hogy talán össze kellene vonni őket -- pedig nem az összevonás hiányzott,
hanem a látható kapcsolat. Ugyanezt a hibát a Szakértő is elkövette öt perccel
azután hogy megírta a linkelő funkciót: a Chrome-autofill kártyát `#46`-ként
hivatkozta be, sorszámmal, és az akkor még semmivel nem linkelt össze.

**Eljárás, MINDEN új kártyánál, a mentés előtt vagy közvetlenül utána:**

1. **Keress rá.** A cím 2-3 kulcsszavával nézd végig a meglévő kártyákat:
   ```bash
   curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
     http://localhost:{{WEB_PORT}}/api/kanban | python3 -c "
   import json,sys
   for c in json.load(sys.stdin):
       t=(c.get('title') or '')+' '+(c.get('description') or '')
       if 'KULCSSZO' in t.lower(): print(c['seq'], c['id'], c['status'], c['title'][:70])
   "
   ```
2. **Döntsd el mi a viszony:**
   - Ugyanannak a munkának egy RÉSZE -> `parent_id`, tehát alkártya.
   - Külön munka, de ugyanahhoz a témához tartozik -> kereszthivatkozás
     a leírásban, MINDKÉT irányban.
   - Semmi köze -> nincs teendő.
3. **Írd bele a hivatkozást a LEÍRÁSBA, ne csak kommentbe.** A dashboard a
   címet és a leírást olvassa a "Kapcsolódó kártyák" listához, a kommenteket
   nem.
4. **Mindkét irányban.** Az új kártya leírásába a régi azonosítója, a régi
   kártya leírásába (PUT /api/kanban/<id>) az újé. Egyirányú hivatkozásból az
   egyik oldalon nem látszik semmi.
5. **Ellenőrizd:** nyisd meg a kártyát a dashboardon, és nézd meg hogy a
   "Kapcsolódó kártyák" sorban tényleg ott van-e a másik.

**Melyik formában hivatkozz:** a nyolc karakteres azonosító (`85eafd56`) és a
sorszám (`#46`) is működik linkként. Az azonosító a biztos, mert a sorszám
elvileg változhat.

**A kártya nem tekinthető késznek** -- se létrehozáskor, se lezáráskor, se
jóváhagyásra küldéskor -- amíg ez a lépés meg nem történt.

## Meglévő kártyák auditja

Ha bármikor gyanús, hogy régebbi kártyák is címke nélkül maradtak,
fusd le ezt (dashboard token kell hozzá):
```bash
curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)" \
  "http://localhost:{{WEB_PORT}}/api/kanban" | python3 -c "
import json,sys
d = json.load(sys.stdin)
missing = [c for c in d if not (c.get('labels') or [])]
print(len(missing), 'kartya cimke nelkul')
for c in missing: print(c['id'], c['title'][:60])
"
```
Ha találsz ilyet, ugyanígy dönts a fenti 2-3. lépés szerint --
egyértelmű esetben magad javítsd, kétesnél kérdezz.

## Buktatók

- A régi két-lépéses minta (kártya létrehozás, majd külön címke-hívás)
  MÁR NEM MŰKÖDIK címke nélkül: az első hívás 400-at ad. A `POST
  /api/kanban/<id>/labels` továbbra is létezik, de csak MEGLÉVŐ kártyához
  ad hozzá további címkét -- nem az a hely, ahol az első címke felkerül.
- A dashboard "új kártya" ablakában is kötelező a címke: van egy
  címke-választó a mentés gomb fölött, és címke nélkül nem enged menteni.
- "Marvin-eszközzel/skillekkel épült" NEM ugyanaz mint "Marvin
  fejlesztése" -- lásd a fenti arany-elemzés esetet.
- Ha egy feladat több kategóriát is érinthet, kérdezz -- ne tegyél fel
  több címkét "biztonságból" ha nem vagy benne biztos melyik az
  elsődleges, inkább kérdezz.

## Ellenőrzés

- A `POST /api/kanban` válaszában a `labels` tömb nem üres (ez már
  magában a létrehozási válaszban látszik, nem kell külön lekérdezni).
- Kétes besorolásnál van Telegram-üzenet {{OWNER_NAME}}-nak a döntés előtt, nem
  utólagos találgatás.
