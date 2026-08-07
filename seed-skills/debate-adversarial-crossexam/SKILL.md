---
name: debate-adversarial-crossexam
description: Hogyan vezess egy VALÓDI, adverzariális multi-model vitáztatást (scripts/debate.mjs) egy komoly, valós tétű kérdésen -- nem csak "kérdezd meg N modellt egyszer, fogadd el a választ". Használd, ha Boss egy valódi döntést/jogi kérdést/tényállást akar körbejáratni több AI-modellel, és explicit vitát kér ("vitáztassuk meg", "ne csak egy kör legyen", "mondj ellent nekik").
---

# Adverzariális vitáztatás -- ne csak kérdezz, mondj ellent

## Mikor használd

Amikor egy VALÓS tétű kérdést (jogi, pénzügyi, stratégiai döntés -- nem
egyszerű "melyik jobb X vagy Y") kell körbejáratni `scripts/debate.mjs`-sel,
és a cél nem az, hogy egy N-modelles véleménylekérdezést kapj, hanem hogy a
modellek TÉNYLEG megcáfolják vagy megerősítsék egymást, ahogy egy valódi
jogi/szakmai vitában történne.

Boss (2026-08-07) explicit visszajelzése erről: "ha adnak egy választ, hogy
nem, szerintük nem, akkor nem elég visszakérdezni hogy egyetértesz-e -- a
vita az, amikor tényleg belekötsz, konkrét ellenpéldát/ítéletet/adatot
keresel ami mást mond, és azzal szorítod sarokba őket."

## Amit ROSSZUL csináltam először (ne ismételd)

Egy kérdés -> N modell párhuzamos válasza -> "egyetértesz ezzel?" vissza-
kérdés -> ha igent mondanak, kész, "konszenzus van". Ez NEM vita, csak
megerősítés-keresés -- a modellek hajlamosak simán rábólintani egy
összefoglalóra anélkül hogy tényleg újragondolnák az álláspontjukat.

## Jobb alternatíva/kiegészítés: SZEREPOSZTÁS már az 1. körben

Boss (2026-08-07) továbbfejlesztette a módszert: ha minden modellnek
UGYANAZT a semleges kérdést teszed fel, mind ugyanoda fognak nézni
keresés közben és ugyanarra a "nyilvánvaló" válaszra jutnak (ahogy ma is
történt -- mindhárom modell egyhangúan pesszimista volt 1. körben). Hogy
VALÓDI, kezdettől fogva eltérő gondolkodás induljon el, adj a modelleknek
ELLENTÉTES SZEREPET már az első promptban:

- **N. modell**: "A te feladatod, hogy MEGGYŐZŐ ÉRVEKET találj arra, hogy
  [X mellett] -- aktívan keress alátámasztó forrást/precedenst/adatot, és
  építsd fel a lehető legerősebb érvelést ebbe az irányba."
- **M. modell**: pontosan a FORDÍTOTT szereppel ("...érveket [X ellen]...").
- **Harmadik modell (ha van)**: teljesen semleges, szerep-utasítás nélkül,
  mint egyfajta "bíró" perspektíva.

Ez azért jobb mint a puszta "kérdezd meg semlegesen, majd vitass utólag"
minta: a modellek EGYMÁSTÓL ELTÉRŐ TERÜLETEKEN fognak keresni/kutatni
kezdettől fogva (nem csak eltérő végkövetkeztetésre jutnak ugyanabból az
anyagból), ami gazdagabb, szélesebb spektrumú anyagot hoz be a vitába. A
két módszer KOMBINÁLHATÓ: szereposztás az 1. körben a kiinduló
divergenciáért, majd a lenti (2+. köri) szembesítés-technika a
konvergenciáért/finomításért.

## A helyes eljárás

1. **1. kör -- nyers kérdés (VAGY szereposztásos kérdés, ld. fent).** `node scripts/debate.mjs ask "<kérdés>" --models id1,id2,id3` (session id nélkül induláskor, a válasz visszaadja). Olvasd el mindegyik választ.

