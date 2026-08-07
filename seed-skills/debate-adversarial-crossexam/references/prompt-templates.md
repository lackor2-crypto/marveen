# Kész prompt-sablonok az adverzariális vitáztatáshoz

Ez a fájl CSAK a moderátornak (nekem, Marvinnak) szól -- ez a "hogyan írjam
meg ténylegesen a promptot minden egyes lépésnél" szint. A fő SKILL.md-ben
lévő eljárás (`## A helyes eljárás`) lépésszámaira hivatkozik. Minden
sablonban `[SZÖGLETES]` a kitöltendő rész.

Progressive disclosure: ezt a fájlt csak akkor olvasd be, ha ténylegesen
egy éles vitát moderálsz és konkrét prompt-szöveg kell -- a SKILL.md
önmagában elég a döntéshez hogy MIKOR és MILYEN LÉPÉSEKBEN vezesd a vitát.

---

## 1. lépés -- 1. kör, semleges kérdés

```
node scripts/debate.mjs ask "[a kérdés pontos, tényszerű megfogalmazása --
adj hozzá minden releváns tényt/számot/dátumot amit tudsz, mert a modell
CSAK amit a promptban kap, semmi mást nem lát a mi ügyünkből]" \
  --models [id1,id2,id3]
```

Konkrét példa (illusztráció, egy jóléti-juttatás elutasítás mintájára):
```
node scripts/debate.mjs ask "Egy német Bürgergeld-igénylést utasítottak el
azzal az indokkal, hogy a kérelmező egy [X órás/heti] minijobot végzett a
[hozzátartozó/nem-hozzátartozó] munkáltatójánál [Y euró] órabérért. A
Jobcenter szerint ez nem valós munkaviszony, hanem [az indoklás pontos
szövege]. Mekkora eséllyel nyerhető meg egy ez elleni Widerspruch, ha [a mi
konkrét tényállásunk 3-5 pontban]? Adj becsült %-ot és indoklást." \
  --models openai/gpt-5.5,x-ai/grok-4,google/gemini-3-pro
```

## 1b. lépés -- szereposztásos változat (ha az 1. kör semleges kérdés
egyhangú/homogén választ adna, vagy ELEVE ezzel indítasz)

```
node scripts/debate.mjs ask "A te feladatod KIZÁRÓLAG az, hogy MEGGYŐZŐ
ÉRVEKET találj arra, hogy [ÁLLÍTÁS] IGAZ/HELYES/MEGNYERHETŐ. Aktívan keress
alátámasztó forrást, precedenst, jogszabályt, statisztikát. Ne törődj azzal
hogy ez 'igazságos'-e a kérdésre nézve -- kizárólag az [ÁLLÍTÁS] melletti
legerősebb érvelést építsd fel. [A tényállás.]" \
  --models [modell A]

node scripts/debate.mjs ask "A te feladatod KIZÁRÓLAG az, hogy MEGGYŐZŐ
ÉRVEKET találj arra, hogy [ÁLLÍTÁS] HAMIS/HELYTELEN/NEM NYERHETŐ MEG.
Aktívan keress ELLENÉRVET, gyenge pontot, ellenkező precedenst. Ne törődj
azzal hogy ez 'igazságos'-e a kérdésre nézve -- kizárólag az [ÁLLÍTÁS]
elleni legerősebb érvelést építsd fel. [A tényállás.]" \
  --models [modell B] --session [ugyanaz a session id mint fent]

node scripts/debate.mjs ask "Semleges, bírói szerepben nézd át az alábbi
kérdést: [ÁLLÍTÁS]. [A tényállás.] Ne foglalj el előre álláspontot -- mérd
fel a rendelkezésre álló érveket mindkét irányban." \
  --models [modell C, "bíró"] --session [ugyanaz]
```

## 2. lépés -- kutatás (nem prompt, hanem WebSearch/tudor lépés)

Nincs sablon-prompt, de a kutatási KÉRDÉS megfogalmazásához séma:
```
"[jogterület/téma] + [a modellek 1. körös konklúziójának kulcsszava, pl.
'elutasítva' vagy 'megnyerve'] + hasonló tényállás + ítélet/precedens"
```
Mindkét irányba keress (megerősítő ÉS cáfoló), ne csak az egyiket.

## 3. lépés -- 2. kör, szembesítés

```
node scripts/debate.mjs ask "A 1. körben ezt mondtad: '[a modell 1. körös
válaszának tömör összefoglalása, 1-2 mondat]'. VITATOM -- itt egy konkrét
ellenpélda: [a talált ítélet/adat/forrás NEVE, DÁTUMA, ÜGYSZÁMA, és a
releváns rész SZÓ SZERINTI IDÉZETE]. Forrás: [URL]. Ha ez ilyen közel áll
a mi ügyünkhöz, miért gondolod hogy nálunk más lenne a kimenetel?
Konkrétan reagálj erre a konkrét forrásra, ne általánosságban." \
  --session [id] --round 2 --models [egy adott modell]
```
Ismételd modellenként külön hívással, ha személyre szabott az ellenpélda.

## 4. lépés -- 3. kör, egymásnak feszítés (a legfontosabb lépés)

