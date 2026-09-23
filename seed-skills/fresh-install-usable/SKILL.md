---
name: fresh-install-usable
description: KÖTELEZŐ minden fejlesztésnél. Minden funkciót úgy kell megírni, hogy egy FRISSEN TELEPÍTETT Marveenben is végig lehessen csinálni a felületről — üres adatbázissal, a fejlesztő adatai nélkül, terminál és API-hívás nélkül. Használd, amikor bármilyen új funkciót, oldalt, mappaszerkezetet, integrációt vagy beállítást építesz, és akkor is, amikor egy meglévőt bővítesz.
scope: global
---

# FRISSEN TELEPÍTETT MARVEENBEN IS MŰKÖDJÖN

{{OWNER_NAME}} szó szerinti kikötése (2026-08-21):

> „ugy csinald hogy a marveen feluleten egy ujjonnan telepitett marveen ban is
> meg tudja a user ezt csinalni. ki tudja alakitani sajat magatol a
> mappparendszert!!"
> „mindig! kotelezo igy eljarni, implementalni."

Ez **nem egy plusz szempont a végén**, hanem a feladat része. Ha egy funkció
csak azért működik, mert ezen a gépen már ott van egy fájl, egy mappa, egy
bejegyzés az adatbázisban vagy egy kézzel meghívott API-végpont — akkor **nincs
kész**, akkor is, ha itt hibátlanul fut.

## A próba, amit minden munka végén el kell végezni

Képzeld el, hogy valaki most telepítette a Marveent. Üres `store/`, üres
adatbázis, semmilyen szinkron nem futott le, a te neved sehol. **Végig tudja
csinálni, amit most megépítettél, kizárólag kattintgatással?**

Ha bármelyik lépésnél „hát ehhez előbb be kell írni a JSON-ba" / „ehhez kell egy
curl" / „ezt Claude állítja be neki" a válasz — a munka nincs kész.

## Az öt tipikus bukás

1. **Nincs felület a beállításhoz.** A háttér (API) kész, ellenőriz, hibát is
   mond — de a felületről nem lehet elérni, csak `POST`-tal. A felhasználó nem
   fog curl-özni. *Példa: az életfa lakóit (személyek, cégek) hónapokig csak
   `POST /api/life/config`-gal lehetett szerkeszteni.*
2. **A beállító doboz elrejtőzik, és nincs másik út.** Az „első indítás"
   varázsló eltűnik, amint kész, és utána már nem lehet módosítani. **Minden
   beállításhoz kell egy állandó, megtalálható út is.**
