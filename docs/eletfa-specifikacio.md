# Marvin – EGYSÉGES ÉLET- ÉS ADATTÁR

## Végleges fejlesztői specifikáció

> **Forrás:** a Boss által 2026-08-21-én átadott, ChatGPT-vel kidolgozott végleges
> specifikáció. Ez a dokumentum **felülírja** a korábbi 25 pontos altervet.
> A korábbi terv megvalósítása (`life-tree.ts`, `life-mounts.ts`, Marvin Intéző,
> Beérkező-készség) áll, de a **mappafa szerkezete ez alapján épül újra**.
>
> Kapcsolódó: kanban `#152`, `seed-skills/fresh-install-usable`.

---

### 1. A rendszer célja

A Marvin hozzon létre egy **egységes élet- és adattárat**, amelyben a felhasználó
az egész életét egyetlen, logikus mappafában látja: személyes adatok, más
személyek adatai, család, jogi ügyek, pénzügyek, hatósági ügyek, cégek,
projektek, média, dokumentumok, Google Drive-ok, Google Photos, Git repók,
beérkező dokumentumok, fizikai papírok helye.

**A felhasználónak ne kelljen tudnia, hogy egy fájl fizikailag melyik Drive-on,
Google Photos-ban vagy helyi mappában van.** A Marvin azonban mindig tudja, és
meg is tudja mutatni.

### 2. Alapelv: két külön dolog

**A) LOGIKAI ÉLETFA** – amit a felhasználó lát:

```text
Média/KORPÁS LÁSZLÓ/Fotók/Ági családja
```

**B) FIZIKAI TÁROLÓ** – ahol a fájl ténylegesen van:

```text
F:\Marveen\Rendszer\Tárolók\DRIVE_04\...
F:\Marveen\Rendszer\Tárolók\GOOGLE_PHOTOS\...
```

A kettő között **Marvin saját belső adatmodellje** tart kapcsolatot.
Nem Windows shortcut. Nem fájlrendszer-link. Nem másolat. Nem két példány.

### 3. A fizikai gyökér

```text
F:\Marveen
│
├── KORPÁS LÁSZLÓ
├── BAKOS ÉVA
├── Cégek
├── Tudás
├── Média
├── Digitális
├── Beérkező
├── Megosztott
├── Archív
└── Rendszer
```

**Ne legyen külön `ÉLET` mappa** a fenti szintek fölött.

### 4. Rendszer

```text
Rendszer
├── Marvin
├── Tárolók
│   ├── DRIVE_01 … DRIVE_10
│   └── GOOGLE_PHOTOS
└── Git
```

Dinamikus: ha 15 Drive lesz, 15 tárolót kell kezelni. A `Rendszer` technikai
terület – normál Intéző-nézetben **ne legyen zavaró módon előtérben**. A tárolók
a **Beállítások → Tárolók** felületen kezelhetők.

### 5. Több Google Drive

A Marvin **nem építhet egyetlen Drive-ra**. Minden tárolóhoz tartozzon: egyedi
azonosító, megjelenített név, fizikai hely, Google-fiók, típus, állapot, utolsó
szinkronizálás, jogosultság, aktív/inaktív. A felhasználó adhasson értelmes
nevet (`DRIVE_01 → Laci dokumentumok`, `DRIVE_03 → Freeberischeaper`).

### 6. A Drive nem a munkavégzés elsődleges helye

A munkavégzés **mindig a helyi gépen** történik; a Drive raktár / tartalék.

* Helyi törlés → a Drive szinkronizálhatja a törlést.
* **Drive-ról érkező külső törlés SOHA ne töröljön automatikusan helyi adatot.**
* A helyi gép az elsődleges munkapéldány; a Drive-on a Google kukája ad
  visszaállítást.

### 7. Google Photos

Tárolóként működik, fizikailag letöltve
`F:\Marveen\Rendszer\Tárolók\GOOGLE_PHOTOS` alá, a logikai fában viszont
`Média/KORPÁS LÁSZLÓ/Fotók/Ági családja/kép.jpg` néven jelenik meg,
📷 GOOGLE PHOTOS forrásjelöléssel.

### 8. A Marvin Intéző

Windows Intéző-szerű fájlkezelő: mappa- és fájlmegnyitás, áthelyezés, új mappa,
keresés, részletes információ, forrás és fizikai hely megjelenítése, fizikai
példány állapota, drag & drop ha biztonságos.

**Alapszabály:** ha Marvin leáll, a Windows Intézőből is áttekinthető maradjon.

### 9. Forrásjelölés

`📷 FOTÓ`, `☁ DRIVE`, `🔀 Git`, `💻 HELYI`, `◉ VEGYES`.
Három mód: **ikon (alapértelmezett)**, felirat (`[PHOTOS]`), kikapcsolva.

### 10. Részletes fizikai információ

Az információs panelen: fájlnév, logikai hely, forrás, tároló, fizikai hely,
fizikai példány. Git esetén: repository és branch.

### 11. Személyes ág (példa: KORPÁS LÁSZLÓ)

```text
KORPÁS LÁSZLÓ
├── Identitás
├── Személyes
├── Család
├── Pénzügy
├── Jogi
├── Hatóságok
├── Otthon
├── Munka
├── Projektek
├── Egészség
└── Digitális
```

Az **ország nem kerül a gyökér alá**, csak ott jelenik meg, ahol értelme van:
`Jogi / Pénzügy / Hatóságok` alatt.

> **BOSS KIEGÉSZÍTÉSE (2026-08-21):** ez a struktúra **minden felvett személynél
> teljesen kiépül** – Bakos Évánál is ugyanúgy, mint Korpás Lászlónál –, **akkor
> is, ha éppen nincs benne semmi.** Nincs „csökkentett" személyi ág.
>
> **BOSS MÁSODIK KIEGÉSZÍTÉSE (2026-08-21):** az **országszintek is előre
> létrejönnek**, nem szükség szerint. Indok: „van már jog USA-ban is és németben
> is, meg minden. Hiszen éltem itt is, ott is." Tehát a `Jogi`, `Pénzügy` és
> `Hatóságok` alatt **mind a három kategóriában, mindkét személynél** ki kell
> bontani az országokat, végig.
>
> Az országlista **személyenként konfigurálható** (a kódban nem szerepel
> országnév sem):
>
> ```text
> KORPÁS LÁSZLÓ → Magyarország, Németország, USA
> BAKOS ÉVA     → Magyarország, Németország
> ```
>
> Vagyis:
>
> ```text
> KORPÁS LÁSZLÓ            BAKOS ÉVA
> ├── Jogi                 ├── Jogi
> │   ├── Magyarország     │   ├── Magyarország
> │   ├── Németország      │   └── Németország
> │   └── USA              ├── Pénzügy
> ├── Pénzügy              │   ├── Magyarország
> │   ├── Magyarország     │   └── Németország
> │   ├── Németország      └── Hatóságok
> │   └── USA                  ├── Magyarország
> └── Hatóságok                └── Németország
>     ├── Magyarország
>     ├── Németország
>     └── USA
> ```

