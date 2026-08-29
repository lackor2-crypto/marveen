---
name: cheap-model-delegation
description: A fo-agens NEM vegezheti el sajat maga az olyan reszfeladatot, ami delegalhato gyengebb/olcsobb retegnek. Nem merlegeles, hanem kotelezettseg. Triggerel: barmilyen kulon-hatarolhato reszfeladat (review, elemzes, kutatas, egyszeru kodmodositas, ellenorzes) mielott sajat kontextusban vagy a legerosebb modellel inditanad el.
---

# Kötelező delegálás olcsóbb rétegnek

## Mikor használd

**KÖTELEZŐ, nem mérlegelés.** Ha egy rész-feladatot meg lehet oldani
gyengébb/olcsóbb réteggel, azt a fő-ágens NEM végezheti el saját maga --
kötelező átadni. Lásd a CLAUDE.md „KÖTELEZŐ DELEGÁLÁS" szakaszát a teljes
szabályhoz. Ez a skill a GYAKORLATI rangsort és eljárást adja hozzá.

Mielőtt saját magad nekiállnál egy delegálható, jól körülhatárolt
rész-feladatnak -- VAGY mielőtt a legdrágább modellt hívnád egy feladatra --
állj meg egy pillanatra és döntsd el: kinek adod ki.

Az elv: *„Ami olyan munka, amit olcsóbb, butább modellel is el lehet végezni,
azt mindenféleképpen add ki almunkába. Takaríts meg minél több tokent."*

## Rangsor (olcsótól drágáig)

A konkrét ügynökök telepítésenként mások. A **Csapat** lapon (vagy
`GET /api/agents`) látod, milyen ügynökök léteznek ezen a gépen, melyiknek
mi a modellje, és melyiknek van saját fiókja. A rangsort ehhez a listához
illeszd, ne beégetett nevekhez:

1. **Olcsó modellű saját ügynök** (jellemzően Haiku, önálló fiókkal és saját
   csatornával) -- egyszerű, mechanikus, kevés kontextust igénylő munka.
   Inter-agent üzenettel vagy a csatornáján is elérhető.
2. **Ingyenes OpenRouter teszt-ügynökök** (ha a telepítésen be van kötve
   OpenRouter-kulcs, lásd a Fiókok lapot) -- jól körülhatárolt
   ellenőrzés/review/elemzés, ami NEM igényel megbízható visszajelentést.
3. **Olcsóbb modellű sub-agent** (Agent tool, `model` paraméterrel) -- ha a
   feladat nem illik tisztán a fenti kettőre (pl. saját, izolált kontextust
   igényel egy adott hívásban).
4. **Erős modellű saját ügynök** -- fontos/komplex feladat, ami tényleg erős
   modellt igényel, de a VÉGREHAJTÁS kiadható neki: nem muszáj a fő-ágensnek
   saját kontextusban csinálnia.
5. **A fő-ágens saját maga** -- csak az marad nála, ami koordinációt,
   szintézist, {{OWNER_NAME}}-kommunikációt, vagy szét nem darabolható
   döntést igényel. Upstream-merge ütközés-feloldás KIVÉTEL: az mindig a
   legerősebb modellt igényli, de azt is DELEGÁLVA (erős sub-agent vagy erős
   modellű ügynök), nem magán váltva.

## Eljárás

1. Mielőtt egy rész-feladatot saját kontextusban végeznél el, vagy mielőtt
   egy Agent hívásnál modellt választanál, tedd fel: „ezt tényleg csak a
   legerősebb modell tudja jól, vagy egy olcsóbb réteg is elég?"
2. Ha delegálható: válaszd a legolcsóbb réteget, ami még megbízhatóan
   elvégzi -- ne automatikusan a legerősebbet.
3. A fő-ágens modelljén élőben nem lehet váltani, csak sub-agenst lehet más
   modellel indítani.

## Ha SAJÁT kereted fogy ki -- SOHA ne állj le, add ki

A tényleges „most NE kódolj" viselkedés-korlátozás (a `rate-limit-guard.py`
hook) KIZÁRÓLAG az 5 órás (fiveHour) keretet nézi; a heti (sevenDay) sosem
blokkol. A heti szám **semmit** nem vált ki: se leállást, se átadást. Csak
kijelzés. Az egyetlen küszöb az 5 órás keret.

Ha a saját 5 órás kereted magas és emiatt egy kódolási feladatot nem
kezdenél el vagy nem fejeznél be, az **nem** azt jelenti, hogy megállsz és
jelented, hogy „majd ha lesz keretem" -- az egy delegálási trigger. A hibás
minta: egy kártyát „waiting"-be teszel azzal, hogy „a keret miatt most nem
kezdem el" -- ez ROSSZ, mert leállítja a munkát ahelyett, hogy kiadná.

