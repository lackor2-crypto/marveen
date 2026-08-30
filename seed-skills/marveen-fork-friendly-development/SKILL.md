---
name: marveen-fork-friendly-development
description: ÁLLANDÓ, ELSŐDLEGES SZABÁLY -- minden Marveen KÖVETETT kódját (src/, web/, scripts/, package.json) érintő fejlesztésnél vedd figyelembe, hogy ez egy fork (upstream: Szotasz/marveen), és minimalizáld a jövőbeli upstream-merge ütközéseit. Trigger: új funkció építése, meglévő megosztott fájl (web/app.js, src/db.ts, src/web.ts, web/style.css, package.json) módosítása, vagy upstream merge/pull végzése.
scope: global
---

# Marveen fork-barát fejlesztés

{{OWNER_NAME}} állandó szabálya (2026-08-06): mivel Marveen a saját GitHubjára (a te fork-fiókod alá, `<YOUR_GH_ACCOUNT>/marveen`) forkolt verzió az eredeti Szotasz/marveen-ből, és mindkét oldal folyamatosan fejlődik egymástól függetlenül, MINDEN jövőbeli fejlesztésnél ELSŐDLEGES szempontként vedd figyelembe, hogy minél kevesebb ütközés legyen egy jövőbeli upstream-merge-nél.

**Miért fontos:** 2026-08-06-i állapotfelmérés szerint a fork (main) 25 commit-tal állt az upstream előtt (főleg az email-funkció), az upstream közben 33 commit-tal ment tovább nélkülünk, és 10 fájlt mindkét oldal módosított -- ezek közül a legkritikusabb a `web/app.js` (monolitikus, több ezer soros fájl, szinte minden dashboard-funkció ide megy mindkét oldalon). {{OWNER_NAME}} explicit kérte, hogy ez legyen minden jövőbeli fejlesztés elsődleges szempontja, ne csak egy utólagos megfontolás.

## Mikor alkalmazd

- Minden alkalommal, amikor Marveen KÖVETETT kódját (`src/`, `web/`, `scripts/`, `package.json`) módosítod vagy új funkciót építesz -- akár {{OWNER_NAME}} kérésére, akár saját kezdeményezésre.
- Amikor upstream-merge-öt/pull-t végzel.
- Fejlesztés-tervezéskor, MIELŐTT hozzákezdenél az implementációhoz (ez legyen az egyik első szempont, nem utólagos csiszolás).

## Szabályok (ebben a sorrendben mérlegeld)

1. **Új funkció -> új fájl, ha logikailag elkülöníthető.** Ha egy funkció önálló modulnak tekinthető (pl. `email-imap.ts`, `email.ts` route -- ezek már bevált minta), tedd ÚJ fájlba, ne egy meglévő megosztott fájlba zsúfold. Az upstream soha nem fog egy csak-nálunk-létező fájlhoz nyúlni -> nulla ütközési kockázat, amíg a fájl neve nem ütközik egy upstream által később bevezetett azonos nevű fájllal (ritka, de nézd meg gyorsan).

2. **Megosztott/monolitikus fájloknál (`web/app.js`, `src/db.ts`, `src/web.ts`, `web/style.css`, `package.json`) additív szerkesztés, ne átszervezés.** Új kódot egy jól elkülönült blokkhoz/a fájl végéhez add hozzá, ne írj át meglévő függvényeket/sorrendet ha nem feltétlenül szükséges. Git sor-alapú merge-je csak akkor ütközik ténylegesen, ha UGYANAZOKAT a sorokat módosítja mindkét oldal -- tiszta hozzáadás a legtöbbször automatikusan összefésülhető.

3. **`package.json`/`package-lock.json`**: új dependency-t a lista logikus helyére (ábécésorrend, ha azt követi a fájl) illeszd, ne rendezd át/formázd újra az egész fájlt egy apró változtatásért.

4. **Rendszeres, kis lépésekben történő upstream-szinkron, ne ritka nagy merge.** Ne hagyd hónapokig nőni a szakadékot -- egy havi ütemezett ellenőrzés fut erre (lásd lent), ami Telegramon jelenti az állapotot.

5. **Implementáció előtti gyors self-check**: mielőtt egy meglévő megosztott fájlhoz nyúlnál, tedd fel a kérdést -- "ez tényleg csak itt oldható meg, vagy kiszervezhető egy külön modulba?" Ha kiszervezhető, azt válaszd, még ha egy kicsit több munkával is jár most.

## Diagnosztika -- ütközési kockázat gyors felmérése

```bash
git fetch upstream main
git diff --name-only upstream/main...main   # a mi egyedi módosításaink (upstream-hez képest)
git diff --name-only main...upstream/main   # amit upstream változtatott nélkülünk
comm -12 <(git diff --name-only upstream/main...main | sort) <(git diff --name-only main...upstream/main | sort)   # átfedő fájlok -- itt van tényleges ütközés-kockázat
```

Ha egy tervezett módosítás olyan fájlt érintene, ami ezen a listán szerepel, az önmagában nem tiltó ok -- csak jelzi, hogy extra körültekintéssel (additív szerkesztés, kis diff) érdemes hozzányúlni.

## Havi upstream-szinkron: próbamerge külön branch-en

Ütemezett feladat (`marveen-upstream-divergence-check`) fut havonta (a hónap 1. napján, 08:00), és {{OWNER_NAME}} 2026-08-06-i pontosítása szerint NEM csak jelent, hanem ténylegesen megpróbálja a merge-öt egy KÜLÖN branch-en (soha nem a main-en közvetlenül):