### 12–13. Személyes projektek és a Marvin projekt

A projektek **nem automatikusan céges dolgok**.

```text
KORPÁS LÁSZLÓ
└── Projektek
    └── Marvin
        ├── Tudásbázis
        ├── További anyagok
        └── Fejlesztés
            ├── Tudásbázis
            ├── További anyagok
            └── GIT_REPOS
                └── Marvin
```

A `GIT_REPOS/Marvin` alatt a **valódi Git repository** legyen (`git clone`,
`git pull`). A repó saját dokumentációját Marvin **nem módosíthatja**.

### 14–15. Cégek

```text
Cégek
└── FREEBERISCHEAPER
    ├── Céges ügyek
    ├── Levelezés
    ├── Tudásbázis
    ├── Pénzügy
    ├── Jogi
    ├── Marketing
    ├── Weboldal
    └── Fejlesztés
        ├── Tudásbázis
        ├── További anyagok
        └── GIT_REPOS
            ├── freeberischeaper.com
            ├── driver-app
            └── admin
```

A cég **soha nem kerül egy személy alá**. **A Marvin repója itt nem szerepel.**

### 16. Git repók szabálya

A `GIT_REPOS` alatt mindig **valódi Git repository** (`.git`, `src`, `README.md`
…). Nem másolat, nem export, nem kivonat, nem shortcut. A repó tartalmát Marvin
nem rendezheti át. Frissítés: GitHub → `git pull` → helyi repository.

### 17. Tudásbázisok

A repó és a fölötte lévő `Tudásbázis` **nem ugyanaz**. A repó dokumentációjából
Marvin **magasabb szintű kivonatot** készít a `Fejlesztés/Tudásbázis`-ba – ez
összefoglaló tudásréteg, nem másolat.

### 18–19. Média és családi média

```text
Média
├── KORPÁS LÁSZLÓ
│   ├── Fotók
│   ├── Videók
│   ├── Audió
│   └── Szken
├── BAKOS ÉVA
└── Cégek
```

A gyerekek **nem `Child 1 / Child 2`** szerint azonosítandók; a csoportosítás
alapja a családi ág:

```text
Fotók / Videók
├── Ági családja
├── Jutka családja
├── MIKE CSALÁDJA
├── Párom
├── Barátok
├── Utazás
├── Otthon
└── Egyéb
```

A rendszer **ne feltételezze**, hogy minden felhasználónak ilyen családi
csoportjai vannak – telepítéskor konfigurálhatók.

### 20. Drive-ok és a Média kapcsolata

A logikai fa nem változik attól, hogy a kép `DRIVE_02`-n, `DRIVE_07`-en vagy a
Photos-ban van. Egy fájlhoz Marvinnak tudnia kell:
`logicalPath`, `storageId`, `storageType`, `physicalPath`, `sourceProvider`.

### 21. Digitális

Nem másolatgyűjtő. Csak önálló életciklusú digitális dolgok:
`Domainek`, `Eszközök`, `Digitális szolgáltatások`.

**Jelszó, API-kulcs, token SOHA nem kerül ide** – a **Marvin VAULT**-ban marad.

### 22. Beérkező

Bármit ide lehessen dobni (szken, PDF, e-mail melléklet, letöltés, fénykép,
bírósági irat, banki dokumentum, hatósági levél). Besorolási lánc:

```text
KIHEZ TARTOZIK? → MELYIK TERÜLET? → MELYIK ORSZÁG?* → MELYIK ÜGY?
→ MELYIK DOKUMENTUMTÍPUS? → HOVA KERÜLJÖN?
```

\* Az ország csak a megfelelő területeken jelenjen meg.

### 23. Beérkező biztonsági szabályai

* **SOHA ne találja ki**, kihez tartozik egy dokumentum – ha nem biztos, kérdezzen.
* **SOHA ne írjon felül** meglévő fájlt – azonos névnél álljon meg és kérdezzen.
* **SOHA ne tegyen jelszót, API-kulcsot, tokent az életfába.**

### 24. Fizikai papírok

Nagyon egyszerű: nincs QR-kód, nincs külön ID, nincs bonyolult adatbázis, nincs
fizikai mappaazonosító. Egy dokumentumnál csak: **Fizikai példány: IGEN / NEM**.
Ha van, a fizikai hely **ugyanazt a logikai útvonalat** kövesse
(`KORPÁS LÁSZLÓ / Jogi / Németország / BÍRÓSÁG`). Így Marvin nélkül is ugyanazzal
a logikával kereshető papíron és Windowsban.

### 25. Archív

Lezárt, nem aktív anyagok (`KORPÁS LÁSZLÓ`, `BAKOS ÉVA`, `Cégek`).
Marvin **ne archiváljon automatikusan érzékeny ügyet pusztán idő alapján** – az
archiválás felhasználói döntés, vagy külön, explicit szabály.

### 26. Megosztott

Nem „minden, amit másnak küldtem". Csak valóban **megosztott / közös használatú**
anyagok. Ami egy konkrét ügyhöz tartozik, az az ügy saját helyén legyen.

### 27. Egy fizikai fájl = egy fizikai példány

Nem szabad ugyanazt a fájlt több helyre másolni azért, mert több logikai
kategóriához kapcsolódik. Ha több helyről kell elérni, azt **Marvin logikai
nézete** kezelje.

### 28. Mappák generálása

Kötelezően létrejön: a fő gyökérmappák, a személyek, a cégek, az alapstruktúra.

