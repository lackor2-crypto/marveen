---
name: email-fastpath-guard
description: A gyors level-test betoltes (direct-IMAP fast path) egeszseg-orjaratja. 15 percenkent ellenorzi minden email fiokot, es CSAK allapotvaltaskor szol -- igy egy visszaeso fiok nem maradhat eszrevetlenul, amig valaki eppen ki nem nyitja az Email oldalt.
---

# Email gyors-betoltes orjarat

## Mikor fut
15 percenkent. Csendes, ha minden zold.

## Miert letezik
2026-08-18-an kiderult, hogy a direct-IMAP gyors level-test betoltes NEM
mukodott egyetlen fioknal sem -- egy TOML-formatum-elteres miatt a
config.toml irója (smol-toml stringify, beagyazott tabla-fejlec forma) es a
regi, kezzel irt olvaso (email-imap.ts parseHimalayaToml, csak a
pontozott-kulcs formatumot ismerte) kozott. A hiba 2026-08-06 ota lappangott,
es csak azota torte el MINDEN fiokot, hogy a dashboardon eloszor mentettek
fiok-beallitast azota -- egyetlen uj fiok felvetele volt a lathato tunet, de
a valodi hatokor sokkal nagyobb volt. Csak azert derult ki, mert valaki
eszrevette, hogy egy level lassan toltodik be.

Az olvaso azota valodi TOML-konyvtarat hasznal (formatum-fuggetlen), ami ezt
a KONKRET hibaosztalyt strukturalisan kizarja -- de ez az orjarat nem a
mult ellen van kitalalva, hanem a KOVETKEZO regresszio ellen: egy jovobeli
kod-valtoztatas, vagy egy uj fiok tenylegesen hianyos/rossz beallitasa.
Lasd: checkImapAccountConfig() (src/web/email-imap.ts) es a
/api/email/fastpath-status vegpont (src/web/routes/email.ts) -- ugyanaz a
logika adja ezt az orjaratot, mint az Email oldal piros allapot-sav-jat.

## Eljaras

```bash
bash {{INSTALL_DIR}}/scripts/email-fastpath-guard.sh
```

A script lekerdezi a /api/email/fastpath-status vegpontot, es CSAK
allapotvaltaskor (zoldbol pirosba, vagy pirosbol zoldbe), illetve pirosan
toltve 2 oranta kuld inter-agent uzenetet -- igy egy tartos hiba nem nemul el
az elso figyelmeztetes utan, de nem is spammel 15 percenkent.

Ha jelentest kapsz tole (piros):
1. Kovesd a jelentesben leirt diagnozis-menetrendet (git log az erintett
   fajlokon, checkImapAccountConfig oka, a config.toml aktualis tartalma az
   erintett fioknal).
2. Ha a gyokerok biztonsagosan javithato kod-regresszio: javitsd a szokasos
   menetrenddel -- `npx tsc --noEmit -p .`, a valtozott fajlok masolasa a
   szigetelt worktree-be, `npx vitest run` ott, `npm run build`, a dashboard
   service ujrainditasa, majd curl-lel ellenorizd a
   /api/email/fastpath-status valaszat.
3. Ha a gyokerok valodi hianyzo/rossz hitelesito adat (uj fiok rossz
   jelszoval, OAuth2 fiok jelszo-parancs nelkul, stb.): NE talalj ki es NE
   modosits hitelesito adatot automatikusan -- jelentsd pontosan, mi hianyzik
   vagy hibas, es kerd az operator kozbelepeset.
4. A himalaya-fallback (a level-test kezelo email.ts-ben) marad a biztonsagi
   halo -- ez sose kerul kikapcsolasra vagy toroelesre. Ez az orjarat kizarolag
   arrol szol, hogy AZONNAL kiderujon, ha a gyors ut helyett megint arra
   tamaszkodunk.
5. Barhogy is vegzodik: irj rovid osszefoglalot -- a gyokerok, javitottad-e
   (vagy miert nem), es hogy a build zold-e.

## Buktatok
- A script a dashboard sajat /api/email/fastpath-status vegpontjat hivja
  (ugyanaz a logika, mint az Email oldal piros sav-ja) -- ha a dashboard
  service all, a script csendben skip-el, nincs mit ellenorizni.
- Az allapot a store/email-fastpath-guard.state fajlban van; ha torlod, a
  kovetkezo futas ujra "friss" allapotvaltaskent fogja ertelmezni azt, amit
  talal.

## Ellenorzes
```bash
bash {{INSTALL_DIR}}/scripts/email-fastpath-guard.sh --report-only
tail -10 {{INSTALL_DIR}}/store/email-fastpath-guard.log
```
