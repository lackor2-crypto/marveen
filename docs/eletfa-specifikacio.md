# MARVIN – EGYSÉGES ÉLET- ÉS ADATTÁR

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
MÉDIA/KORPÁS LÁSZLÓ/FOTÓK/ÁGI CSALÁDJA
```

**B) FIZIKAI TÁROLÓ** – ahol a fájl ténylegesen van:

```text
F:\Marveen\RENDSZER\TÁROLÓK\DRIVE_04\...
F:\Marveen\RENDSZER\TÁROLÓK\GOOGLE_PHOTOS\...
```

A kettő között **Marvin saját belső adatmodellje** tart kapcsolatot.
Nem Windows shortcut. Nem fájlrendszer-link. Nem másolat. Nem két példány.

### 3. A fizikai gyökér

```text
F:\Marveen
│
├── KORPÁS LÁSZLÓ
├── BAKOS ÉVA
├── CÉGEK
├── TUDÁS
├── MÉDIA
├── DIGITÁLIS
├── BEÉRKEZŐ
├── MEGOSZTOTT
├── ARCHÍV
└── RENDSZER
```

**Ne legyen külön `ÉLET` mappa** a fenti szintek fölött.

### 4. RENDSZER

```text
RENDSZER
├── MARVIN
├── TÁROLÓK
│   ├── DRIVE_01 … DRIVE_10
│   └── GOOGLE_PHOTOS
└── GIT
```

Dinamikus: ha 15 Drive lesz, 15 tárolót kell kezelni. A `RENDSZER` technikai
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
`F:\Marveen\RENDSZER\TÁROLÓK\GOOGLE_PHOTOS` alá, a logikai fában viszont
`MÉDIA/KORPÁS LÁSZLÓ/FOTÓK/ÁGI CSALÁDJA/kép.jpg` néven jelenik meg,
📷 GOOGLE PHOTOS forrásjelöléssel.

### 8. A Marvin Intéző

Windows Intéző-szerű fájlkezelő: mappa- és fájlmegnyitás, áthelyezés, új mappa,
keresés, részletes információ, forrás és fizikai hely megjelenítése, fizikai
példány állapota, drag & drop ha biztonságos.

**Alapszabály:** ha Marvin leáll, a Windows Intézőből is áttekinthető maradjon.

### 9. Forrásjelölés

`📷 FOTÓ`, `☁ DRIVE`, `🔀 GIT`, `💻 HELYI`, `◉ VEGYES`.
Három mód: **ikon (alapértelmezett)**, felirat (`[PHOTOS]`), kikapcsolva.

### 10. Részletes fizikai információ

Az információs panelen: fájlnév, logikai hely, forrás, tároló, fizikai hely,
fizikai példány. Git esetén: repository és branch.

### 11. Személyes ág (példa: KORPÁS LÁSZLÓ)

```text
KORPÁS LÁSZLÓ
├── IDENTITÁS
├── SZEMÉLYES
├── CSALÁD
├── PÉNZÜGY
├── JOGI
├── HATÓSÁGOK
├── OTTHON
├── MUNKA
├── PROJEKTEK
├── EGÉSZSÉG
└── DIGITÁLIS
```

Az **ország nem kerül a gyökér alá**, csak ott jelenik meg, ahol értelme van:
`JOGI / PÉNZÜGY / HATÓSÁGOK` alatt.

> **BOSS KIEGÉSZÍTÉSE (2026-08-21):** ez a struktúra **minden felvett személynél
> teljesen kiépül** – Bakos Évánál is ugyanúgy, mint Korpás Lászlónál –, **akkor
> is, ha éppen nincs benne semmi.** Nincs „csökkentett" személyi ág.

### 12–13. Személyes projektek és a MARVIN projekt

A projektek **nem automatikusan céges dolgok**.

```text
KORPÁS LÁSZLÓ
└── PROJEKTEK
    └── MARVIN
        ├── TUDÁSBÁZIS
        ├── TOVÁBBI ANYAGOK
        └── FEJLESZTÉS
            ├── TUDÁSBÁZIS
            ├── TOVÁBBI ANYAGOK
            └── GIT_REPOS
                └── Marvin
```

A `GIT_REPOS/Marvin` alatt a **valódi Git repository** legyen (`git clone`,
`git pull`). A repó saját dokumentációját Marvin **nem módosíthatja**.

### 14–15. CÉGEK

```text
CÉGEK
└── FREEBERISCHEAPER
    ├── CÉGES ÜGYEK
    ├── LEVELEZÉS
    ├── TUDÁSBÁZIS
    ├── PÉNZÜGY
    ├── JOGI
    ├── MARKETING
    ├── WEBOLDAL
    └── FEJLESZTÉS
        ├── TUDÁSBÁZIS
        ├── TOVÁBBI ANYAGOK
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

A repó és a fölötte lévő `TUDÁSBÁZIS` **nem ugyanaz**. A repó dokumentációjából
Marvin **magasabb szintű kivonatot** készít a `FEJLESZTÉS/TUDÁSBÁZIS`-ba – ez
összefoglaló tudásréteg, nem másolat.

