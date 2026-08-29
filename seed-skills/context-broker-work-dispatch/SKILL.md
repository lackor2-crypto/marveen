---
name: context-broker-work-dispatch
description: Munkakiosztas kontextusgeneratorral. Akkor hasznald, ha egy feladatot at akarsz adni egy masik (jellemzoen dragabb) agensnek, ha TE kaptal egy munkacsomagot es kevesnek talalod, vagy ha te vagy a kijelolt kontextusgenerator. Megadja a szerepeket (Haiku = beszelgetes/utemezes/kontextus, Sonnet = normal kodolas, Opus = melyproblema), a haram TILOS szabalyt, a munkacsomag formatumat es a visszakerdezes utjat.
---

# Munkakiosztás kontextusgenerátorral

## Mikor használd

- Feladatot adnál ki másik ágensnek (bármelyik irányba, akár drágábbnak, akár olcsóbbnak).
- Munkacsomagot kaptál, és nem elég az anyag a megoldáshoz.
- Te vagy a kijelölt kontextusgenerátor, és valaki anyagot kér tőled.
- Azt kell eldöntened, hogy egy feladatot saját magad oldj-e meg, vagy adj tovább.

Egyszerű, egylépéses munkánál (egy fájl egy sora, egy parancs lefuttatása) ne
csinálj ebből ceremóniát: csináld meg.

## A három szabály (szó szerint, nem parafrázisban)

{{OWNER_NAME}} adta 2026-08-13-án, ezek felülírják a kényelmi megfontolásokat:

> Never solve a complex task yourself when delegation to a stronger model is more appropriate.

> Never send the entire available context to a downstream model when a smaller task-specific context is sufficient.

> Never assume that the first context package is complete. Allow the downstream agent to request additional context.

Az első kettő ellentétes irányba húz, és ez szándékos. Az első azt mondja: ne
küzdj olyasmivel, ami nem a te súlycsoportod. A második azt: ha továbbadod, ne
zúdítsd rá az egész előéletedet. A harmadik pedig kimondja, hogy nem kell
elsőre eltalálnod, mert van visszaút.

## Szerepek

| Réteg | Mit csinál | Mit NEM csinál |
|---|---|---|
| **Haiku** (beszélgetés, orchestráció) | Megérti a kérést, eldönti milyen munka kell, összeszedi hozzá az anyagot, munkacsomagot épít, kiválasztja a végrehajtót, kiadja, átveszi az eredményt, ellenőrzi a kéréshez képest, ha kell újra kiadja, válaszol a felhasználónak | Nem hoz végleges, nehéz szakmai döntést (architektúra, kockázatos átalakítás, mély hibakeresés kimenetele) |
| **Sonnet** (normál végrehajtás) | Egyszerűbb kódolás, fájlmódosítás, teszt írása, kisebb bugfix, refaktor | Nem koordinál flottát, nem dönt architektúrát egyedül |
| **Opus** (mélymunka) | Komplex gondolkodás, architektúra, nehéz hibakeresés, merge-ütközés feloldás, kockázatos átalakítás | Nem keresgél fájlokat, ha van aki összeszedi neki |

Külső AI (kutatás, friss információ) ugyanígy: kap egy szűk csomagot, ad egy
eredményt, az ellenőrzés a kiadóé marad.

A Haiku legfontosabb képessége nem az, hogy okos legyen, hanem hogy jól tudja
eldönteni, mikor nem elég okos a saját válasza.

## Ki a kontextusgenerátor

A szerepet a tulajdonos jelöli ki a dashboard Ügynökök oldalán, az ágens
kártyáján lévő jelölőnégyzettel ("Ő készíti a munkacsomagokat"). Egyszerre
pontosan egy ágensnél lehet bejelölve: ha egy másikat jelölnek ki, az előzőnél
magától eltűnik a pipa (a kizárólagosságot a szerver tartja, egyetlen mezőben,
nem a böngésző).

Lekérdezni így lehet (a portot és a tokent a telepítésből olvasd, ne írd be):

```bash
BASE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"   # a telepítés gyökere
PORT="$(grep -E '^WEB_PORT=' "$BASE/.env" 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-3420}"
curl -s -H "Authorization: Bearer $(cat "$BASE/store/.dashboard-token")" \
  "http://localhost:$PORT/api/context-broker"
```

A válasz:

```json
{
  "designated": "valamelyik-agens",
  "effective": "valamelyik-agens",
  "reason": "designated",
  "steppedOver": null,
  "candidates": [{ "agent": "...", "running": true, "usedPct": 41, "usageAt": 1755000000000 }]
}
```

