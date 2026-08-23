---
name: i18n-final-verification
description: KÖTELEZŐ minden Marveen-fejlesztésnél, ami képernyőre kerülő szöveget hoz létre vagy módosít -- web/index.html, web/app.js, web/lang/*, ÉS a szerveroldali szövegtáblák (pl. src/life-hints.ts) vagy hibaüzenetek. Minden felületi szöveg kétnyelvű (HU+EN); ez a skill megmondja, hogyan kell megírni, és melyik teszt bukik el, ha nem így írtad meg. Trigger -- bármilyen felhasználónak látható szöveg (címke, gomb, tooltip, placeholder, súgó, hibaüzenet, toast, confirm).
---

# Minden képernyőre kerülő szöveg kétnyelvű

## Mikor használd

**Minden olyan fejlesztés ELEJÉN és VÉGÉN**, ahol felhasználónak látható szöveg
születik vagy változik. Nem csak a végén: ha a szerkezetet eleve rosszul veszed
fel, a végén már átírás, nem ellenőrzés.

## Miért -- ez a szabály MÁR HÁROMSZOR megbukott

| mikor | mi | miért nem fogta meg semmi |
|---|---|---|
| 2026-08-06 | email-felület, majd az Iroda-Beállítások form | nem volt zárólépés |
| 2026-08-21 | az Intéző **használati útmutatója** (~90 sor próza az index.html-ben) | ez a skill létezett, de senki nem hívta meg |
| 2026-08-21 | a **„Kik szerepeljenek a fában?"** szerkesztő + a mappa-súgók (`src/life-hints.ts`) | a súgók a szerveren álltak, egynyelvű táblában — a skill csak a `web/`-et nézte |

{{OWNER_NAME}}, 2026-08-23: „nincs meg angol nyelven!!!!!", majd **„de erről már
volt egyszer szó."**

A tanulság: **egy kézzel futtatandó checklist nem védelem.** Ezért a skill első
lépése ma már egy teszt, ami MEGBUKTATJA a munkát, és a checklist csak a
mögötte lévő magyarázat.

Lásd [[i18n-required-for-new-features]] memória.

## Eljárás

### 1. A KAPU — ezt futtasd, ez a bizonyíték

```bash
npx vitest run src/__tests__/i18n-no-hardcoded-hu.test.ts src/__tests__/lang-parity.test.ts
```

- `i18n-no-hardcoded-hu` — van-e **ÚJ**, kézzel odaírt magyar szöveg a
  `web/index.html`-ben vagy a `web/app.js`-ben. Megnevezi a fájlt, a sort és a
  szöveget.
- `lang-parity` — a `hu.js` és az `en.js` kulcsai egyeznek-e.

**Ha az első elbukik, a teendő NEM a bázis bővítése, hanem a fordítás.** A
`src/__tests__/fixtures/i18n-baseline.json` a régi adósság listája; az csak
rövidülhet. Fordítás után: `npm run i18n:baseline`.

### 2. Így írd meg (hogy ne is bukjon el)

| hol | így |
|---|---|
| `web/index.html` | `data-i18n="kulcs"` — attribútumra `-title`, `-placeholder`, `-aria-label`; HTML-tartalomra `-html` |
| `web/app.js` | `t('kulcs')`, paraméter `{n}` formában: `t('x.y', { n: 5 })` |
| szerveroldali szövegtábla | kétnyelvű típus, ne opcionális mezővel: `type Hint = { hu: string; en: string }` |
| szerveroldali végpont | a nyelv **paraméterként** jön (`?lang=`), és a felület küldi: `'?lang=' + (window._lang \|\| 'hu')` |

A kulcs MINDIG **mindkét** fájlba kerül: `web/lang/hu.js` ÉS `web/lang/en.js`.

**Hosszú súgó/próza NE menjen a HTML-be.** Egy 90 soros bekezdés a HTML-ben
gyakorlatilag lefordíthatatlan — pont ezért maradt el kétszer. Tedd egyetlen
`data-i18n-html="…"` kulcsba, a szöveg a lang-fájlokban álljon.

### 3. Amit a legkönnyebb elfelejteni

- `confirm()`, `alert()`, `showToast()` szövege
- `title=`, `placeholder=`, `aria-label=`
- `innerHTML`-be épített sablonszövegek (ezekre **nincs** automata
  `data-i18n` kezelés — render-időben kell `t()`-be csomagolni)
- szerverről jövő hibaüzenetek, amiket a felület változatlanul kiír
- a mappák zárójeles magyarázatai (`src/life-hints.ts`)

### 4. Ami NEM követi a felület nyelvét

A **lemezen lévő mappák NEVE**. Azt az `APP_LANG` (a telepítés nyelve) adja —
átnevezni adatvesztés volna, mert minden útvonal, bekötés és papír-nyilvántartás
rá mutat. A zárójeles magyarázat viszont a felület nyelvét követi. A kettőt ne
keverd össze: egy angolra kapcsolt felületen a `Rendszer` mappa `Rendszer`
marad, de a mellette álló magyarázat angolul áll.

### 5. URL-eket ne fordíts

`href="https://…"` nem fordítandó — csak a körülötte lévő szöveg.

## Buktatók

- A `t()` HU→EN→kulcs sorrendben esik vissza, tehát egy hiányzó kulcs **nem dob
  hibát**, csak csendben rossz nyelven jelenik meg. Kódolvasással nem vehető
  észre — ezért van a kapu.
- A `lang-parity` zöld marad akkor is, ha a szöveg **be sem került** a
  lang-fájlokba: a kulcshalmazok akkor is tökéletesen egyeznek. Ezt egyedül az
  `i18n-no-hardcoded-hu` fogja meg. A kettő EGYÜTT véd, külön-külön nem.
- Az angol szöveget ne a magyar átmásolásával „fordítsd": az `en.js`-t külön
  teszt őrzi, magyar ékezet nem lehet benne.

## Ellenőrzés

Az 1. pont két tesztje zölden fut le, ÉS a `npm run i18n:baseline` kimenete a
lista **csökkenését** mutatja (`↓`), ha fordítottál.
