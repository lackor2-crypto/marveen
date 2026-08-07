---
name: notify-with-fallback
description: Szöveges üzenet kézbesítése egy elsődleges csatornán (pl. WhatsApp Desktop, Telegram), saját magadnak ellenőrizve hogy sikerült-e, és csak sikertelenség esetén másodlagos csatornára (pl. email) esve vissza. Akkor használd, ha Boss egy adott kontaktnak/csatornának ad küldési sorrendet ("előbb X-en, ha nem megy Y-on"), nem csak egy csatornát.
---

# Elsődleges csatorna + fallback küldés

## Mikor használd

Boss egy adott kontaktra vagy helyzetre megad egy KÜLDÉSI SORRENDET, nem
csak egy csatornát -- pl. "előbb WhatsAppon, ha nem megy át, akkor
emailen". Ez a skill az ÁLTALÁNOS mintát írja le, függetlenül attól hogy
melyik két csatornáról van szó és kinek szól -- a konkrét kontakt
elérhetőségei/különleges igényei (pl. akadálymentesség) egy KÜLÖN,
kontakt-specifikus memóriában/skillben legyenek (lásd pl.
[[kiss-zoltan-contact-accessibility]] mint konkrét példa erre a mintára).

Elsőként megépítve 2026-08-07, Kiss Zoltánnak küldött tőzsdei
elemzésekhez (WhatsApp elsődleges, email fallback), de a mechanizmus
bármilyen két csatornára/kontaktra alkalmazható.

## Eljárás

1. **Küldés az elsődleges csatornán.** Desktop-appon (WhatsApp, Signal,
   stb.) keresztül ez a [[windows-desktop-input]] skill (kattintás +
   vágólap-beillesztés + Enter); ha az elsődleges csatorna maga is API-val
   elérhető (pl. Telegram bot, email API), akkor egyszerűen azt hívd meg
   közvetlenül -- nem kell desktop-automatizálás, ha van rendes API.

2. **Ellenőrizd SAJÁT MAGADNAK, hogy sikerült-e** -- NE találgass, nézz
   utána ténylegesen:
   - Desktop-app esetén: friss screenshot (lásd [[windows-desktop-screenshot]]),
     nézd meg hogy az üzenet ott van-e a beszélgetésben, és van-e rajta
     "elküldve" jelzés (pipa/checkmark -- WhatsAppnál pl. szürke pipa =
     elküldve, ez elég, nem kell a "kék pipa = elolvasva" szintig várni).
   - API-alapú csatorna esetén: a hívás HTTP-válasza (200/sikeres
     azonosító) számít sikernek, ugyanúgy mint az agent-msg.sh mintája
     az inter-agent üzeneteknél (ne a "lefutott hibaüzenet nélkül"
     legyen az egyetlen jel, nézd meg a tényleges választ).
   - **Ha a célnak akadálymentességi igénye van (pl. vak, képernyőolvasót
     használ) -- a saját-ellenőrzésre használt screenshotot SOHA ne küldd
     el neki**, csak neked kell a visszaigazoláshoz.

3. **Ha az 1-2. lépés sikeres volt -> KÉSZ, ne küldj mást is.** Ne küldj
   automatikusan mindkét csatornára "biztonságból" -- az felesleges
   duplikáció, és ha a cél mindkét csatornát figyeli, zavaró.

4. **Ha az elsődleges csatorna sikertelen vagy bizonytalan** (nem sikerült
   megnyitni az appot, a kattintás/beillesztés nem talált célt, a
   screenshot nem mutat elküldött üzenetet) -> **KÖTELEZŐEN** küldd el
   ugyanazt a szöveget a másodlagos csatornán (pl. email,
   `scripts/gmail-send.py` vagy a megfelelő fiók küldő scriptje).

## Buktatók

- Ne cseréld fel a sorrendet -- ha Boss "előbb X, ha nem megy Y"-t mond,
  az NEM azt jelenti hogy mindkettőre menjen mindig, csak hogy Y a
  biztonsági háló, nem az alapértelmezett út.
- A "sikeres küldés" ellenőrzése NEM ugyanaz mint "a parancs hibaüzenet
  nélkül lefutott" -- lásd a marveen `agent-msg.sh` inter-agent üzenet
  mintáját, ahol pont ez a hiba (curl 0-val tér vissza 401/500 esetén is)
  okozott néma küldés-hibát korábban. Mindig a TÉNYLEGES eredményt nézd.

## Ellenőrzés

- Az elsődleges csatornán tényleg megjelenik az üzenet elküldve-jelzéssel.
- Fallback esetén az email/másodlagos csatorna küldése is visszaigazolt
  (nem csak elindítva).
