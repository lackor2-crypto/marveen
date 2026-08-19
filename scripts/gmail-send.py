#!/usr/bin/env python3
"""Gmail draft/send with attachment, using the Marvin OAuth token (gmail.send scope).

Usage:
  python3 scripts/gmail-send.py draft  <to> <subject> <file> [file2 ...]
  python3 scripts/gmail-send.py send   <to> <subject> <file> [file2 ...]

- 'draft' creates a Gmail draft (Boss reviews + sends from phone). SAFE default.
- 'send'  sends immediately (level2 -- only on explicit Boss instruction).
Body is auto-filled with a short line; each file becomes an attachment.
Prints the created draft/message id on success.
"""
import sys, os, json, base64, mimetypes, urllib.request, urllib.error
from email.message import EmailMessage

# Repo root = this script's parent dir, so it works from any CWD and any
# install path. Absolute paths here pointed at one author's home directory and
# simply failed to open on every other machine.
_BASE = os.environ.get("MARVEEN_STORE") or os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "store")
TOKENS = os.path.join(_BASE, "google-tokens.json")      # fiok-kulcsolt (ez az elo)
TOKEN = os.path.join(_BASE, "google-token.json")        # LEGACY, csak ha nincs masik
CLIENT = os.path.join(_BASE, "google-oauth-client.json")


def _token_record():
    """A hasznalando token, es hogy melyik fiokrol van szo.

    2026-08-19-en merve, es ez volt a valodi hiba: a rendszer 2026-08-10-en
    atallt a fiok-kulcsolt store/google-tokens.json-ra (a google-auth.py at is
    migralta a regit), CSAK ez a script maradt a regi, egyfiokos
    google-token.json-on. Azt a fajlt azota semmi nem ujitja meg: mind a 10 fiok
    elt es zold volt, mikozben a levelkuldes `invalid_grant | Token has been
    expired or revoked` hibaval bukott.

    Innentol ugyanabbol a tarbol dolgozunk, mint minden mas: a fiokot a
    MARVEEN_GOOGLE_ACCOUNT adhatja meg, kulonben a "_default". A regi fajl csak
    akkor jon szoba, ha a fiok-kulcsolt tar egyaltalan nincs meg (migracio
    elotti telepites) -- kulonben eppen a halott utat valasztanank ujra.
    """
    kert = os.environ.get("MARVEEN_GOOGLE_ACCOUNT", "").strip()
    if os.path.exists(TOKENS):
        store = json.load(open(TOKENS))
        fiok = kert or store.get("_default")
        rec = store.get(fiok) if isinstance(fiok, str) else None
        if isinstance(rec, dict) and rec.get("refresh_token"):
            return rec, "%s <%s>" % (fiok, rec.get("email", "?"))
        letezo = ", ".join(k for k in store if not k.startswith("_"))
        raise SystemExit(
            "HIBA: nincs hasznalhato Google-fiok '%s' neven. Bekotott fiokok: %s. "
            "Add meg a MARVEEN_GOOGLE_ACCOUNT valtozoval, vagy csatlakoztasd a "
            "fiokot a dashboard Fiokok oldalan." % (fiok, letezo or "(egy sem)"))
    if os.path.exists(TOKEN):
        return json.load(open(TOKEN)), "legacy google-token.json"
    raise SystemExit(
        "HIBA: nincs Google-token. Csatlakoztass egy fiokot a dashboard Fiokok "
        "oldalan (vagy: python3 scripts/google-auth.py auth).")


def _access_token():
    t, honnan = _token_record()
    # Kiirjuk, MELYIK fiokrol megy a level: tiz bekotott cimnel a naplobol
    # kulonben nem allapithato meg, es epp ez volt a kerdes.
    print("   (kuldo fiok: %s)" % honnan)
    # refresh unconditionally -- tokens are short lived
    c = json.load(open(CLIENT))
    data = urllib.parse.urlencode({
        "client_id": c.get("client_id") or c.get("installed", {}).get("client_id"),
        "client_secret": c.get("client_secret") or c.get("installed", {}).get("client_secret"),
        "refresh_token": t["refresh_token"],
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["access_token"]


def _build(to, subject, files):
    msg = EmailMessage()
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(os.environ.get("MAIL_BODY", "Csatolva a kert dokumentum.\n\n--\nMarvin"))
    for f in files:
        if not os.path.isfile(f):
            raise SystemExit(f"HIBA: nincs ilyen fajl: {f}")
        ctype, _ = mimetypes.guess_type(f)
        maintype, subtype = (ctype or "application/octet-stream").split("/", 1)
        with open(f, "rb") as fh:
            msg.add_attachment(fh.read(), maintype=maintype, subtype=subtype,
                               filename=os.path.basename(f))
    return base64.urlsafe_b64encode(msg.as_bytes()).decode()


def _post(url, at, payload):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Authorization": "Bearer " + at,
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HIBA {e.code}: {e.read().decode()[:400]}")


def main():
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    mode, to, subject = sys.argv[1], sys.argv[2], sys.argv[3]
    files = sys.argv[4:]
    raw = _build(to, subject, files)
    at = _access_token()
    if mode == "draft":
        res = _post("https://gmail.googleapis.com/gmail/v1/users/me/drafts", at,
                    {"message": {"raw": raw}})
        print("DRAFT OK id=" + res.get("id", "?"))
    elif mode == "send":
        res = _post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", at,
                    {"raw": raw})
        print("SENT OK id=" + res.get("id", "?"))
    else:
        raise SystemExit("mode: draft | send")


if __name__ == "__main__":
    main()