### 18–19. MÉDIA és családi média

```text
MÉDIA
├── KORPÁS LÁSZLÓ
│   ├── FOTÓK
│   ├── VIDEÓK
│   ├── AUDIÓ
│   └── SZKEN
├── BAKOS ÉVA
└── CÉGEK
```

A gyerekek **nem `Child 1 / Child 2`** szerint azonosítandók; a csoportosítás
alapja a családi ág:

```text
FOTÓK / VIDEÓK
├── ÁGI CSALÁDJA
├── JUTKA CSALÁDJA
├── MIKE CSALÁDJA
├── PÁROM
├── BARÁTOK
├── UTAZÁS
├── OTTHON
└── EGYÉB
```

A rendszer **ne feltételezze**, hogy minden felhasználónak ilyen családi
csoportjai vannak – telepítéskor konfigurálhatók.

### 20. Drive-ok és a MÉDIA kapcsolata

A logikai fa nem változik attól, hogy a kép `DRIVE_02`-n, `DRIVE_07`-en vagy a
Photos-ban van. Egy fájlhoz Marvinnak tudnia kell:
`logicalPath`, `storageId`, `storageType`, `physicalPath`, `sourceProvider`.

### 21. DIGITÁLIS

Nem másolatgyűjtő. Csak önálló életciklusú digitális dolgok:
`DOMAINEK`, `ESZKÖZÖK`, `DIGITÁLIS SZOLGÁLTATÁSOK`.

**Jelszó, API-kulcs, token SOHA nem kerül ide** – a **MARVIN VAULT**-ban marad.

### 22. BEÉRKEZŐ

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
(`KORPÁS LÁSZLÓ / JOGI / NÉMETORSZÁG / BÍRÓSÁG`). Így Marvin nélkül is ugyanazzal
a logikával kereshető papíron és Windowsban.

### 25. ARCHÍV

Lezárt, nem aktív anyagok (`KORPÁS LÁSZLÓ`, `BAKOS ÉVA`, `CÉGEK`).
Marvin **ne archiváljon automatikusan érzékeny ügyet pusztán idő alapján** – az
archiválás felhasználói döntés, vagy külön, explicit szabály.

### 26. MEGOSZTOTT

Nem „minden, amit másnak küldtem". Csak valóban **megosztott / közös használatú**
anyagok. Ami egy konkrét ügyhöz tartozik, az az ügy saját helyén legyen.

### 27. Egy fizikai fájl = egy fizikai példány

Nem szabad ugyanazt a fájlt több helyre másolni azért, mert több logikai
kategóriához kapcsolódik. Ha több helyről kell elérni, azt **Marvin logikai
nézete** kezelje.

### 28. Mappák generálása

Kötelezően létrejön: a fő gyökérmappák, a személyek, a cégek, az alapstruktúra.
A mélyebb mappák (`JOGI / USA`) **szükség szerint** jönnek létre, nem üresen
előre.

### 29. Nyelv

Belső kategóriák **nyelvfüggetlen kulcsokkal** (`legal`, `finance`, `projects`,
`media`); a megjelenített név konfigurálható (`JOGI`, `PÉNZÜGY`, …). Az
alapértelmezett telepítés magyar. **A kód ne tartalmazzon konkrét személyneveket.**

### 30. Személyek konfigurációja

Semmilyen kódban nem szerepelhet `Korpás László`, `Bakos Éva`, `Ági`, `Jutka`,
`Mike`. A rendszer csak kategóriákat ismer; a személyeket konfigurációból kapja.

### 31. Git és életfa – végleges szabály

```text
Személyes:  KORPÁS LÁSZLÓ / PROJEKTEK / MARVIN / FEJLESZTÉS / GIT_REPOS / Marvin
Céges:      CÉGEK / FREEBERISCHEAPER / FEJLESZTÉS / GIT_REPOS / céges-repo
```

A személyes projekt repója **soha ne kerüljön** a cég repói közé, és fordítva.

### 32. A Marvin saját rendszere ≠ az életfa

A Marvin skilljei, konfigurációi, belső indexei, logjai, metaadatai,
rendszerfájljai a **saját technikai környezetében** maradnak. Különösen: **ne
másolja át a WSL/Ubuntu rendszerfájljait az életfába** azért, hogy „minden egy
helyen legyen". A `RENDSZER` tárolási réteg lehet, de nem a teljes runtime helye.

### 33. Tárolókezelő

**Beállítások → Tárolók**: lista (ikon, azonosító, név, állapot), új tároló
hozzáadása, átnevezés, deaktiválás, megnyitás, ellenőrzés, szinkronállapot.

### 34. Navigáció

Elsődleges navigáció a **logikai ágak** szerint (`CÉGEK`, `KORPÁS LÁSZLÓ`,
`MÉDIA`, `TUDÁS`…), **nem** `DRIVE_01 / DRIVE_02 / PHOTOS / GIT` szerint.

