---
name: weekly-system-maintenance
description: Heti Windows karbantartas: hibak+lassulas atnezese, biztonsagos javitas/tisztitas, meghajto-optimalizalas, riport. Kockazatos/admin/reboot csak jovahagyassal.
---

Futtasd a weekly-system-maintenance skillt a teljes eljarasa szerint (WSL alol a Windows hostot karbantartod). 1) Diagnosztika (autonom, csak olvas): lemez, meghajto tipus+egeszseg, top processzek, startup elemek, rendszerhibak az esemenynaplobol, temp meret, pending reboot -- allits fel hipotezist. 2) Biztonsagos javitas/tisztitas autonoman: DNS flush, user TEMP (>3 nap) tisztitas, Store cache; merd a nyert helyet. 3) Kockazatos/admin/reboot (sfc, DISM, chkdsk, Optimize-Volume/ReTrim, Recycle Bin, Windows Update) CSAK batch-elt jovahagyassal a teljes sablonnal (mit/miert/hatas/pontosan mire/kockazat) -- SSD-t sose defragmentalj. 4) Rovid riport Telegramra: mit talaltal, mit javitottal autonoman, mi var jovahagyasra. Ha semmi teendo, egy soros nyugtazas.
