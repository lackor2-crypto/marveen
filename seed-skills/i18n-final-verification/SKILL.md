---
name: i18n-final-verification
description: Marveen dashboard UI-fejlesztés (új oldal, form, szöveg) LEZÁRÓ lépéseként kötelező HU/EN teljesség-ellenőrzés, mielőtt "kész"-nek jelented a tulajdonosnak ({{OWNER_NAME}}). Trigger -- bármilyen web/index.html, web/app.js vagy web/style.css módosítás ami felhasználónak látható szöveget hoz létre vagy változtat.
---

# i18n végső ellenőrzés

## Mikor használd

A LEGUTOLSÓ lépésként, minden olyan Marveen dashboard-fejlesztés végén, ahol
új vagy módosított felhasználó-néző szöveg született (label, gomb, tooltip,
placeholder, hibaüzenet, státusz-szöveg). {{OWNER_NAME}} kétszer is ugyanezt a hibát
találta meg (2026-08-06, email-felület, majd ugyanaznap este az
Iroda-Beállítások form) -- a szabály puszta ismerete nem volt elég, konkrét
zárólépés kell. Lásd [[i18n-required-for-new-features]] memória.

NE hagyd ki még akkor sem ha "biztos jó" -- pont ez volt a hiba mindkétszer.

## Eljárás

1. **Hardcode-keresés a módosított JS-ben**: grep az érintett funkció(k)ra
   ékezetes magyar karakterre:
   ```bash
   sed -n '<start>,<end>p' web/app.js | grep -nE "[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]"
   ```
   Ha BÁRMI HTML-attribútumon vagy sima JS-stringen belüli szöveg (nem
   komment) találat -- az hiba, be kell kötni a fordító-rendszerbe.

2. **Kulcs-pariás ellenőrzés**: a bevezetett i18n-prefixre (pl.
   `irodaSettings.*`) hasonlítsd össze a hu.js és en.js kulcshalmazát:
   ```bash
   python3 -c "
   import re
   hu = set(re.findall(r\"'(PREFIX\.[^']+)':\", open('web/lang/hu.js').read()))
   en = set(re.findall(r\"'(PREFIX\.[^']+)':\", open('web/lang/en.js').read()))
   print('HU only:', hu - en)
   print('EN only:', en - hu)
   "
   ```
   Mindkét halmaznak azonosnak kell lennie. Bármelyik oldali eltérés hiba.

3. **Használt-vs-definiált ellenőrzés**: nézd át hogy minden `t('PREFIX...')`
   hívás és `data-i18n="PREFIX..."` attribútum tényleg szerepel-e mindkét
   lang-fájlban (grep `t('` és `data-i18n="` az érintett fájlokban, vesd
   össze a kulcslistával).

4. Csak ha mindhárom check tiszta, jelentsd készre a tulajdonosnak ({{OWNER_NAME}}).

## Buktatók

- A `t()` fordító-függvény HU→EN→kulcs sorrendben esik vissza, szóval egy
  hiányzó kulcs NEM dob hibát, csak csendben rossz nyelven (vagy a nyers
  kulcsnévvel) jelenik meg -- ez pont miért nem vehető észre kódolvasás
  nélkül, csak a fenti grep/diff-fel.
- Dinamikusan generált HTML (`wrap.innerHTML = ...` string-template) NEM
  kap automata `data-i18n` kezelést -- minden benne lévő szöveget kézzel
  `t('kulcs')`-ba kell csomagolni render-időben.
- Linkek/URL-ek (pl. `href="https://..."`) NEM fordítandók -- csak a
  körülöttük lévő szöveg. Ne csomagolj URL-t i18n-kulcsba.

## Ellenőrzés

A fenti 3 lépés (grep, kulcs-diff, használt-vs-definiált) mind tiszta
kimenetet ad, ELLENŐRZÖTTEN mindkét lang-fájlban.
