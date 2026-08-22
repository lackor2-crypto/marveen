#!/usr/bin/env python3
"""Marveen Google Workspace OAuth helper -- Gmail / Drive / Calendar.

Nincs kulso fuggoseg (csak Python stdlib) es nincs desktop app: egy egyszeri
loopback OAuth-folyam szerzi meg a refresh tokent, amit a store/-ba ment.

Tobb-fiokos (2026-08-10, kanban b0c697ce): a token-tarolas fiok-kulcsolt,
ugyanaz a minta mint a GitHub-integracio (store/.github-tokens.json).
Az elso valaha bekotott fiok automatikusan "_default" lesz -- minden
parancs, ami nem kap explicit fiok-azonositot, erre esik vissza, igy a
meglevo hivok (scripts/google.py alapertelmezett hasznalata, ha nincs
--account flag) valtozas nelkul tovabb mukodnek. Uj fiok hozzaadasa:
  python3 scripts/google-auth.py auth <uj-fiok-nev>
A regi, nem-fiok-kulcsolt store/google-token.json-t az elso futaskor
automatikusan atmigraljuk (a Gmail cim helyi resze lesz a kulcs, pl.
"lackor2@gmail.com" -> "lackor2").

WSL-baratsag: FIX loopback port + kezi-beillesztes fallback. Ha a Windows-bongeszo
localhost-atiranyitasa nem eri el a WSL-szervert, a felhasznalo bemasolja a
cimsorbol a teljes redirect-URL-t (vagy a code-ot), es az `exchange` beváltja.

Fajlok:
  store/google-oauth-client.json    -- Google Cloud "Desktop app" OAuth kliens (Boss teszi ide)
  store/google-tokens.json          -- fiok-kulcsolt tokenek (refresh_token), chmod 600, gitignore
  store/google-token.json           -- LEGACY egy-fiokos token, csak migraciohoz olvasva
  store/.google-auth-pending.json   -- ideiglenes (state + redirect_uri + fiok), az exchange olvassa

Hasznalat:
  python3 scripts/google-auth.py auth [fiok]              # link + 10 perc varakozas (auto ha a loopback atmegy)
  python3 scripts/google-auth.py exchange "<URL>" [fiok]  # kezi: a bongesző cimsorabol bemasolt redirect-URL vagy code
  python3 scripts/google-auth.py token [fiok]              # ervenyes access_token (auto-refresh)
  python3 scripts/google-auth.py test [fiok]                # gyors ellenorzes: Gmail/Calendar/Drive read
  python3 scripts/google-auth.py list                      # bekotott fiokok listaja
Fiok nelkul = az aktualis "_default" fiok (elso bekotott fiok, altalaban lackor2).
"""
import json, os, re, sys, time, urllib.parse, urllib.request, http.server, secrets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT       = os.path.join(ROOT, "store", "google-oauth-client.json")
TOKENS       = os.path.join(ROOT, "store", "google-tokens.json")
LEGACY_TOKEN = os.path.join(ROOT, "store", "google-token.json")
PENDING      = os.path.join(ROOT, "store", ".google-auth-pending.json")

FIXED_PORT = 47921
REDIRECT   = f"http://localhost:{FIXED_PORT}/"
WAIT_SECS  = 600  # 10 perc

# b) olvasas + iras. A kuldes/modositas az autonomy-config szerint amugy is
# jovahagyasos (level 2) -- a scope megleteitol fuggetlenul.
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar",   # read + events write
    "https://www.googleapis.com/auth/drive",      # read + organize/modify
    # Google Fotok. A regi "photoslibrary.readonly" (konyvtar-bongeszes) scope-ot
    # a Google 2025-03-31-en visszavonta -- azota a Library API csak azt latja,
    # amit maga az alkalmazas toltott fel. A telefonon levo kepekhez EGYEDUL a
    # Picker vezet: a felhasznalo a Google sajat kepvalaszto feluleten valaszt,
    # es csak a kivalasztott kepeket kapjuk meg.
    "https://www.googleapis.com/auth/photospicker.mediaitems.readonly",
]
AUTH_URI  = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URI = "https://oauth2.googleapis.com/token"


