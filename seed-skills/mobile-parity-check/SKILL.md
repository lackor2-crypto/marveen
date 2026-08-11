---
name: mobile-parity-check
description: KOTELEZO lepes minden Marveen dashboard-fejlesztes vegen (web/app.js, web/index.html, web/style.css, vagy barmi ami a dashboardon lathato UI-t erint) -- a valtoztatast MOBIL nezetben is ellenorizni es igazitani kell, nem csak asztalin. {{OWNER_NAME}} telefonrol hasznalja a dashboardot, es tobbszor talalt olyan funkciot ami asztalin jo volt, mobilon viszont elerhetetlen. Trigger: barmilyen dashboard-UI valtoztatas elkeszult, vagy {{OWNER_NAME}} mobil-hibat jelez.
---

# Mobil-paritás: amit asztalin megcsinálsz, mobilon is meg kell csinálni

{{OWNER_NAME}} állandó szabálya (2026-08-10): **ha a Marvint fejlesztjük, a mobil
nézetet is módosítani kell. Soha ne felejtsük el.**

Ez nem stílus-kérdés. {{OWNER_NAME}} a telefonjáról vezérli a rendszert, és egy nap
alatt négy olyan dolgot talált, ami asztali gépen tökéletes volt, telefonon
viszont használhatatlan: a csapat-fa fele levágva és nem görgethető, a
jóváhagyások ellenőrzés-gombja a képernyőn kívül, kilógó feliratok a
darabszám-dobozokból, és egy régi oldal miatt hiányzó ikonok. Egyik sem
látszott az asztali fejlesztés közben.

## Mikor futtasd

- MINDEN dashboard-UI változtatás után (`web/app.js`, `web/index.html`,
  `web/style.css`), mielőtt késznek jelented.
- Ha {{OWNER_NAME}} mobil-hibát jelez.
- Új oldal/panel/modális bevezetésekor -- ott a legnagyobb az esély, hogy
  csak asztali szélességre lett kitalálva.

## Eljárás

1. **Automatikus söprés** -- ez találja meg a bajt emberi szem nélkül. A
   szkript minden oldalt betölt 390 pixeles telefon-nézetben, és jelenti
   azokat az elemeket, amik kilógnak a képernyőről ÚGY, hogy nincs
   görgethető ősük (tehát elérhetetlenek):

   ```bash
   python3 ~/.claude/skills/mobile-parity-check/scripts/mobile_audit.mjs   # lásd lent, node kell hozzá
   node ~/.claude/skills/mobile-parity-check/scripts/mobile_audit.mjs
   ```

   A "van görgethető őse" kivétel fontos: egy szándékosan oldalra
   görgethető táblázat NEM hiba, egy levágott gomb igen.

2. **Nézd meg a saját változtatásod oldalát telefon-méretben** (390px), és
   kérdezd meg: minden GOMB elérhető? Minden felirat kifér? Van vízszintes
   görgetés ott, ahol nem kellene?

3. **Ha kilóg valami, a javítás szinte mindig ugyanaz** (mérve 2026-08-10):
   - fejléc-gombsor inline `display:flex` + tördelés nélkül -> `flex-wrap: wrap`
     telefonon;
   - fix szélességű mező/legördülő -> `max-width: 100%` + `min-width: 0`;
   - asztali nézetben oldalra nyíló panel (`left: 100%`) -> telefonon kerüljön
     a hívó elem ALÁ (`left: 0; top: 100%`);
   - rács-elem, ami kiszélesíti az oldalt -> `min-width: 0` (a grid-elem
     alapértéke `auto`, ettől nő túl a sávján);
   - széles táblázat -> telefonon a sorok kártyává állnak (a cellák `display:
     block`, a `thead` eltűnik). Adatot NE rejts el, csak rendezd át.

4. **A javítás mobil-only legyen** (`@media (max-width: 768px)`), és az
   asztali nézetet mérd vissza -- egy mobil-javítás sem érhet asztali
   regressziót.

## Buktatók

- **A "nem látszik" nem mindig kód-hiba.** {{OWNER_NAME}} telefonján többször egy
  RÉGI, betöltve maradt oldal volt (a `?v=` cache-buster csak új
  oldalbetöltéskor hat). Mielőtt kódot javítasz, ellenőrizd hogy a kiszolgált
  fájl tartalmazza-e már a javítást:
  `curl -s http://localhost:3420/app.js | grep -c "<a keresett kód>"`.
  Ha igen, a válasz "töltsd újra az oldalt", nem egy újabb commit.
- **Szintetikus touch-esemény nem görget.** Playwright `touchscreen`/CDP
  touch-eseményekkel nem lehet bizonyítani hogy egy konténer ujjal húzható --
  a bizonyíték az, hogy `scrollWidth > clientWidth` ÉS `overflow-x: auto`,
  plusz programozott `scrollLeft`-tel minden elem elérhető.
- **A `web/style.css` és `web/app.js` közös fájl**, gyakran más ágens is
  szerkeszti egyszerre. Mobil-javítást a fájl VÉGÉRE, külön `@media` blokkba
  írj, és ha más módosítása is bent van a munkakönyvtárban, csak a saját
  hunkodat stage-eld:
  ```bash
  git diff web/style.css > /tmp/all.patch   # majd csak a sajat hunkot:
  git apply --cached /tmp/mine.patch
  ```
- Inline `style="..."` erősebb minden osztály-szabálynál -- ha a kilógó elem
  inline stílust visel, vagy a markupot kell javítani, vagy `!important` kell
  (kommenttel, hogy miért).

## Ellenőrzés

- Az 1. lépés söprése "TISZTA" eredményt ad mind a ~28 oldalra.
- Az érintett funkció gombjai 390 pixelen a képernyőn belül vannak
  (`getBoundingClientRect().right <= innerWidth`).
- Asztali nézet (1400px) változatlan: nincs új görgetősáv, nem tört el az
  elrendezés.
