---
name: workitem-finalised-is-locked
description: A finalised work item is locked for the owner AND for the assistant; editing it needs an explicit reopen. If the owner asks for a change, the assistant asks "reopen this work item?" first. Use when editing, translating or changing anything on a document that has a final version.
scope: global
---
# Véglegesített munkadarab zárolva van, az asszisztensnek is

## Mikor használd
- Bármely módosítási kérés (szöveg, szakasz, melléklet, cím) egy olyan munkadarabon, aminek van végleges (véglegesített) változata.
- Nyelvi változat készítése/újrafordítása olyan eredetiből, ami véglegesítve van.

## Szabály (Boss, 2026-10-26, TG 10496)
- A véglegesített munkadarabot TILOS szerkeszteni: nem a felhasználó, és nem az asszisztens sem (doc.* eszközök, doc.translateSection, blokk-/szakaszírás).
- Ha a felhasználó változtatást kér rajta, az asszisztens ELŐBB visszakérdez: "Ez a munkadarab véglegesítve van. Újranyissam?". Csak igenre nyitja újra, és csak utána szerkeszt.
- Nem fordulhat elő, hogy a munkadarab véglegesítve MARAD és közben a tartalma megváltozik (a végleges PDF és a munkadarab szövege eltér).
- A nyelvi változat (pl. magyar) külön munkadarab: a fordítása nem érinti az eredeti véglegesítését, és a változat külön véglegesíthető.

## Eljárás
1. Szerkesztés előtt ellenőrizd: van-e végleges változata (doc.status / véglegesítés jelző)?
2. Ha van: állj meg, kérdezd meg a felhasználót az újranyitásról; amíg nem válaszol, ne írj.
3. Újranyitás után szerkeszthetsz; a végén új véglegesítés kell (lásd workitem-final-pdf-overwrite).

## Buktatók
- Valós eset (2026-10-26, munkadarab 68M, Billigkeitsantrag Berlin): véglegesített német munkadarabot az asszisztens átírt újranyitás nélkül, így a végleges és a tartalom eltért.

## Ellenőrzés
- Véglegesített munkadarabon a szerkesztő eszközök hibát adnak, nem írnak; az asszisztens az újranyitást kérdezi.
