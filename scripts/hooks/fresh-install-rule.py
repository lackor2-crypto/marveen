#!/usr/bin/env python3
"""MINDEN CHAT-UZENETNEL kiirja a friss-telepites szabalyt.

Boss, 2026-08-23: "ezt tudja minden agent minden egyes uj parancsnal! [...]
amikor chatbe itt beirok valamit, azonnal ez legyen az elso amirol tudomast
szerez az agent!!!"

Miert hook, es miert nem eleg a CLAUDE.md meg a skill? Mert azok EGYSZER
kerulnek be a beszelgetes elejen, es egy hosszu munka soran elsullyednek. A
`UserPromptSubmit` hook kimenete MINDEN uzenetnel bekerul a kontextusba --
ez az egyetlen hely, ami a Boss keresenek szo szerint megfelel.

A szoveg szandekosan rovid: minden uzenetnel ott lesz.
"""
import sys

print("""[KOTELEZO SZABALY -- minden feladatnal]
FRISSEN TELEPITETT MARVEENBEN IS MUKODJON. Amit epitesz, egy uj telepitesen
(ures store/, ures adatbazis, a fejleszto adatai sehol) is vegig kell hogy
menjen a FELULETROL, terminal es API-hivas nelkul. Ha csak azert mukodik,
mert ezen a gepen mar ott van egy fajl vagy egy bejegyzes -- nincs kesz.
A NULLA KET DOLGOT JELENTHET: "meg nincs semmi" vagy "nem lattam oda".
Kulon kerdezd meg a forrast; a talalatok szamabol ne kovetkeztess. Es SOSE
talalgasd a hiba okat -- a tenyleges hibauzenetbol olvasd ki, vagy mondd meg,
hogy nem tudod.
A zaro 5+1 pontos onellenorzest ird is le a valaszodban (`fresh-install-usable` skill).""")

sys.exit(0)