def _load_client():
    if not os.path.exists(CLIENT):
        sys.exit(f"HIBA: hianyzik a kliens-JSON: {CLIENT}")
    d = json.load(open(CLIENT))
    d = d.get("installed") or d.get("web") or d
    if "client_id" not in d:
        sys.exit("HIBA: a kliens-JSON nem tartalmaz client_id-t (rossz fajl?).")
    return d


def _slugify(email):
    local = email.split("@", 1)[0] if "@" in email else email
    slug = re.sub(r"[^a-z0-9]+", "_", local.lower()).strip("_")
    return slug or "account"


def _load_tokens():
    if os.path.exists(TOKENS):
        try:
            return json.load(open(TOKENS))
        except Exception:
            return {}
    # Elso futas: ha van regi, nem-fiok-kulcsolt token, migraljuk automatikusan
    # -- a Gmail cim (profile lekerdezessel) adja a kulcsot, nem egy talalt nev.
    if os.path.exists(LEGACY_TOKEN):
        legacy = json.load(open(LEGACY_TOKEN))
        try:
            c = _load_client()
            fresh = _post(TOKEN_URI, {
                "refresh_token": legacy["refresh_token"], "client_id": c["client_id"],
                "client_secret": c["client_secret"], "grant_type": "refresh_token",
            })
            at = fresh["access_token"]
            prof = _get("https://gmail.googleapis.com/gmail/v1/users/me/profile", at)
            key = _slugify(prof.get("emailAddress", "lackor2"))
        except Exception:
            key = "lackor2"  # ismert, meglevo fiok -- biztonsagos fallback ha a profil-lekerdezes megbukik
        data = {"_default": key, key: legacy}
        _save_tokens(data)
        print(f"(migracio: {LEGACY_TOKEN} -> {TOKENS}, fiok='{key}')", file=sys.stderr)
        return data
    return {}


