---
name: windows-folder-lock-diagnosis
description: WSL alol egy /mnt/<meghajto> mappa athelyezese/atnevezese EACCES/EPERM/EBUSY-val bukik (Windows zar). Megmutatja, hogyan talald meg a zarolt almappat es a valoszinu programot, anelkul hogy barmit elrontanal.
scope: global
---
# Windows mappa-zar felderitese WSL alol

## Mikor hasznald
- `renameSync`/`mv` egy DrvFs (`/mnt/c`, `/mnt/f` ...) mappan `EACCES`, `EPERM` vagy `EBUSY` hibat ad,
  pedig a jogosultsagok (`drwxrwxrwx`) rendben vannak.
- A Windows oldali `Move-Item` is "Access to the path ... is denied"-et mond.

## Eljaras
1. A WSL oldali folyamatok kizarasa: van-e olyan folyamat, aminek a `cwd`-je a mappa alatt van
   (`readlink /proc/*/cwd`). Ha van, az a tulajdonose/masik agense: NE allitsd le, szolj.
2. A PowerShell teljes utvonallal hivhato (a PATH-ban gyakran nincs):
   `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`. Magyar ekezetes utvonalhoz:
   `[Console]::OutputEncoding=[Text.Encoding]::UTF8`.
3. Szukites szintenkent: minden kozvetlen almappat nevezz at `<nev>.__t`-re, es AZONNAL vissza.
   Amelyik "LOCKED", abba menj egy szinttel melyebbre. Ismeteld, amig a legmelyebb zarolt mappat
   meg nem talalod. (Ez rovid ideig atnevez felhasznaloi mappakat: a vegen
   `ls | grep __t` legyen ures.)
4. A tartalombol kovetkeztess a programra (pl. `MQL4` + futo `Code.exe` = VS Code munkamappa), es
   kerd meg a tulajdonost, hogy zarja be. A Windows programjat NE loed le magad.
5. Bezaras utan probald ujra ugyanazt a muveletet.

## Buktatok
- A `catch` blokkban a PowerShell `$_` mar a HIBA, nem az elem: mentsd el elotte (`$d=$_`).
- Egy tobb-mappas koltoztetes legyen mindent-vagy-semmit, es visszalepeskor torolje a SAJAT maga
  altal letrehozott, URES szulomappakat (`rmdir`, nem rekurziv), kulonben ures cel-mappa marad.
- A felhasznalonak szolo uzenet mondja meg a teendot ("egy program nyitva tart valamit, zard be"),
  ne csak a hibakodot.

## Ellenorzes
- Az ujraprobalt muvelet `ok`; a forras-helyen nem maradt `.__t` vegu mappa.
