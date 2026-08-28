# Fotók oldal (Google Fotók)

A **Fotók** menüpont alatt **kizárólag a Google Fotók** tartalma jelenik meg.
Drive-fájl ide soha nem kerül be — akkor sem, ha az a Drive-on egy kép.

## Miért kell a képeket „hozzáadni”, miért nem látszik magától az egész album?

Ez nem a mi korlátunk, hanem a Google-é, és lemértük:

- A Google **2025-03-31-én visszavonta** azt a jogosultságot
  (`photoslibrary.readonly`), amivel egy program végig tudta böngészni a te
  fotótáradat. Azóta a régi felület **csak azt látja, amit maga a program
  töltött fel** — a telefonodról felkerült képeket nem.
- Ami maradt: a **Picker** (képválasztó). Te a **Google saját oldalán**
  választod ki a képeket, és a Marveen csak a kiválasztottakat kapja meg.

Ezért van a „Képek hozzáadása” gomb: a Google-nél ez az egyetlen élő út.

## Hogyan használd (lépésről lépésre)

1. Nyisd meg a bal oldali menüben a **Fotók** pontot.
2. Fent válaszd ki a **fiókot** (több Google-fiók is be lehet kötve).
3. Nyomd meg a **Képek hozzáadása** gombot.
4. Új lapon megnyílik a Google képválasztója. Jelöld ki a képeket, majd nyomd
   meg a **Kész** gombot.
5. Zárd be azt a lapot, és menj vissza a Marveenre — a képek pár másodperc
   múlva megjelennek a rácsban.

Egy képre kattintva nagyban is megnézheted. A nagy nézetben az **Eltávolítás**
gomb a **Marveenből** törli a képet; a Google Fotókban semmi nem változik.

## Ha azt írja: „Ehhez a fiókhoz még nincs Fotók-engedély”

A Google a fotókra **külön engedélyt** kér, és ezt **fiókonként egyszer** kell
megadni. Az oldal ki is írja a pontos parancsot, ilyen alakban:

```bash
python3 scripts/google-auth.py auth lackor2
```

Futtasd a terminálban (a `lackor2` helyére a saját fiók neve kerül, ahogy az
oldal kiírja). A parancs ad egy linket: nyisd meg, jelentkezz be **azzal** a
Google-fiókkal, és engedélyezd a Fotókat. Utána frissítsd a Fotók oldalt, és a
„Képek hozzáadása” gomb működni fog.

Ezt **minden fióknál külön** meg kell csinálni, amelyiknek a fotóit látni
akarod. Egy régebben bekötött fiók belépése továbbra is érvényes marad — csak a
fotó-engedély hiányzik belőle, mert a jogosultságok a beleegyezéskor dőlnek el,
és utólag nem bővülnek maguktól.

> Ha a parancs után a Marveen `SERVICE_DISABLED` hibát írna, akkor a Google
> Cloud Console-ban a projekten engedélyezni kell a **Photos Picker API**-t.

## Hol vannak a képek?

A kiválasztott képeket a Marveen **azonnal letölti a saját gépre**:

```
store/photos/<fiók>/          a képfájlok
store/photos/index.json       melyik kép melyik fiókhoz tartozik
```

Ennek konkrét oka van: a Google által adott letöltési link **60 perc múlva
lejár**. Ha nem hoznánk le rögtön a képeket, egy óra múlva üres lenne az oldal.
Így viszont a képek utána is megmaradnak — akkor is, ha nincs internet.

### Ha be van állítva Raktár

A telepítési mappa nem arra való, hogy gigabájtok álljanak benne. Ezért a
Beállítások oldalon megadható egy **Raktár** (nálad: `D:\Marveen`), és onnantól a
képek oda kerülnek — a **fajta** van felül, alatta a fiók:

```
<raktár>/Rendszer/Tárolók/GOOGLE_PHOTOS/lackor2/          a lackor2 képei
<raktár>/Rendszer/Tárolók/GOOGLE_PHOTOS/usalackor/        az usalackor képei
<raktár>/Rendszer/Tárolók/Drive/lackor2/          ugyanennek a fióknak a Drive-mentése
```