def _save_tokens(data):
    with open(TOKENS, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(TOKENS, 0o600)


def _default_account(data=None):
    data = data if data is not None else _load_tokens()
    d = data.get("_default")
    if d and d in data:
        return d
    # Nincs (meg) explicit default, de pontosan egy fiok van -- egyertelmu.
    keys = [k for k in data.keys() if k != "_default"]
    if len(keys) == 1:
        return keys[0]
    return None


def _post(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HIBA: token-vegpont {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")


def _get(url, at):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {at}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def _token_email(tok):
    """A frissen kapott tokenhez tartozo Gmail cim, vagy None.

    SOSEM allitja meg a mentest: az authorization code egyszer hasznalhato,
    egy atmeneti halozati hiba miatt nem dobhatjuk el a jovahagyast."""
    try:
        at = tok.get("access_token")
        if not at:
            return None
        prof = _get("https://gmail.googleapis.com/gmail/v1/users/me/profile", at)
        addr = prof.get("emailAddress")
        return addr if isinstance(addr, str) and "@" in addr else None
    except Exception:
        return None


def _free_key(base, data):
    """Szabad fiok-kulcs, a TS-oldali suggestAccountId-vel azonos nevezektan."""
    if base not in data:
        return base
    for n in range(2, 100):
        cand = f"{base}_{n}"
        if cand not in data:
            return cand
    return f"{base}_{int(time.time())}"


def _exchange_code(code, account):
    c = _load_client()
    tok = _post(TOKEN_URI, {
        "code": code, "client_id": c["client_id"], "client_secret": c["client_secret"],
        "redirect_uri": REDIRECT, "grant_type": "authorization_code",
    })
    if "refresh_token" not in tok:
        sys.exit("HIBA: nem jott refresh_token. A Google-fioknal vond vissza a Marveen hozzaferest, majd ujra 'auth'.")
    tok["saved_at"] = int(time.time())
    # KET KULON ORA, mert ket kulon dolog jar le (2026-08-22, mert hiba):
    #   saved_at         -- az ACCESS token mentese; oranként ujul (cmd_token).
    #   refresh_saved_at -- maga a REFRESH token szuletese; csak ITT, es a
    #                       rotacional (cmd_token). Ebbol szamol a lejarat-
    #                       figyelo (src/web/credential-expiry.ts).
    # Amig egyetlen ora volt, minden access-frissites 7 nappal elore tolta a
    # refresh-token hataridejet is, igy a figyelo SOHA nem tudott szolni: a
    # tar "ma 00:00-kor mentve, 08-29-ig ervenyes"-t mutatott, a Google kozben
    # invalid_grant-tal utasitotta el mind a 10 fiokot.
    tok["refresh_saved_at"] = tok["saved_at"]
    data = _load_tokens()
    email = _token_email(tok)
    prev_email = data.get(account, {}).get("email") if isinstance(data.get(account), dict) else None
    if email:
        tok["email"] = email
    elif prev_email:
        # Nem sikerult megkerdezni, ki jelentkezett be (halozat). A regi cimet
        # visszük tovabb, kulonben a slot elvesztene a cimet -- azzal a lenti
        # ellenorzes is orokre lefegyverezodne. Ha kivetelesen megis mas cim
        # volt, a kovetkezo ellenorzes (probe) amugy is a valodi cimet mutatja.
        tok["email"] = prev_email
    # Ugyanabba a slotba MAS cimmel bejelentkezni (elgepelt fioknev, vagy a
    # Google-fiokvalasztoban rossz sor) felulirna az elozo fiok tokenjet: a
    # nev maradna, a cim kicserelodne, a regi hozzaferes pedig nyom nelkul
    # elveszne. Ilyenkor nem irunk felul, hanem uj fiokkent mentjuk.
    prev = data.get(account)
    if isinstance(prev, dict) and email and prev_email and prev_email != email:
        wanted = account
        account = _free_key(_slugify(email), data)
        print(f"(figyelem: a(z) '{wanted}' fiok cime {prev_email}, most viszont {email} jelentkezett be "
              f"-- nem irtam felul, uj fiokkent mentem: '{account}')", file=sys.stderr)
    is_first = not any(k != "_default" for k in data.keys())
    data[account] = tok
    if is_first:
        data["_default"] = account
    _save_tokens(data)
    try: os.remove(PENDING)
    except OSError: pass
    print(f"OK: token mentve -> {TOKENS} (fiok='{account}')")


def _build_url(account):
    c = _load_client()
    state = secrets.token_urlsafe(16)
    json.dump({"state": state, "redirect_uri": REDIRECT, "account": account}, open(PENDING, "w"))
    os.chmod(PENDING, 0o600)
    return state, AUTH_URI + "?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent", "state": state,
    })


def cmd_auth(account):
    account = account or _default_account() or sys.exit(
        "HIBA: elso fiok bekotesekor add meg a fiok nevet: google-auth.py auth <nev>")
    state, url = _build_url(account)
    print(f"NYISD MEG EZT A BONGESZOBEN es hagyd jova ({account} fiokhoz):\n", url, "\n", flush=True)
    holder = {}
    seen = {"requests": 0, "stray": 0, "mismatch": 0}

    # A szerver TOBB kerest is kiszolgal, nem csak egyet. A regi alak egyetlen
    # handle_request()-et engedett, igy BARMILYEN korabbi keres (favicon, egy
    # nyitva felejtett regi ful ujratoltese, bongeszo-elonezet) elhasznalta az
    # egy szal lehetoseget -- utana a VALODI atiranyitas mar zart portra
    # erkezett, es a hiba "idotulles"-nek latszott. Merve: 2026-08-14/15-en 22
    # inditas futott, kozottuk 14 perces szunetekkel (=10 perc varakozas + hiba).
    class H(http.server.BaseHTTPRequestHandler):
        # Egy felig nyitott kapcsolat kulonben orokre megallitana a kiszolgalo
        # ciklust (a keresek most egy szalon, sorban jonnek).
        timeout = 10
        def do_GET(self):
            q = {k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).items()}
            mine = (q.get("state") == state)
            if not holder and mine and (q.get("code") or q.get("error")):
                holder.update(q)
                msg = ("Marveen: a Google hitelesites kesz, visszaterhetsz a chatbe."
                       if q.get("code") else
                       "Marveen: a Google elutasitotta a jovahagyast. Visszaterhetsz a Marveenbe.")
            elif q.get("code") or q.get("error"):
                # Egy REGI ful jott vissza. Ez NEM allitja le a mostani varakozast
                # -- a jo ablak meg utana is megerkezhet. (A kodot elfogadni tilos:
                # a state pont az ilyen osszekeveredes ellen van.)
                seen["mismatch"] += 1
                msg = ("Marveen: ez a jovahagyas egy KORABBI bejelentkeztetesbol jott, "
                       "ezert nem hasznalhato. Zard be ezt a fulet, es a LEGUJABB linket nyisd meg.")
            else:
                seen["stray"] += 1
                msg = ("Marveen: ez a keres nem tartalmazott jovahagyasi kodot -- "
                       "varok tovabb. Ha regi fulet toltottel ujra, hasznald a LEGUJABB linket.")
            seen["requests"] += 1
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(msg.encode("utf-8"))
        def log_message(self, *a):  # a stdout a felhasznaloe, nem a HTTP-naploe
            pass
    # Kotes ujraprobalassal. Amikor a felhasznalo azt valaszolja, hogy "szakitsd
    # meg a masikat es inditsd ezt", a regi folyamat SIGTERM-et kap, es a
    # kovetkezo ezredmasodpercben indulunk el mi -- ha az meg nem engedte el a
    # portot, egyetlen probalkozassal itt kikotnenk a kezi beillesztesnel.
    # Merve (3 kor, uresjaratban): mindig az UJ folyamate lett a socket -- de ez
    # idozitesi szerencse volt, terheles alatt atfordulhat. A varakozas ingyen van.
    srv, last_err = None, None
    for _ in range(30):  # ~3 masodperc
        try:
            srv = http.server.HTTPServer(("127.0.0.1", FIXED_PORT), H)
            break
        except OSError as e:
            last_err = e
            time.sleep(0.1)
    if srv is None:
        print(f"(figyelem: a loopback szerver nem indult a {FIXED_PORT} porton: {last_err}. Kezi beillesztes fog kelleni.)", flush=True)
    if srv:
        srv.timeout = 1  # igy a handle_request() nem ragad be orokre
        deadline = time.time() + WAIT_SECS
        while not holder and time.time() < deadline:
            srv.handle_request()
        srv.server_close()
    if holder.get("code") and holder.get("state") == state:
        _exchange_code(holder["code"], account); return

    # Innentol MINDIG megmondjuk, MI tortent. A regi kod mind a negy esetre
    # ugyanazt a "idotulles vagy a loopback nem ert ide" mondatot irta ki, holott
    # a teendo esetenkent mas -- ez tartotta korben a Bosst.
    paste = ("Kezi ut: masold ki a bongeszo cimsorabol a teljes URL-t a jovahagyas utan, es futtasd:\n"
             f"  python3 scripts/google-auth.py exchange \"<bemasolt URL vagy code>\" {account}")
    if holder.get("error"):
        sys.exit(f"HIBA: a Google elutasitotta a jovahagyast ({holder['error']}) -- a fiok nem lett bekotve.\n"
                 "Ha te nyomtal Megse-t, inditsd ujra. Ha nem: valoszinuleg nem vagy teszt-felhasznalo "
                 "ennel a Google-projektnel.\n" + paste)
    if seen["mismatch"]:
        sys.exit("HIBA: egy KORABBI bejelentkeztetes ablakabol jott vissza a jovahagyas, nem ebbol (state-eltres).\n"
                 "Zard be a regi Google-fuleket, es MINDIG a legutoljara kapott linket nyisd meg.\n" + paste)
    waited = f"{WAIT_SECS // 60} perc" if WAIT_SECS >= 60 else f"{WAIT_SECS} masodperc"
    if seen["requests"] == 0:
        sys.exit(f"HIBA: {waited} alatt nem erkezett vissza semmi a bongeszobol "
                 f"(a link megnyitasa vagy a jovahagyas maradt el).\n"
                 "Ha megnyitottad es jovahagytad, akkor a bongeszo nem erte el a gepen a "
                 f"localhost:{FIXED_PORT} cimet.\n" + paste)
    sys.exit(f"HIBA: erkezett {seen['requests']} keres a loopback-portra, de egyikben sem volt jovahagyasi kod.\n"
             "Ez tipikusan egy regi/masik ful ujratoltese.\n" + paste)


