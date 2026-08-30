---
name: user-is-not-a-programmer
description: Használd MINDEN olyan fejlesztésnél, ahol a felhasználó lát vagy csinál valamit -- felület, hibaüzenet, beállítás, varázsló, értesítés. A Marveen felhasználója nem programozó. Egy funkció nincs kész attól, hogy működik; akkor kész, ha egy laikus egyedül végig tud rajta menni.
scope: global
---

# A felhasználó nem programozó

## Mikor használd

Minden felületi munkánál: beállítás-mező, varázsló-lépés, hibaüzenet,
üres-állapot szöveg, értesítés, megerősítő kérdés. Akkor is, ha csak egy
címkét írsz át.

## Miért

A tulajdonos, 2026-08-11, miközben a beállítás-varázslót nézte: "a user egy komuves!
nem tudja hogy oda a beviteli mezokbe mit is kell hogy irjon! [...] mert meg
most is ugy programozol mintha a user ertene hozza hogy mit hasznal!"

A Marveen nyílt forráskódú. Aki telepíti, nem feltétlenül ért a
számítástechnikához. Egy mező felirattal és üres helyettesítő szöveggel
technikailag kész, gyakorlatilag használhatatlan.

## A négy kérdés -- MINDEGYIKRE válaszolj a felületen

Egy beviteli mező vagy művelet mellett ott kell lennie:

1. **Mi ez, és miért kellene nekem?** Egy mondat, szakszó nélkül.
   - Rossz: "Helyi modell-szerver a szemantikus memória-kereséshez."
   - Jó: "Ezzel a Marveen a saját gépeden keres a régi beszélgetéseid között,
     internet nélkül. Enélkül is működik minden, csak lassabb a keresés."
2. **Honnan szerzem meg?** Számozott lépések + KATTINTHATÓ LINK.
   - "lásd a leírást" önmagában TILOS. Hol van a leírás? Ha hivatkozol rá,
     tedd oda a linket.
3. **Mit írjak be?** Konkrét példa a formátummal.
   - Jó: "Így néz ki: `123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`"
4. **Mi van, ha kihagyom?** Mondd meg, működik-e nélküle.

## Prioritás -- három szint, és a szín is számít

| Szint | Szín | Jelentés |
|---|---|---|
| Alapfunkció | piros | Enélkül a Marveen nem működik. Javítani kell. |
| Ajánlott | narancssárga | Sokat ad hozzá, de működik nélküle. |
| Extra | semleges (SOHA nem piros) | Kényelmi funkció. |

**Extra funkció hiányát tilos vészjelzésnek látszó felülettel mutatni.**
Valós eset (2026-08-11): három EXTRA képesség hiánya egy vérvörös, fekete
gombos sávot eredményezett az Áttekintésen. Úgy nézett ki, mintha a rendszer
elromlott volna. A felhasználó nyugodjon meg attól amit lát, ne ijedjen meg.

## Varázsló az legyen varázsló

Egy lista, aminek a tetején az áll hogy "varázsló", nem varázsló. A varázsló:
- egyszerre EGY dolgot kér,
- megmondja mit csináljon és hova kattintson,
- ad linket, ha ki kell menni egy weboldalra,
- megvárja amíg beírja az értéket,
- utána lép a következőre,
- és kihagyhatóvá teszi azt, ami nem kötelező.

## Buktatók

- **A szakszó akkor is szakszó, ha neked természetes.** "OAuth kliens",
  "token", "repo", "endpoint", "cron" -- mindegyiket meg kell magyarázni,
  vagy ki kell kerülni.
- **Az üres helyettesítő szöveg nem magyarázat.** A `placeholder` mutatja a
  formátumot, nem helyettesíti a leírást.
- **Ne kérj olyat, ami nem csinál semmit.** Mielőtt beleteszel egy mezőt,
  nézd meg, olvassa-e valami a kódban. (2026-08-11: a GOOGLE_API_KEY-t
  semmi nem olvasta, mégis bekerült a varázslóba.)
- **Több fiók.** Ha a rendszer több fiókot ismer (Gmail, Drive, naptár,
  GitHub), a felület adjon választást és alapértelmezettet, ne feltételezze
  hogy egy van.

## Ellenőrzés

Olvasd el a felületet úgy, mintha most látnád először és nem tudnád mi az a
token. Ha bármelyik kérdésre nem kapsz választ MAGÁRÓL A FELÜLETRŐL --
mi ez, honnan szerzem, mit írjak be, muszáj-e -- akkor még nincs kész.
