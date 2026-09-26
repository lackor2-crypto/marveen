---
name: bake-in-wizard-selfcheck
description: KÖTELEZŐ minden Marveen- és Iroda-fejlesztésnél, ami új képességet, külső szolgáltatást (API-kulcs, token, fiók), telepítendő programot vagy beállítást hoz be. A fejlesztés kizárólag a Marveenbe beégetve, globálisan készül (friss telepítésen is ott van), és ugyanabban a munkában bekerül a Beállítások → Varázslóba ÉS az Áttekintés önellenőrzésébe. Trigger -- új API-kulcs vagy token, új integráció (kép-, videó-, hanggenerálás, keresés, felhő), új telepítendő program, új beállítás a config-registry-ben, vagy a kérdés "benne van-e a varázslóban / az önellenőrzésben?".
scope: global
---

# BEÉGETVE, VARÁZSLÓBAN, ÖNELLENŐRZÉSBEN

{{OWNER_NAME}} (2026-09-26, #404):

> „barmi fejlesztunk a marveen on vagy az irodan ugy kell fejleszteni hogy a
> marveen ba beegetve globalisan! csak kizarolag igy fejlesztunk. es az
> onellenorzesbe mindig be kell kotni. meg a varazsloba ha telepites van."

**A valós eset.** A Munkapad webkeresésének kulcsa csak a Munkapad oldalán volt
beállítható. A telepítő varázsló nem tudott róla, az önellenőrzés nem kérdezte,
és a súgó szövege („van ingyenes csomag") elavult, mire kiderült. Egy friss
telepítésen senki nem vezette volna végig a felhasználót.

## A három kötelező pont (egy munkában, nem „majd")

1. **Beégetve, globálisan.** Kód a repóban, skill a `seed-skills/` alatt,
   sablon a `templates/` alatt, helyőrzőkkel (`{{OWNER_NAME}}` stb.). Ami csak
   ezen a gépen van meg (`~/.claude/...`, kézzel másolt fájl, kézi `.env`-sor),
   az friss telepítésen nem létezik. Lásd `host-agnostic-development`.
2. **Varázsló.** Ha a felhasználónak bármit be kell állítania vagy telepítenie
   kell (kulcs, token, bejelentkezés, program), akkor legyen rá egy lépés a
   `src/web/setup-wizard-registry.ts` `SETUP_ITEMS` listájában:
   - külső szolgáltatás → `group: 'integrations'`, `tier: 'extra'` (vagy amit a
     tulajdonos mond), `required: false`;
   - számozott lépések (`stepKeys`), kattintható linkek (`links`), példa
     (`exampleKey`), és egy súgó, ami kimondja, **mi történik nélküle**;
   - **ingyenes csomag / ingyenes keret**: mondd meg őszintén, van-e, mennyi,
     kell-e bankkártya. Ellenőrizd a szolgáltató oldalán, ne emlékezetből írd
     (az árazás változik: a Brave 2026 februárjában szüntette meg az ingyenes
     csomagot);
   - ha a kulcs a config-registry-ben is él (más képernyő is írja), akkor
     `store: 'override'`, különben a varázsló `.env`-írását az override
     csendben felülírja;
   - telepítendő programnál: `src/system-deps.ts` (a varázsló „Külső programok"
     lépése azt mutatja, bemásolható telepítő-sorral).
3. **Önellenőrzés.** Az Áttekintés önellenőrzése mondja ki, hogy be van-e
   állítva:
   - a `group: 'integrations'` lépések **maguktól** kapnak sort
     (`integrationRows()` a `src/web/system-health.ts`-ben): nincs beállítva →
     semleges figyelmeztetés, rákattintva a varázsló SAJÁT lépésére visz;
   - minden más képességnél írj saját `*Rows()` függvényt a
     `system-health.ts`-be, és vedd fel a `systemHealth()` listájába;
   - **a nulla két dolgot jelenthet**: „nincs beállítva" ≠ „nem láttam oda".
     Ha a forrást nem tudod kiolvasni, külön sor (`*_blind`), ne „hiányzik";
   - Extra funkció hiánya SOHA nem piros (`bad`), csak `warn`; a kártya
     legfeljebb 2 sor, a többi az „Egyéb" dobozba kerül.

## Kétnyelvűség

Minden új szöveg a `web/lang/hu.js` ÉS `web/lang/en.js` fájlba (lépések,
linkek, `health.<id>` és `health.<id>_action`). Lásd `i18n-final-verification`.

## Gépi őr (ettől nem kell emlékezni rá)

`src/__tests__/setup-wizard-integrations.test.ts` elbukik, ha a
config-registry-be olyan titkos, `*_API_KEY`, `*_TOKEN` vagy `*_SECRET`
beállítás kerül, aminek nincs varázsló-lépése. Kivétel csak az `EXEMPT`
listában lehet, **írott indokkal**. A teendő bukáskor NEM a kivétel-lista
bővítése, hanem a varázsló-lépés.

## Záró ellenőrzés

```bash
npx vitest run src/__tests__/setup-wizard-integrations.test.ts \
  src/__tests__/setup-wizard.test.ts src/__tests__/lang-parity.test.ts \
  src/__tests__/i18n-no-hardcoded-hu.test.ts src/__tests__/template-identity-hygiene.test.ts
```

És a `fresh-install-usable` 5+1 pontja: üres `store/`-ral, a felületről végig
lehet-e csinálni; a varázsló elvezet-e a beállításig; az önellenőrzés
kimondja-e, ha hiányzik.

## Buktatók

- A képesség saját oldalán lévő beállító doboz NEM helyettesíti a varázslót:
  friss telepítésen senki nem tudja, hogy oda kell mennie.
- A varázsló `.env`-et ír, a legtöbb képernyő override-ot. Ha ugyanaz a kulcs
  mindkét helyen él, a varázsló csak `store: 'override'`-dal mondhat igazat.
- Az árazásról szóló mondat elavul. Ha a súgó ingyenes csomagot ígér, a
  fejlesztéskor nézd meg újra a szolgáltató oldalán.