def cmd_exchange(arg, account):
    if not arg:
        sys.exit("HIBA: add meg a bemasolt redirect-URL-t vagy a code-ot argumentumkent.")
    code = arg.strip()
    pending = json.load(open(PENDING)) if os.path.exists(PENDING) else {}
    account = account or pending.get("account") or _default_account()
    if not account:
        sys.exit("HIBA: nem sikerult megallapitani, melyik fiokhoz tartozik -- add meg explicit: exchange \"<url>\" <fiok>")
    if "code=" in code:  # teljes URL bemasolva
        q = urllib.parse.urlparse(code).query or code.split("?", 1)[-1]
        params = urllib.parse.parse_qs(q)
        want = pending.get("state")
        if want and params.get("state", [None])[0] not in (None, want):
            sys.exit("HIBA: state-eltres (nem ehhez a folyamathoz tartozik a link). Inditsd ujra: auth")
        code = params.get("code", [""])[0]
    if not code:
        sys.exit("HIBA: nem talaltam code-ot a bemasolt szovegben.")
    _exchange_code(code, account)


# Biztonsagi savszelesseg a lejarat elott: ennyivel korabban mar frissitunk,
# hogy egy epp elinditott keres ne fusson bele a lejaratba.
TOKEN_MARGIN_SECS = 120