### 35. Filozófia

> **Az ember szerint rendezzünk, ne a tároló szerint.**

Az ember azt kérdezi: „Hol vannak Laci fotói?" – nem azt, hogy „melyik Drive-on".

### 36. A rendszer végső képe

```text
F:\Marveen
├── KORPÁS LÁSZLÓ
│   ├── IDENTITÁS / SZEMÉLYES / CSALÁD / PÉNZÜGY / JOGI / HATÓSÁGOK
│   ├── OTTHON / MUNKA / EGÉSZSÉG / DIGITÁLIS
│   └── PROJEKTEK
│       └── MARVIN
│           ├── TUDÁSBÁZIS / TOVÁBBI ANYAGOK
│           └── FEJLESZTÉS
│               ├── TUDÁSBÁZIS / TOVÁBBI ANYAGOK
│               └── GIT_REPOS / Marvin
├── BAKOS ÉVA            (ugyanaz a teljes szerkezet, üresen is)
├── CÉGEK
│   └── FREEBERISCHEAPER
│       ├── CÉGES ÜGYEK / LEVELEZÉS / TUDÁSBÁZIS / PÉNZÜGY
│       ├── JOGI / MARKETING / WEBOLDAL
│       └── FEJLESZTÉS
│           ├── TUDÁSBÁZIS / TOVÁBBI ANYAGOK
│           └── GIT_REPOS / céges repók
├── TUDÁS
├── MÉDIA
│   └── KORPÁS LÁSZLÓ / FOTÓK, VIDEÓK, AUDIÓ, SZKEN
├── DIGITÁLIS
├── BEÉRKEZŐ
├── MEGOSZTOTT
├── ARCHÍV
└── RENDSZER
    └── TÁROLÓK / DRIVE_01 … DRIVE_10, GOOGLE_PHOTOS
```

### 37. A 10 megsérthetetlen fejlesztési szabály

1. A logikai életfa **nem azonos** a fizikai tárolókkal.
2. A felhasználó a logikai életfát látja elsődlegesen.
3. Több Drive egyidejű kezelése **kötelező**.
4. A Drive-ok csak tárolók, nem a felhasználói mappafa alapjai.
5. A munkavégzés helyben történik.
6. A Drive külső törlése nem törölhet automatikusan helyi adatot.
7. A Git repók valódi repók a megfelelő személy/cég `GIT_REPOS` mappájában.
8. A Marvin **személyes** projekt: `<személy> / PROJEKTEK / MARVIN` alatt.
9. A céges repók a `CÉGEK / <cég> / FEJLESZTÉS / GIT_REPOS` alatt.
10. Egy fájlt **ne másoljunk** több helyre azért, mert több helyről néznénk.

### 38. Végső működési példa

Beérkező PDF → Marvin felismeri (személy / jogi / Németország / bírósági ügy) →
`KORPÁS LÁSZLÓ / JOGI / NÉMETORSZÁG / BÍRÓSÁG / dokumentum.pdf`, az információs
panelen: forrás `💻 HELYI`, fizikai példány IGEN, fizikai irat IGEN.

---

## Fejlesztői megjegyzések (Claude, 2026-08-21) – NEM része a Boss specifikációjának

Ezek nyitott pontok, amikre a megvalósítás előtt döntés kell:

1. **`ÉLET` mappa megszűnik.** A jelenlegi kód `<depó>/ÉLET` gyökeret használ, és
   `LifeNode.rel` ahhoz képesti. A gyökér `<depó>` lesz → a `mounts` és a
   `physical` bejegyzések útvonalait migrálni kell (`ÉLET/` előtag levágása).
2. **A mostani `drive/`, `fotok/`, `projektek/`, `munka/`, `mentesek/`,
   `rendszer/` mappák (~30 GB) átkerülnek** `RENDSZER/TÁROLÓK/DRIVE_xx`,
   `RENDSZER/TÁROLÓK/GOOGLE_PHOTOS` alá. A szinkron-célútvonalakat (drive-sync,
   fotók-letöltő) együtt kell átállítani, különben két helyre töltenek.
3. **`DIGITÁLIS` kétszer szerepel**: főágként (21. pont) és a személyi ág egyik
   kategóriájaként (11. pont). Ez szándékos-e? Javaslat: a személyi alatti a
   személy saját digitális eszközei/előfizetései, a főág a háztartás-szintűeké.
4. **`TUDÁS` főág tartalma** továbbra sincs definiálva. Javaslat: ide gyűljön a
   Marvin által készített, nem személyhez/céghez kötött tudásréteg.
5. **Több Drive kezelése** ma nincs meg: a `drive-sync` egyetlen fiókra épül.
   Ez önálló, nagyobb fejlesztés (tároló-nyilvántartás + Beállítások → Tárolók).
6. **Külső törlés elleni védelem (6. pont)** ma nincs implementálva – a Drive
   szinkron kétirányú. Ezt külön kártyán kell megcsinálni, mert adatvesztési
   kockázat.