> **BOSS FELÜLÍRÁSA (2026-08-21):** a pont eredeti megfogalmazása
> (`Jogi / USA` csak szükség szerint) **NEM érvényes.** A teljes vázat **előre ki
> kell bontani, végig** – beleértve az országszinteket is, mindkét személynél,
> mind a három országot viselő kategóriában. Indok: az ügyek ténylegesen
> léteznek mindhárom országban, és a felhasználó azt akarja, hogy a hely **már
> ott legyen**, amikor keres vagy lerak valamit.
>
> A „szükség szerint" elv csak arra marad érvényben, ami **nem a vázhoz**
> tartozik: konkrét **ügymappák** (`Németország / BÍRÓSÁG / 2024-es per`),
> konkrét **projektek**, konkrét **repók**, konkrét **cégek**. Ezeket továbbra
> sem találja ki Marvin előre.
>
> A teljes, előre generált váz nagyságrendje ettől is kezelhető marad: két
> személy × 11 kategória + 3 × országbontás + a főágak ≈ néhány tucat mappa,
> nem több száz.

### 29. Nyelv

Belső kategóriák **nyelvfüggetlen kulcsokkal** (`legal`, `finance`, `projects`,
`media`); a megjelenített név konfigurálható (`Jogi`, `Pénzügy`, …). Az
alapértelmezett telepítés magyar. **A kód ne tartalmazzon konkrét személyneveket.**

### 30. Személyek konfigurációja

Semmilyen kódban nem szerepelhet `Korpás László`, `Bakos Éva`, `Ági`, `Jutka`,
`Mike`. A rendszer csak kategóriákat ismer; a személyeket konfigurációból kapja.

### 31. Git és életfa – végleges szabály

```text
Személyes:  KORPÁS LÁSZLÓ / Projektek / Marvin / Fejlesztés / GIT_REPOS / Marvin
Céges:      Cégek / FREEBERISCHEAPER / Fejlesztés / GIT_REPOS / céges-repo
```

A személyes projekt repója **soha ne kerüljön** a cég repói közé, és fordítva.

### 32. A Marvin saját rendszere ≠ az életfa

A Marvin skilljei, konfigurációi, belső indexei, logjai, metaadatai,
rendszerfájljai a **saját technikai környezetében** maradnak. Különösen: **ne
másolja át a WSL/Ubuntu rendszerfájljait az életfába** azért, hogy „minden egy
helyen legyen". A `Rendszer` tárolási réteg lehet, de nem a teljes runtime helye.

### 33. Tárolókezelő

**Beállítások → Tárolók**: lista (ikon, azonosító, név, állapot), új tároló
hozzáadása, átnevezés, deaktiválás, megnyitás, ellenőrzés, szinkronállapot.

### 34. Navigáció

Elsődleges navigáció a **logikai ágak** szerint (`Cégek`, `KORPÁS LÁSZLÓ`,
`Média`, `Tudás`…), **nem** `DRIVE_01 / DRIVE_02 / PHOTOS / Git` szerint.

### 35. Filozófia

> **Az ember szerint rendezzünk, ne a tároló szerint.**

Az ember azt kérdezi: „Hol vannak Laci fotói?" – nem azt, hogy „melyik Drive-on".

### 36. A rendszer végső képe

```text
F:\Marveen
├── KORPÁS LÁSZLÓ
│   ├── Identitás / Személyes / Család / Otthon / Munka / Egészség / Digitális
│   ├── Jogi       → Magyarország, Németország, USA
│   ├── Pénzügy    → Magyarország, Németország, USA
│   ├── Hatóságok  → Magyarország, Németország, USA
│   └── Projektek
│       └── Marvin
│           ├── Tudásbázis / További anyagok
│           └── Fejlesztés
│               ├── Tudásbázis / További anyagok
│               └── GIT_REPOS / Marvin
├── BAKOS ÉVA            (ugyanaz a teljes szerkezet, üresen is;
│                         országok: Magyarország, Németország)
├── Cégek
│   └── FREEBERISCHEAPER
│       ├── Céges ügyek / Levelezés / Tudásbázis / Pénzügy
│       ├── Jogi / Marketing / Weboldal
│       └── Fejlesztés
│           ├── Tudásbázis / További anyagok
│           └── GIT_REPOS / céges repók
├── Tudás
├── Média
│   └── KORPÁS LÁSZLÓ / Fotók, Videók, Audió, Szken
├── Digitális
├── Beérkező
├── Megosztott
├── Archív
└── Rendszer
    └── Tárolók / DRIVE_01 … DRIVE_10, GOOGLE_PHOTOS
```

### 37. A 10 megsérthetetlen fejlesztési szabály

1. A logikai életfa **nem azonos** a fizikai tárolókkal.
2. A felhasználó a logikai életfát látja elsődlegesen.
3. Több Drive egyidejű kezelése **kötelező**.
4. A Drive-ok csak tárolók, nem a felhasználói mappafa alapjai.
5. A munkavégzés helyben történik.
6. A Drive külső törlése nem törölhet automatikusan helyi adatot.
7. A Git repók valódi repók a megfelelő személy/cég `GIT_REPOS` mappájában.
8. A Marvin **személyes** projekt: `<személy> / Projektek / Marvin` alatt.
9. A céges repók a `Cégek / <cég> / Fejlesztés / GIT_REPOS` alatt.
10. Egy fájlt **ne másoljunk** több helyre azért, mert több helyről néznénk.

### 38. Végső működési példa

Beérkező PDF → Marvin felismeri (személy / jogi / Németország / bírósági ügy) →
`KORPÁS LÁSZLÓ / Jogi / Németország / BÍRÓSÁG / dokumentum.pdf`, az információs
panelen: forrás `💻 HELYI`, fizikai példány IGEN, fizikai irat IGEN.

---

## Fejlesztői megjegyzések (Claude, 2026-08-21) – NEM része a Boss specifikációjának

Ezek nyitott pontok, amikre a megvalósítás előtt döntés kell:

1. **`ÉLET` mappa megszűnik.** A jelenlegi kód `<depó>/ÉLET` gyökeret használ, és
   `LifeNode.rel` ahhoz képesti. A gyökér `<depó>` lesz → a `mounts` és a
   `physical` bejegyzések útvonalait migrálni kell (`ÉLET/` előtag levágása).
2. **A mostani `drive/`, `fotok/`, `projektek/`, `munka/`, `mentesek/`,
   `rendszer/` mappák (~30 GB) átkerülnek** `Rendszer/Tárolók/DRIVE_xx`,
   `Rendszer/Tárolók/GOOGLE_PHOTOS` alá. A szinkron-célútvonalakat (drive-sync,
   fotók-letöltő) együtt kell átállítani, különben két helyre töltenek.
