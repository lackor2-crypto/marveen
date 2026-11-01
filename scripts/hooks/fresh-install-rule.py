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
Kulon kerdezd meg a forrast; a talalatok szamabol ne kovetkeztess. HIVATKOZAST
KOVESS: ha valami linkelt/hivatkozott (annex, belinkelt fajl, referencia,
DB-bejegyzes), SOHA ne vedd uresnek a fizikai mappa vagy a talalatszam alapjan --
kovesd a linket, nezd meg MIRE mutat es tenyleg megvan-e, es ugy vedd, mintha
ott lenne a mappaban. Nem-nulla mappa / van bejegyzes -> tilos azt mondani,
hogy ott nincs semmi. Es SOSE talalgasd a hiba okat -- a tenyleges
hibauzenetbol olvasd ki, vagy mondd meg, hogy nem tudod.
REJTETT KORLATOT SOHA: ha fejlesztest kernek, onmagadtol ne epits bele korlatot,
tiltast, meret- vagy hely-hatart. Ha szerinted nagyon fontos egy korlat, ELOBB jelezd
a tulajdonosnak, es csak az engedelyevel told be (a felulet mondja ki, mi a korlat).
GYOKEROK: hibajelzesnel ne csak a mutatott gombot javitsd: keresd meg, hol hasznalodik
maskeppen ugyanaz a fuggveny/szabaly/renderer, es a KOZOS okot javitsd egyszerre (R16).
MUNKADARAB MAPPA: csak a Kontextus es a Teendo fajl lehet benne, sajat segedfajl (Jogi kontextus stb.) TILOS (R24).
A zaro 5+1 pontos onellenorzest ird is le a valaszodban (`fresh-install-usable` skill).""")

sys.exit(0)
