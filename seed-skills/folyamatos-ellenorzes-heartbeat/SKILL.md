---
name: folyamatos-ellenorzes-heartbeat
description: A "folyamatos-ellenorzes" scheduled heartbeat (naptar/email/kanban gyors-ellenorzes) végrehajtása. Használd, ha ez a heartbeat fut, vagy hasonló naptár+email+kanban gyors-átvizsgálást kell csinálni.
scope: global
---

# Folyamatos ellenorzes heartbeat

## Mikor hasznald
A `folyamatos-ellenorzes` scheduled heartbeat futásakor (vagy hasonló "nézd meg
naptár/email/kanban, szólj ha fontos" jellegű gyors ellenőrzésnél).

## Eljaras
A parancsokat a saját munkakönyvtáradból (`{{PROJECT_ROOT}}`) futtasd, ne fixen
beírt útvonalról -- a `scripts/` és `store/` a repó gyökeréhez képest relatív.
1. Naptár: `python3 scripts/google.py mai-naptar` -- nézd meg van-e esemény 1
   órán belül.
2. Email: `python3 scripts/google.py olvasatlan 10` -- nézd meg van-e sürgős
   (nem promó/spam) levél.
3. Kanban: `curl -s -H "Authorization: Bearer $(cat store/.dashboard-token)"
   http://localhost:{{WEB_PORT}}/api/kanban` majd szűrd a `due_date`-re.

## Buktatok
- A kanban `/api/kanban` válaszban a `due_date` mező **nem mindig string** --
  néhány kártyánál `int` (pl. epoch vagy null helyett 0), másiknál ISO string.
  Egy `c.get('due_date','').startswith(...)` ezért `AttributeError`-ral elhasal
  int-en. Mindig ellenőrizd típust előbb:
  `isinstance(d, str) and d.startswith(today)`.

## Ellenorzes
- Ha mindhárom forrás csendes (nincs 1 órán belüli esemény, nincs sürgős email,
  nincs mai határidős kártya): NE írj semmit, fejezd be a kört akció nélkül.
- Ha bármelyik talál valamit: rövid, tömör Telegram üzenet.