3. **`Digitális` kétszer szerepel**: főágként (21. pont) és a személyi ág egyik
   kategóriájaként (11. pont). Ez szándékos-e? Javaslat: a személyi alatti a
   személy saját digitális eszközei/előfizetései, a főág a háztartás-szintűeké.
4. **`Tudás` főág tartalma** továbbra sincs definiálva. Javaslat: ide gyűljön a
   Marvin által készített, nem személyhez/céghez kötött tudásréteg.
5. ~~**Több Drive kezelése** ma nincs meg~~ — **MEGVAN (2026-08-21).** Lásd
   lentebb: „TÖBBFIÓKOS TÁROLÓK". A `drive-sync` valójában már fiókonkénti
   mappába írt; ami hiányzott, az a nyilvántartás és a Git fiók-szintje.
6. **Külső törlés elleni védelem (6. pont)** ma nincs implementálva – a Drive
   szinkron kétirányú. Ezt külön kártyán kell megcsinálni, mert adatvesztési
   kockázat.

---

## MEGVALÓSULÁS — 2026-08-21 (commit `fcbcc6f` + `89cd4c6`)

Ez a szakasz azt rögzíti, hogy a fenti specifikációból **mi épült meg**, és
mi nem. Azért van a dokumentum végén, hogy a terv szövege érintetlen maradjon:
a terv a szándék, ez a mérleg.

### Megépült

| Spec | Mi lett belőle |
|---|---|
| 3. | Nincs `ÉLET` gyűjtőmappa: a személyek közvetlenül a depó gyökerében állnak |
| 4./36. | `Rendszer/Tárolók` — **csak ez**, lásd a lenti helyesbítést |
| 11. | 11 személyi kategória, **minden** személynek, üresen is (Boss felülírása) |
| 12–13. | `<személy>/Projektek/<projekt>/{Tudásbázis, További anyagok, Fejlesztés/{…, GIT_REPOS}}` |
| 15–16. | 8 céges kategória, `Fejlesztés/GIT_REPOS` valódi repóknak |
| 18. | `Média/<személy>/<típus>/<ország>/<csoport>` |
| 21. | `Digitális/{Domainek, Eszközök, Digitális szolgáltatások}` — jelszó nélkül |
| 25–26. | `Archív`, `Megosztott` |
| 28. | Az országszintek **előre** elkészülnek (a Boss felülírása), a konkrét ügymappák továbbra is szükség szerint |
| 29–30. | A kódban egyetlen valódi név sincs; a sablonok helyőrzőket használnak, és ezt teszt őrzi |
| 31. | A személyes és a céges git-repók külön ágon állnak |
| 33. | A depó helye a Beállításokból állítható |

**Ezen felül**, a Boss külön kérésére:

- **Ország-bontás kapcsolóként.** Nem fix a „csak Jogi/Pénzügy/Hatóságok" hármas:
  személyenként eldönthető, mely területek bomoljanak országra — a **Média is**,
  hogy a három ország fotói és videói külön álljanak.
- **Kész sablonok** friss telepítéshez (`src/life-templates.ts`): négy szerkezet,
  amit a felhasználó kiválaszt, aztán a neveket átírja magára.
- **A `drive` és a `fotok` a gyökérben maradt.** A többi technikai mappa a
  `Rendszer` alá került; ez a kettő a Boss döntése alapján nem mozdult, és élő
  szinkron-cél is, tehát az elmozdítása a letöltéseket a régi útra írná.

### Még nincs kész

Ezek **nem** részei ennek a körnek, és külön fejlesztést igényelnek:

1. **Több Drive-tároló kezelése** (5., 33.) — `DRIVE_01..10`, Beállítások → Tárolók.
   Ma egy Drive-fiók van bekötve.
2. **Külső törlés elleni védelem** (6.) — a Drive-ból érkező törlés ne törölhesse
   vissza a helyi életfát. Ez a szinkron-motor módosítása, nem a fáé.
3. **A Beérkező-lánc automatikus besorolása** (22–23.) — a mappa és a szabályok
   megvannak, a mozgató logika nem.
4. **A per-fájl adatmodell** (20.) — `storageId`, `physicalPath`, `sourceProvider`
   minden fájlra. Ma a forrásjelvény a mappa bekötéséből következtet.

### Ami változatlanul tilos

Jelszó, API-kulcs és token **soha** nem kerül az életfába (21., 23.) — ezek a
Marvin Vaultban maradnak. A kód nem is kínál nekik helyet.

---

## HELYESBÍTÉS — 2026-08-21 (Boss: „nézd át újra az egész mapparendszert")

A fenti megvalósulás három ponton **eltért** a specifikációtól. A Boss kérésére a
spec az irányadó, tehát a fa ezekben visszaállt:

| Eltérés | Ami volt | Ami a spec szerint van |
|---|---|---|
| `Rendszer` tartalma | `Marvin`, `Tárolók`, `Git`, plusz a depó `Munka` és `Mentések` mappája | **csak `Tárolók`** (36. pont). A `Marvin` a 8. alapszabály szerint személyes projekt (`<személy>/Projektek/Marvin`), a git-repók a 7. pont szerint a `GIT_REPOS`-ban vannak. A depó technikai munkamappái a `Tárolók` alá kerültek. |
| Személyi kategóriák | 12 (a `Dokumentumok`-kal) | **11** — a 11. és a 36. pont felsorolásában nincs `Dokumentumok` |
| Országszintek | minden kategória alatt | **csak `Jogi` / `Pénzügy` / `Hatóságok` alatt** (11. pont) |

Az „ország-bontás kapcsolóként" lehetőség a kódban **megmarad** (személyenként
bekapcsolható bármelyik területre), de az **alapértelmezés** a specifikáció
hármasa. Ami a lemezen kiépült és üres volt, azt a helyesbítés eltakarította;
nem üres mappát nem törölt.

Ezzel egy időben minden generált mappanév **mondatkezdő** alakra váltott
(`CSALÁD` → `Család`) — a Boss saját elnevezése (`Mykael család`) alapján.


---

## TÖBBFIÓKOS TÁROLÓK — 2026-08-21

> Boss: „több fiókosra kell megcsinálni. drive fotok es git is! tobb fiokkal."

**Mi volt már készen, és mi nem.** A mérés (nem becslés) ezt adta:

