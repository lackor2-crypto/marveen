#!/usr/bin/env python3
"""Marveen Google Workspace OAuth helper -- Gmail / Drive / Calendar.

Nincs kulso fuggoseg (csak Python stdlib) es nincs desktop app: egy egyszeri
loopback OAuth-folyam szerzi meg a refresh tokent, amit a store/-ba ment.

WSL-baratsag: FIX loopback port + kezi-beillesztes fallback. Ha a Windows-bongeszo
localhost-atiranyitasa nem eri el a WSL-szervert, a felhasznalo bemasolja a
cimsorbol a teljes redirect-URL-t (vagy a code-ot), es az `exchange` beváltja.

Fajlok:
  store/google-oauth-client.json    -- Google Cloud "Desktop app" OAuth kliens (Boss teszi ide)
  store/google-token.json           -- megszerzett token (refresh_token), chmod 600, gitignore
  store/.google-auth-pending.json   -- ideiglenes (state + redirect_uri), az exchange olvassa

Hasznalat:
  python3 scripts/google-auth.py auth              # link + 10 perc varakozas (auto ha a loopback atmegy)
  python3 scripts/google-auth.py exchange "<URL>"  # kezi: a bongesző cimsorabol bemasolt redirect-URL vagy code
  python3 scripts/google-auth.py token             # ervenyes access_token (auto-refresh)
  python3 scripts/google-auth.py test              # gyors ellenorzes: Gmail/Calendar/Drive read
"""
import json, os, sys, time, urllib.parse, urllib.request, http.server, threading, secrets

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT  = os.path.join(ROOT, "store", "google-oauth-client.json")
TOKEN   = os.path.join(ROOT, "store", "google-token.json")
PENDING = os.path.join(ROOT, "store", ".google-auth-pending.json")

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


def _save_token(tok):
    tok["saved_at"] = int(time.time())
    with open(TOKEN, "w") as f:
        json.dump(tok, f, indent=2)
    os.chmod(TOKEN, 0o600)


def _post(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"HIBA: token-vegpont {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")


def _exchange_code(code):
    c = _load_client()
    tok = _post(TOKEN_URI, {
        "code": code, "client_id": c["client_id"], "client_secret": c["client_secret"],
        "redirect_uri": REDIRECT, "grant_type": "authorization_code",
    })
    if "refresh_token" not in tok:
        sys.exit("HIBA: nem jott refresh_token. A Google-fioknal vond vissza a Marveen hozzaferest, majd ujra 'auth'.")
    _save_token(tok)
    try: os.remove(PENDING)
    except OSError: pass
    print("OK: token mentve ->", TOKEN)


def _build_url():
    c = _load_client()
    state = secrets.token_urlsafe(16)
    json.dump({"state": state, "redirect_uri": REDIRECT}, open(PENDING, "w"))
    os.chmod(PENDING, 0o600)
    return state, AUTH_URI + "?" + urllib.parse.urlencode({
        "client_id": c["client_id"], "redirect_uri": REDIRECT, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent", "state": state,
    })


def cmd_auth():
    state, url = _build_url()
    print("NYISD MEG EZT A BONGESZOBEN es hagyd jova:\n", url, "\n", flush=True)
    holder = {}
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            holder.update({k: v[0] for k, v in urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).items()})
            self.send_response(200); self.end_headers()
            self.wfile.write("Marveen: a Google hitelesites kesz, visszaterhetsz a chatbe.".encode("utf-8"))
    try:
        srv = http.server.HTTPServer(("127.0.0.1", FIXED_PORT), H)
    except OSError as e:
        print(f"(figyelem: a loopback szerver nem indult a {FIXED_PORT} porton: {e}. Kezi beillesztes fog kelleni.)", flush=True)
        srv = None
    if srv:
        threading.Thread(target=lambda: [srv.handle_request() for _ in range(1)], daemon=True).start()
        for _ in range(WAIT_SECS):
            if holder: break
            time.sleep(1)
        srv.server_close()
    if holder.get("code") and holder.get("state") == state:
        _exchange_code(holder["code"]); return
    sys.exit("HIBA: nem erkezett ervenyes kod (idotullepes vagy a loopback-atiranyitas nem ert ide).\n"
             "Javaslat: hasznald a kezi utat -- masold ki a bongesző cimsorabol a teljes URL-t a jovahagyas utan, es futtasd:\n"
             "  python3 scripts/google-auth.py exchange \"<bemasolt URL vagy code>\"")


def cmd_exchange(arg):
    if not arg:
        sys.exit("HIBA: add meg a bemasolt redirect-URL-t vagy a code-ot argumentumkent.")
    code = arg.strip()
    if "code=" in code:  # teljes URL bemasolva
        q = urllib.parse.urlparse(code).query or code.split("?", 1)[-1]
        params = urllib.parse.parse_qs(q)
        if os.path.exists(PENDING):
            want = json.load(open(PENDING)).get("state")
            if want and params.get("state", [None])[0] not in (None, want):
                sys.exit("HIBA: state-eltres (nem ehhez a folyamathoz tartozik a link). Inditsd ujra: auth")
        code = params.get("code", [""])[0]
    if not code:
        sys.exit("HIBA: nem talaltam code-ot a bemasolt szovegben.")
    _exchange_code(code)


def cmd_token():
    if not os.path.exists(TOKEN):
        sys.exit("HIBA: nincs token. Futtasd eloszor: python3 scripts/google-auth.py auth")
    c = _load_client(); t = json.load(open(TOKEN))
    fresh = _post(TOKEN_URI, {
        "refresh_token": t["refresh_token"], "client_id": c["client_id"],
        "client_secret": c["client_secret"], "grant_type": "refresh_token",
    })
    t.update({k: fresh[k] for k in ("access_token", "expires_in") if k in fresh})
    _save_token(t)
    print(t["access_token"])


def _get(url, at):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {at}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def cmd_test():
    c = _load_client(); t = json.load(open(TOKEN))
    at = _post(TOKEN_URI, {
        "refresh_token": t["refresh_token"], "client_id": c["client_id"],
        "client_secret": c["client_secret"], "grant_type": "refresh_token",
    })["access_token"]
    prof = _get("https://gmail.googleapis.com/gmail/v1/users/me/profile", at)
    print("Gmail:", prof.get("emailAddress"), "-", prof.get("messagesTotal"), "uzenet")
    cals = _get("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=3", at)
    print("Calendar naptarak:", len(cals.get("items", [])))
    files = _get("https://www.googleapis.com/drive/v3/files?pageSize=3", at)
    print("Drive fajlok (minta):", len(files.get("files", [])))
    print("OK: mindharom API elerheto.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "auth"
    arg = sys.argv[2] if len(sys.argv) > 2 else ""
    if cmd == "exchange": cmd_exchange(arg)
    elif cmd == "token":  cmd_token()
    elif cmd == "test":   cmd_test()
    else:                 cmd_auth()
