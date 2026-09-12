---
name: nyomtalan-munka
description: Az életfát nem szemeteljük tele. Semmilyen fájl ne keletkezzen magától; ami a fejlesztéshez ideiglenesen kell, azt a végén TÖRÖLD; a lezárt munka végén hatásvizsgálat + bugkeresés, majd AZONNAL commit és push. Minden fejlesztés elején és KÖTELEZŐEN a végén fusd át.
scope: global
---

# Nyomtalan munka — az életfát nem szemeteljük tele

## A szabály

**Önmagától ne keletkezzen semmilyen fájl.** Amit létrehozol, azt vagy kérték,
vagy a munka végterméke — minden más szemét, és a szemét nem marad a fán. Ez
rád, a felügyelőre, minden ügynökre és minden szkriptre egyformán érvényes.

> {{OWNER_NAME}}, 2026-08-30: „önmagától ne keletkezzen semmilyen fájl (…) te,
> Marvin, az agentek senki nem tehet plusz fájlt ebbe az életfába ezt nem
> szeretem, ha tele van szemetelve és akkor később itt kiderül, hogy na
> egyébként meg 8 darab fájl ott van." — és külön: „hogyha ideiglenesen, vagy a
> fejlesztéshez kell létrehozni egy fájlt, akkor azt utána, amikor a fejlesztés
> készen van, utána törölni kell." — és: „amikor vége van a munkának commit és
> push azonnal."

## A négy pont

**1. Ideiglenes fájl SOHA nem a projekt fájába megy.**
Próbaszkript, képernyőkép, dump, kimenet, kísérleti másolat → `/tmp/` vagy a
session saját scratch-könyvtára. A projekt **gyökerébe** különösen nem: ott csak
commitolt, a projekthez tartozó fájl állhat.

**2. Amit a fejlesztéshez létrehoztál, a fejlesztés végén TÖRÖLD LE.**
A „kész" nem kész, amíg ott áll egy fájl, amire már nincs szükség. Nem a
következő session dolga eldönteni, hogy kell-e még — egy nap múlva már senki nem
tudja.

**3. A munkaegység végén a fa legyen tiszta.**
Nézd meg `git status --porcelain --untracked-files=all`, és **számolj el minden
sorral**: commit vagy törlés. A „majd később" nem opció.

**4. A lezárt munka végén: hatásvizsgálat + bugkeresés (szélesen és mélyen),
utána AZONNAL commit ÉS push.**
Nem maradhat commitolatlan vagy pusholatlan munka: a következő ügynök
félbehagyott munkát lát belőle, és vagy hozzányúl, vagy megáll miatta. Ugyanez
áll a chat-naplóra: a lezárt munkaegységről **még ugyanabban a válaszban** írj
bejegyzést, ne a session végén.

## Miért — a mért eset

**2026-08-29 18:34:18 – 18:37:05**, három perc alatt **nyolc** fájl keletkezett a
repó gyökerében: négy Playwright-próbaszkript (`.tmp-check-marvin*.mjs`) és a
kimeneteik (`.tmp-info.json`, `.tmp-shot1.png`, `.tmp-shot2.png`,
`.tmp-claudepart.html`). **Nem a projekt kódja írta őket** — egy asszisztens-menet
írta a gyökérbe egy eldobható munkakönyvtár helyett, és a munka végén egyik sem
lett letörölve. Ugyanaznap 19:35-kor egy `""` nevű könyvtár is keletkezett egy
másik projekt munkakönyvtárában, ugyanebből a menetből.