def _still_valid(t):
    """Ervenyes-e meg a tarolt access_token."""
    try:
        return bool(t.get("access_token")) and \
            int(t["saved_at"]) + int(t["expires_in"]) - TOKEN_MARGIN_SECS > int(time.time())
    except (KeyError, TypeError, ValueError):
        return False


def cmd_token(account):
    data = _load_tokens()
    account = account or _default_account(data)
    if not account or account not in data:
        sys.exit(f"HIBA: nincs token a(z) '{account}' fiokhoz. Futtasd eloszor: python3 scripts/google-auth.py auth {account or ''}".rstrip())
    c = _load_client(); t = data[account]
    # A meg ervenyes access_tokent ujrahasznaljuk. Enelkul minden hivas egy
    # refresh-kerest inditott a Google fele -- tiz fiok egyidejü nezeteben
    # (Drive "Osszes fiok") ez oldalankent tiz felesleges kores ut, es a
    # refresh-vegpontot a Google fojtja is.
    if _still_valid(t):
        print(t["access_token"])
        return
    fresh = _post(TOKEN_URI, {
        "refresh_token": t["refresh_token"], "client_id": c["client_id"],
        "client_secret": c["client_secret"], "grant_type": "refresh_token",
    })
    t.update({k: fresh[k] for k in ("access_token", "expires_in") if k in fresh})
    t["saved_at"] = int(time.time())
    # A REFRESH token hatarideje itt csak akkor mozdul, ha a Google tenylegesen
    # mondott rola valamit. Egy access-frissites onmagaban NEM fiatalitja meg a
    # refresh tokent -- ezt hittuk korabban, es ezert nem szolt semmi.
    if fresh.get("refresh_token"):
        # Rotacio: uj refresh token, uj szuletesnap.
        t["refresh_token"] = fresh["refresh_token"]
        t["refresh_saved_at"] = t["saved_at"]
        if isinstance(fresh.get("refresh_token_expires_in"), int):
            t["refresh_token_expires_in"] = fresh["refresh_token_expires_in"]
    elif isinstance(fresh.get("refresh_token_expires_in"), int):
        # A Google a HATRALEVO elettartamot mondja meg (Testing app: 604799-bol
        # visszaszamolva). Ez a legpontosabb adat, amit kaphatunk: mostantol
        # merjuk, igy a hatarido magatol helyre all akkor is, ha a tarolt
        # ertek regen elcsuszott.
        t["refresh_token_expires_in"] = fresh["refresh_token_expires_in"]
        t["refresh_saved_at"] = t["saved_at"]
    data[account] = t
    _save_tokens(data)
    print(t["access_token"])


