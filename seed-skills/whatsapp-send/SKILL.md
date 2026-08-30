---
name: whatsapp-send
description: WhatsApp-üzenet küldése a beállított címzettnek Windows-asztali automatizálással, e-mail tartalék-úttal. A kilépőkód KÉZBESÍTÉST jelent, nem azt, hogy a WhatsApp működött.
scope: global
---

# whatsapp-send

Ez a skill azt mondja meg, **hogyan tud egy ügynök WhatsApp-üzenetet küldeni** —
és azt is, **mikor NEM tud**. Nem minden ügynök tudja: az út egy élő Windows
asztali munkameneten megy keresztül, ami sok környezetben egyszerűen nincs.

A hivatkozott szkript a repóval együtt érkezik, tehát friss telepítésen is
megvan: `{{PROJECT_ROOT}}/scripts/whatsapp-send.py` (mellette a mérő
önteszt: `scripts/whatsapp-send-selftest.py`).

## ⛔ Kimenő üzenet valódi címzettnek — előbb KÉRDEZZ

Ez a szkript **igazi embernek küld igazi üzenetet**, és nem vonható vissza. A
visszakérdezés-szabály ide maradéktalanul érvényes: ha nem szó szerint kérték
tőled az elküldést, vagy ha a címzett vagy a szöveg akár halványan is
kétértelmű, **kérdezz, mielőtt futtatod**. Próbához ott a `--dry-run`.

## Mikor használd

Akkor, ha a feladat kimondottan WhatsApp-üzenetet kér a beállított címzettnek.
Egyéb értesítéshez a rendszer saját csatornái (dashboard, Telegram, e-mail)
olcsóbbak és megbízhatóbbak — ez az út egy GUI-automatizálás, tehát a
legtörékenyebb mind közül.

## Mi kell hozzá (ha bármelyik hiányzik, ez az út NEM járható)

| Feltétel | Miért |
|---|---|
| WSL, ahonnan a `powershell.exe` elérhető | a szkript maga keresi meg; a WSL PATH-ban gyakran nincs `/mnt/c` |
| Bejelentkezett, **interaktív** Windows asztali munkamenet | a Feladatütemező `LogonType Interactive` feladatként indítja; zárolt vagy fej nélküli gépen nincs, ahova gépelni lehetne |
| Telepített WhatsApp Desktop (Store-csomag) | ebbe gépel a szkript |
| `WHATSAPP_FALLBACK_EMAIL` a `.env`-ben | a tartalék-út címzettje. **Nincs alapértelmezése**: egy rosszul kitalált cím idegennek küldene levelet |

Nem kötelező, de állítható: `WHATSAPP_CONTACT` (a WhatsApp keresőjébe gépelt
név — ékezet nélkül, mert a SendKeys az ékezetes betűket szó szerint gépeli),
`WHATSAPP_PACKAGE_FAMILY` (a Store-csomag, amivel az app indul).

## Eljárás

```bash
# Próba: egyetlen billentyűleütés sem történik, csak a feltételeket nézi meg
python3 {{PROJECT_ROOT}}/scripts/whatsapp-send.py --dry-run "szöveg"

# Éles küldés
python3 {{PROJECT_ROOT}}/scripts/whatsapp-send.py "szöveg"
```

Kapcsolók: `--retries N` (alapértelmezés 3), `--skip-launch` (a WhatsApp már
nyitva), `--no-fallback` (az e-mail tartalék-út kikapcsolása), `--select-only`,
`--dry-run`.

## A kilépőkód KÉZBESÍTÉST jelent, nem azt, hogy a WhatsApp működött

- `0` = **a címzettnél ott van az üzenet** — vagy a WhatsAppon, vagy az
  elküldött tartalék-levélben.
- `1` = **a címzettnél semmi nincs**; mindkét út bukott. Ilyenkor a szöveg egy
  piszkozatban parkol, hogy ne vesszen el — de a piszkozat **nem kézbesítés**,
  ezért marad nem-nulla a kód.

Ezt a szerződést az önteszt védi: `python3 scripts/whatsapp-send-selftest.py`
kicseréli a küldő függvényeket, semmit nem küld el, és megméri mind a három
esetet.

## Buktatók

- **A „lefutott" nem bizonyíték.** A siker egyetlen jele a szkript saját
  eredményfájlja, amire megvárakozik — nem az, hogy a PowerShell visszatért.
- **A piszkozat nem kézbesítés.** Ha `1`-et kaptál, a címzett nem tud semmiről;
  ne jelentsd elküldöttnek.
- **Zárolt képernyő / nincs bejelentkezett asztal** esetén a gépelés a semmibe
  megy. Előbb `--dry-run`.
- **Ékezetes címzettnév** a keresőben félremegy. Ezért a `Kiss Zolt`-szerű,
  ékezet nélküli, de elég hosszú töredék — a puszta vezetéknév több
  találatot ad, és a WhatsApp sorrendjére bízná a választást.
- A gépspecifikus értékek a környezetből jönnek, **soha ne írd őket a kódba**.
