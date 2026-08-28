# Drive-szinkron

A Marveen a bekötött Google-fiók **teljes Drive-ját** lehozza a raktárba, és azóta
**oda-vissza** tartja szinkronban. Egy fiók = egy kattintás, mappaválasztás
nélkül: „a lackor2 drivot mindenestul".

## Az irányok — és a szándékos aszimmetria

| Ami történik | Mi lesz belőle |
|---|---|
| A Drive-on új vagy módosult egy fájl | **lejön** a gépedre |
| A gépeden létrehozol vagy szerkesztesz egy fájlt | **felmegy** a Drive-ra |
| A gépeden szerkesztesz egy Doc/Sheet/Slides fájlt | **felmegy**, és a Drive-on **Doc marad** (lásd lentebb) |
| A gépeden törölsz egy fájlt | fent a **Kukába** kerül (30 napig visszahozható) |
| A Drive-on átnevezel egy fájlt | a gépeden **átnevezzük** (nem hagyunk régi nevű példányt) |
| A Drive-on törlődik egy fájl | **nálad megmarad** |

Az utolsó sor nem hiányosság, hanem a lényeg:

> „ami a driv on fent torlodik az nalam megmarad. az helyes. mert ha valaki
> feltori a drivomat akkor a gepemrol ne tudjon torolni."

Ezért a lefelé menő ág **soha nem töröl helyben**, a felfelé menő pedig soha nem
töröl **véglegesen** — `files.delete` helyett `trashed: true`.

## Hova kerül a gépeden

```
<raktár>/Rendszer/Tárolók/Drive/lackor2/     a lackor2 teljes Drive-ja, ugyanazzal a fastruktúrával
<raktár>/Rendszer/Tárolók/Drive/usalackor/   az usalackor Drive-ja
```

