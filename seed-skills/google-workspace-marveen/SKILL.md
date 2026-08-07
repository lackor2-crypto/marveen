---
name: google-workspace-marveen
description: Gmail / Google Drive / Google Calendar bekotese Marveenen belul, sajat Google Cloud OAuth appal (nincs desktop app / GUI kliens). Trigger: "kosd be a Gmail/Drive/Calendar-t", google integracio, OAuth setup.
---
# Google Workspace (Gmail/Drive/Calendar) integracio Marveenen belul

## Mikor használd
Boss a Gmail/Drive/Calendar bekoteset keri Marveenbe, desktop app / GUI nelkul, API/OAuth/CLI alapon.

## Fontos kontextus (felderites eredmenye)
- Alaphelyzetben NINCS Google-integracio (a morning routine `search_emails`/`list-events` csak sablon).
- A natix Claude connectorok (`gmail.mcp.claude.com`, `gcal.mcp.claude.com`, `microsoft365.mcp.claude.com`) a user `~/.claude/settings.json`-ban `tengu_mcp_local_oauth_blocked_hosts` alatt TILTVA vannak local OAuth-ra (hatter-agens megbizhatosag). Drive-hoz natix connector nincs.
- Ezert: sajat Google Cloud OAuth app (Desktop client) + egyszeri browser consent + refresh token a `store/`-ban. Minden hivas Marveenbol.

## Eljárás
1. **Felderites**: `.mcp.json`, `~/.claude/settings.json` (blocked hosts), `store/` token-nyomok, google CLI-k (gcalcli/rclone) -- van-e mar valami.
2. **Boss Google-oldali manualis lepesei (csak o tudja, ird le pontosan):**
   - console.cloud.google.com -> uj projekt "Marveen"
   - APIs & Services -> Library -> Enable: Gmail API, Google Drive API, Google Calendar API
   - OAuth consent screen: External, app=Marveen, Test users += sajat email (Testing modban maradhat)
   - Credentials -> Create -> OAuth client ID -> **Desktop app** -> Download JSON
   - A JSON-t NE a chatbe -> mentse: `store/google-oauth-client.json` (erzekeny, gitignore!)
3. **Scope-dontes Bosstol**: a) csak olvasas, vagy b) olvasas+iras (a kuldes/modositas ugyis level2 approval az autonomy-configban). Minimal scope-ok:
   - Gmail: `gmail.readonly` (+ `gmail.send` ha b)
   - Calendar: `calendar.readonly` (+ `calendar.events` ha b)
   - Drive: `drive.readonly` (+ `drive.file` vagy `drive` ha rendezes/mozgatas kell)
4. **Token megszerzese (egyszeri, browser consent):** generalj auth URL-t a client_id + scope-okkal, Boss megnyitja, jovahagyja, a kapott code-ot beirja; token-csere -> refresh_token mentese `store/`-ba (chmod 600, gitignore).
5. **Marveen-oldali bekotes:** helyi Google Workspace MCP szerver VAGY kis CLI/scriptek az API-khoz. A package install level2 approval (autonomy-config). Valaszd a legkarbantarthatobbat, egy eszkoz mind a haromra ha lehet.
6. **Naplozz**, es teszteld: 1 email-lista, 1 naptar-lista, 1 drive-lista hivas.

## Buktatók
- A kliens-JSON es a refresh token ERZEKENY: sose chatbe, sose logba, `store/`-ban chmod 600, `.gitignore`-ban.
- Ne telepits desktop appot / GUI klienst -- Boss explicit tiltotta.
- A natix connectorok tiltva vannak; ne azokkal probalkozz.
- Testing modu consent screennel a refresh token ~7 nap utan lejarhat, HA a consent screen "Testing" es nem "In production". Ha tartos kell: publikald a consent screent (vagy vallald az ujra-consentet). Jelezd Bossnak.
- A kuldes/modositas/megosztas az autonomy-config szerint level2 (jovahagyas) -- a scope megleteitol fuggetlenul kerj engedelyt elottuk.
- **WSL loopback buktato:** a Windows-bongesző `http://localhost:<port>` redirectje NEM mindig eri el a WSL-beli loopback szervert (localhostForwarding), ezert a random-portos auto-folyam idotullepessel elbukhat. Megoldas: FIX loopback port + KEZI fallback -- a felhasznalo a jovahagyas utan a bongesző cimsorabol bemasolja a teljes redirect-URL-t (`localhost:<port>/?code=...&state=...`), es egy kulon `exchange "<URL>"` parancs bevaltja a code-ot (a token-csere nem igenyli az elo szervert, csak azonos redirect_uri-t). Adj 10 perc ablakot; a code egyszerhasznalatos, gyorsan kell bevaltani.
- OOB flow (`urn:ietf:wg:oauth:2.0:oob`) NEM mukodik uj klienseknel (Google 2022-ben leallitotta) -- loopback redirect az egyetlen jarhato ut.

## Olvaso-CLI (kesz, level 3 autonom)
`python3 scripts/google.py <parancs>` -- CSAK olvasas, a friss access_tokent a google-auth.py token adja:
- `mai-naptar` | `kovetkezo-esemeny`
- `utolso-emailek [N]` (alap 5) | `olvasatlan [N]` (alap 10) -- spam/promo szurve
- `drive-legutobbi [N]` (alap 10)
- `napi-osszefoglalo` -- datum + fontos olvasatlan VALODI darabszam (`_list_ids`, NEM a megbizhatatlan resultSizeEstimate) + top5 + kovetkezo esemeny (vagy "nincs").
A reggeli-napindito (SKILL.md) a `napi-osszefoglalo`-t hivja; a CLAUDE.md "Reggeli napindito" is ezekre mutat.
Minden google.py parancs auto-logol a kozos esemeny-logba (`store/event-log.txt`, `scripts/eventlog.sh` formatum): `google:<cmd> | OK|ERROR`. Visszanezes: `tail store/event-log.txt`.

## Ellenőrzés
- `store/google-oauth-client.json` + token fajl chmod 600, gitignore-ban.
- `python3 scripts/google.py mai-naptar` es tarsai valos adatot adnak.
- Kuldes/modositas/megosztas SINCS az olvaso-CLI-ben; csak approval utan, kulon.
