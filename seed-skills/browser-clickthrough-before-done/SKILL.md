---
name: browser-clickthrough-before-done
description: KÖTELEZŐ minden felületet érintő munka (web/, dashboard, Munkapad, bármi, amit a felhasználó lát) végén, a "kész" és a waiting-be mozgatás ELŐTT. Valódi böngészős végigkattintás külön, üres web-only példányon, mint egy felhasználó; az eredmény kommentként a kártyára. Trigger -- UI-t érintő kártya tesztelése vagy befejezése, land-pr.sh után, "kész"-jelentés és waiting-mozgatás előtt.
scope: global
---

# Felületet érintő munka: a végén valódi böngészős végigkattintás

## Miért van ez a skill
{{OWNER_NAME}} szabálya (2026-10-17): a felületet érintő munka UTOLSÓ kötelező lépése
a valódi böngészős végigkattintás, "mint egy user". A forrás-teszt és a vitest zölden
megy akkor is, ha a képernyőn a gomb nem csinál semmit, vagy a PDF rossz helyre
kerül. A kártya csak akkor mehet `waiting`-be, ha a végigkattintás működik.

## NEM ALKUKÉPES (2026-10-30, a tulajdonos, harmadszor)
A "nem kattintottam végig" mondat NEM elfogadható kész-jelzés. A tulajdonos szó szerint:
"kötelező ... úgy, mint egy user ... ezerszer elmondtam". A kész-üzenet addig NEM megy ki,
amíg a végigkattintás meg nem történt és nincs róla mért eredmény. Ha a munka UI-t érint
(akár csak közvetve: költöztetés, törlés, link, kijelzés), a végigkattintás a landolás
ELŐTT és a deploy UTÁN is kell, a próba nem tesztből, hanem a képernyőről jön. A
"csak tesztek futottak" nem mentség, hanem hiányzó munka: előbb csináld meg, aztán jelents.

## Eljárás
1. Készítsd el külön, üres web-only példányon a próbakörnyezetet az
   `isolated-web-only-instance-browser-test` skill szerint (izolált worktree, saját
   port, ideiglenes raktár, a saját port leállítása a végén).
2. Kattints végig Playwrighttal, mint egy felhasználó: MINDEN gomb és funkció, amit a
   munka érintett, a megszokott útvonalon (menü -> oldal -> gomb), nem
   közvetlen API-hívással.
3. Fájl- vagy PDF-generálásnál: indítsd el, és ellenőrizd a kimenetet (nyisd meg /
   `ffprobe` / méret), valamint azt, HOVA került (melyik mappa, látszik-e a felületen).
4. Nézz meg képernyőképet is (asztali és telefon-szélesség), ne csak a logot.
   `pageerror` számláló legyen 0.
5. Írd a kártyára kommentként az eredményt: mit kattintottál végig, mit mértél, és
   mit NEM próbáltál (pl. valódi érintés, másik böngésző).
6. Csak ezután a `waiting`-be mozgatás (`card-done-to-waiting`).

## Ha nem tudod megcsinálni
Ne hallgasd el és ne "kockázatos" címen hagyd ki: mondd ki a kártyán és a
kész-jelzésben, hogy a végigkattintás nem történt meg és miért. A kártya ilyenkor
NEM megy `waiting`-be, a munka megy tovább.

## Buktatók
- A részletes tapasztalatok (varázsló-ablak, readonly mezők, port, token) az
  `isolated-web-only-instance-browser-test` skillben vannak.
- A zöld teszt NEM bizonyíték a képernyőre: a "működik" szót csak mért eredményre mondd.

## Ellenőrzés
- [ ] a kártyán van komment a végigkattintás eredményével (és a nem mért dolgokkal)
- [ ] a próbapéldány portja leállítva, a worktree és az ideiglenes fájlok törölve