Így egy pillantással látod, hol tartanak a képeid, és melyik fióké mi — nem
kell fiókonként külön mappákba lépkedned.

Két dolgot érdemes tudni:

- **Az index marad a régi helyén** (`store/photos/index.json`), és **nem tárol
  útvonalat**. Ezért a képek átmozgatása nem tud „elrontani” semmit: a Marveen
  mindkét helyen megnézi, hol van meg a fájl.
- **A költözés nem mindent-vagy-semmit**: ha félbeszakad, a képek egy része a
  Raktárban van, a többi a régi helyén — és az oldal **mindkettőt** kiszolgálja.

*(2026-08-15 előtt a szerkezet fordított volt: `fiokok/<fiók>/fotok`. Ami ott
maradt, azt a Marveen induláskor **egyszer**, magától átnevezi az új helyre. Ha
az új helyen már van ilyen mappa, hozzá sem nyúl — inkább maradjon két helyen
valami, mint hogy felülírjon bármit.)*

A lap tetején látszik, hány kép van és mennyi helyet foglal a gépen. Ugyanez
lekérdezhető a `GET /api/photos/usage` végponton, fiókra bontva is.

## A rács kicsi képeket mutat, nem az eredetit

Amikor a Fotók oldalt nézed, a képek **nem** az internetről jönnek — azok már
rég a gépeden vannak. Ami mégis „töltődik”, az a saját géped és a böngésző
közötti út. Eddig ezen az úton a **teljes** fájlok mentek át, videóstul.

Mekkora ez? A saját tárad, 2026-08-15-én mérve:

| | darab | méret |
|---|---|---|
| kép | 342 | 110 MB |
| **videó** | **36** | **6 985 MB** (a legnagyobb egymaga 1,8 GB) |

Vagyis egyetlen végiggörgetés **7 GB**-ot mozgatott a gépen belül — ezért volt
percekig üres a rács, és ettől hízott a szolgáltatás több gigásra.

Mostantól:

- **a rácsba bélyegkép megy** (480 képpont széles, pár tíz KB). Videónál a
  film egy kimerevített kockája. Ugyanaz a 40 elem: 9,1 MB helyett **1,3 MB**.
- **a teljes minőség csak akkor mozdul meg, amikor nagyban megnyitod** egy
  képet;
- **amit a böngésző egyszer már látott, azt megjegyzi** — ugyanabba a fiókba
  visszatérve nem tölti újra. Ha mégis rákérdez, a szerver „nem változott”
  választ ad, és egyetlen bájt sem megy át.

A bélyegképek a képfájl mellé, annak `.thumbs/` almappájába kerülnek — vagyis
oda, ahol maga a kép van (`store/photos/<fiók>/.thumbs/`, Raktár esetén
`<raktár>/Rendszer/Tárolók/GOOGLE_PHOTOS/<fiók>/.thumbs/`). Ez szándékos: egy költözés után a bélyegek nem
maradnak árván a régi mappában.

A bélyegek az első megnézéskor készülnek el (egy kép ~0,16 mp, egy 1,8 GB-os videó szintén, mert
nem olvassa végig). Utána már készen vannak: **9,5 mp helyett 0,5 mp** ugyanaz
a 40 elem. Alig foglalnak helyet — jelenleg 1,3 MB a 6,93 GB mellett —, és a
`GET /api/photos/usage` külön ki is írja őket (`thumbHuman`).

Amit egyelőre **nem** tud: videót lejátszani a nagy nézetben. A kimerevített
kockát mutatja. Egy 1,8 GB-os fájlt a böngésző memóriájába tölteni nem
lejátszás lenne, hanem összeomlás; ehhez darabolt kiszolgálás kell.

## Kétszer ugyanaz a kép? Egyszer kerül a lemezre

A Marveen **a tartalmat** nézi, nem a fájlnevet és nem a méretet: minden lehozott
képről ujjlenyomat (SHA-256) készül.