1. `git fetch upstream main`, állapotfelmérés (hány commit elő/hátra).
2. Új branch (`upstream-sync-YYYY-MM`) a main-ből, azon `git merge upstream/main`.
3. **Ha konfliktusmentes**: build + tesztek futtatása annak ellenőrzésére hogy semmi nem tört el, majd kanban kártya (status: waiting) + jóváhagyás-kérés a tulajdonosnak ({{OWNER_NAME}}) a nem-ütköző rész behúzásáról. Push/merge a main-be CSAK jóváhagyás után.
4. **Ha van tényleges ütközés**: `git merge --abort`, majd kanban kártya (status: planned) ami felsorolja mely fájlokban/sorokban ütközik, és röviden összefoglalja mit változtatott mindkét oldal -- hogy a tulajdonossal ({{OWNER_NAME}}) együtt fájlonként eldönthető legyen mi kerül be és mi nem.
5. Telegram-összefoglaló mindkét esetben.

**A lényeg, amit {{OWNER_NAME}} explicit tisztázott:** a nem-ütköző részek automatikusan (git natív hunk-szintű merge-je alapján) behúzhatók -- ez pont az, amit egy sima `git merge` amúgy is tud (fájlszinten "érintett mindkét oldal" nem jelent automatikusan sorszintű ütközést). Az ütköző részeknél viszont közös döntés kell, hogy egyáltalán hasznos-e nekünk az adott upstream-változtatás. Push a main-be MINDIG csak jóváhagyás után (lásd [[marveen-code-change-warning]]) -- ez akkor is érvényes, ha a merge technikailag konfliktusmentes volt.

### Tényleges (sor-szintű) ütközés feloldása

Amikor git tényleges ütközést talál, mindkét verziót beteszi a fájlba konfliktus-jelölőkkel (`<<<<<<< HEAD` / `=======` / `>>>>>>> upstream/main`) -- nem automatikusan dönt. Két tipikus eset:

1. **Egymás melletti, független hozzáadás** (mindkét oldal ugyanahhoz a listához/blokkhoz tett hozzá valamit, csak nem ugyanoda) -- ilyenkor egyszerűen mindkettő megtartható, nincs valódi szándék-ütközés, csak a git nem tudta magától eldönteni a sorrendet. Ez biztonságosan, önállóan feloldható.
2. **Upstream átalakított/átnevezett valamit, amit mi is használunk vagy módosítottunk** -- ilyenkor a saját kódunkat kell hozzáigazítani az új formához. Ha ez csak mechanikus (pl. egy átnevezett függvényhívás javítása), önállóan megoldható. Ha viselkedést/logikát is érintene, vagy nem egyértelmű hogy melyik oldal "szándéka" az irányadó, NE dönts egyedül -- tedd ki a konkrét részt (mindkét verziót) a kanban kártyára, és a tulajdonossal ({{OWNER_NAME}}) együtt döntsétek el.

### Három lehetséges kimenetel egy ütköző résznél ({{OWNER_NAME}}, 2026-08-06)

Egy tényleges ütközésnél nem csak "erőltessük össze" a válasz -- három érvényes út van, a tulajdonossal ({{OWNER_NAME}}) közösen (a kanban kártyán) eldöntve, melyik illik az adott esetre:

1. **Befogadás (merge):** ha az upstream diffje közvetlenül, kis igazítással beilleszthető, és tényleg kell nekünk -- ez az alapeset.
2. **Saját megvalósítás az upstream diff helyett:** ha az upstream ÖTLETE/célja jó, de a konkrét kódja nem illik a mi (időközben eltérő) kódunkhoz, akkor NEM kell az ő diffjüket beerőltetni -- megírható a mi logikánk szerint, ugyanazt a célt elérve. Ez a helyzettől függően EGYSZERŰBB is lehet, mint egy nehéz konfliktust kibogozni.
3. **Végleges kihagyás:** ha nem fontos/nem kell nekünk, egyszer eldöntjük és RÖGZÍTJÜK -- utána a jövőbeli merge-eknél ez a döntés automatikusan érvényesül, nem kérdezzük újra minden hónapban.

**Döntés-napló:** `store/knowledge/upstream-sync-decisions.md` (gitignore-olt, per-install fájl) -- minden 2. és 3. típusú döntés ide kerül rögzítésre (mit, miért, mikor). A havi upstream-sync feladat MINDIG ELŐSZÖR ezt a fájlt nézi át, mielőtt egy ismétlődő ütközést újra elemezne -- ha a terület már szerepel benne "kihagyjuk" döntéssel, a konfliktust csendben a mi verziónk megtartásával oldja fel (nincs újra kanban kártya, nincs újra Telegram-kérdés), "saját megvalósítás" döntésnél pedig ellenőrzi hogy a korábban megírt saját verzió még mindig megvan-e / nem kell-e frissíteni.

## Buktatók

- `web/app.js` a legnagyobb ütközési felület -- monolitikus, több ezer soros, mindkét oldal rendszeresen módosítja. Extra körültekintés kell itt, akár érdemes megfontolni hosszú távon egy modulokra bontást (ez maga is egy jövőbeli, a tulajdonossal ({{OWNER_NAME}}) egyeztetendő döntés, nem egyoldalúan meghozandó).
- Ne halogasd az upstream-merge-t "majd egyszer"-re -- minél régebbi az utolsó szinkron, annál fájdalmasabb és kockázatosabb lesz a végeredmény.
- Ez a szabály a [[marveen-code-change-warning]] mellett érvényes, nem helyette -- egy tervezett kódmódosítás előtt MINDKÉT szempontot vedd figyelembe: (a) kell-e {{OWNER_NAME}} explicit jóváhagyása a kód-módosításhoz, (b) hogyan minimalizáljuk az upstream-ütközést.
