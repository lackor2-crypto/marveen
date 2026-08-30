---
name: recheck-before-restating
description: KÖTELEZŐ újramérés. Ha egy tényt MÁSODSZOR is kimondasz — mert a felhasználó visszakérdez, mert összefoglalóba írod, vagy mert egy következő lépés épül rá —, előbb újra le kell mérned. A saját korábbi válaszod és az emlékezet nem forrás. Minden állapotra, dátumra, verzióra, jelszóra, darabszámra és listára érvényes.
scope: global
---

# Újra állítás előtt újra meg kell nézni

## A szabály

**Ha egy tényt másodszor is kimondasz, előbb újra le kell mérned.**

A saját korábbi válaszod **nem forrás**. A beszélgetés eleje **nem forrás**. Az
emlékezet **nem forrás**. Ezek arról szólnak, mi volt igaz *akkor*, nem arról,
mi igaz *most*. A kettő között a felhasználó dolgozott a rendszeren.

{{OWNER_NAME}}, 2026-08-25: „mielőtt állítasz újra valamit, akkor meg kell nézned újra!
mindig a friss infót adni a usernek."

## Miért van ez a szabály (a valódi eset)

2026-08-24 13:09-kor egy ellenőrzést végző ügynök a break-glass végponttal
átállította a tulajdonos dashboard-jelszavát egy teszt-sztringre. Ez bekerült a
beszélgetés kontextusába. Másnap, egy összefoglaló végén ez a mondat ment ki a
tulajdonosnak: „a jelszavad még mindig `testpassword123`".

A tulajdonos **ugyanaznap 13:16:40-kor**, hét perc múlva már át is állította.

A visszakérdezése egyetlen mondat volt: *„ezt honnan veszed? már rég
kijavítottam."* És a helyes válasz az volt, hogy sehonnan — emlékeztem. Egyetlen
`SELECT updated_at FROM dashboard_users` két másodperc alatt eldöntötte volna.

**Az elavult adat rosszabb a hiányzónál.** A hiányzó adat miatt valaki utánanéz;
az elavult adat miatt a tegnapi állapot alapján cselekszik.

## Mikor kötelező újramérni

Minden olyan tény, ami az idő múlásával megváltozhat:

- **állapot** — fut-e a szolgáltatás, aktív-e egy ügynök, mennyi a hely, él-e a
  kapcsolat;
- **dátum és időbélyeg** — mikor futott le utoljára, mikor járt le, mikor
  módosult;
- **verzió, commit, build** — a `git log -1` tegnap más volt;
- **fájl** — létezik-e, mi van benne (más ügynök vagy a felhasználó közben írhatta);
- **jelszó, token, hozzáférés, jogosultság** — ezek kifejezetten azért
  változnak, mert valaki megváltoztatja;
- **darabszám és lista** — hány kártya, hány ügynök, hány hiba;
- **egy korábbi hiba** — „még mindig fennáll?" mindig újramérendő kérdés.

Triggerek, amikre azonnal újramérés jár: „még mindig…", „ugyanaz…", „ahogy
mondtam…", „a korábbi…", a beszélgetés-összefoglaló, és minden olyan válasz,
amit egy `/compact` vagy egy session-folytatás után adsz.

## Ha nem tudod újramérni

Akkor **ne add elő ténynek**. Mondd meg, mikori adatból beszélsz, és hogy most
nem tudtad ellenőrizni:

- ✅ „A legutóbbi mérésem szerint (tegnap 21:50) X volt — most nem tudtam
  ellenőrizni, mert nincs hozzáférésem a DB-hez."
- ❌ „X."

A „legutóbb X volt" és az „X" **két különböző mondat**. Ez ugyanaz a szabály,
mint a nulla kétértelműsége: a „nem látok oda" nem ugyanaz, mint a „nincs".

## Ha az újramérés mást mutat

A **friss adat nyer**. Javítsd ki röviden és tényszerűen, és mondd meg, honnan
tudod (melyik táblát, melyik parancsot, melyik fájlt nézted meg). Ne
mentegetőzz, ne írj hosszú önkritikát, és **ne találgasd, miért változott meg**
— ha az ok érdekes, azt is mérd meg (ki írta, mikor, melyik úton).

## Önellenőrzés a válasz elküldése előtt

1. Van a válaszomban olyan tény, amit **nem most mértem**?
2. Ha igen: meg tudom mérni? Ha igen, **mérjem meg**, ne írjam le előtte.
3. Ha nem tudom megmérni: oda van írva, hogy **mikori** adat, és hogy most nem
   ellenőriztem?
4. Ha a mérés mást mutat, mint a korábbi állításom: kijavítottam, és megmondtam,
   **melyik forrásból**?
