---
name: email-send
description: Amikor egy email-küldő eszközzel rendelkező ágensnek emailt kell küldenie. KÖZVETLENÜL küld, a fő ágens közvetítése és a régi governance-gate nélkül. Kikényszeríti a címzett/tárgy/tartalom megerősítési protokollt: ami hiányzik vagy nem egyértelmű, arra rákérdez; amit a felhasználó már megadott, azt nem kérdezi újra; email-címet sosem talál ki.
---
# Email küldése (közvetlen, felhasználói megerősítéssel)

## Mikor használd
Bármikor, amikor a feladat email kiküldése, és van email-küldő eszközöd
(pl. `scripts/gmail-send.py`, `scripts/graph-mail.ts send`, vagy egy MCP
`send_email` eszköz). Ez a skill MINDEN ilyen ágensre vonatkozik, nem csak a
fő ágensre.

**Nem kell a fő ágens.** Az email-küldés 2026-08-20 óta NEM fő-ágens-only
képesség (Boss döntése, ekkor szűnt meg a governance hard-gate). Ha van
email-küldő eszközöd, közvetlenül használd:

```
Ágens -> Email eszköz -> Elküldve
```

Amit TILOS (ezek a megszűnt régi mechanizmus maradványai):
- NE add át a feladatot automatikusan a fő ágensnek jóváhagyásra.
- NE várj a fő ágens jóváhagyására.
- NE keresd/hívd az `email-send-gate` mechanizmust (nem létezik többé).
- NE hivatkozz arra, hogy "csak a fő ágens küldhet emailt" (már nem igaz).

## Alapszabály: három adat kell
Küldés ELŐTT győződj meg róla, hogy mindhárom egyértelműen megvan:
1. **Címzett** (kinek megy)
2. **Tárgy** (mi a subject)
3. **Tartalom** (mit írunk bele)

Ha bármelyik hiányzik VAGY nem egyértelmű, kérdezz rá a felhasználónál,
MIELŐTT küldesz. Röviden, csak a ténylegesen hiányzó adatra:
- Kinek menjen?
- Mi legyen a tárgy?
- Mit írjunk bele?

Ha az adat egyértelmű, NE kérdezz -- használd közvetlenül az eszközt.

## Ne kérdezz feleslegesen
Amit a felhasználó MÁR egyértelműen megadott, azt NE kérdezd újra.

Példa: "Írd meg Péternek, hogy holnap nem tudok menni, és küldd el."
-> a címzett (Péter), a tartalom (holnap nem megyek) és a küldési szándék is
egyértelmű. Ilyenkor NE kérdezd újra hogy kinek, mit, vagy hogy elküldheted-e.
Legfeljebb a tárgy hiányozhat -- ha a kontextusból ("holnapi találkozó")
egyértelműen levezethető, tedd oda, ne kérdezz. Csak a TÉNYLEGESEN hiányzó vagy
kétértelmű adatra kérdezz rá.

Fordítva: ha a felhasználó csak annyit mond "küldd el neki", de nem derül ki
pontosan MIT, akkor kérj rövid pontosítást a tartalomra.

## Címzett ellenőrzése -- címet SOSE találj ki
- Ha egy ismert kapcsolat email-címe rendelkezésre áll (címjegyzék, korábbi
  levelezés, tárolt kontakt), használd azt.
- Ha több lehetséges címzett van, vagy nem egyértelmű MELYIK személynek kell
  küldeni, kérdezz rá -- ne tippelj.
- Email-címet TILOS kitalálni/összerakni. Ha nincs meg a cím és nem tudod
  megbízhatóan előkeríteni, kérdezd meg a felhasználót.
- Csak VERIFIKÁLT címre küldj. Sose névből "kikövetkeztetett" címre.

## Tartalom
- A levél szövegét te is megírhatod a felhasználó utasítása alapján.
- A CLAUDE.md email-aláírás szabálya érvényben marad (aláírás CSAK emailbe).
- Sose írj alá a tulajdonos nevével, és sose kérj pénzt bárki nevében. Ez nem
  a megszűnt gate, hanem állandó doktrína -- a gate megszűnt, ez marad.

## Buktatók
- **A gmail-send.py alapból `draft` (piszkozat) módban futhat** -- a piszkozat
  NEM kézbesítés, a címzett semmit nem kap. Ellenőrizd, hogy tényleg KÜLDÉS
  történt-e, ne csak piszkozat készült.
- **A küldést a képernyőn/naplóban igazold vissza** (elküldött-visszaigazolás,
  message-id), ne feltételezd hogy ment, mert a parancs 0-val tért vissza.
- **Bizonytalanságnál kérdezz, ne küldj.** Egy rossz címzettre kiment levél
  nem vonható vissza -- a kétértelműség feloldása MINDIG a küldés elé kerül.

## Ellenőrzés
- Küldés előtt: mind a három adat (címzett, tárgy, tartalom) megvan és
  egyértelmű, vagy a hiányzóra rákérdeztél és megkaptad a választ.
- Küldés után: van tényleges kézbesítés-visszaigazolás (nem piszkozat).