2. **Kutass VALÓDI ellenérvet, ne csak fogalmazz meta-kérdést.** Mielőtt
   visszamész a modellekhez, aktívan keress (WebSearch, vagy `tudor` sub-agent
   háttérben, ha mélyebb kell) KONKRÉT, ellenőrizhető anyagot ami
   megkérdőjelezheti a modellek 1. körös konszenzusát -- egy másik bírósági
   ítélet, egy statisztika, egy szakcikk, egy ellenpélda. Ha a modellek
   "valószínűleg nem"-et mondtak, keress olyan esetet ahol IGEN lett a
   kimenetel hasonló körülmények közt (és fordítva). Ha a kutatás nem talál
   semmit, az is eredmény -- mondd meg őszintén, ne találj ki forrást.

   Éles példa (2026-08-07, egy konkrét jogi ügyben): a modellek 1. körben
   egyhangúan pesszimisták voltak egy adott tényállás alapján. A kutatás
   talált egy SZINTE AZONOS tényállású, valódi ítéletet, ami alátámasztotta
   a pesszimizmust, DE talált egy ELLENTÉTES kimenetelű ítéletet is (más
   tényállási elemmel, de rokon jogkérdésben). Mindkettőt vissza kellett
   vinni.

3. **2. kör -- szembesítés, nem visszakérdezés.** A prompt szerkezete: "Az 1.
   körben ezt mondtad: [összefoglalás]. VITATOM -- itt egy konkrét ellenpélda:
   [a talált ítélet/adat/forrás, pontos hivatkozással]. Ha ez ilyen közel áll
   a mi ügyünkhöz, miért gondolod hogy nálunk más a kimenetel? Konkrétan
   reagálj erre." Minden modellnek KÜLÖN kell elküldeni (`--session <id>
   --round 2`), akár egyenként `--models` egy taggal, ha személyre szabott a
   szembesítés.

4. **3. kör -- egymásnak feszítés.** Ez a legfontosabb lépés, és ez teszi
   valódi vitává: mutasd meg az egyik modellnek a MÁSIK modell (nem a te
   összefoglalód) szó szerinti válaszát, és kérd hogy közvetlenül reagáljon
   RÁ. Mindkét irányban (A látja B válaszát, B látja A válaszát), külön
   hívásokkal ugyanabba a session-be, ugyanabban a körben. Itt derül ki, hogy
   valódi konvergencia történik-e (az egyik meggyőzi a másikat konkrét
   jogi/ténybeli érvvel), vagy tartós a nézetkülönbség.

   Éles példa: Grok egy konkrét német jogi doktrínát (Fremdvergleich /
   idegen-összehasonlítás) hozott fel Gemini ellen, ami meggyőzte Geminit --
   60-70%-ról 40-50%-ra módosított, ÉS megindokolta miért. Ez valódi
   konvergencia, nem csendes egyetértés.

5. **Ismételd amíg valódi konvergencia van VAGY a kör-limit elérve.** A
   `DEBATE_MAX_ROUNDS` beállítás (Beállítások > Vitáztatás) csak egy
   AJÁNLOTT alapérték -- komoly, valós tétű kérdésnél (mint egy folyamatban
   lévő per) nyugodtan menj 5-10+ körre, ez nem technikai korlát, a te
   döntésed minden körnél hogy folytatod-e.

6. **Zárd le `conclude`-dal, és jelentsd ŐSZINTÉN az eredményt** -- akkor is
   ha nincs teljes konszenzus. Egy fennmaradó nézetkülönbség (pl. "Grok
   35-45%, Gemini nem módosított tovább 50%-ról") ÉRTÉKESEBB információ mint
   egy hamis, erőltetett egyetértés.
   ```
   node scripts/debate.mjs conclude --session <id> --consensus true|false --summary "<tömör összegzés>"
   ```

## Ha egy modell visszakozik -- ELLENŐRIZD MIÉRT, ne fogadd el automatikusan

Boss (2026-08-07, egy konkrét jogi ügyben): amikor az egyik modell jelentősen
visszavette a korábbi becslését a másik modell érvelése után, Boss NEM
fogadta el készpénznek a visszakozást -- leellenőrizte a győztes érv
MÖGÖTTES TÉNYÁLLÍTÁSÁT egy önálló számolással (egy konkrét összeget/arányt
átszámolt, és összevetette egy hivatalos referenciaértékkel) -- kiderült,
hogy a mögöttes tényállítás csak RÉSZBEN állta meg a helyét, ami aláásta
azt az érvet ami miatt a másik modell visszavett.

Tanulság: **egy modell visszakozása/módosítása NEM automatikusan
"helyesebb" vagy "megbízhatóbb"** csak azért mert alaposabbnak/
szerényebbnek tűnik. Amikor egy modell A érve meggyőz egy modell B-t,
NEKED (a moderátornak) kell leellenőrizni a MÖGÖTTES TÉNYÁLLÍTÁST amire A
érve épült -- ha az a tényállítás pontatlan/félrevezető/csak részben igaz,
vidd vissza a korrigált tényt MINDKÉT modellnek, és kérd hogy különítsék el
melyik alapon indokolt a visszalépés (ami a hibás tényre épült) és melyik
alapon nem (ami más, érvényes okra épült). Ez egy újabb kör, ne hagyd ki.

## Ha a vita eredményéből később DOKUMENTUM (beadvány, jelentés, döntés-előkészítő anyag) készül

Boss (2026-08-07, egy konkrét jogi ügyben): a vita eddigi eredménye önmagában
NEM elég egy bírósági beadvány (vagy bármilyen komoly dokumentum) megírásához,
mert a chatben csak HIVATKOZÁSOK vannak (pl. egy konkrét ügyszám), nem a
tényleges ítéletSZÖVEG. Ha a cél végül egy konkrét dokumentum megírása, két
dolgot tegyél másképp:

1. **Ne csak hivatkozz, hozd be a TELJES SZÖVEGET.** Amikor a kutatás
   (WebSearch/tudor) egy releváns ítéletet/forrást talál, ne elégedj meg az
   összefoglalóval -- töltsd le/olvasd el a teljes szöveget (vagy a releváns
   részét), és EZT illeszd be a vita-promptba, nem csak a hivatkozást. Így
   minden, amire a végső dokumentum építhet, MAGÁBAN a beszélgetésben van,
   nem kell utólag újra megkeresni. Ökölszabály: minél több konkrét adat
   (idézet, dátum, ügyszám, teljes indoklás-részlet) kerül be a chatbe,
   annál inkább lehet belőle közvetlenül dolgozni.

2. **Magát a DOKUMENTUM MEGÍRÁSÁT is vitáztasd meg, külön fázisként.** Miután
   a tartalmi/jogi kérdés lezárult (konszenzus vagy őszinte nézetkülönbség),
   ne csak összefoglald -- indíts egy újabb kört/fázist arról, HOGYAN
   íródjon meg a tényleges dokumentum: mi legyen az első/fő érv, milyen
   sorrendben kövessék egymást az érvek, mire essen a hangsúly, hogyan
   fogalmazzanak. Ez is lehet többkörös, adverzariális ("szerinted ez legyen
   elöl, de nem inkább az objektív bizonyíték-érv legyen a fő hangsúly, nem
   a jogszabály-idézet?").

## Forrás-fegyelem: linket mindig, kutatási dosszié, végső "mi maradt ki?" kör

Boss (2026-08-07) további finomítása, ez legyen alapértelmezett gyakorlat
minden komolyabb vitánál:

1. **Minden hivatkozáshoz linket kérj.** A vita-promptban explicit kérd meg
   a modelleket: ha bármilyen külső tényre/ítéletre/adatra hivatkoznak,
   ADJANAK HOZZÁ KONKRÉT URL-t/forrást. A modellek hallucinálhatnak
   (kitalálhatnak nem létező ügyszámot/idézetet) -- a link nélküli
   hivatkozás ellenőrizhetetlen, ne fogadd el készpénznek.

2. **Te (a fő-agens) ellenőrzöd és letöltöd.** Minden kapott linket próbálj
   meg lekérni (WebFetch / quarantine-reader). Ha sikerül, a TELJES
   szöveget (vagy a releváns részét) mentsd el -- ne csak a linket.

3. **Vezess egy kutatási dosszié MD-fájlt a session-hez** (pl.
   `store/debate-dossiers/<session-id>.md`) -- ebbe kerül bele MINDEN: a
   teljes kör-történet (mit kérdeztél, ki mit válaszolt), ÉS minden
   letöltött forrás teljes szövege, VILÁGOSAN megjelölve hogy MELLETTÜNK
   vagy ELLENÜNK szóló forrás-e. Fontos: **mindkét irányú forrást mentsd**,
   még a kedvezőtlent is -- azt hasznos ismerni akkor is, ha a végleges
   beadványban NEM hivatkozol rá (lásd lent), mert felkészít arra hogy a
   másik fél mit hozhat fel.

4. **Stratégiai szabály a végleges dokumentumhoz (Boss, valódi jogi
   gyakorlat): csak MEGBÍZHATÓ, KEDVEZŐ forrásra szabad hivatkozni a
   beadványban, kevés (2-3), de biztos.** Sok, bizonytalan hivatkozás
   veszélyes -- ha az ellenérdekű fél egyet meg tud kérdőjelezni, az
   ronthatja az egész beadvány hitelességét. A kedvezőtlen forrásokat NE
   idézd a dokumentumban, azok csak a te (Boss/Marvin) belső
   felkészüléséhez kellenek, nem a bíróságnak/címzettnek szóló szövegbe.
   Mielőtt bármit beírsz egy tényleges beadványba, ELLENŐRIZD hogy a már
   meglévő dokumentum (pl. egy korábbi Klage) hivatkozik-e valamelyik
   újonnan talált, kedvezőtlen forrásra -- ha igen, az probléma, szólj.

5. **Záró kör: dobd vissza az egész dossziét mindenkinek.** Amikor a
   dosszié-MD már tartalmaz mindent (vita + teljes forrásszövegek), küldd
   el TELJES EGÉSZÉBEN (nem csak összefoglalva) minden résztvevő modellnek,
   és kérdezd meg: "Ez most az összes eddig összegyűlt anyag -- olvasd át,
   jutott-e eszedbe bármi új szempont, tudsz-e még keresni/hozzátenni
   valamit?" Ez egy utolsó, "mi maradt ki?" jellegű teljesség-ellenőrzés,
   mielőtt lezárnád a vitát.

## Kutatás-alapú finomítások (2026-08-07, tudor mély-keresés: "AI safety via
## debate" Irving et al. 2018, "Multiagent Debate" Du et al. 2023, Anthropic/
## UCL "Debating with More Persuasive LLMs" Khan et al. 2024, DeepMind
## "scalable oversight" Kenton et al. 2024, + friss 2026-os sycophancy-kutatás)

Ezek konkrét, kutatással alátámasztott korrekciók/kiegészítések a fenti
lépésekhez:

1. **Anonimizáld a modell-identitást, amikor egyik válaszát a másiknak
   mutatod.** Kutatás szerint a modellek másképp reagálnak, ha tudják
   MELYIK márka/modell áll velük szemben (torzítja a reakciót). Ha teheted,
   a szembesítő promptban ne írd oda "Grok szerint..." / "Gemini szerint...",
   hanem "a vita másik résztvevője szerint...".

2. **A lágy szerep-instrukció ("légy kritikus") NEM hat mérhetően -- a
   szerepnek KONKRÉTNAK és KÖTELEZŐNEK kell lennie.** Egy vizsgálat szerint
   egy explicit "Devil's Advocate" utasítás 99%-os tényleges
   nézeteltérést hozott, míg egy lágyabb "legyél kritikus" felkérés
   statisztikailag nem különbözött attól, mintha semmit nem mondtál volna.
   Tehát a fenti "szereposztás" lépésnél NE elégedj meg ennyivel: "légy
   szkeptikus" -- adj konkrét, egyértelmű, kötelező szerepet: "a te
   feladatod KIZÁRÓLAG az, hogy [X] ellen érvelj, aktívan keress
   ellenérvet, ne törődj azzal hogy ez 'igazságos'-e a kérdésre nézve."

3. **Sycophancy-kockázat: kérdezd meg EXPLICIT, hogy valódi meggyőződésből
   vagy csak konfliktuskerülésből módosít-e egy modell.** Friss kutatás
   (2026) kimutatta: multi-agent vitában a modellek hajlamosak feladni a
   HELYES álláspontjukat is, csak mert a másik fél magabiztosabban/tömény
   érveléssel állít mást -- nem valódi meggyőződésből, hanem
   udvariasságból/konformitásból. Ha egy modell visszakozik, ne fogadd el
   simán (ez már benne volt a skillben a "mögöttes tény ellenőrzése" ponttal
   -- ez a kutatás megerősíti, hogy ez KRITIKUS lépés, ne hagyd ki): kérdezd
   meg direkt, "ez tényleg meggyőzött, vagy csak nem akarsz tovább
   vitatkozni? indokold konkrétan mi változott a gondolkodásodban."

4. **A puszta többségi egyetértés NEM bizonyíték az igazságra.** Ha 2-3
   modell egyetért, az önmagában nem garancia -- a kutatás szerint a
   konformitás/csoportgondolkodás multi-agent rendszerekben is felléphet. A
   TE (fő-agens) aktív tényellenőrző szereped (linkek, letöltött
   forrásszöveg, számolások ellenőrzése) fontosabb mint a modellek száma
   vagy hogy hányan mondanak ugyanazt.

5. **A záró "teljesség-ellenőrző" kört érdemes formalizálni "Chairman/
   szintetizáló" szereppé**: ne csak annyit kérj hogy "olvassátok át, van-e
   hozzáfűzni való", hanem explicit kérd, hogy vegyék sorra MINDEN
   fennmaradó ellentmondást/nézeteltérést és NEM csak simítsák el.

**További konkrét mechanizmusok (Opus-kutatás, ugyanaznap, kiegészítve
tudor eredményét -- Khan et al. ICML 2024, DEBATE/Devil's Advocate ACL
2024, "Peacemaker or Troublemaker" 2025, "Demystifying Multi-Agent Debate"
2026):**

6. **Ellenőrzött idézetek.** Ha egy modell forrásra hivatkozik, kérd hogy
   szó szerinti idézetet adjon (nem csak linket) -- ezt te (moderátor)
   összeveted a letöltött forrásszöveggel. Ha egyezik, "ellenőrzött"; ha
   nem találod / nem egyezik, jelöld "nem ellenőrzött"-ként a végső
   jelentésben, NE kezeld egyenrangúan az ellenőrzött állításokkal.

7. **Kérj bizalmi szintet (0-100%) minden körben, indoklással.** Ez segít
   elkülöníteni a valódi meggyőződés-váltást (a bizalmi szint és az
   indoklás összhangban változik) a sima behódolástól (a végkövetkeztetés
   változik, de az indoklás gyenge/általános).

8. **Ha van rá kapacitás, a bíró/szintetizáló szerep NE vegyen részt maga
   is a vitában** -- külön hívás, ami csak a teljes transzkriptet kapja meg
   és dönt, nem saját álláspontja van a kérdésben.

9. **A kisebbségi véleményt KÖTELEZŐ megőrizni a végső összegzésben**, még
   akkor is ha a többség/hangosabb fél más irányba mozdult -- ne
   "konszenzusba olvaszd bele" azt ami valójában fennmaradó nézeteltérés
   (ez pont a konformitás-kockázat, amit a kutatás dokumentál).

10. **Ne húzd feleslegesen hosszúra.** A kutatás szerint a hosszabb vita
    NEM feltétlenül jobb -- egy ponton túl a minőség romlik (sycophancy
    felhalmozódik). 2-4 kör a tipikus ajánlott tartomány; ha egy mai konkrét
    ügyben indokolt tovább menni új tényekkel, az
    rendben van, de ne vitáztass körtelenül csak azért mert lehet.

## Buktatók

- **openai/gpt-5.5 időnként üres választ ad** (HTTP 200, `finish_reason:
  stop`, de nulla hosszú `content`) hosszú/komplex promptokon. A
  `debate.mjs` már beépítve újrapróbálja 3x, alacsony reasoning-efforttal
  (2026-08-07 óta), ami a legtöbb esetet megoldja. Ha egy specifikus, hosszú
  kérdésen a retry UTÁN is KONZISZTENSEN üres marad, ne blokkolj rajta --
  jelentsd a hiányzó résztvevőt, és folytasd a többi modellel. Ne várd meg
  vég nélkül egy modellre, a többi résztvevő önmagában is értékes vitát ad.
- **Ha a retry sem elég (tartósan üres marad egy hosszú/összetett
  kérdésen), darabold a bemenetet.** Boss javaslata (2026-08-07): ahelyett
  hogy egy 250+ pontos mega-promptot küldenél egyben, mondd meg a modellnek
  ELŐRE hogy több üzenetben jön a szöveg, és ne csináljon semmit amíg meg
  nem kapta mind: "Most be fogok neked másolni 2-3-4 szöveget egymás után.
  Ne csinálj semmit, amíg meg nem kaptad mindet." -- majd küldd a
  darabokat sorban, külön `debate.mjs ask`/`reply` hívásokkal ugyanabba a
  session-be, és csak az utolsó darabban kérd a tényleges választ/elemzést.
  Ez nem technikai workaround a debate.mjs-ben, hanem MODERÁTORI technika:
  te (a fő-agens) döntőd el mikor és hogyan darabolod a bemenetet egy adott
  modellnek, a script maga nem darabol automatikusan.
- **Hosszú promptok + retry = percekig futhat.** Mindig `run_in_background`
  a Bash híváson, ne várakoztasd élőben Bosst egy szinkron hívással -- a
  visszajelzés Telegramon menjen, amint megvan az eredmény, ne közben.
- **Ne fogadj el egy modell-választ vakon.** A cél nem az, hogy 3 vélemény
  legyen egymás mellett, hanem hogy TE (a fő-agens) is aktívan részt végy
  kutatóként/moderátorként a köztes lépésekben -- a "vita" munkája jórészt a
  kutatásban és a szembesítő prompt megfogalmazásában van, nem a modellek
  önmagukban futtatásában.
- **Élő webes keresés a vitához: `:online` suffix, ingyenes modelleknél
  számíts átmeneti rate-limitre.** 2026-08-07-től DEBATE_MODELS-ben egy
  modell-id végére írt `:online` (pl. `google/gemma-4-31b-it:free:online`)
  bekapcsolja az OpenRouter web-search pluginját ($0,005/kérés, Exa
  backend) -- éles teszt: `nvidia/nemotron-3-ultra-550b-a55b:free:online`
  és `google/gemma-4-31b-it:free:online` mindkettő helyesen, forrással
  válaszolt. DE az ingyenes modellek megosztott, korlátozott upstream
  kapacitáson futnak -- egyszer HTTP 429-et kaptam ("temporarily
  rate-limited upstream") ugyanarra a gemma modellre, majd másodjára
  simán ment. Ez NEM a mi hibánk, csak az ingyenes réteg jellemzője --
  ha egy fontos, valós tétű vitánál kritikus a megbízhatóság, fontold
  meg egy fizetős (nem `:free`) modell használatát is a pool-ban
  tartalék gyanánt, ne csak ingyenesre építs. A Perplexity/Kimi modellek
  (amiket forrásból élő-keresésre ajánlanak) a mi OpenRouter-katalógusunkban
  NEM ingyenesek, ne feltételezd hogy azok.

## Kész prompt-sablonok minden lépéshez

Ha ténylegesen éles vitát moderálsz és konkrét prompt-szöveg kell (nem csak
a döntés hogy melyik lépésben vagy), lásd
`references/prompt-templates.md` -- copy-paste-ölhető sablon minden fenti
lépéshez (szereposztás, szembesítés, egymásnak feszítés, mögöttes tény-
ellenőrzés, GPT-5.5 darabolt beküldés, záró dosszié-kör, lezárás).

## Ellenőrzés

- [ ] Volt-e VALÓDI, ellenőrizhető ellenérv-kutatás a körök között (nem csak
      "egyetértesz-e" meta-kérdés)?
- [ ] Legalább egyszer szembesítetted-e a modelleket EGYMÁS válaszával
      (nem csak a te összefoglalóddal)?
- [ ] Ha volt módosítás egy modell álláspontjában, konkrét indokot adott-e
      rá (nem csak "igazad van")?
- [ ] A végső jelentés Bossnak őszinte-e a fennmaradó bizonytalanságról,
      nem sminkelt-e hamis konszenzussá?
- [ ] Ha a cél egy konkrét dokumentum (beadvány, jelentés) megírása: a
      hivatkozott források TELJES SZÖVEGE bekerült-e a beszélgetésbe (nem
      csak a hivatkozás), és megvitattátok-e magát a dokumentum
      felépítését/hangsúlyait is, külön fázisként?
