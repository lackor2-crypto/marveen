---
name: inbox-document-sorting
description: A BEÉRKEZŐ mappa iratainak besorolása az egységes életfába (kihez tartozik, milyen terület, melyik ország, milyen ügy, milyen dokumentumtípus, hová kerüljön). Akkor használd, ha a felhasználó beszkennelt papírt, PDF-et, e-mail mellékletet, hatósági/banki/bírósági iratot vagy fotót dobott a Beérkezőbe, vagy ha megkér, hogy rendezd el a Beérkezőt.
---

# BEÉRKEZŐ — automatikus iratrendezés

A {{OWNER_NAME}} véglegesített alapterve (2026-08-21) szerint ez **az egyik legfontosabb
Marvin-funkció**: bármi bedobható, és Marvin eldönti, hova tartozik.

## Mikor használd

- „Ezt tedd el.” / „Rendezd el a Beérkezőt.”
- Új fájl jelent meg az `ÉLET/BEÉRKEZŐ` mappában (`GET /api/life/inbox` mutatja a darabszámot).
- A felhasználó beszkennelt egy papírt, továbbított egy e-mail mellékletet.

## A besorolási lánc — ebben a sorrendben

Minden iratnál pontosan ezt az öt kérdést teszed fel, ebben a sorrendben. Ez a
sorrend nem esztétika: a későbbi kérdés válasza az előzőtől függ (egy „bírósági
végzés” önmagában nem hely, csak akkor az, ha tudjuk, KIÉ és MELYIK országban).

1. **Kihez tartozik?** — személy vagy cég. A felvett neveket a
   `GET /api/life/config` adja meg; ne találj ki új nevet.
2. **Milyen terület?** — SZEMÉLYES / IDENTITÁS / CSALÁD / PÉNZÜGY / JOGI /
   HATÓSÁGOK / OTTHON / MUNKA / PROJEKTEK / EGÉSZSÉG / DOKUMENTUMOK / MÉDIA.
3. **Melyik ország?** — csak ott, ahol számít: JOGI, PÉNZÜGY, HATÓSÁGOK.
   Máshol NINCS országszint, és ne is hozz létre.
4. **Milyen ügy?** — a konkrét eljárás/szerződés/ügyfél mappája.
5. **Milyen dokumentumtípus?** — végzés, számla, szerződés, igazolás, levél.

Ebből áll össze: **hová kell kerülnie.**

## Amit tenned kell

1. `GET /api/life/list?path=ÉLET/BEÉRKEZŐ` — mi vár besorolásra.
2. Nézd meg az irat tartalmát (PDF/kép esetén olvasd ki, ami olvasható).
3. Fusd végig az öt kérdést. Ha egy szinten nincs meg a célmappa, hozd létre:
   `POST /api/life/mkdir {parent, name}`.
4. `POST /api/life/move {from, to}` — a `to` a **célmappa**, nem a célfájl.
5. Ha az irat papíron is megvan (a felhasználó ezt mondja, vagy szkennelt
   eredetiről van szó), rögzítsd:
   `POST /api/life/physical {path, physical: true, location, note}`.
   A `location` **ugyanaz a fa-útvonal**, ahol a papír áll. Nincs QR-kód,
   nincs mappa-ID.
6. Írd meg egy mondatban, mit hová tettél — a felhasználónak ellenőrizhetőnek
   kell lennie.

## Amit SOHA ne tegyél

- **Ne találgass személyt.** Ha nem derül ki egyértelműen, kihez tartozik,
  hagyd a Beérkezőben, és kérdezd meg. Egy rossz helyre tett bírósági végzés
  rosszabb, mint egy besorolatlan.
- **Ne írj felül semmit.** Az áthelyezés `exists` hibával áll meg, ha a célban
  már van ilyen nevű fájl — ilyenkor kérdezz, ne nevezz át magadtól.
- **Jelszó, API-kulcs, token, hitelesítési adat NEM kerül ebbe a fába.**
  Az a Marvin Vault dolga. Ha ilyet találsz a Beérkezőben, szólj, és hagyd ott.
- **Ne hozz létre országszintet** olyan terület alatt, ahol a terv szerint
  nincs (csak JOGI / PÉNZÜGY / HATÓSÁGOK).
- **Ne nyúlj a git repók saját dokumentációs rétegéhez.**
- **Ne törölj.** A Beérkező kiürítése áthelyezéssel történik, sosem törléssel.

## Kétes esetek

| Amit látsz | Hova |
|---|---|
| Céges számla | `ÉLET/CÉGEK/<cég>/PÉNZÜGY` |
| Magánszemély számlája | `ÉLET/<név>/PÉNZÜGY/<ország>` |
| Bírósági irat | `ÉLET/<név>/JOGI/<ország>/<ügy>` |
| Hatósági levél | `ÉLET/<név>/HATÓSÁGOK/<ország>` |
| Családi fotó | `ÉLET/MÉDIA/<név>/FOTÓK/<családi csoport>` |
| Céges marketing-fotó | `ÉLET/CÉGEK/<cég>/MARKETING/MÉDIA/FOTÓK` |
| Bizonyítvány, oklevél | `ÉLET/<név>/IDENTITÁS` |
| Lelet, zárójelentés | `ÉLET/<név>/EGÉSZSÉG` (csak a gazdának van ilyen ága) |

Ha a táblázat nem dönt el egy esetet, a lánc dönt — és ha a lánc sem, kérdezz.