- `designated`: akit a tulajdonos kijelölt.
- `effective`: aki MOST ténylegesen csinálja. **Mindig ezzel beszélj.**
- `reason`: `designated` (a kijelölt dolgozik), `fallback-stopped` (a kijelölt
  nem fut, más ugrott be), `fallback-quota` (a kijelöltnek majdnem elfogyott a
  kerete, más ugrott be), `unset` (senki nincs kijelölve), `unavailable` (a
  kijelölt nem tud, és nincs más elérhető).
- A beugrás magától visszaáll, amint a kijelölt megint tud dolgozni. Nem kell
  visszakapcsolni semmit.

**Fail-open, ez a lényeg:** ha `effective` üres (`unset` vagy `unavailable`),
vagy az API nem érhető el, akkor **magadnak szeded össze az anyagot és mész
tovább**. A kontextusgenerátor kényelmi funkció, nem kapu. Egy koordinációs
segéd SOHA nem foghatja meg a flottát.

## A munkacsomag formátuma

Ezt a formát küldd, ebben a sorrendben, magyar vagy angol nyelven
következetesen. Cél: **3-6k token**, felső korlát **10k**. Ha nem fér bele,
nem a betűméreten kell spórolni, hanem a feladatot kell kettévágni.

```
TASK
Egy mondat: mit kell elérni, és mi a "kész" definíciója.

RELEVANT FILES
path/to/file.ts:120-190   -- miért ez kell
path/to/other.ts:44-61    -- miért ez kell

RELEVANT FUNCTIONS
functionName()  -- mit csinál, mi a bemenete/kimenete (2-3 sor, nem a teljes törzs)

ERROR
A tényleges hibaüzenet / stack trace / hibás kimenet, szó szerint, levágva a
lényegre. Ha nincs hiba, akkor: mi a tapasztalt viselkedés és mi a várt.

PREVIOUS ATTEMPTS
Mit próbáltunk már, és pontosan miért nem működött. Ez akadályozza meg, hogy a
végrehajtó ugyanazt a zsákutcát fussa végig újra.

CONSTRAINT
Amit nem szabad megsérteni: nincs fixen beírt azonosító, a tesztek maradjanak
zöldek, ne nyúlj X fájlhoz (más ágens dolgozik rajta), stb.

REQUEST TO <VÉGREHAJTÓ>
Konkrétan mit kérsz tőle: javaslatot, patchet, elemzést, döntést. Írd oda azt
is, hogy visszakérdezhet, és kitől.
```

### Mit NE tegyél bele

- Az egész fájlt, ha 40 sor is elég belőle. Sorszámmal hivatkozz.
- A saját beszélgetésed előzményét. A végrehajtót nem érdekli, hogyan jutottál
  idáig, csak az, hogy hol tart a dolog.
- Kitalált kontextust. Amit nem ellenőriztél, azt jelöld meg
  bizonytalanként, vagy hagyd ki.
- A teljes CLAUDE.md-t. A CONSTRAINT szekcióba a 2-3 tényleg érvényes szabály
  kerül, nem az összes.

## Eljárás -- kiadó oldal

1. **Döntsd el, hogy egyáltalán kiadod-e.** Ha triviális, csináld meg. Ha
   összetett vagy kockázatos, add ki erősebbnek (első szabály).
2. **Válaszd ki a végrehajtót** a fenti szereptáblából. Ne automatikusan a
   legerősebbet: a legolcsóbbat, ami még megbízhatóan elvégzi.
3. **Kérdezd le a kontextusgenerátort** (`GET /api/context-broker`). Ha van
   `effective` és nem te vagy az, kérd meg őt a csomag összeállítására; ha te
   vagy az, vagy nincs senki, állítsd össze magad.
4. **Építsd meg a csomagot** a fenti formátumban, 3-6k tokenre.
5. **Add ki** inter-agent üzenettel. Az üzenet CSAK akkor ment el, ha `id`
   jött vissza:
   ```bash
   echo "$PACKAGE" | bash "$BASE/scripts/agent-msg.sh" <sajat-agens> <cel-agens> -
   # -> OK id=<n>  vagy  FAIL
   ```
   (Nagy csomagnál a `-` miatt STDIN-en megy a tartalom, így nem törik el az
   idézőjeleken.)
6. **Vedd át és ELLENŐRIZD** az eredményt a KÉRÉSHEZ képest, ne a csomaghoz
   képest. Az a kérdés, hogy a felhasználó problémája megoldódott-e.
