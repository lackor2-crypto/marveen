---
name: host-agnostic-development
description: Használd MINDEN Marveen-fejlesztésnél, mielőtt kódot, scriptet, skillt vagy sablont írnál. Marveen nyílt forráskódú -- semmilyen gépspecifikus adat (tulajdonos neve, ágens-id, abszolút útvonal, GitHub-fiók, repo-URL, chat-id) nem kerülhet fixen a kódba, mert akkor csak a szerző gépén működik. Ez a skill megmondja, honnan kell olvasni helyette.
scope: global
---

# Gépfüggetlen fejlesztés

## Mikor használd

MINDEN fejlesztés előtt, ami a Marveen repóba ír. Különösen, ha a kódba
kerülne bármelyik: egy személy neve, egy ágens azonosítója, egy `/home/<user>/...`
útvonal, egy GitHub-fiók vagy repo-URL, egy port, egy chat-id.

## Miért

Marveen nyílt forráskódú. Amit fixen beírsz, az a te gépeden működik, és
mindenki máséin csendben rosszul viselkedik. Nem elméleti: 2026-08-11-én
kiderült, hogy a seed-skillek 21 fájlban 151-szer írták fixen a tulajdonos
nevét, mert a telepítő behelyettesítés nélkül másolta őket. Egy másik
telepítésen az összes skill egy nem létező embernek szólt volna. Ugyanaznap
derült ki, hogy a Windows-mentés célrepója is fixen be volt égetve: az nem
csak elromlott volna máshol, hanem egy idegen ember privát repójába célzott.

A tulajdonos szabálya: "kenyszeritsd ki hogy mindig ugy kell egy fejlesztest
megirni, valtozo nevekkel. tehat nem csak itt a nevnel, hanem barhol mashol!"

## Eljárás

MIELŐTT beírsz egy konkrét értéket, kérdezd meg: ez minden telepítésen
ugyanaz? Ha nem, ne írd be. Innen vedd:

| Amit be akarsz írni | Honnan vedd (TS) | Honnan vedd (shell/python) |
|---|---|---|
| Tulajdonos neve | `currentOwnerName()` a `config.js`-ből | `.env` `OWNER_NAME` |
| Fő ágens id | `MAIN_AGENT_ID` | `.env` `MAIN_AGENT_ID`, fallback `marveen` |
| systemd unit neve | `SERVICE_ID` | `.env` `SERVICE_ID`, aztán `MAIN_AGENT_ID` |
| Telepítési útvonal | `PROJECT_ROOT` / `STORE_DIR` | a script saját mappájából: `BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"` |
| Bot / termék neve | `currentBotName()`, `currentBrandName()` | `.env` `BOT_NAME` / `BRAND_NAME` |
| Web port | `WEB_PORT` | `.env` `WEB_PORT`, fallback 3420 |
| GitHub-fiók, repo-URL | új `.env` kulcs | új `.env` kulcs |
| Chat-id | `chat_id: 0` (a kötött csatorna) | `chat_id: 0` |

A frontendben (`web/app.js`): `mainAgentDisplayName()`, `chatOwnerName()`,
vagy a `t()` tokenek: `{bot}`, `{brand}`, `{owner}`, `{agentId}`. Soha ne
írj be nevet i18n-szövegbe.

Sablonokban (`seed-skills/`, `seed-scheduled-tasks/`, `templates/`) a
kulcsneveket DUPLA KAPCSOS ZÁRÓJELBE téve kell írni -- ebben a fájlban
szándékosan nem szerepelnek úgy, mert a telepítő sed-je lecserélné őket,
és pont ez a leírás veszítené el az értelmét. A behelyettesíthető kulcsok:
`OWNER_NAME`, `MAIN_AGENT_ID`, `BOT_NAME`, `INSTALL_DIR`, `WEB_PORT`.

### Új gépfüggő érték felvétele

1. Vedd fel a kulcsot a `src/config.ts`-be, ÜRES alapértelmezéssel.
2. Dokumentáld a `.env.example`-ben, kikommentezve, `<placeholder>` értékkel.
3. A kód üres értéknél mondja meg, hogy nincs beállítva -- NE találgasson.
4. A saját `.env`-edbe írd be a valódi értéket (az nincs verziókövetve).

## Buktatók

- **Magyar ragozás**: a behelyettesített névre NEM lehet ragot tenni, mert a
  hangrend elromlik (a helyettesítő + "nak" a legtöbb névnél hibás alakot ad).
  A ragot tedd a köznévre, a név jöjjön utána értelmezőként:
  "a tulajdonosnak (helyettesítő)". Ezt a formát használják a
  seed-scheduled-tasks sablonok is.
- **Az alapértelmezés is gépfüggő lehet**: egy shell-fallback, ami egy létező
  telepítés ágens-idjét nevezi meg (`${MAIN_AGENT:-<valakinek-az-idje>}`),
  ugyanúgy hiba, mint a fix érték. A fallback a `config.ts`-beli semleges
  alapértelmezés legyen (`marveen`).
- **Kommentbe szabad nevet írni.** Aki kérte a változtatást, az fejlesztési
  történet, nem viselkedés. A teszt is csak a végrehajtható sorokat nézi.
- **Példa-email nem azonosító**: `valaki@work.example` szándékos placeholder.
- **Fix rendszerútvonalak nem a te home-od**: a Linuxbrew prefixe,
  `/mnt/c/Users/Public/...` minden gépen ugyanaz, ezek maradhatnak.

## Ellenőrzés

```bash
npx vitest run src/__tests__/template-identity-hygiene.test.ts
```

Ez a teszt kiolvassa a `.env`-ből a telepítés SAJÁT azonosítóit
(`OWNER_NAME`, `MAIN_AGENT_ID`, `SERVICE_ID`, `GITHUB_PUSH_ACCOUNT`), és
elbukik, ha bármelyik literálként szerepel a `src/`, `scripts/`, `web/`
végrehajtható soraiban vagy a sablonfákban. Nem fix névlistára megy, tehát
akkor is véd, ha a telepítést Gézának hívják.

Nagyobb változtatás után futtasd a teljes sort is:
```bash
git worktree add /tmp/mv-test && cd /tmp/mv-test && npm test
```
