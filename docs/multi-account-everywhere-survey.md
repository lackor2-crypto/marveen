# Tobb-fiokos mukodes mindenhol -- felmeres + terv

Keszult: 2026-09-03, Segedmunkas (lackor3). Kartya: `b4beb9b4` (#101),
letrehozva 2026-08-11, Boss eredeti kerese (Gmail, Drive, naptar, GitHub,
Telegram tobb-fiokos hasznalata, feltoltes/iras elott valasztassal).

A kartya sajat szovege szerint az ELSO LEPES felmeres, nem kodolas -- ez a
dokumentum azt potolja, ami korabban hianyzott: a kartya `waiting`-be kerult
ures kezzel (ellenorizve: nincs komment, nincs commit, nincs dokumentum a
tenyleges munkarol -- lasd az `a60c4d9e-4b4b-4725-ab3b-375f87e38304` approval
`fail` verdiktjet, 2026-09-02).

---

## A legfontosabb dolog, mielott a listat nezed

**A kartya ota (2026-08-11) a hitelesito-reteg NAGY RESZE mar tobb-fiokossa
valt** -- de ettol fuggetlenul, MAS okbol. A Google multi-account tamogatas
(`store/google-tokens.json`) mar `b0c697ce` kartyan epult meg 2026-08-10-en
(EGY nappal a b4beb9b4 letrehozasa elott), a GitHub-fiokok listaja `551823e2`
(#47) es `8c91bfcb` (#198) kartyakon, a Claude Code tobb-bejelentkezes es a
kulcsos-szolgaltatasok tobb-fiokossaga meg kesobb, `61e9ed2b` (#52) es
2026-09-02-i munkakkal.

**De egyik sem a b4beb9b4-ert epult**, es egyik sem oldja meg Boss eredeti,
konkret keresét: "mindenhol a rendszer felajanlja azt, hogy hova szeretned
feltolteni ezt meg azt" -- vagyis egy VALASZTAS a MUVELET PILLANATABAN
(melyik naptarba irjak, melyik Drive-mappaba toltsek fel, melyik GitHub-fiokkal
push-oljak), NEM csak azt, hogy TOBB hitelesito adat van eltarolva.

**A ket reteg kulon dolog:**

1. **Hitelesito-reteg** (van-e tobb fiok/token elmentve, latszik-e a
   Fiokok oldalon) -- ez a legtobb teruleten MAR MEGVAN.
2. **Muvelet-idejü valasztas** (melyik fiokkal/mappaval/naptarral tortenjen
   EZ a konkret muvelet, es kerdezi-e a rendszer, ha tobb lehetoseg van) --
   ez SEHOL nincs meg, egyetlen teruleten sem.

A ket reteg osszekeverese az, ami miatt a kartya konnyen "kesz"-nek
nezhetett volna ki egy felszines nezetbol -- pedig Boss eredeti kerese a
2. retegrol szolt, es abbol semmi nem epult meg.

---

## Teruletenkenti allapot (merve, 2026-09-03)

### 1. Gmail / Google OAuth -- hitelesito-reteg KESZ, muvelet-valasztas HIANYZIK

- `src/web/google-accounts.ts` + `store/google-tokens.json`: nevesitett
  fiokonkent kulon OAuth-token, `_default` mutato, akar ~10 parhuzamos cim.
  A `scripts/google-auth.py list` adja vissza a fiokneveket.
- `src/web/routes/accounts.ts` (`GET /api/accounts`): a Fiokok oldal
  MUTATJA a Google-fiokok listajat es az alapertelmezettet -- de csak
  STATUS-kent (olvashato, GET-only), nem valaszthato ki innen muveletenkent.
- **Hianyzik**: amikor a rendszer email-t kuld/olvas, NEM kerdezi meg,
  melyik fiokkal tegye -- mindig az alapertelmezett (`_default`) fiokot
  hasznalja. Nincs UI-elem egyetlen email-kuldo/olvaso folyamatban sem, ami
  fiokot valasztana muvelet elott.
- claude.ai MCP-konnektorok (ha valaki azon keresztul kotne be Gmail-t):
  EZ A REteg NEM tud tobb-fiokos lenni -- elo, tenyleges probaval igazolva
  (`claude mcp add --transport http gmail-ketto ...` -> "Incompatible auth
  server: does not support dynamic client registration"). Ez nem Marveen
  hiba, hanem a Google/Anthropic MCP-vegpont korlatja -- csak akkor merul
  fel, ha valaki NEM a beepitett `google-auth.py`-t hasznalja.

### 2. Google Drive -- hitelesito-reteg keszen all (megosztott), cel-mappa EGY, fix

- `src/config.ts:167`: `OWNER_DRIVE_FOLDER` -- EGY Drive-mappa-azonosito
  `.env`-bol, install-szinten fix.
- `src/web/agent-scaffold.ts:1622-1626`: a flotta-doktrina (agens CLAUDE.md
  sablon) kifejezetten EGY alapertelmezett kozos meghajtot ir elo minden
  agensnek ("ha nincs mas kijelolve, az ALAPERTELMEZETT kozos meghajtora
  irj"), ami PONTOSAN az ellentetje annak, amit Boss kert (mappa-VALASZTAS
  minden feltoltesnel).
- **Hianyzik**: nincs semmilyen UI vagy folyamat, ahol egy Drive-feltoltes
  elott a rendszer megkerdezné, melyik mappaba (vagy melyik Google-fiok
  Drive-jaba) menjen a fajl. Az egyetlen "valasztas" ma az, hogy egy
  agens szoveges CLAUDE.md-utasitasa szerint dont -- ez nem felhasznaloi
  valasztas, hanem fix szabaly.

### 3. Naptar (Google Calendar) -- EGY naptar, fix, iras is csak oda mehet

- `src/config.ts:457`: `HEARTBEAT_CALENDAR_ID` -- EGY naptar-azonosito.
- Nincs olyan kod-hely, ahol tobb naptar kozul valasztana a rendszer irasnal
  vagy a heartbeat-ellenorzesnel.
- **Hianyzik**: teljesen, ugyanugy mint a kartya eredeti leirasa allitotta
  2026-08-11-en -- ezen a teruleten semmi nem valtozott azota.

### 4. GitHub -- hitelesito-reteg KESZ (tobb fiok, gh CLI-vel is), muvelet-cel EGY, fix

- `src/git-accounts.ts` (`gitAccountsWithToken()`) + `store/.git-tokens.json`
  ES a gh-CLI altal tarolt bejelentkezesek egyutt adjak a fioklistat --
  ez a legutobbi, `2026-09-02`-i munka eredmenye (commit `b34720f` /
  `b1969dc`, "a GitHub-fiok lista lassa a gh-CLI kulcsu fiokokat is").
- `src/web/routes/accounts.ts` GET `/api/accounts`: a Fiokok oldal MUTATJA
  az osszes GitHub-fiokot.
- `src/config.ts:173`: `WINDOW_BACKUP_REPO_URL` -- EGY fix repo-URL a
  Windows-mentes celjahoz. `setup-wizard-registry.ts:208`:
  `GITHUB_PUSH_ACCOUNT` -- EGY fix fioknev a push-hoz.
- **Hianyzik**: hiaba latszik tobb fiok a Fiokok oldalon, egyetlen push-
  vagy mentes-muvelet SEM kerdezi meg, melyikkel tortenjen -- mindig a
  telepitesi-idoben rogzitett `GITHUB_PUSH_ACCOUNT` es a fix
  `WINDOW_BACKUP_REPO_URL` szamit.

### 5. Telegram -- meg a hitelesito-reteg is EGY-fiokos

- `TELEGRAM_BOT_TOKEN` (`src/config.ts`): EGY bot-token, boolean
  `configured` allapotot ad csak a Fiokok oldalon (`accounts.ts:331`).
- Grep-kereses a repo egeszen (`multi.*telegram`, `TELEGRAM_BOT_TOKEN_2`,
  `telegramAccounts`) NEM talalt tobb-fiokos Telegram-infrastrukturat.
- **Ez az egyetlen terulet, ahol MEG A HITELESITO-RETEG SEM tobb-fiokos** --
  a masik negy teruletnel legalabb a token-tarolas mar tamogatna tobb
  identitast.

---

## Osszefoglalo tablazat

| Terulet   | Hitelesito-reteg (tobb fiok TAROLVA) | Muvelet-idejü VALASZTAS |
|-----------|----------------------------------------|--------------------------|
| Gmail     | KESZ (google-tokens.json, ~10 fiok)    | HIANYZIK                 |
| Drive     | Google-fiokkal egyutt jon               | HIANYZIK (fix mappa)     |
| Naptar    | Google-fiokkal egyutt jon               | HIANYZIK (fix naptar)    |
| GitHub    | KESZ (git-accounts.ts + gh CLI)         | HIANYZIK (fix fiok+repo) |
| Telegram  | HIANYZIK                                | HIANYZIK                 |

**A kartya eredeti, 2026-08-11-i allitasa** ("Gmail: egy OAuth kliens, egy
token", "GitHub: egy fiok") **a hitelesito-retegre MAR NEM igaz** Gmail-nel
es GitHub-nal -- ezt kesobbi, EGYEB kartyak (nem b4beb9b4) oldottak meg,
mellekesen. A kartya VALODI, meg mindig nyitott resze a muvelet-idejü
valasztas -- ez az, amit Boss szoban is ket kulon mondatban kert ("legyen
egy alapertelmezett, DE legyen ott a lehetoseg", "a rendszer felajanlja,
hogy HOVA szeretned feltolteni").

---

## Javasolt terv (kovetkezo lepesek, meg NEM megvalositva)

Sorrend fontossag es meret szerint, a legkisebb/leghasznosabb elorel:

1. **Google Drive feltoltes-valasztas** (legkisebb valtoztatas, mert a
   Google-fiok-reteg mar kesz): ahol ma egy fajlt `OWNER_DRIVE_FOLDER`-be
   tesz a rendszer, ott -- ha tobb Google-fiok van elmentve -- kerdezzen
   ra (dashboard-felugro vagy Telegram-visszakerdezes), melyik fiok/melyik
   mappa legyen a cel; alapertelmezettkent maradjon a mai fix mappa.
2. **GitHub push-fiok valasztas**: hasonloan, ahol `GITHUB_PUSH_ACCOUNT`
   szamit, es tobb GitHub-fiok van a Fiokok oldalon, ott legyen lathato/
   valaszthato melyikkel tortenjen a push -- NEM csak telepitesi env-
   valtozoval eldontve.
3. **Naptar-valasztas irasnal**: `HEARTBEAT_CALENDAR_ID` helyett/mellett
   egy naptar-lista + alapertelmezett mechanizmus, hasonloan a
   Google-fiokokhoz -- ez a legnagyobb egyedi munka, mert MA meg a
   hitelesito-reteg is csak egy naptart ismer fel konfiguraciosan.
4. **Telegram tobb-fiokos alap**: ez a legnagyobb tetel, mert itt meg a
   token-tarolas SEM tobb-fiokos -- elobb azt kellene `TELEGRAM_BOT_TOKEN`
   helyett egy nevesitett-tobb-token tarolova alakitani (a Google-mintat
   kovetve), utana johetne a valasztas maga.
5. **Egysegesites**: miutan legalabb 2 terulet kesz, erdemes egy KOZOS
   "hova menjen ez?" UI-mintat kialakitani (egy ujrafelhasznalhato
   dashboard-komponens), hogy ne 4 kulon megoldas szulessen -- ez mar
   tervezesi dontes, nem resze ennek a felmeresnek.

**Tarolas kerdese** (a kartya eredeti megjegyzese szerint is nyitott): a
`.env` egyetlen erteket tud tartani egy kulcshoz, listat es
alapertelmezettet nem -- a Google-fiokok mintaja (`store/google-tokens.json`,
`_default` mutato) mar bizonyitottan mukodik erre a celra, erdemes ezt
kovetni a tobbi teruletnel is ahelyett, hogy uj tarolasi mintat talalnank ki.

---

## Kapcsolodo kartyak

- `551823e2` (#47, done) -- Projekt-mappa struktura + Google Drive
  biztonsagi mentes (a mai fix `OWNER_DRIVE_FOLDER` hasznalata innen jott)
- `61e9ed2b` (#52, done) -- Claude Code fiokvaltas a dashboardrol (a
  `/api/accounts/claude/*` vegpontok forrasa)
- `8c91bfcb` (#198, done) -- Fiokok oldal: GitHub-fiok hozzaadasa hianyzik
- `aa55180c` (#14) -- kapcsolodo, nem ellenorizve ebben a felmeresben
- `b4beb9b4` (#101, EZ a kartya) -- ez a dokumentum a felmeres+terv resz;
  a tenyleges megvalositas (fenti 4 lepes) uj, kulon kartyakat igenyel.

## Modszertan

Grep + Read alapu kod-felmeres (`src/config.ts`, `src/web/google-accounts.ts`,
`src/web/routes/accounts.ts`, `src/git-accounts.ts`, `src/web/agent-scaffold.ts`,
`src/web/setup-wizard-registry.ts`), a `git log --oneline` friss commit-
tortenete (2026-09-02-i GitHub-fiok-lista javitas), es teljes szoveges grep
tobb-fiokos Telegram-tamogatas utan (nem talalt semmit). Kodvaltozas ennek a
dokumentumnak a resze NEM tortent -- a kartya sajat szovege szerint ez a
lepes felmeres, nem kodolas; a tervben felsorolt 4 lepes onallo, kesobbi
kartyakon valosulhat meg.