3. **Az üres állapot hibaüzenetnek látszik.** Egy friss telepítésen minden
   lista üres. Az üres lista **nem hiba**: mondd meg, mit tegyen
   („Még nincs mit bekötni — előbb a Drive oldalon hozz le tartalmat"), ne azt,
   hogy „nincs adat" vagy `no_depot`.
4. **A hibaüzenet gépi kód.** `bad_config`, `EACCES`, `no_depot` — a
   felhasználónak magyar mondat kell, ami megmondja a **következő lépést**.
5. **A mérés csak a hiba pillanatában fut, ezért soha nem tud magától
   megjavulni.** Ez a legalattomosabb, mert a szám nem hiányzik és nem is
   nulla: **elavult**, és pontosan úgy néz ki, mint egy friss adat.
   *Valós eset, 2026-09-23:* a Drive tárhely-mérését (`recordDriveQuota`)
   EGYETLEN helyről hívtuk, a „megtelt a tárhely" hiba kezelőjéből. Amíg van
   hiba, van mérés — de amint {{OWNER_NAME}} helyet szabadított fel, a hiba
   megszűnt, tehát **semmi nem mért újra**, a régi hiba viszont a naplóban
   maradt. A képernyő a végtelenségig ismételte a hajnali számot: a tárolt
   mérés 03:30-as volt (14,65 GB), miközben a Google saját felülete 13:28-kor
   már 13,1 GB-ot mutatott. A felhasználó jogosan mondta: „van hely rajtuk.
   mi az hogy nincs hely?"

   **A szabály:** ha egy mért szám csak a hibaágon frissül, akkor a hiba
   megszűnése után **strukturálisan képtelen** helyesre fordulni. A mérésnek
   a NORMÁL úton is futnia kell (a futás elején, ütemezetten, vagy egy kézi
   „Mérd meg most" gombról), és a rá épülő jelzésnek **önmagát kell tudnia
   visszavonni**: ha a friss mérés újabb a hibánál és ellentmond neki, a
   **friss mérés nyer**, a sor eltűnik. Kötelező kérdés minden mérésre:
   *„mi hozza vissza zöldre ezt a sort, ha a felhasználó megoldotta a
   problémát?"* Ha nincs rá válasz, a mérés hibás.

## Amit kötelező megépíteni minden új funkcióhoz

- **Felület minden beállításhoz**, amit a funkció igényel — beleértve a
  későbbi módosítást is, nem csak a létrehozást.
- **Üres kezdőállapot**, ami magától elindul (egy üres sorral, alapértékkel),
  nem üres képernyővel.
- **Előnézet minden visszafordíthatatlan lépés előtt** — a felhasználó lássa,
  MI fog történni (hány mappa jön létre, mi íródik felül), mielőtt megnyomja.
- **Ellenőrzés a szerveren, emberi mondattal.** A felület a szerver
  `message` mezőjét mutassa, ne az `error` kódot.
- **Semmi fixen beírt azonosító** — lásd a `host-agnostic-development` skillt.
  A kód a VÁZAT ismerje, a konkrét neveket a felhasználó adja.
- **Ha a funkció egy külső programot hív** (LibreOffice, ffmpeg, pdftotext,
  tesseract, himalaya, ...), vedd fel a `src/system-deps.ts` listájába
  (szint: alap / ajánlott / extra, mire kell, csomagnév apt/dnf/brew alatt), és
  a csomagot az `install-linux.sh` ajánlott-programok szakaszába is. Ettől
  kapja meg a friss telepítés, és ettől látja az önellenőrzés és a varázsló
  „Rendszer-programok" lépése, ha hiányzik. A `system-deps.test.ts` elbukik,
  ha a lista és a telepítő elválik. (Kanban d7acdd75: a LibreOffice úgy
  hiányzott, hogy semmi nem szólt érte.)

## A záró önellenőrzés (írd is le a válaszodban)

1. Üres `store/`-ral is elindul? Nem dob hibát, hanem felkínálja a beállítást?
2. Minden beállítás elérhető a felületről, **most is és később is**?
3. Van előnézet a lemezre író / visszafordíthatatlan lépés előtt?
4. Minden hibaút magyar mondattal végződik, ami a következő lépést mondja meg?
5. Kerestél a kódban a fejlesztő gépére jellemző értéket (név, útvonal, fiók,
   meghajtóbetű)? Ha találtál, kivezetted beállításba?
6. **Minden nulla/üres eredménynél meg tudod különböztetni a „még nincs"-et a
   „nem látok oda"-tól?** Ha nem, a mérés hibás — lásd alább.
7. **Ha a felhasználó megoldja a problémát, mi viszi vissza zöldre a jelzést?**
   Nevezd meg a konkrét utat. Ha csak a hibaágon mérsz, nincs ilyen út, és a
   sor örökre ott marad — lásd az 5. bukást.

## ⛔ A NULLA KÉT DOLGOT JELENTHET (2026-08-23)

{{OWNER_NAME}}: „remelem akik ujonnan telepitik a marveent azoknak ez nem fog elojonni.
azoknak sem." — és: „ugy kell fejleszteni hogy az ujonnan telepitett
marveenban is mukodjon minden!!!"

A friss telepítés próbájának van egy néma testvére. A git-lehúzás bejárása egy
**elérhetetlen depó-gyökéren** nulla tárolót talált. Az önellenőrzés ebből azt
olvasta ki, hogy „nincs bekötve git" — és hallgatott. Közben minden tároló
elavult. Egy friss telepítésen a csend a HELYES válasz ugyanarra a nullára;
egy elállt csatolásnál a leghangosabb sor kell.

**A szabály:** ha egy szám nulla lehet azért is, mert még nincs semmi, és
azért is, mert nem fértél hozzá — akkor a kódnak KÜLÖN kell megkérdeznie a
forrást (elérhető-e a mappa, válaszol-e a szolgáltatás), és nem szabad a
találatok számából következtetnie.

**És soha ne találgasd az okot.** Ugyanez a hiba másik fele volt, hogy a sor
azt állította, „általában hiányzó vagy rossz kulcs az ok", holott mind az öt
hiba hálózati volt. A tippelt ok rosszabb a semminél: rossz irányba küldi a
felhasználót. Az okot a TÉNYLEGES hibaüzenetből olvasd ki, és ha nem ismered
fel, mondd meg, hogy nem tudod.

## Kapcsolódó szabályok

- `host-agnostic-development` — semmi fixen beírt azonosító.
- CLAUDE.md: „A FELHASZNÁLÓ NEM PROGRAMOZÓ" — a hülyebiztos felület.
- CLAUDE.md: „KÖTELEZŐ HATÁSVIZSGÁLAT" — a friss-telepítés próba ennek
  mostantól **kötelező pontja**.
