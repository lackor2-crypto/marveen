---
name: test-guard
description: Napi teszt-őrjárat. Lefuttatja a teljes tesztsort a commitolt HEAD-en egy eldobható worktree-ben, és CSAK akkor szól, ha piros. Így egy elavult vagy elromlott teszt nem maradhat észrevétlenül hetekig.
---

# Teszt-őrjárat

## Mikor fut
Minden nap 6:00. Csendes, ha minden zöld.

## Miért létezik
2026-08-11-én kiderült, hogy egy teszt piros volt a main-en, és senki nem vette
észre. A telepítő dashboard-unitját rögzítette `Restart=on-failure`-ön egy
hatókör-jelölőként; a szándék később jogosan megváltozott, az elvárás nem, és
egyszerűen ott maradt elromolva.

Az elavult elvárás csak a tünet volt. A betegség az, hogy SEMMI NEM FUTTATTA A
TESZTEKET: nincs CI, nincs pre-commit hook, nem volt ütemezés. A sor csak akkor
futott, ha valaki éppen kérte, tehát a "piros" és a "zöld" hetekig
megkülönböztethetetlen állapota volt a repónak.

## Eljárás

```bash
bash {{INSTALL_DIR}}/scripts/test-guard.sh
```

A script eldobható git worktree-t készít a commitolt HEAD-ből (a tesztsor
szándékosan megtagadja a futást élő telepítésen, mert ír a store/-ba és a
.env-be), lefuttatja a sort, és csak bukásnál küld inter-agent üzenetet a
bukó tesztek nevével együtt.

Ha jelentést kapsz tőle:
1. Nézd meg, a KÓD romlott-e el, vagy a TESZT rögzít-e egy már nem érvényes
   elvárást.
2. A második is valódi hiba, nem "csak egy teszt". Egy teszt, ami a régi
   viselkedést fagyasztja be, aktívan akadályozza a helyes változtatást.
3. Javítsd a valódi okot. Tesztet kikapcsolni vagy törölni csak akkor szabad,
   ha az elvárás maga érvénytelen -- és akkor is írd le a kommentben, miért.

## Buktatók
- A worktree a HEAD-et futtatja, nem a munkakönyvtárat. Ha a hiba csak nálad
  jelentkezik, az azt jelenti, hogy commitolatlan változtatásod van.
- A `node_modules` szimlinkelve van a fő telepítésből, nincs külön `npm install`.
- Ha a script `skipped`-et naplóz, nézd meg a `store/test-guard.log`-ot.

## Ellenőrzés
```bash
bash {{INSTALL_DIR}}/scripts/test-guard.sh --report-only
tail -5 {{INSTALL_DIR}}/store/test-guard.log
```