| Ág | Állapot a kérés előtt |
|---|---|
| Drive | **többfiókos volt** — `depotAccountDir()`, 6 fiók mappája állt a lemezen |
| Fotók | **többfiókos volt** — ugyanaz, 3 fiók |
| Git | **NEM volt** — egyetlen lapos `Tárolók/Git/<repó>`, fiók-szint nélkül |
| Tároló-nyilvántartás (33. pont) | **nem létezett** — sehol nem látszott együtt, hány tároló van |

### Amit ez a kör hozzátett

1. **`src/storages.ts` — tároló-nyilvántartás.** A három fajta (`drive`,
   `photos`, `git`) egy listában, a specifikáció 33. pontja szerint: azonosító,
   név, állapot, átnevezés, ki/be kapcsolás, ellenőrzés.

2. **Stabil azonosítók: `DRIVE_01 … DRIVE_10`, `PHOTOS_01 …`, `GIT_01 …`** —
   a 36. pont végső képe szerint. A kiosztás `store/storages.json`-ba kerül, és
   **egy számot sosem osztunk ki kétszer**: ha egy fiókot levesznek, a
   felszabadult szám nem kerül új fiókhoz, különben egy régi fizikai hivatkozás
   hirtelen más tárolóra mutatna (20. pont `storageId`-je).

3. **A mappa neve marad a FIÓK neve** (`Drive/lackor2`), nem `DRIVE_01` — a 35.
   pont miatt: Marveen nélkül, a Windows Intézőből is értelmes legyen. Az
   átnevezés csak a megjelenített nevet írja át, a mappát nem mozdítja.

4. **Git fiók-szint: `Tárolók/Git/<fiók>/<repó>`.** Ez a 31. pont szabályát
   (a személyes repó soha ne keveredjen a cégessel) mappaszinten is
   érvényesíti. A régi, lapos `Git/<repó>` továbbra is beköthető marad — egy
   már bekötött repó nem tűnhet el csak azért, mert bevezettük a fiók-szintet.

5. **Ami a lemezen van, sosem tűnik el a listáról.** Egy lejárt tokenű fiók
   mappája `connected: false`-ként jelenik meg, nem hiányzóként: a fájlok ott
   vannak, csak szinkron nincs mögöttük. A kikapcsolás sem töröl semmit.

### Felület

**Depó → Tárolók** kártya: a teljes lista azonosítóval és állapottal, soronként
Átnevezés / Ki-be kapcsolás / Ellenőrzés, alul „Git-fiók hozzáadása". A
Drive- és Fotók-fiókokat itt szándékosan NEM lehet felvenni: azok a
Google-bejelentkezésből jönnek (Fiókok oldal), így egy elgépelt fióknév nem
szülhet üres, sosem szinkronizáló sort.

### Mérve, éles telepítésen

`GET /api/storages` a valódi depón (`F:\Marveen`): **DRIVE_01 … DRIVE_10** és
**PHOTOS_01 … PHOTOS_10** a 10 bekötött Google-fiókból, majd a felületről
felvett **GIT_01** (`Tárolók/Git/lackor2-crypto`, a mappa létre is jött).
Teljes teszt-suite: 347 fájl / 5177 teszt, zöld.


## MÉDIA A SZEMÉLY ALÁ — 2026-08-21

Boss: *„a media t rakd belulre a korpas laszlo ala."*

Eddig a `Média` **közös felső ág** volt (18-20. pont): `Média/<személy>/<típus>/…`.
Mostantól minden személy és minden cég **saját `Média` kategóriát** kap, és
felső szintű `Média` ág **nincs többé**.

| Eddig | Mostantól |
|---|---|
| `Média/Korpás László/Fotók/Ági családja` | `Korpás László/Média/Fotók/Ági családja` |
| `Média/Bakos Éva/Videók/Család` | `Bakos Éva/Média/Videók/Család` |
| `Média/Cégek/Freeberischeaper/Fotók` | `Cégek/Freeberischeaper/Média/Fotók` |
| `Cégek/…/Marketing/Média/Fotók` (9. pont) | `Cégek/…/Média/Fotók` (a FEJLESZTÉS testvére) |
| `Szken` | `Szkennek` |

Miért: aki a fotóit keresi, annál az **embernél** kezdi — nem egy külön
képtárban, ami mellett a jogi ügyei másutt állnak. A kategórián belüli bontás
(típus → ország → családi csoport) **változatlan**; az ország továbbra is a
típus alatt áll, nem a `Média` alatt, hogy egy szinten ne keveredjen kétféle
rendezőelv.

A depón (`F:\Marveen`) az áthelyezés megtörtént, adatvesztés nélkül (a
mappák üresek voltak): `Média/*` → `<tulajdonos>/Média/*`, a felső `Média`
törölve.

## AZ „ÚJRATÖLTÉS" CSÍK MEGSZŰNT — 2026-08-21

Boss: *„ez ne jelenjen meg tobbet! ha kell toltse ujra de automatikusan!!!"*

Ha új változat kerül ki, a lap **magától** tölt újra. Egyetlen kivétel: ha a
kurzor épp egy szöveges mezőben áll, vagy nyitva van egy ablak, akkor vár, és
pár másodpercenként újrapróbálja — a begépelt szöveget semmilyen frissesség
nem éri meg.


## HÁROMSZINTŰ GIT-VÉDELEM — 2026-08-21

Boss: *„a gitrol lehuzott filek ezek. ha valtoztatni kell akkor a igtre
felpusholva valtozik nem? esetleg ha mar nincs szukseg ra akor
lecsatlakoztatni vagy az egeszet torolni azt lehessen.”*

Nem egy szabály van, hanem három — mert három különböző dolog történhet:

| Mi | Mit teszünk | Miért |
|---|---|---|
| A repón **belüli** fájl áthelyezése / új mappa oda | **Megtagadjuk**, de mindig megmondjuk, mit tegyen helyette (szerkesztő → commit → push) | kézzel mozgatva a git elveszíti a fájl történetét; a következő letöltés vagy visszasírja, vagy csendben eldobja |
| Magának a **repó-mappának** a törlése | **Szabad** — de előbb megmérjük (`git status`, a távoli ág előtti commitok), és emberi mondatban kimondjuk | egy klón eldobható és visszahúzható; a veszély nem a törlés, hanem a benne lévő **fel nem töltött munka** |
| A **bekötés** megszüntetése | Szabad, és ezt ajánljuk **elsőként** | semmit nem töröl, csak eltűnik a fából |