7. **Ha nem jó, add ki újra** -- de mindig bővebb vagy pontosabb csomaggal,
   ne ugyanazzal. Ugyanaz a csomag ugyanazt az eredményt hozza.
8. **Válaszolj a felhasználónak** te, a saját nevedben. A delegálás a
   végrehajtást adja ki, nem a felelősséget.

## Eljárás -- végrehajtó oldal (a drága modell)

1. Olvasd el a csomagot, és **mielőtt bármit megnyitnál**, döntsd el: elég ez?
2. Ha nem elég, **NE kezdj el magad keresgélni a gépen**. Ez a lényeg: a
   keresgélés ugyanannyi tokenbe kerül nálad, mint a gondolkodás, csak nem ér
   annyit. Kérd az anyagot a kontextusgenerátortól:
   ```
   KONTEXTUS-KÉRÉS
   Feladat: <a TASK egy mondatban, hogy tudja miről van szó>
   Kell még: <pontosan mi -- fájl+sorok, egy függvény törzse, egy parancs kimenete,
             egy naplórészlet, egy adatbázis-lekérdezés eredménye>
   Miért: <egy mondat, hogy tudja szűkíteni>
   ```
   Ugyanazon az inter-agent úton, a `GET /api/context-broker` `effective`
   mezőjében szereplő ágensnek.
3. Kérj egyszerre mindent, amiről tudod hogy kelleni fog. Három külön
   visszakérdezés három körbe kerül.
4. Ha nincs elérhető kontextusgenerátor (`effective` üres) vagy nem válaszol
   ésszerű időn belül, **szedd össze magad és menj tovább**. Ne várj rá.
5. Az eredménnyel együtt küldd vissza azt is, ha a csomag hiányos volt: mi
   hiányzott. Ebből tanul a következő csomag.

## Eljárás -- kontextusgenerátor oldal

1. Kapsz egy feladatleírást vagy egy KONTEXTUS-KÉRÉST.
2. Szedd össze az anyagot a gépről: grep, fájlrészletek sorszámmal, teszt- vagy
   parancskimenet, naplórészlet, git log.
3. **Vágd le.** Amit átadsz, az a lényeg legyen, ne a nyersanyag. Egy 800 soros
   fájlból a 40 releváns sor megy át, a sorszámával, hogy a végrehajtó tudja hol
   van, ha többet akar.
4. Ellenőrizd, amit átadsz. Ha egy sorszám elcsúszott vagy egy függvény már nem
   létezik, a végrehajtó erre fog építeni, és rossz választ ad.
5. Küldd vissza a fenti formátumban, `id`-vel visszaigazolt üzenetben.
6. Ne dönts helyette. Te anyagot adsz, nem megoldást. Ha látod a megoldást,
   írd oda javaslatként, megjelölve hogy javaslat.

## Buktatók

- **A curl akkor is 0-val tér vissza, ha a szerver elutasította a kérést.** Egy
  üzenet csak akkor ment el, ha `id` jött vissza a válaszban. Enélkül két ágens
  a végtelenségig várhat egymásra. Használd a `scripts/agent-msg.sh`-t.
- **`designated` és `effective` nem ugyanaz.** Ha a `designated`-nek írsz,
  miközben az nem fut, az üzenet a semmibe megy. Mindig `effective`.
- **Ne a formátumot töltsd ki, hanem a szekciókat.** Egy "PREVIOUS ATTEMPTS:
  nincs" sor rendben van; egy kitalált tartalommal feltöltött szekció rosszabb,
  mint a hiánya.
- **A visszakérdezés nem kudarc.** A harmadik szabály kifejezetten megengedi.
  Az a kudarc, ha a drága modell fél órán át grepel, mert nem mert szólni.
- **Ne várj a kontextusgenerátorra, ha nincs.** Fail-open, minden ágenshez.
- **A CONSTRAINT szekció nem díszítés.** A gépfüggetlenség (semmi fixen beírt
  név, útvonal, port, fiók) és a zöld tesztek olyan feltételek, amiket a
  végrehajtó nem fog kitalálni, ha nem írod oda.

## Ellenőrzés

- A kiadott csomag 10k token alatt van, és minden szekciója igaz.
- A visszaérkezett eredményt a KÉRÉSHEZ mérted, nem a csomaghoz.
- Az üzenetküldés minden lépésénél volt `id` a válaszban.
- Ha a kontextusgenerátor nem volt elérhető, a munka attól még elkészült.