**Helyes eljárás:** ellenőrizd `GET /api/overview` -> `rateLimit.byAgent`
alatt a `fiveHourPct` mezőt MINDEN releváns fiókra (a `sevenDayPct` csak
kijelzés, döntést NEM alapozhatsz rá). Ha a sajátod ({{MAIN_AGENT_ID}})
5 órás kerete 90%+ és van olyan ügynök, akinek van szabad kapacitása, add ki
NEKI a feladatot inter-agent üzenettel
(`scripts/agent-msg.sh {{MAIN_AGENT_ID}} <cel-agens> "..."`). Ilyenkor a cél
réteg MÁS, mint költségoptimalizálásnál: **egyenrangú vagy erősebb** modellű
ügynököt válassz, ne butábbat -- itt nem a költség, hanem a saját
kapacitás-kimerülés az ok.

Gyakorlatban: mielőtt egy kártyát „keret miatt szüneteltetve" jelölnél, nézd
meg a többi ügynök `fiveHourPct`-jét -- ha valamelyiké alacsonyabb a tiédnél,
küldd át neki a konkrét, elvégzendő lépéseket (fájlok, mit kell megépíteni),
és a kártyát HOZZÁ rendeld át (assignee), ne magadnál hagyva „waiting"-en.

## Terheléskiegyenlítés a fiókok között

A cél, hogy a fiókok fogyasztása nagyjából EGYÜTT haladjon, ne szaladjon el
egyik sem a többitől: ha az egyik fiók 60%-on áll, egy másik meg 10%-on,
akkor a következő delegálást a 10%-os kapja, hogy a tiéd kevésbé fogyjon.
Ha egy olcsó modellű ügynök alacsonyan áll, HATÁROZOTTAN pörgesd fel --
de olyan feladatot ne adj neki, amit nem tud megoldani.

**Ez csak azt mondja meg, KI kapja a munkát, azt nem, hogy MIKOR delegálj.**
A „mikor" kizárólag az 5 órás kereten múlik; a heti % soha nem indok arra,
hogy egy munkába bele se kezdj, vagy hogy egy nálad lévő munkát átadj.
(Valós kár: egy ügynök 16%-os 5 órás kerettel adott át kész, feltérképezett
munkát, pusztán mert a hetije 93%-on állt. Az átadás maga volt a veszteség.)

**Gyakorlatban delegálás előtt:**
1. Nézd meg minden fiók 5 órás %-át (`GET /api/overview` ->
   `rateLimit.byAgent[].fiveHourPct`, vagy
   `store/rate-limit-status/<agent>.json` -> `fiveHour.usedPct`).
   A `sevenDay` mező csak kijelzés.
2. A feladat NEHÉZSÉGI SZINTJÉHEZ illő, legalacsonyabb terhelésű fiókot
   preferáld -- ha egy feladat elbírja az olcsó modellt ÉS annak az ügynöknek
   alacsonyabb a fogyasztása, ELSŐBBSÉGGEL neki add.
3. Ha a saját ({{MAIN_AGENT_ID}}) fogyasztásod magasabb egy erős modellű
   ügynökénél, told át hozzá a komplexebb részt is -- ez kiegyenlít, nem csak
   a „kifogyott a keretem" vészhelyzetben releváns.
4. Ez a szempont KIEGÉSZÍTI, nem helyettesíti a fenti rangsort: egy erős
   modellt igénylő elemzést nem tolunk olcsó modellre csak azért, mert annak
   alacsonyabb a %-a.

## Buktatók

- Ne delegálj olyat, ami közvetlen {{OWNER_NAME}}-kommunikációt vagy
  megbízható visszajelentést igényel, gyengébb/ingyenes ügynöknek -- azok nem
  mindig jelentenek vissza megbízhatóan.
- Upstream-merge ütközés-feloldás SOHA nem delegálható lefelé.
- A cél költségmegtakarítás, nem minőségromlás -- ha bizonytalan vagy, hogy
  egy olcsóbb modell elég-e, kérdezz vissza, vagy maradj a biztonságosabb
  rétegen egy kritikus feladatnál.
- **Kanban kártya `in_progress`-re húzása AUTOMATA inter-agent üzenetet küld
  a kártya JELENLEGI `assignee`-jének** (kanban-dispatch). Ha ezután TE KÉZZEL
  is küldesz egy delegáló üzenetet egy MÁSIK ügynöknek anélkül, hogy előbb
  átírtad volna az `assignee` mezőt, két, egymásnak ellentmondó „tulajdonos"
  keletkezik ugyanarra a kártyára (élő eset: 5 kártya egyszerre in_progress-re
  húzva, kettő automatikusan a régi assignee-nek ment ki, a kézi üzenetek meg
  valaki másnak -- ütköző tulajdonlás, utólag kellett `PUT /api/kanban/<id>`
  -val korrigálni). **Helyes sorrend:** előbb `PUT` az `assignee`-t az új
  felelősre, utána (vagy azzal egy menetben) a `move` -> `in_progress`, és
  csak EZUTÁN, ha kell, egy kiegészítő kézi üzenet -- ne fordítva.

## Ellenőrzés

- Mielőtt egy Agent hívást indítasz, tudatosan válassz `model` paramétert
  (vagy ingyenes ügynöknek delegálj) ahelyett, hogy alapértelmezettként
  hagynád a legerősebbet.