A mért mondat két alakja:

- tiszta: *„Nyugodtan törölhető: minden fel van töltve ide: <távoli>, bármikor visszahúzható.”*
- veszélyes: *„⚠ 3 commit nincs feltolva és 2 fájl módosítva — ha törlöd, ez a munka elvész.”*

Amit **szándékosan nem** csináltunk: az egész `GIT_REPOS` ág írásvédelme.
Egyrészt a friss telepítésnek is a felületről kell működnie — ha a repó
sehogy nem takarítható, terminál kell hozzá. Másrészt a teljes tiltás
kerülőútra kényszerít (Windows Intéző), ahol **semmilyen** figyelmeztetés
nincs. Jobb bent tartani az embert, és a veszélyes pillanatban mérni.

Kód: `src/git-guard.ts` (szabály), `src/web/routes/life.ts` (kapu),
`web/app.js` → `_intezoRenderGit` (felület). Végpontok:
`GET /api/life/repo-status`, `POST /api/life/repo-delete`.
A törlés a rá mutató bekötéseket is megszünteti — különben egy üres mappa
látszana, és a felhasználó azt hinné, elvesztek a fájljai.

## CÉLMAPPA-TALLÓZÓ ABLAK — 2026-08-21

Boss: *„nem inkabb egy kis panelnek kellene bejonnie ahol kitallozod azt a
mappat amibe at akarod helyezni a filet?”*

Korábban az **egész Intéző** átkapcsolt „válassz célt” üzemmódba: el kellett
navigálni a célig (közben elveszett a kiindulási hely), és egy sáv a lap
tetején magyarázta, mi történik — aki lejjebb görgetett, már nem látta.

Most külön kis ablak nyílik: mappalista, „Fel egy szintet”, alul látszik,
hova kerül, és ott van a „Ez legyen az” gomb. A háttérben minden a helyén
marad. A git-repók itt is `📛` jelet kapnak — aki oda tallózik, előre látja,
hogy oda nem fog tudni bepakolni. Mappát a saját maga alá nem is kínáljuk fel.

Ugyanez az ablak szolgálja a **papír példány helyét** is (egy megoldás, két
hely). A papír helye ráadásul alapból a fájl saját mappája — Boss:
*„alapbol amugy a beviteli mezo alhatna ott ahol eppen van a file”* —, így a
leggyakoribb esetben tallózni sem kell, csak menteni.


## AUTOMATIKUS GIT-SZINKRON — 2026-08-21

Boss: *„meg az osszes git ahol van a mapparendszerben. mind szinkronizaljon
automatan”*.

A `src/git-sync.ts` 6 óránként (indulás után 5 perccel először) végigjárja a
**teljes depó-fát**, nem csak a `Rendszer/Tárolók/Git` alatti repókat. Ahol
`.git`-et talál, ott megáll és nem megy mélyebb — egy repóba ágyazott mappa nem
külön repó, és egy nagy repó bejárása percekbe kerülne körönként.

Egyetlen dolgot kell itt biztosra tudni, és az **nem** az, hogy frissít: azt,
hogy **soha nem semmisít meg helyi munkát**. Ezért a szinkron kizárólag
`fetch` + `merge --ff-only`, és **kihagyja** a repót, ha

| eset | mit tesz |
|---|---|
| nincs távoli ága | hozzá sem nyúl |
| módosított fájl van benne | hozzá sem nyúl |
| fel nem töltött commit van benne | hozzá sem nyúl, és szól, hogy pushra vár |

`reset`, `checkout --force`, `pull --rebase` és `stash` **sehol** nem fut. Egy
elveszett commit visszahozhatatlan, egy elavult repó pedig egy gombnyomás.

A Tárolók lapon a *„🔄 Szinkron most”* ugyanezt a kódot futtatja — nincs külön
„kézi” út, amit külön lehetne elrontani —, és a kimaradt repókat **indokkal**
kiírja. Egy néma „3 kimaradt” arra tanítaná a felhasználót, hogy ne is nézze
meg, pedig éppen ott van a tennivaló.

## GIT-FIÓK: KULCS ÉS LEHÚZÁS A FELÜLETRŐL — 2026-08-21

Boss: *„azal nincs vege hogy egy nevet hozzaadok!!! az felkesz munka!”* és
*„ne te csinald meg. manualisan is tudjam en mindent megcsinalni.”*

Három lépés, mind a felületről (`src/git-accounts.ts`):

1. **Fiók felvétele** — ettől még csak a mappája jön létre.
2. **🔑 Kulcs** — a Marveen **azonnal ellenőrzi a GitHubnál**, és csak akkor
   menti, ha működik; megmondja, hány repót lát vele. Egy elgépelt kulcs csendes
   eltárolása a legrosszabb: minden zöldnek látszana, és csak hetek múlva derülne
   ki, hogy semmi nem jött le.
3. **⬇ Repók** — a hiányzókat lehozza, a meglévőkhöz nem nyúl, tehát bármikor
   újra megnyomható.

**A már bekötött gh-fiókok átvétele.** Boss: *„freeberischeaper, usalackor,
lackor2 ezeket mar bekotottuk.”* Ha a gépen a `gh` már be van jelentkezve,
a Marveen **azt a kulcsot használja**, és nem kér újat. A hozzárendelés
pontos névegyezés vagy `<fiók>-` kezdetű gh-felhasználó (`lackor2` →
`lackor2-crypto`, `usalackor` → `usalackor-blip`) — szándékosan ennyi és nem
több: egy találgatósabb párosítás előbb-utóbb **idegen fiók** kulcsát adná oda.
A sorban ki van írva, honnan jön a kulcs, mert ha ott kijelentkeznek, itt is
elfogy.

**Hol lakik a token.** Nem a fában (21./23. pont), nem a `storages.json`-ben:
külön fájlban, `0600` jogokkal, és a szerver **soha nem adja vissza** a
böngészőnek — csak azt, hogy van-e. A `.git/config`-ba sem kerül: a távoli cím
`https://<fiók>@github.com/...` marad (felhasználónév, nem titok), a kulcsot
futásidőben egy `GIT_ASKPASS` segédprogram adja át a környezetből. Parancssori
argumentumként soha: az `argv` minden felhasználónak látszik (`ps`).


