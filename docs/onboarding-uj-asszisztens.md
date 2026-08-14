# Új asszisztens onboarding (Marveen flotta)

Ez a leírás végigvezet egy új kolléga-asszisztens beüzemelésén: saját Telegram bot
és saját Google (Gmail/Drive/Naptár) hozzáférés. Példa: "Dia Marveenja".

Két dolgot kell beállítani: **Telegram** (hogy a kolléga beszélni tudjon az
asszisztensével) és **Google** (hogy az asszisztens lássa a kolléga levelét,
naptárát, fájljait). A kettő független, bármelyikkel kezdheted.

---

## Alapelvek

- **Minden asszisztens = saját Telegram bot.** Egy bot tokent nem lehet két
  asszisztensen megosztani (a Telegram botonként csak egy kapcsolatot enged, és a
  dashboard is tiltja a duplikációt).
- **A személyes Google a kolléga saját asszisztensébe kerül**, nem a Főnökbe
  (iS Marveen Főnök / marveen-is). A Főnök a flottát kezeli, nem olvassa senki
  postáját.
- **A titkokat (bot token, OAuth) soha ne küldd Telegram-chatbe.** A bot token a
  dashboard mezőjébe megy, a Google belépés pedig egy egyszeri böngészős lépés.

---

## 1. Telegram bot létrehozása és bekötése

1. **Bot létrehozása (Telegramban, @BotFather):**
   - Nyisd meg a @BotFather-t, parancs: `/newbot`
   - Név: pl. `Dia Marveenja`
   - Username: pl. `dia_marveen_bot` (egyedinek kell lennie, `_bot`-ra végződik)
   - A BotFather ad egy API tokent. Ezt másold ki.
   - Tipp: a botot te (admin) hozd létre, így céges kézben marad. A kolléga a
     tokent soha nem látja.

2. **Asszisztens létrehozása a dashboardon** (https://marveen.isolutions.hu):
   - "Felvétel", ahogy a korábbi asszisztenseknél.

3. **Token bekötése:**
   - Az asszisztens csatorna-beállításánál illeszd be a bot tokent.
   - A rendszer ellenőrzi, bekötí, és küld egy üdvözlő üzenetet a boton.

4. **A kolléga hozzáférése (párosítás):**
   - A kolléga megnyitja a botot (`t.me/dia_marveen_bot`), és ír neki egy üzenetet.
   - Alapból csak engedélyezett felhasználó tud írni (allowlist policy).
   - Te a dashboardon jóváhagyod a kolléga párosítását. Ettől kezdve beszélhet az
     asszisztensével.

---

## 2. Google (Gmail / Drive / Naptár) bekötése

Egyszeri céges előfeltétel (már megvan, csak referencia):
- Google Cloud projekt, engedélyezve a Gmail + Drive + Calendar API.
- OAuth consent screen: Internal (csak céges fiókok).
- Egy "Desktop" OAuth kliens, a titka a szerveren zárolva.

A kolléga bekötése:
1. A Főnök (iS Marveen Főnök) előkészíti az asszisztens Google-konfigját és
   generál egy belépési linket.
2. A kolléga a **saját gépén** megnyitja a linket, belép a **saját céges Google
   fiókjával**, és engedélyezi a hozzáférést.
3. A böngésző a végén egy `localhost:...` címre ugrik és hibát mutat. Ez normális.
   A kolléga a böngésző címsorából kimásolja a teljes URL-t, és visszaküldi a
   Főnöknek.
4. A Főnök a szerveren lezárja a belépést. Ezután az asszisztens újraindul, és
   látja a Gmailt/Drive-ot/Naptárt. Újra belépni nem kell.

A kolléga a tokent és a technikai részleteket nem látja, csak egyszer belép a
saját Google fiókjával.

### Ha a Google letiltja a belépést („Hozzáférés letiltva", 403 access_denied)

Ez nem a kolléga hibája és nem is a Marveené: ha a Google Cloud projekt
**„Testing"** publikálási állapotban van, csak a **tesztelők listáján** szereplő
címek tudnak belépni. Mérve (2026-08-14): egy új cím a jóváhagyó képernyő
helyett azonnal „Hozzáférés letiltva" oldalt kap.

Megoldás (2 perc, a projekt tulajdonosa csinálja):
1. Dashboard → **Fiókok → Google** → *„A Google nem enged be?"* gomb. Az itt
   lévő link a **saját projektbe** visz (a projekt azonosítója a szerveren lévő
   OAuth kliensből jön, kézzel keresgélni nem kell).
2. A Google oldalán: **Tesztfelhasználók / Test users → + ADD USERS**.
3. A címet **karakterre pontosan** kell beírni (a panel ki is írja, melyiket).
4. Vissza a dashboardra → *„Felvettem, próbáljuk újra"*.

Két késleltetett következménye is van ugyanennek az állapotnak, érdemes tudni:
- **7 nap múlva** a „Testing" alatt kiadott hozzáférés lejár (`invalid_grant`),
  és a fiók sorában megjelenik az *„Újra bejelentkezés"* gomb. Ez nem hiba,
  hanem a Google szabálya — véglegesen a projekt közzétételével szűnik meg.
- A tesztelői lista **max. 100 cím**. Tíz asszisztensnyi fiók bőven belefér.

Ha az „Újra bejelentkezés"-nél véletlenül **másik** Google-címmel lépsz be, a
rendszer **nem írja felül** a régi fiókot: az új cím külön fiókként jelenik meg,
és a dashboard ki is írja, hogy ez történt.

---

## Ki mit csinál (gyors összefoglaló)

| Lépés | Ki csinálja |
|-------|-------------|
| Bot létrehozása (@BotFather) | Admin (te) |
| Asszisztens felvétele a dashboardon | Admin (te) |
| Bot token bekötése | Admin (te) |
| Párosítás jóváhagyása | Admin (te) |
| Google belépés (egyszeri) | A kolléga (saját fiókkal) |
| Google konfig + lezárás a szerveren | iS Marveen Főnök |

---

## Hibakeresés

- **A kolléga ír a botnak, de nincs válasz:** valószínűleg nincs még jóváhagyva a
  párosítás. Nézd meg a dashboardon a függő (pending) párosításokat.
- **Eltűnő üzenetek / kapcsolat-hibák:** majdnem biztos, hogy ugyanazt a bot
  tokent két asszisztensre tették. Minden asszisztensnek külön bot kell.
- **A Google belépés "origin not allowed" vagy hasonló hibát ad:** szólj a
  Főnöknek, ez OAuth-konfig kérdés, nem a kolléga hibája.

---

*Készítette: iS Marveen Főnök. A flotta a marveen.isolutions.hu címen érhető el.*
