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