## KÖLCSÖNKULCS: OLVASNI AZT IS, AMI NEM A MIÉNK — 2026-08-21

Boss: *„ha nem lehet letolteni az usalackorrol, mert nem az ove, akkor hogyan
fogjuk olvasni a repokat?”*

A hozzáférés **nem a tulajdonon múlik, hanem a jogosultságon**. Az
`usalackor-blip` kulcsa mind a 6 `freeberischeaper`-repót látja
(közreműködőként). Eddig csak azt néztük, mit **birtokol** egy fiók
(`affiliation=owner`), ezért nem jött le semmi.

Mostantól, ha egy fiókhoz nincs saját kulcs, a lehúzás **megkérdezi a
GitHubot**, hogy a gépen lévő gh-bejelentkezések közül lát-e valamelyik olyan
repót, aminek **az a fiók a gazdája** — és csak akkor kölcsönöz. Név alapján
sosem találgatunk: egy találgatósabb párosítás előbb-utóbb idegen fiók kulcsát
adná oda.

**A titok nem másolódik.** A token-tárba csak az kerül, hogy *kié* a kulcs
(`borrowedFrom`), maga a kulcs nem. Futásidőben keressük elő, tehát ha ott
kijelentkeznek, itt is elfogy — nem marad egy elfelejtett másolat egy céges
kulcsról. A klón címébe a **kulcs gazdájának** a neve kerül, nem a fióké.

A felület kiírja: *„kulcs: kölcsön a(z) usalackor-blip fióktól (csak
olvasás)”*. Ez nem díszítés: aki nem tudja, min áll a hozzáférése, az nem tudja
megjavítani sem, amikor elromlik.

A repók a fiók saját mappájába kerülnek (`Rendszer/Tárolók/Git/<fiók>`), és a
fába **bekötéssel** látszanak — például
`Cégek/Freeberischeaper/Fejlesztés/GIT_REPOS`. Másolat sehol.

## TÁROLÓ-SOR TÖRLÉSE — 2026-08-21

Fel lehetett venni git-fiókot, levenni nem — csak kikapcsolni, amitől a sor ott
maradt. A **🗑 Fiók törlése** mérés után, két körben dolgozik; fel nem töltött
munka esetén `force`-szal **sem** töröl, hanem a repó saját törlő-útjára küld,
ahol egyesével látszik, mi veszne el. Fontos részlet: a Tárolók listája a
**lemezről is** dolgozik, ezért a regiszterből törlés önmagában nem tünteti el
a sort — a mappának is mennie kell.


## CSAK-OLVASAS ZAR AZ IDEGEN REPOKON — 2026-08-21

Boss: *„csak olvasni akarom… igy fennal a veszelye hogy beleszerkeszt az egyik
agent veletlenul"* és *„olyat amit nem tud egy agent feltorni vagy barki"*.

**Mit kell tulajdonkeppen megvedeni.** Nem a helyi fajlokat: azok elromolhatnak,
ujra lehuzhatok. A ceges tarolo a vedendo, es oda egyetlen uton jut el barmi —
a **feltoltessel**. Ezert nem fajl-jogot allitunk (azt egy ugynok eszre sem
venne, vagy megkerulne, kozben a sajat munkajat is ellehetetlenitene), hanem a
push utjat vagjuk el.

**Ket fuggetlen reteg**, mert egyet visszavonni keves legyen:

1. `remote.origin.pushurl` egy szandekosan ervenytelen, **beszedes** ertek. A
   git szo szerint kiirja, tehat a hibauzenet maga mondja meg, mi tortent.
2. `.git/hooks/pre-push`, ami a **cimtol fuggetlenul** fut. Aki a cimet
   visszaallitja — ez az elso, amit barki tenne —, meg mindig ebbe utkozik.

A `fetch` mindketton athalad, tehat olvasni es frissulni tovabbra is lehet.
Az `isRepoReadOnly` **mindket** reteget nezi: a felig levett zarat nem jelenti
zartnak, mert azt rosszabb zartnak latni, mint nyitottnak — utana se nezne
senki.

**Amit ez NEM tud, es nem is allitjuk rola.** A gepen teljes joggal futo
folyamat mindket reteget leszedi, ha kifejezetten azt akarja. A helyi zar a
**veletlen** ellen szol. A tenyleg attorhetetlen zar nem itt all, hanem a
GitHub oldalan: egy **irasjog nelkuli kulcs** (fine-grained token, Contents:
Read). Azzal a feltoltes nem azert nem megy, mert megakadalyozzuk, hanem mert
nincs mivel. Amig kolcsonkulcson allunk, a kulcs a kolcsonzo jogait hozza.

**A Marveen sajat szinkronja sosem push-ol fiok-repoba**: a `git-sync` csak
`fetch` + `merge --ff-only`. A kodban egyetlen `push` van, es az a Marveen sajat
`store/window-layout-repo`-jara megy.

**A fiok-mappa neve a repo GAZDAJAT koveti, nem a kulcs gazdajat.** A ceges
repok ezert `Freeberischeaper` alatt allnak akkor is, ha `usalackor-blip`
kulcsaval jottek le — az `usalackor` ala tenni oket hazugsag lenne arrol, kie a
kod, es a nev ugysem vedene semmit. A vedelmet a zar adja, nem a mappa neve.


## MAPPA-SÚGÓK ÉS A FRISS TELEPÍTÉS ALAPSTRUKTÚRÁJA — 2026-08-21

**Miért.** Boss: *„en nem tudom mit szoktak tenni a digitalis, identitas,
otthon, szemelyes, stb ala.. csalad? szoval minden mappahoz irj zarojelbe vagy
5 dolgot"*, majd *„ha valaki letolti a marveen omat, akkor legyen neki egy alap
konytarstruktura. kitalt nevekkel!"* — egy üres, magyarázat nélküli fa nem
mondja meg, mire való.

**A súgók.** Egyetlen forrás: `src/life-hints.ts`. A kulcs a **gépi** név, nem a
magyar mappanév, így egy angol telepítésen ugyanaz a súgó tartozik ugyanahhoz a
helyhez. A súgó **soha nem kerül a mappa NEVÉBE** — az átnevezés eltörne minden
utat, bekötést és rögzített hivatkozást; a zárójeles rész csak a képernyőn
létezik. A megfogalmazás szabálya: konkrét, felismerhető példák
(„lakcímkártya", „közüzemi számla"), nem kategórianevek.