- Ha ugyanazt a képet **mégegyszer** kiválasztod, a Marveen már le sem tölti.
- Ha ugyanaz a kép **két fiókban** is megvan, mindkét fiók alatt látszik, de a
  lemezen **egyetlen** példány van belőle.
- A **korábbról** ottmaradt egyformákat minden letöltés elején kitakarítja —
  ahogy a gazdátlanná vált fájlokat is (olyan fájl, amire már egyetlen kép sem
  hivatkozik, tehát az oldalon sosem látszott, csak a helyet foglalta).

Ez a takarítás **soha nem nyúl** olyan fájlhoz, amire hivatkozik valami. Ha az
index sérült vagy üres lenne, a takarítás **ki sem indul** — inkább maradjon pár
felesleges megabájt, mint hogy egy hiba képeket vigyen el.

## Miért nem akad meg a gép letöltés közben?

Régen a Marveen **egyben** húzta be a memóriába a képet, mielőtt kiírta a
lemezre. Egy telefonos videónál ez több száz MB pillanatnyi tüske volt, és a
flotta memória-őre emiatt hirdetett vészhelyzetet (új agens nem indulhatott).

Most a kép **átfolyik** a memórián: darabonként érkezik és megy is ki a lemezre,
tehát egy 2 GB-os videó sem foglal többet néhány megabájtnál. Emellé jött egy
**fék**: a képek között tart egy pillanat szünetet, és ha nagyon kevés a szabad
memória, kicsit vár a következő előtt.

A fék **soha nem állítja meg** a letöltést: legfeljebb fél percet vár, aztán
mindenképp továbbmegy. Ennek konkrét oka van — a Google letöltési linkje 60 perc
múlva lejár, egy határozatlan várakozás nem lassítaná a letöltést, hanem
**elveszítené** a képeket.

Ha kell, mindhárom érték állítható a `.env`-ben (alapból nem kell hozzányúlni):

| Beállítás | Alapérték | Mit csinál |
| --- | --- | --- |
| `MARVEEN_PHOTO_PAUSE_MS` | 120 | Szünet két kép között (ms). `0` = nincs szünet. |
| `MARVEEN_PHOTO_MIN_AVAIL_MB` | 1200 | Ennyi szabad memória alatt vár. `0` = fék kikapcsolva. |
| `MARVEEN_PHOTO_MAX_WAIT_MS` | 30000 | Legfeljebb ennyit vár képenként, aztán megy tovább. |

Elgépelt érték nem kapcsolja ki csendben a féket: a Marveen ilyenkor az
alapértéket használja.

## Végpontok (fejlesztőknek)

| Végpont | Mit csinál |
| --- | --- |
| `GET /api/photos/accounts` | Fiókok + van-e mindegyiknél Fotók-engedély. |
| `GET /api/photos/list?account=` | A már letöltött képek listája. |
| `GET /api/photos/media?id=&account=` | Egy kép bájtjai a lemezről. |
| `POST /api/photos/session` | Új választás indítása (`pickerUri`-t ad vissza). |
| `GET /api/photos/session?sessionId=&account=` | Kész-e; ha igen, letölti a képeket. |
| `POST /api/photos/remove` | Egy kép törlése a Marveenből (a Google-nál nem). |
| `GET /api/photos/usage` | Darabszám és lemezfoglalás. |

Két dolog, amit könnyű elrontani:

- A képek bájtjait **`fetch` + blob URL**-lel kell megjeleníteni, nem
  `<img src="/api/photos/media...">`-szel: a dashboard `Authorization: Bearer`
  fejléccel hitelesít, amit egy sima képbetöltés nem visz magával — 401-et
  kapnánk kép helyett.
- A Google `baseUrl`-jéhez **kell** a Bearer fejléc, és **méretjelölést** kell a
  végére tenni (`=w1600-h1600`, videónál `=dv`). Ez ellentétes a Drive aláírt
  bélyegkép-linkjeivel, ahol épp hogy nem szabad fejlécet küldeni.