```
node scripts/debate.mjs ask "A vita másik résztvevője erre jutott: '[a
másik modell 2. körös válaszának SZÓ SZERINTI, nem összefoglalt szövege --
lásd Buktatók: anonimizálva, ne írd oda melyik modell]'. Te ezzel
szemben [a modell saját 2. körös álláspontja tömören]. Reagálj KÖZVETLENÜL
erre az érvelésre: cáfolod, vagy meggyőzött? Ha meggyőzött, mi
KONKRÉTAN változott a gondolkodásodban -- ne csak 'igazad van'-t mondj." \
  --session [id] --round 3 --models [modell A]

# ...és fordítva, modell B kapja meg A érvelését ugyanígy.
```

## 4b. lépés -- ha egy modell visszakozik: mögöttes tényállítás ellenőrzés

Miután TE (moderátor) leellenőrizted a győztes érv mögöttes tényét (pl.
számolás, statisztika, jogszabály pontos szövege) és hibát/pontatlanságot
találtál, vidd vissza MINDKÉT modellnek:

```
node scripts/debate.mjs ask "Ellenőriztem a [modell A] által hivatkozott
tényt: '[az eredeti állítás]'. Ez PONTATLAN/RÉSZBEN IGAZ: [a helyes tény,
számolás, forrás]. Ennek fényében: [modell B], te visszavontad az
álláspontodat erre az érvre hivatkozva -- indokolt-e még mindig a
visszavonás, vagy ez megváltoztatja az értékelésedet? [modell A], hogyan
módosítod az érvelésedet a helyes tény ismeretében?" \
  --session [id] --round [N] --models [mindkettő, külön hívással]
```

Kérdezz rá EXPLICIT a sycophancy-gyanúra is, ha releváns:
```
"...Ez tényleg meggyőzött téged, vagy csak nem akartál tovább vitatkozni?
Indokold konkrétan, mi változott a gondolkodásodban -- ha semmi konkrét
nem változott, mondd ki nyíltan hogy fenntartod az eredeti álláspontodat."
```

## 5. lépés -- bizalmi szint kérése minden körben

Toldd hozzá bármelyik fenti prompt végéhez:
```
"...Adj végül egy 0-100%-os bizalmi szintet az álláspontodra, és indokold
2-3 mondatban miért éppen ennyi -- ne kerekíts automatikusan 50%-ra ha
bizonytalan vagy, mondd meg konkrétan mi hiányzik a magasabb bizonyossághoz."
```

## 6. lépés -- záró dosszié-visszadobás, "mi maradt ki?" kör

```
node scripts/debate.mjs ask "Ez most az ÖSSZES eddig összegyűlt anyag a
vitánkból [a teljes dosszié-MD tartalma, vagy annak linkje/beillesztése]:
olvasd át teljesen, és sorold fel MINDEN fennmaradó ellentmondást vagy
nézeteltérést -- ne simítsd el, ha van. Jutott-e eszedbe bármi új
szempont amit még nem vizsgáltunk? Tudsz-e még konkrét forrást/precedenst
keresni ami eddig kimaradt?" \
  --session [id] --round [utolsó+1] --models [mindenki]
```

## 7. lépés -- lezárás

```
node scripts/debate.mjs conclude --session [id] --consensus true|false \
  --summary "[tömör, ŐSZINTE összegzés -- ha nincs teljes konszenzus, ez is
benne legyen, pl. 'Grok 35-45%, Gemini nem módosított tovább 50%-ról,
fennmaradó nézeteltérés oka: X']"
```

## GPT-5.5 (vagy más, hosszú promptra üresen visszatérő modell) darabolt
## beküldése

Első üzenet (bevezető, NE kérj még választ):
```
node scripts/debate.mjs ask "Most több üzenetben fogok neked szöveget
küldeni (összesen [N] darabban). NE csinálj semmit, ne válaszolj érdemben,
amíg az utolsó darabot meg nem kaptad -- csak nyugtázd hogy megkaptad ezt
a részt, egy szóval. 1/[N]: [az első szövegdarab]" \
  --models openai/gpt-5.5 --session [id]
```
Köztes darabok (ugyanabba a session-be, ugyanabban a körben, `reply` vagy
`ask --session` a pontos CLI-szintaxistól függően):
```
"2/[N]: [a második szövegdarab, nyugtázd, még ne válaszolj érdemben]"
...
```
Utolsó darab (itt kérd a tényleges választ):
```
"[N]/[N] (utolsó): [az utolsó szövegdarab]. Most hogy megkaptad mind a(z)
[N] részt, válaszolj érdemben az eredeti kérdésre: [a kérdés]."
```

## Sablon a "kedvezőtlen forrás ellenőrzés" lépéshez (dokumentum-írás előtt)

```
node scripts/debate.mjs ask "Mielőtt beépítjük ezt a végleges dokumentumba:
van-e a dossziéban [a most talált, kedvezőtlen forrás neve/lényege] --
hivatkozik-e rá a MÁR MEGLÉVŐ dokumentumunk (pl. a korábbi Klage/beadvány)?
Ha igen, ez probléma-e a jelenlegi érvelésünk szempontjából?" \
  --session [id] --models [a szintetizáló/bíró szerepű modell, ha van]
```