Globálisan jelenik meg: a fa-lista (`/api/life/list` → `entry.hint`), a
mappaválasztó gombok, és a `/api/life/hints` végpont mind ugyanabból a táblából
dolgozik.

**A Beérkező.** A gyökér legelső eleme, saját színnel és 📥 ikonnal. Ez a
bejárat: ezen keresztül kerül minden a helyére. A gazda közvetlenül utána áll,
a `Rendszer` marad leghátul.

**Friss telepítés.** `defaultLifeConfig()` a tulajdonos MELLETT ad egy példa
személyt (`Példa Panna`) és egy példa céget (`Példa Kft`). A nevek szándékosan
felismerhetően kitaláltak: egy valódinak látszó minta-név évekig ott maradna,
mert senki nem meri kitörölni. A súgójuk kimondja az átnevezést ÉS a törlést is
— egy példa, amit nem lehet egyszerűen eltüntetni, tehertétel.

**Változatlan tilalom.** Jelszó, API-kulcs és token továbbra sem kerül a fába
(§21, §23) — a `Digitális` és a `Digitális szolgáltatások` súgója ezt ki is
írja ott, ahol a kísértés lenne rá.

**Tesztek:** `src/__tests__/life-fresh-install.test.ts` — a példa-ágak
megléte, a nevek felismerhetősége, a súgó-tábla teljessége (minden kulcs
visszatalál egy létező fa-mappára), és a jelszó-tilalom szövege.


## A KÉT `Tudásbázis` MARAD — DÖNTÉS, 2026-08-22

Boss rákérdezett, miért áll `Tudásbázis` és `További anyagok` a projekt (illetve
cég) szintjén **és** a `Fejlesztés` alatt is. Ez **nem regresszió**: a 13. és a
17. pont szándékosan tart két réteget — a projekt saját tudása, és külön a
repók dokumentációjából készült összefoglaló.

**Döntés:** *„ne vedd ki. […] akkor hagyd ott."* A szerkezet marad. Egy későbbi
átnézésen ezt **nem szabad** duplikációként kivenni.

Amit a félreértés ellen tettünk: a súgó helyfüggő. A `Fejlesztés` alatt más
szöveg áll, és kimondja, hogy „nem ugyanaz, mint a projekt fölötte lévő
Tudásbázisa" (`DEV_KNOWLEDGE_HINT`, `DEV_MORE_HINT`). A nevet nem írtuk át:
az minden utat és bekötést eltörne.

Pontosítás, hogy ne rögzüljön félre: ez **nem a keresést gyorsítja**. Azt
tartja külön, aminek külön a helye.

A teljes tervezett fát végigszámoltuk: pontosan **3** ilyen hely van (a Marvin
és a Freeberischeaper fejlesztési ága). Önmagát ismétlő, vagy a szülőjével
azonos nevű mappa **nincs**.


## AZ INTÉZŐ KEZELÉSE: JOBB EGÉRGOMB, KUKA, ÚTMUTATÓ — 2026-08-22

Boss visszajelzése: *„bassza meg hogy jojjon erre ra az ember a komuvesunk hogy
ra kell nyomnia az info gombra? … kimaradt a torles! … nem is ertem hogy miert
nem lehet ezeket a mappa letrehozasokat stb megcsinalni ugy ahogy az intezoben
van. jobb egergomb mappa letrehoz es kesz."*

Három dolog változott, és mind a hármat a **megszokás** vezette: a felhasználó
azt próbálja ki, amit a Windows Intézőben megtanult.

1. **Jobb egérgomb.** A sorra jobb gombbal kattintva a Marveen **előbb kijelöli**
   a sort (Boss: *„persze elobb kivalasztas"*), majd felkínálja a műveleteket:
   megnyitás, új mappa ide, átnevezés, áthelyezés, bekötés, papír példány,
   törlés. Üres területen: „Új mappa itt". A menü ugyanazokat a függvényeket
   hívja, mint a felső gombsor — egy viselkedés, két bejárat.
2. **Bal klikk a soron = kijelölés.** A néven a klikk továbbra is **belép** (az a
   leggyakoribb művelet), de a sor bármely más pontja kijelöl. A kijelölés
   ezzel nem múlik többé azon, hogy valaki megtalálja-e a sor végén az „Info"
   gombot.
3. **Törlés — de Kukával.** `trashLife()` a `Rendszer/Kuka/<időbélyeg>/` alá
   mozgat, nem töröl. Egy fa-nézetben, ahol egy sorral feljebb valakinek a
   teljes élete áll, visszafordíthatatlan gombot nem adunk a kéz alá; a Windows
   Intézőben sincs igazi törlés.

**Az őrzők (mind a négy élesben lemérve):**

| eset | válasz | miért |
|---|---|---|
| git-repó belseje | `git_repo` | a git a gazda, kézzel mozgatva elvész a fájl története |
| bekötött mappa | `mounted` | csak mutató; kukázni megtévesztő („töröltem, mégis ott van") |
| repó gyökere | `repo` | van saját, **mérő** végpontja, ami előbb megnézi a fel nem töltött munkát |
| a fa fő ága | `top` | a következő „Könyvtárszerkezet létrehozása" úgyis visszatenné → a beállításban kell kivenni |

Az **átnevezés** külön művelet, nem az áthelyezés egy esete: a felhasználónak is
két külön dolog, és a hibaüzenete is más. Bekötött mappát nem enged átnevezni —
a bekötés az útvonalra szól, új néven nem találna rá.

**Használati útmutató a felületen.** A `docs/` alatti leírást a kőműves sosem
fogja megnyitni, ezért az útmutató **az Intéző lap tetején**, összecsukható
kártyában áll (`#intezoHelp`): mozgás a fában, új mappa, átnevezés/áthelyezés/
törlés, új személy–cég–projekt öt lépése, git-repó bekötése lépésről lépésre,
mihez ne nyúljon kézzel, és a „törölhetek a Windows Intézőből?" kérdés
megválaszolva. A sablon-blokk címe **„Sablonok — kezdj egy kész szerkezettel"**:
a korábbi cím kedves volt, de nem mondta ki a szót, amit a szem keres.

A „Mentés és előnézet" után a lap **odagörget** a „Könyvtárszerkezet
létrehozása" gombhoz és négy másodpercre kiemeli — enélkül a felhasználó azt
hiszi, kész van, pedig a lemezen még nem történt semmi.