**Egy napig ott álltak, szó nélkül**, mert az egyetlen figyelő a **nem-követett**
fájlokat szándékosan eldobta („a scratch file nobody has staged is not work at
risk"). Két réteg volt nyitva egyszerre: semmi nem állította meg a keletkezést,
és semmi nem vette észre utána.

## Mi őrzi (nem kézi fegyelem)

- **`scripts/hooks/no-stray-files.py`** — PreToolUse kapu. Megállítja az új fájlt
  a projekt gyökerében és az ideiglenes nevű fájlt (`.tmp-`, `tmp-`, `scratch-`,
  `.bak`, `.orig`, `~`) a fán belül, és **megmondja, hova írd helyette**. Minden
  bizonytalanságnál átenged (hibás bemenet, hiányzó git, fán kívüli út).
  Kikapcsoló: `MARVEEN_STRAY_FILE_GATE=0`.
- **A commitolatlan-munka figyelő** most három kategóriát mond ki külön:
  commitolatlan / **szemét (nem-követett)** / **pusholatlan commit**.
- **`src/__tests__/nyomtalan-munka.test.ts`** — megbuktatja a munkát, ha szemét
  áll a repó gyökerében.

## Törlés előtt: a visszakérdezés-szabály is áll

Ha **nem te** hoztad létre a fájlt, vagy nem vagy biztos benne, hogy eldobható,
**kérdezz** — vagy előbb **mozgasd el** `/tmp/` alá (visszafordítható), és úgy
kérdezz. A törlés visszafordíthatatlan; az elmozgatás nem.

## Záró ellenőrzés minden fejlesztés végén

1. Létrehoztam-e bármit ideiglenesen? Letöröltem-e mindet?
2. `git status --porcelain --untracked-files=all` — minden sorra van válaszom?
3. Megvolt-e a hatásvizsgálat + bugkeresés, szélesen és mélyen?
4. Commit **és** push megtörtént?
5. A chat-napló megkapta a bejegyzést a lezárt munkaegységről?


## ⛔ FÉLBEHAGYOTT MUNKA NINCS — COMMITOLATLAN ÉS PUSHOLATLAN ÁLLAPOTBAN SOHA

**{{OWNER_NAME}}, 2026-09-12:** „nem lehet ugy felbehagyni munkat hogy az a vegen
commitkolatlan es pusholatlan maradjon. **soha**." — és az indok ugyanabból a
mondatból: „**mert most mindenki all. es nem lehet tudni ki hagyta ott oket**."

**A mért eset.** 2026-09-12-én az éles Marveen-telepítés munkafájában **59 fájl**
állt commitolatlanul, legalább négy külön funkcióból (böngésző-bővítmény, kód-híd
mappatallózó, címke-kezelés, kvóta-reset). A kód **zöld volt** — 487 tesztfájl,
7523 teszt, 0 bukás —, csak soha nem lett commitolva. Emiatt nem volt szerzője,
üzenete, visszavonható pontja, és nem lehetett kiadni senkinek: **mindenki állt**.

**A munkaegység definíció szerint akkor van kész, amikor fel van pusholva.** Nem
„majd a végén", nem „ha zöld lesz minden".

- **Félbe kell hagynod? Akkor is commitold és pushold** azt, ami elkészült,
  `wip:` prefixű üzenettel, ami leírja, hol tartasz és mi hiányzik.
- **A félkész munka commitolható — a névtelen nem.** Egy WIP-commit külön ágon
  mindig jobb, mint gazdátlan fájlok a munkafában.
- **Zöldre nem tudod hozni? Az nem ok a commit elhagyására.** A bukó tesztet írd
  le a commit-üzenetben. A bukó teszt látszik; a hiányzó commit nem.
- **Idegen, gazdátlan commitolatlan munkát NEM törlünk** — készre visszük és
  commitoljuk. Törlés előtt a visszakérdezés-szabály áll.
- **A „pusholatlan" külön kategória a „commitolatlan" mellett.** A lokális commit
  a másik gépen nem létezik. És a pusholatlan darabszám lehet `null` is — az NEM
  nulla, az „nem látok oda".

Részletek: a Marveen `nyomtalan-munka` skillje és a repó CLAUDE.md-je.

## ⛔ SOHA NEM DOLGOZUNK KÖZVETLENÜL AZ ÉLŐ FÁBAN — MINDIG IZOLÁLT WORKTREE

**{{OWNER_NAME}}, 2026-09-12:** „ilyen ne forduljon elo soha hogy … **Valaki KÖZVETLENÜL az
élő tree-ben dolgozott, nem izolált worktree-ben** … sohasem dolgozunk
kozvetlenul az elo tree ben!"

**A mért eset.** Ugyanaz a 2026-09-12-i eset a másik oldaláról. Az élő
telepítésben (amiben a szolgáltatás **fut**) folyt a fejlesztés, és ennek három
mért következménye lett:

1. **Ott a tesztkészletet el sem lehet indítani.** Az őr
   (`assert-not-live-install.ts`) szándékosan megtagadja a futást élő
   telepítésben, mert a teszt az éles adatbázisba írna. Aki az élő fában
   dolgozik, **nem tudja lefuttatni a saját tesztjeit**.
2. **Az éles repó beállítása elromlott:** `core.bare = true` került a
   `.git/config`-ba, és ettől ott **semmilyen** `git status`/`commit` nem futott
   le („this operation must be run in a work tree").
3. **Egy fa, több gazda** — utólag nem lehetett szétválasztani, ki mit hagyott ott.

**Az élő checkout futtat, nem fejleszt.** Fejlesztés izolált worktree-ben megy
(`git worktree add --detach <cél> HEAD`). Az élő fában csak olvasás, a telepítés
frissítése (`git pull` / ág-váltás) és üzemeltetés megengedett.

- **Ha mégis az élő fában találsz magadra**, az első lépés a worktree felhúzása és
  a munka átvitele oda — nem a folytatás helyben.
- **Az élő fát csak bizonyítással léptesd előre:** mielőtt commitra állítod,
  mutasd meg, hogy nem vész el semmi (`git diff <commit>` üres, vagy pontosan a
  szándékolt változás).
- **A teszt-őrt nem kerüljük meg.** Ha megtagadja a futást, az nem hiba, hanem a
  helyes válasz: rossz helyen vagy. A megoldás a worktree, nem az őr kikapcsolása.

Részletek: a Marveen `nyomtalan-munka` skillje és a repó CLAUDE.md-je.
