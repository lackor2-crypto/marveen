---
name: marveen-test-suite-triage
description: Amikor egy Marveen kanban-kártya (vagy {{OWNER_NAME}}) egy konkrét, kis számú hibázó tesztet említ, vagy meg kell állapítani hogy egy tesztsikertelenség a SAJÁT mai munkád okozta-e vagy már korábban is megvolt. Trigger -- "hibás teszt", "X/Y sikertelen", "regresszió-e ez", bármilyen vitest hiba triázsa.
---

# Marveen tesztkör triázs: teljes futtatás + baseline-diff

## Mikor használd

- Egy kanban-kártya vagy {{OWNER_NAME}} egy KONKRÉT tesztfájlt/hibaszámot említ (pl.
  "3/10 sikertelen egy fájlban") -- ez majdnem mindig egy RÉSZLEGES futtatásból
  származó pillanatkép, nem a teljes kép.
- El kell dönteni: ez a hiba a MOST folyó munkád okozta (valódi regresszió),
  vagy már korábban is megvolt (backlog-adósság, nem a te hibád)?
- `assert-not-live-install.ts` miatt a teszt csak worktree-ből futtatható az
  éles telepítésen -- ez a szabály önmagában is forrása lehet meglepő
  hibáknak (lásd Buktatók).

## Eljárás

1. **Mindig a TELJES kört futtasd**, ne csak az említett fájlt -- egy
   "3 hiba egy fájlban" jelentés tipikusan egy korábbi RÉSZLEGES futtatásból
   származik, és a valós kép sokkal nagyobb lehet:
   ```bash
   git worktree add /tmp/<egyedi-nev> HEAD
   cd /tmp/<egyedi-nev> && npm install --no-audit --no-fund
   npx vitest run 2>&1 | tail -80   # összesítés + FAIL lista a végén
   ```
2. **Csoportosítsd** a hibázó teszteket a hibaüzenet/ok alapján -- gyakran
   TÖBB, EGYMÁSTÓL FÜGGETLEN gyökérok áll egy nagy hibaszám mögött, nem
   érdemes mindet egy jelenségnek kezelni.
3. **Baseline-diff: a mai munkád okozta, vagy már megvolt?** Nyiss egy
   MÁSIK worktree-t az utoljára push-olt állapotból, és futtasd ott is
   UGYANAZOKAT a hibázó teszteket:
   ```bash
   git worktree add /tmp/<masik-nev> origin/main
   cd /tmp/<masik-nev> && npm install --no-audit --no-fund
   npx vitest run <hibazo-fajl1> <hibazo-fajl2> ... 2>&1 | tail -60
   ```
   Ha ott IS elbukik -> nem a te mai munkád törte el, backlog-adósság.
   Ha ott ZÖLD -> valódi regresszió, a te mai változtatásod okozta, azt
   sürgősen javítsd/vizsgáld a saját commitjaid között.
4. **Takarítás**: mindkét worktree-t távolítsd el a végén, ne maradjon ott:
   ```bash
   git worktree remove /tmp/<egyedi-nev> --force
   git worktree remove /tmp/<masik-nev> --force
   ```
5. Az eredményt (csoportosítva, gyökérokokkal, regresszió-e vagy sem) írd a
   kanban kártyára -- ne csak "X teszt bukik", hanem a fenti diagnózis is
   kerüljön bele, hogy a következő session ne kezdje elölről.

## Buktatók

- **2026-08-07: a worktree önmaga /tmp alatt van, ez tesztet dönthet el.**
  Ha egy teszt saját "biztonságos, létező szkript" fixture-t számít
  `__dirname`/`PROJECT_ROOT`-ból (tehát a checkout tényleges lemez-helyétől
  függ), és a projekt van egy `isUnsafeHookCommand`-szerű /tmp-elutasító
  guardja, akkor EGY WORKTREE-BŐL FUTTATVA a teszt saját fixture-je is
  /tmp alá esik, és a guard (helyesen) elutasítja -- ez NEM kódhiba, hanem a
  "mindig worktree-ből tesztelj" szabály és egy /tmp-tiltó biztonsági guard
  szerkezeti ütközése. Ne próbáld a guardot gyengíteni (valós incidenst
  előzött meg, lásd `hook-path-guard.test.ts` fejléc-kommentje) -- a teszt
  fixture-jét kellene a checkout helyétől függetleníteni.
  **Tényleges megoldás, ami bevált (2026-08-08, kártya #b33afe71, 19/19
  javítva):** `existsSync`-et NEM kellett mockolni -- a guard tmp-prefix
  ellenőrzése tiszta stringmatch a `command`-on, `existsSync`-hez semmi köze,
  úgyhogy egy mockolt `existsSync` itt nem is segítene. Ami bevált: (1) ha a
  teszt maga építi az utat (pl. `hook-path-guard.test.ts`), másold át a
  valódi szkriptet egy VALÓS, nem-tmp fixture-mappába (`homedir()` alatt,
  soha nem /tmp valós gépen), és arra mutass; (2) ha az út a TESZTELT
  FÜGGVÉNYEN belül épül `PROJECT_ROOT`-ból (pl. `injectEmailSendGate`),
  `vi.mock('../config.js', ...)`-kal cseréld ki a `PROJECT_ROOT` exportot egy
  hasonló, valós, nem-tmp tükör-mappára, amiben megvannak a hivatkozott
  szkriptek másolatai. Közös helper mindkettőhöz:
  `src/__tests__/helpers/fake-project-root.ts` (a `vi.mock` factory-ban hívd
  meg, mert a `vi.mock` a fájl tetejére hoistolódik, external segédfüggvényt
  viszont dinamikus `await import(...)`-tal biztonságos behívni onnan).
- Ne higgy egy kártya "N/M sikertelen" számának -- mindig futtasd újra a
  teljes kört magad, a szám gyakran elavult vagy részleges.
- Több hibázó teszt egyetlen futtatásból könnyen egy jelenségnek tűnik --
  mindig nézd meg az egyedi hibaüzeneteket, nem csak a piros számot.

## Ellenőrzés

- A jelentésben szerepel: teljes hibaszám, fájlonkénti/okonkénti csoportosítás,
  és mindegyik csoportról explicit "regresszió / nem regresszió" döntés.
- Mindkét worktree eltávolítva (`git worktree list` tiszta).
