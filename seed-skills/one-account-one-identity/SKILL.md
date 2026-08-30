---
name: one-account-one-identity
description: Egy hely = egy fiók. Új nevesített fiókot (előfizetést, hozzáférést, munkamenetet) MINDIG ahhoz az e-mail címhez kell kötni, amelyikkel be akarnak jelentkezni — soha nem egy meglévőhöz. A cím a felvételkor kötelező, a helyhez rögzül, és ha később más fiók jelentkezik be, azt hangosan jelezni kell. Akkor is érvényes, ha a bejelentkezés böngészőn át történik.
scope: global
---

# Egy hely = egy fiók

## A szabály

**Új fiók felvételekor kötelező megadni annak a fióknak a címét, amelyikkel be
akarnak jelentkezni — és azt a címet a helyhez kell rögzíteni, MÉG a
bejelentkezés előtt.**

{{OWNER_NAME}}, 2026-08-30: „ha valaki szeretne felvenni egy uj fiokot, akkor azt
mindenfelekeppen ahhoz az emailhez kell kotni amivel regisztralni akar. erted?
nem egy meglevohoz!!!"

Három dolog jár együtt, és mind a három kell:

1. **Kötelező cím a felvételkor.** Nem opcionális mező, nem „csak előre kitölti
   a bejelentkezési oldalt". Cím nélkül a felvétel nem indulhat el.
2. **Egy cím egyszer.** Ha a cím már egy másik helyhez tartozik — akár mérve
   (most az ül ott), akár rögzítve (annak kell ott lennie) —, a felvételt el
   kell utasítani, és meg kell nevezni, melyik helyhez tartozik.
3. **Eltéréskor a bejelentkezést VISSZA KELL VONNI.** Ha a végén más fiók jött
   be, mint a rögzített, a szólás önmagában kevés: amíg a rossz hitelesítés ott
   marad, a hely a rossz fiók keretét fogyasztja — vagyis pontosan az az állapot
   áll elő, ami ellen a szabály szól. A most létrejött bejelentkezést azonnal el
   kell venni, a hely maradjon üresen, a rögzített címre várva. A rögzített cím
   felülírása csak kifejezett, megerősített felhasználói döntésre történhet.
   Ha maga a visszavonás nem sikerül, azt a leghangosabb sorban kell kimondani
   — az a valódi vészhelyzet, nem az elutasított bejelentkezés.

## Miért van ez a szabály (a valódi eset)

2026-08-29-én kiderült, hogy két külön nevű előfizetés — `lackor3` és
`usalackor` — ugyanabba a Claude-fiókba volt bejelentkezve. Nem másolt fájl
volt: két külön bejelentkezés, ugyanabba a fiókba. A következménye nem
látványos, ezért maradt hetekig észrevétlen: **ketten ették ugyanannak az egy
fióknak a keretét, a másik előfizetés pedig használatlanul állt.**

Az ok mechanikus, és mindenhol ugyanez lesz: **a böngésző azt a fiókot hagyja
jóvá, amelyik éppen be van benne jelentkezve.** Aki egy új helyet vesz fel, és
a rendszer nem kérdezi meg, kinek szánja, az a saját böngészőjében nyitva lévő
fiókot fogja jóváhagyni — akkor is, ha egészen mást akart.

A nyilvántartásban évek óta ott volt egy `expectedEmail` mező. **Soha, sehol nem
használta semmi.** Sehol nem volt leírva, KINEK kellene abban a helyen lennie,
így nem is lehetett észrevenni, hogy nem ő van ott.

## Hogyan alkalmazd

**Felvételkor** (a felületen ÉS a szerveren, két rétegben — a gomb be se küldje,
a szerver akkor se engedje, ha valaki megkerüli a lapot):

- kötelező, ellenőrzött formájú e-mail cím;
- ütközés-vizsgálat a már ismert helyekkel: a mért cím és a rögzített cím
  **egyaránt foglaltság**;
- a cím a helyhez rögzül a bejelentkezés előtt.

**Bejelentkezés ELŐTT és KÖZBEN:** írd ki, melyik cím tartozik ehhez a helyhez.
A böngésző azt a fiókot hagyja jóvá, amelyik éppen be van benne jelentkezve, és
utána már csak visszavonni lehet — olcsóbb előre szólni, mint utána kijavítani.

**Bejelentkezés után:** hasonlítsd össze a ténylegesen bejelentkezett címet a
rögzítettel. Egyezik → csend. Nincs még rögzítve → az első bejelentkezés
rögzíti. Eltér → **visszavonás** (a most létrejött hitelesítés elvétele) + emberi
mondat, ami megmondja a következő lépést: jelentkezz ki a szolgáltatás
weboldaláról, vagy nyiss privát ablakot a helyes fiókkal, és indítsd újra.
Ilyenkor a „kész / hozzáadva" mondat is hazugság lenne — azt el kell hagyni.

**Az önellenőrzésben** legyen saját sor rá: két hely azonos címen, hely a gép
saját fiókján, eltérés a rögzített címtől. És a megnyugtató zöld sor **csak
akkor** jelenhet meg, ha egyetlen kifogás sincs — egy félrevezető zöld rosszabb,
mint a hallgatás.

## A nulla itt is két dolgot jelent

„Nincs ütközés" és „nem láttam bele minden fiókba" nem ugyanaz. Ha egy hely
állapotát nem sikerült megmérni, az **külön harmadik állapot** (`vak`), és a
felületen is annak kell látszania. Cím nélkül **ne** állíts ütközést: két
ismeretlen cím nem „ugyanaz a semmi". A „nem tudom" nem bizonyíték.

## Hol van ez beégetve (Marveen)

- `src/web/account-identity-guard.ts` — a tiszta döntések:
  `auditIdentities()`, `decidePostLogin()`, `decideNewAccountEmail()`.
- `src/web/claude-plans.ts` — `pinExpectedEmail()`: az első bejelentkezés
  rögzít, később magától soha nem ír felül.
- `src/web/claude-auth-runner.ts` — a felvételi út kötelező címe, a
  bejelentkezés utáni eltérés-jelzés, és az eltérés VISSZAVONÁSA
  (`logoutAccount`) a `reverted` / `revertError` mezőkkel.
- `src/web/system-health.ts` — `named_login_same_account`,
  `named_login_same_as_host`, `named_login_drift`.
- Felület: figyelmeztetés a fiók-doboz gombja fölött + „Mostantól ez a helyes
  cím" gomb megerősítéssel.

Kapcsolódó: `fresh-install-usable` (friss telepítésen az ELSŐ bejelentkezés
rögzít, semmit nem kell kézzel beállítani), `recheck-before-restating` (a
„melyik fiók ez" kérdést mérd újra, ne emlékezetből mondd).
