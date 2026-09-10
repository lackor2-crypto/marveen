---
name: delegate-availability-check
description: KÖTELEZŐ ellenőrzés munkaátadás előtt. Mielőtt bárkinek (sub-agensnek, flotta-tagnak) munkát adnál át, ELŐSZÖR ellenőrizd élő forrásból, hogy a címzett egyáltalán tud-e most dolgozni -- fut-e, be van-e jelentkezve, nincs-e kimerült keretnél. Ez az ELSŐ lépés, még a feladat megfogalmazása előtt, nem utólagos ellenőrzés.
scope: global
---

# Munka átadása előtt kötelező ellenőrizni: online-e a címzett

## A szabály

Mielőtt bárkinek (sub-agensnek, flotta-tagnak) munkát adnál át, **ELŐSZÖR**
ellenőrizd élő forrásból, hogy a címzett egyáltalán tud-e most dolgozni --
fut-e, be van-e jelentkezve, nincs-e kimerült keretnél. Ez nem opció és nem
utólagos ellenőrzés: ez az **ELSŐ** lépés, még a feladat megfogalmazása előtt.

{{OWNER_NAME}} hangüzenetben (2026-09-08): "meg mielőtt kiadnád a parancsot
bárkinek, az első dolog annak kéne lennie hogy leellenőrizted hogy egyáltalán
él-e vagy halott. van-e még egysége."

## Miért van ez a szabály (a valódi eset)

Egy feladatot egy olyan ágensnek adtak ki, amelyik pontosan abban a
pillanatban "Not logged in -- Please run /login" állapotban ült -- semmit nem
tudott feldolgozni, még a feladatot hordozó üzenetet sem. A második
próbálkozás egy másik ágensnek ment, amelyik már a saját heti keretét is
kimerítette. Mindkét átadás tiszta veszteség volt: a feladat érintetlenül
állt, amíg a tulajdonos rá nem mutatott arra, amit egyetlen állapot-lekérdezés
már előre megmutatott volna.

## Mit jelent az ellenőrzés

A címzett ágens ÉLŐ állapota:
- fut-e a folyamata,
- be van-e jelentkezve (nincs "Please run /login" vagy hasonló a panelen),
- nincs-e kimerülve a kerete (5 órásnál a saját, másnál akár a heti is
  számít, ha az az adott szolgáltatás tényleges használati korlátja).

Ez API-hívással vagy a panel/tmux állapot élő elolvasásával történik, **SOSE**
a legutóbbi ismert állapotból vagy emlékezetből -- ugyanaz az elv, mint a
[[recheck-before-restating]] szabálynál.

## Ha a címzett NEM elérhető

Két út van, sorrendben próbáld:

1. **Van-e HARMADIK ágens**, aki elérhető ÉS megfelel a feladat
   követelményeinek (képesség, jogosultság, kontextus) -- ha igen, oda add ki.
2. **Ha nincs ilyen**, a feladatot magadnak kell elvégezned -- nem maradhat
   kiadatlanul és nem várakozhat egy nem-elérhető címzettre "majd ha
   helyreáll" alapon, hacsak a feladat maga nem kifejezetten arra vár.

## Kivétel

NE alkalmazd ezt, ha a feladat maga éppen a címzett elérhetetlenségének
elhárításáról szól (pl. "állítsd helyre X bejelentkezését") -- ott a cél
éppen az, hogy a címzett újra elérhető legyen, tehát az elérhetetlenség nem ok
az elutasításra, csak azt dönti el, ki végzi el a helyreállítást.

## Önellenőrzés munkaátadás előtt

1. Frissen (nem emlékezetből) lekérdeztem-e a címzett élő állapotát?
2. Fut-e, bejelentkezve van-e, nincs-e kimerülve a kerete?
3. Ha NEM elérhető: van-e harmadik, alkalmas ágens? Ha nincs, magam végzem el.
4. Ez a feladat maga a helyreállításról szól-e (kivétel)?
