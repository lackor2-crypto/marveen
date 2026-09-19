---
name: project-continue
description: Amikor {{OWNER_NAME}} egy meglevo projektet akar folytatni vagy rakerdez ("folytassuk a Kovacs weboldal projektet", "hol tartunk a X projekttel?", "mi van meg hatra a Y-ban?"). EGY hivassal lekeri a projekt teljes kontextusat a dashboardrol (mentett osszefoglalo, nyitott kartyak, fuggo jovahagyasok, futo munka, legutobbi esemenyek, kotott otletek/memoriak/vitak), es abbol dolgozik -- nem talalgat, nem kutat szet a fajlok kozott.
scope: global
---

# Projekt folytatasa (Iroda -> Projektek)

A projektek a dashboard Iroda -> Projektek oldalan elnek. Ha {{OWNER_NAME}} egy
projektet nevvel (vagy nev-reszlettel) emlit, ELOSZOR kerd le a kontextusat:

```bash
TOKEN=$(cat {{PROJECT_ROOT}}/store/.dashboard-token)
curl -s -G -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=Kovacs weboldal" --data-urlencode "lang=hu" \
  http://127.0.0.1:{{WEB_PORT}}/api/projects/context
```

A valasz `state` mezoje donti el a kovetkezo lepest:

- `found` -- a `text` mezo a projekt teljes, mert kontextusa. Ebbol dolgozz;
  amit mondasz, az ebbol jojjon (a mentett osszefoglalonak idopontja van -- ha
  a szoveg jelzi, hogy azota tortent valami, mondd meg, hogy lehet elavult).
- `ambiguous` -- tobb projekt illik a szavakra (`matches`). NE valassz:
  kerdezz vissza, melyikre gondolt, a nevek felsorolasaval.
- `none` -- nincs ilyen projekt. Sorold fel a meglevoket (`projects`), es
  kerdezd meg, melyikre gondolt, vagy hozzon-e letre ujat a dashboardon.

A kontextus csak olvasas: semmit nem mozgat, semmit nem ir.