A helyi mappa neve **a fiók neve** — nincs külön névadó mező. („a lackor2 legyen
lackor2. igy nincs keveredes.")

## Átnevezés a Drive-on

Mérve: az átnevezés **felviszi a `modifiedTime`-ot**, tehát a fájl az új néven
jön le. A régi nevű példány ilyenkor a gépeden maradna — és mivel az már nem
szerepel a nyilvántartásban, a felmenő ág **új fájlként küldené vissza**: az
átnevezés után újra megjelenne a régi név is. Ezért a helyi példányt is
**átnevezzük**. Ez nem törlés: egy bájt sem vész el, csak követi a nevet.

Ha közben a gépeden is módosítottad, hozzá sem nyúlunk: a **tiéd marad**, és az
megy fel a már átnevezett dokumentumba (ugyanaz a fájlazonosító).

## Névütközés: két Drive-fájl, egy helyi név

Egy Doc neve „Jelentés", a gépeden `Jelentés.docx`. De **ugyanabban a mappában
lehet egy valódi `Jelentés.docx` is** — a Drive „Google Doc-ká alakítás"
pontosan ilyen párt hagy maga után. Két külön dokumentum, egy helyi név.

Ilyenkor az **első viszi a nevet, a másodikat kihagyjuk**, és a futás
hibalistája néven nevezve kiírja, melyikről van szó. A kihagyott fájlhoz a
felmenő ág **hozzá sem nyúl** — se írás, se törlés —, mert egy rossz tipp az
egyik dokumentum tartalmát írná a másikba. A megoldás a te kezedben van: nevezd
át az egyiket a Drive-on.

## Ütközés: mindkét helyen módosult

A **gépeden lévő nyer**: az megy fel, a letöltés kimarad, és a futás
hibalistájában megjelenik, melyik fájlnál történt. A Drive-on lévő változat nem
vész el — a Google verzió-történetéből előhozható.

## Fékek

A felmenő ág **kihagyja magát**, ha bármi bizonytalan. Sorrendben:

1. **A felmenő ág ki van kapcsolva** (kapcsoló a Raktár oldalon).
2. **Sérült a beállítás-fájl** (`store/drive-sync.json`). Üres állapotból minden
   helyi fájl „újnak" látszana, és az egész raktár felmenne. A sérült fájlt
   `.serult-<időbélyeg>` néven **félretesszük**, nem írjuk felül.
3. **Csonka volt a Drive bejárása** (elértük a `MAX_FOLDERS` / `MAX_FILES`
   határt). Ilyenkor nem tudjuk, mi van a Drive-on — tehát nem is törlünk.
4. **Nincs meg a helyi mappa** (pl. nincs bedugva a raktár lemeze). Ez nem azt
   jelenti, hogy „mindent töröltél".
5. **Csonka volt a helyi bejárás.**
6. **Tömeges törlés vészfék:** ha a nyilvántartott fájlok több mint **10%-a**
   (és legalább 4 darab) hiányzik a gépedről, fent **semmit** nem törlünk, és a
   képernyőn figyelmeztetés jelenik meg.

## Google Docs, Sheets, Slides — miért nincs „egy az egyben másolat"

Egy Google Doc **nem fájl**. Nincsenek bájtjai, amiket le lehetne másolni: a
Drive-on egy szerkezet van tárolva (bekezdések, stílusok, kommentek, változat-
történet), és a `?alt=media` letöltés erre `403`-mal felel — *„Only files with
binary content can be downloaded."* A `size` is 0 vagy formális.

Ezért nem lehet bájtazonos másolatot csinálni. Amit lehet, és amit a Marveen
csinál:

| | |
|---|---|
| **Le** | a Doc `.docx`-ként, a Sheet `.xlsx`-ként, a Slides `.pptx`-ként jön le |
| **Fel** | ugyanaz a fájl megy vissza **ugyanarra a Drive-azonosítóra**, az export típusával — a Google visszakonvertálja |

Mivel a fájlazonosító ugyanaz marad, **a Doc Doc marad**: a linkje, a
megosztásai és a Google verzió-története megmarad, nem keletkezik mellette egy
idegen Word-fájl.

Mérve az éles Drive-on (2026-08-15), nem a dokumentációból: a `.docx`
visszaküldése után a fájl `mimeType`-ja továbbra is `…google-apps.document`
volt, a tartalma pedig a felküldött szöveg.

**Amit tudni kell:** az oda-vissza út a Word-formátumon megy keresztül, tehát
nem veszteségmentes — ami a `.docx`-ben nem ábrázolható (pl. kommentek,
javaslatok, néhány Google-specifikus formázás), az a visszaíráskor elveszhet.
A Google **verzió-történetéből** viszont az előző állapot visszahozható.

## Ami szándékosan kimarad

- **Google Rajz és Apps Script:** ezek is lejönnek (`.png`, `.json`), de a
  Drive **nem veszi vissza** őket — a PNG visszaírása a rajzra mérve
  `400 Bad Request`. Ha ilyet szerkesztesz a gépeden, a futás hibalistája
  **néven nevezve kiírja**, hogy nem ment fel. (A törlésük viszont propagál: a
  törléshez nem kell konvertálni.)
- **Űrlap, Site, Saját térkép:** ezeknek egyáltalán nincs letölthető alakjuk,
  le sem jönnek.
- **100 MB fölötti fájlok** nem mennek fel (egyszerű `uploadType=media` — egy
  megszakadt kapcsolat után elölről kezdődne; a darabolt feltöltés külön munka).
  Az ilyen fájl néven nevezve megjelenik a futás hibalistájában.

## Korlátok

| Korlát | Érték | Ha betelik |
|---|---|---|
| Drive-mappa / páros | 500 | „részleges", a felmenő ág **kimarad** |
| Drive-fájl / páros | 5 000 | „részleges", a felmenő ág **kimarad** |
| Helyi fájl / páros | 2 000 | a feltöltés és a törlés **kimarad** |
| Feltölthető fájlméret | 100 MB | az adott fájl marad ki |

A „kimarad" itt mindig biztonsági döntés: ha nem látjuk az egész képet, nem
nyúlunk a Drive-hoz.

Ha valamelyik betelik, a futás eredménye **„részleges"** lesz — nem „rendben".
Egy csonka mentés nem nézhet ki ugyanúgy, mint egy teljes.

## Kapcsolók (Raktár oldal)

- *A gépemen készült változás menjen fel a Drive-ra* — a teljes felmenő ág.
- *Amit a gépemen törlök, az fent is kerüljön a Kukába* — csak a törlés-átvitel.
  Ha a felmenő ág ki van kapcsolva, ez szürke, mert magában nem csinál semmit.

Mindkettő alapból be van kapcsolva, és a **kiszolgáló** mondja meg az állásukat
— nem a HTML-be írt alapérték.

## Jogosultság

A `scripts/google-auth.py` teljes `drive` scope-ot kér (nem `drive.readonly`),
így a feltöltéshez és a kukázáshoz **nem kell újra engedélyt adni**.
