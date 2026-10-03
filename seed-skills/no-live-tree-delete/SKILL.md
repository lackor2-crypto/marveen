---
name: no-live-tree-delete
description: Az élő checkoutban (a fő munkafa, amiből a dashboard fut) TILOS törölni, áthelyezni, csonkítani. Használd minden törlő parancs (rm, unlink, mv, truncate, find -delete, git clean) előtt, és minden tesztnél, ami adatbázist vagy fájlt töröl. Törlés csak worktree-ben, ABSZOLÚT úttal.
scope: global
---
# Törlés az élő fában tilos

## Mikor használd
- Bármilyen `rm`, `unlink`, `shred`, `truncate`, `mv`, `find -delete`, `git clean` előtt.
- Teszt-példány adatbázisának vagy ideiglenes fájlnak a takarításakor.
- Ha a session munkakönyvtára az élő fa gyökere (`PROJECT_ROOT`).

## Miért (mért eset, 2026-10-03 02:28)
Egy tesztelő parancslánc `cd <worktree> && ...; rm -rf store/<adatbázis>*` alakú volt.
A worktree közben már nem létezett, a `cd` elbukott, a pontosvessző utáni törlés az ÉLŐ
fán futott le. Az élő adatbázis kiürült: ~23 óra adat veszett el (kártyák, memóriák,
projektek, jóváhagyások, a tulajdonos prezentációja és névjegye). A legutóbbi jó mentés
23 órás volt, a közbeni munka nem állítható vissza.

## Eljárás
1. Dolgozz `scripts/agent-worktree.sh <név>` worktree-ben.
2. Törölni ABSZOLÚT úttal törölj: `rm -rf /abs/út/.worktrees/<név>/...`.
3. SOHA ne láncolj törlést `cd` után (`cd x && rm ...` vagy `cd x; rm ...`): ha a `cd`
   elbukik, a törlés a régi helyen fut.
4. Ideiglenes fájl: `/tmp` vagy a session scratch-könyvtára, nem a projekt fája.
5. Az élő fán törlés csak a tulajdonos döntésével.

## Gép is kikényszeríti
`scripts/hooks/no-live-tree-delete.py` (teljes fa) és `scripts/hooks/no-live-store-delete.py`
(adatbázis), PreToolUse, minden ágensnek a `templates/settings.json.template`-ből.
Kidobható helyek (nem állítja meg): `.worktrees/`, `store/tmp/`, `node_modules/`, `dist/`,
`agents/`. Kikapcsoló: `MARVEEN_NO_LIVE_TREE_DELETE_GATE=0`, csak a tulajdonos döntésére.

## Buktatók
- A kapu a parancs szövegét nézi: egy parancs, ami idézetben vagy heredocban tartalmaz
  `rm`-et és élő utat, tévesen megállhat; ilyenkor a fájlt Write eszközzel írd.
- Relatív utat a kapu a cwd-hez ÉS a parancsban szereplő `cd` célhoz képest is megnéz.

## Ellenőrzés
`npx vitest run src/__tests__/no-live-tree-delete-hook.test.ts`