def cmd_test(account):
    data = _load_tokens()
    account = account or _default_account(data)
    if not account or account not in data:
        sys.exit(f"HIBA: nincs token a(z) '{account}' fiokhoz.")
    c = _load_client(); t = data[account]
    at = _post(TOKEN_URI, {
        "refresh_token": t["refresh_token"], "client_id": c["client_id"],
        "client_secret": c["client_secret"], "grant_type": "refresh_token",
    })["access_token"]
    prof = _get("https://gmail.googleapis.com/gmail/v1/users/me/profile", at)
    print(f"[{account}] Gmail:", prof.get("emailAddress"), "-", prof.get("messagesTotal"), "uzenet")
    cals = _get("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=3", at)
    print("Calendar naptarak:", len(cals.get("items", [])))
    files = _get("https://www.googleapis.com/drive/v3/files?pageSize=3", at)
    print("Drive fajlok (minta):", len(files.get("files", [])))
    print("OK: mindharom API elerheto.")


def cmd_calendars(account):
    """A fiok naptarainak GEPI listaja (JSON), a vezerlopult valasztojahoz.

    Boss (2026-08-18): "HEARTBEAT_CALENDAR_ID... ezt sem tudja egy komuves
    megcsinalni, allitani." -- ezert a dashboard nem ures szoveg-mezot mutat,
    hanem legordulot; az adat innen jon. Hiba eseten is JSON-t irunk ki
    (kilepesi kod 0), hogy a hivo mindig ertelmes uzenetet tudjon mutatni.
    """
    try:
        data = _load_tokens()
        account = account or _default_account(data)
        if not account or account not in data:
            print(json.dumps({"error": f"nincs bekotott token a(z) '{account}' fiokhoz"}))
            return
        c = _load_client(); t = data[account]
        at = _post(TOKEN_URI, {
            "refresh_token": t["refresh_token"], "client_id": c["client_id"],
            "client_secret": c["client_secret"], "grant_type": "refresh_token",
        })["access_token"]
        cals = _get("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250", at)
    except Exception as e:
        print(json.dumps({"error": str(e)[:300]}))
        return
    items = []
    for it in cals.get("items", []):
        items.append({
            "id": it.get("id"),
            "summary": it.get("summary") or it.get("id"),
            "primary": bool(it.get("primary")),
            "role": it.get("accessRole"),
        })
    items.sort(key=lambda x: (not x["primary"], (x["summary"] or "").lower()))
    print(json.dumps({"account": account, "calendars": items}, ensure_ascii=False))


def cmd_list():
    data = _load_tokens()
    default = _default_account(data)
    accounts = [k for k in data.keys() if k != "_default"]
    if not accounts:
        print("Nincs bekotott Google-fiok.")
        return
    for a in accounts:
        print(f"  {a}{'  (alapertelmezett)' if a == default else ''}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "auth"
    if cmd == "list":
        cmd_list()
    elif cmd == "exchange":
        arg = sys.argv[2] if len(sys.argv) > 2 else ""
        acct = sys.argv[3] if len(sys.argv) > 3 else None
        cmd_exchange(arg, acct)
    elif cmd == "token":
        cmd_token(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "calendars":
        cmd_calendars(sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "test":
        cmd_test(sys.argv[2] if len(sys.argv) > 2 else None)
    else:
        cmd_auth(sys.argv[2] if len(sys.argv) > 2 else None)
