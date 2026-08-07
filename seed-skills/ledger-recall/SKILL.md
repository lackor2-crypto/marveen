---
name: ledger-recall
description: Amikor Boss korábbi beszélgetésre utal vissza ("ezt már mondtam", "nem ezt beszéltük", "emlékszel amikor...", "mit kértem pontosan"), és a jelen session kontextusa (SessionStart-kor betöltött kivonat vagy a folyó beszélgetés) nem tartalmazza elég pontosan -- keress rá a ledger adatbázisban kulcsszóval, ne találgass és ne kérdezz vissza feleslegesen.
---

# Ledger visszakeresés

## Mikor használd

Minden Telegram be- és kimenő üzenet automatikusan mentve van a
`store/claudeclaw.db` -> `conversation_log` táblába (a ledger rendszer, lásd
`scripts/hooks/ledger_lib.py`), 2026-08-02 óta, törlés/limit nélkül. A
SessionStart hook ebből csak egy rövid, friss ablakot (~20 forduló / ~8KB)
tölt be minden induláskor -- ha Boss ennél régebbi dologra utal vissza, a
válasz NEM a betöltött kontextusban van, hanem a ledgerben.

Trigger: visszautalás korábbi döntésre, kérésre vagy beszélgetésre, amit a
jelenlegi kontextus nem fed le egyértelműen.

## Eljárás

```bash
python3 scripts/hooks/ledger-search.py "kulcsszó" [limit] [agent_id]
```

- A kulcsszó legyen szűk és célzott (egy funkció/termék/döntés neve), NE
  általános szó -- ez tartja alacsonyan a token-felhasználást (Boss kérése:
  ne olvass be feleslegesen nagy tételt).
- A `limit` alapértelmezetten 20 sor -- csak annyit kérj amennyi tényleg kell.
- Ha az első kulcsszó nem hoz találatot, próbálj egy másik, rokon kulcsszót
  (max 2-3 próbálkozás), de ne olvasd be az egész táblát egyszerre.
- Az `agent_id` paramétert csak akkor add meg, ha kifejezetten egy másik,
  a flottában regisztrált ágens historyjára van szükség -- alapértelmezetten
  a jelenlegi (main) ágensé.

## Buktatók

- A ledger csak Telegram-üzeneteket tartalmaz (be- és kimenő szöveg), nem
  belső tool-hívásokat, fájlműveleteket vagy más csatornákat.
- Ha a keresés (néhány próbálkozás után) sem hoz semmit, mondd meg egyenesen
  Bossnak hogy nem találtad meg, ne találj ki választ a hiányra.
- Ne olvasd be az egész conversation_log táblát egy nagy dumpban "biztos ami
  biztos" alapon -- ez pont az a kvóta-pazarlás, amit Boss el akar kerülni.

## Ellenőrzés

- A visszakeresett szövegrészlet ténylegesen alátámasztja amit válaszolsz,
  nem csak témában hasonló.
